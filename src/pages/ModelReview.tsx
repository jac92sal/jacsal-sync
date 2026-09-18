import { useEffect, useMemo, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import type { ShellCtx } from './ProjectShell'
import { api, ftIn, unitsToFeet, type CadEntity, type CadFile, type Candidate, type ModelRegion } from '../lib/api'
import { Card, Pill } from '../components/ui'
import { PlanViewer, focusBox } from '../components/PlanViewer'

const KINDS: Record<string, string[]> = { WALL: ['WALL', 'BEAM', 'SHEAR_WALL'], BEAM: ['BEAM', 'WALL'], WINDOW: ['WINDOW', 'DOOR'], DOOR: ['DOOR', 'WINDOW'], ROOM: ['ROOM'] }
const KIND_LABEL: Record<string, string> = { WALL: 'Wall', BEAM: 'Beam / header', SHEAR_WALL: 'Shear wall', WINDOW: 'Window', DOOR: 'Door', ROOM: 'Room' }

/**
 * Step one. The system shows what it found on each model page; the person walks through
 * the elements, names them, and confirms. Objects are built from those names.
 */
export default function ModelReview() {
  const ctx = useOutletContext<ShellCtx>()
  const [files, setFiles] = useState<CadFile[]>([])
  const [fileId, setFileId] = useState<string>('')
  const [models, setModels] = useState<ModelRegion[]>([])
  const [insunits, setInsunits] = useState<number | null>(null)
  const [modelIx, setModelIx] = useState(0)
  const [entities, setEntities] = useState<CadEntity[]>([])
  const [cands, setCands] = useState<Candidate[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState('WALL')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [onlyPending, setOnlyPending] = useState(true)

  const k = unitsToFeet(insunits)
  const file = files.find((f) => f.id === fileId)
  const model = models[modelIx] ?? null

  useEffect(() => { (async () => {
    const f = (await api.get<{ files: CadFile[] }>(`/projects/${ctx.project.id}/files`)).files.filter((x) => x.status === 'PARSED')
    setFiles(f); if (!fileId && f[0]) setFileId(f[0].id)
  })() }, [ctx.project.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!fileId) return; (async () => {
    const m = await api.get<{ models: ModelRegion[]; insunits: number | null }>(`/files/${fileId}/models`)
    setModels(m.models); setInsunits(m.insunits); setModelIx(0)
  })() }, [fileId])
  const loadCands = async () => setCands((await api.get<{ candidates: Candidate[] }>(`/projects/${ctx.project.id}/candidates`)).candidates.filter((c) => c.file_id === fileId))
  useEffect(() => { if (!fileId) return; (async () => {
    const q = models.length ? `?model=${modelIx}` : ''
    const e = await api.get<{ entities: CadEntity[] }>(`/files/${fileId}/entities${q}`)
    setEntities(e.entities); await loadCands()
  })() }, [fileId, modelIx, models.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Candidates that sit on the current model page (values are in feet; model bbox is in drawing units).
  const onPage = useMemo(() => {
    const geo = cands.filter((c) => ['WALL', 'ROOM', 'WINDOW', 'DOOR', 'BEAM'].includes(c.kind))
    if (!model) return geo
    const b = { minX: model.bbox.minX * k, minY: model.bbox.minY * k, maxX: model.bbox.maxX * k, maxY: model.bbox.maxY * k }
    return geo.filter((c) => { const f = focusBox(c, 0); return f && f.minX >= b.minX - 1 && f.maxX <= b.maxX + 1 && f.minY >= b.minY - 1 && f.maxY <= b.maxY + 1 })
  }, [cands, model, k])
  const queue = useMemo(() => onPage.filter((c) => !onlyPending || c.action === 'PENDING'), [onPage, onlyPending])
  const active = onPage.find((c) => c.id === activeId) ?? null
  const pos = active ? queue.findIndex((c) => c.id === active.id) : -1

  const pick = (c: Candidate) => { setActiveId(c.id); setLabel(c.human_name ?? ''); setKind(c.kind); setErr('') }
  const step = (d: 1 | -1) => { if (!queue.length) return; const i = pos < 0 ? 0 : (pos + d + queue.length) % queue.length; pick(queue[i]) }
  const act = async (action: 'CONFIRM' | 'IGNORE') => {
    if (!active) return
    setBusy(true); setErr('')
    try {
      await api.post(`/candidates/${active.id}`, action === 'CONFIRM' ? { action, humanName: label.trim() || undefined, kind } : { action })
      await loadCands(); await ctx.reload()
      const next = queue.filter((c) => c.id !== active.id)
      const i = Math.min(Math.max(pos, 0), next.length - 1)
      if (next[i]) pick(next[i]); else setActiveId(null)
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  const done = onPage.filter((c) => c.action !== 'PENDING').length

  if (!files.length) return <Card title="01 · Model review"><div className="p-6 text-sm text-muted">No parsed drawing yet. Upload a DWG or DXF on the dashboard; conversion takes a minute or two.</div></Card>
  return (
    <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
      <Card title="What we see" right={<div className="flex items-center gap-2 text-xs">
        {files.length > 1 && <select className="input py-1" value={fileId} onChange={(e) => setFileId(e.target.value)}>{files.map((f) => <option key={f.id} value={f.id}>{f.filename}</option>)}</select>}
        <Link className="text-accent underline" to="list">table view</Link></div>}>
        {models.length > 1 && <div className="flex gap-1 px-3 pt-3 flex-wrap">{models.map((m) => <button key={m.ix} className={`btn py-1 px-3 ${m.ix === modelIx ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setModelIx(m.ix); setActiveId(null) }}>{m.title}</button>)}</div>}
        {models.length === 0 && file && <div className="px-4 pt-3 text-xs text-muted">No separate model pages were recognised in {file.filename}; showing the whole drawing.</div>}
        <div className="p-3" style={{ height: 560 }}>
          <PlanViewer entities={entities} k={k} candidates={onPage} activeId={activeId} onPick={pick} bbox={active ? focusBox(active) : model?.bbox ?? null} />
        </div>
        <div className="px-4 pb-3 text-xs text-muted">Grey is the drawing. Orange walls, green outlines, and dots are what the system found. Click any of them, or use Next to walk through. Fit resets the view.</div>
      </Card>

      <Card title={`Walk-through · ${done} of ${onPage.length} reviewed`} right={<label className="text-xs flex items-center gap-1"><input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} /> pending only</label>}>
        <div className="p-4 text-sm space-y-3">
          <div className="h-1.5 bg-line rounded"><div className="h-1.5 bg-ok rounded" style={{ width: `${onPage.length ? (100 * done) / onPage.length : 0}%` }} /></div>
          {!active ? <div className="text-muted">{queue.length ? <>Click an element on the drawing or <button className="text-accent underline" onClick={() => step(1)}>start with the first one</button>.</> : 'Everything on this page has been reviewed.'}</div> : <>
            <div className="flex items-center justify-between"><div className="text-xs text-muted">Item {pos + 1} of {queue.length}</div><Pill v={active.action} /></div>
            <div className="text-xs text-muted">{describe(active)}</div>
            <label className="block"><span className="block text-xs font-bold uppercase text-muted mb-1">What is it?</span>
              <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>{(KINDS[active.kind] ?? [active.kind]).map((x) => <option key={x} value={x}>{KIND_LABEL[x] ?? x}</option>)}</select></label>
            <label className="block"><span className="block text-xs font-bold uppercase text-muted mb-1">Label</span>
              <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={kind === 'ROOM' ? 'Kitchen' : kind === 'WALL' ? 'Kitchen north wall' : 'Window 3'} autoFocus onKeyDown={(e) => { if (e.key === 'Enter' && label.trim()) void act('CONFIRM') }} />
              <span className="text-xs text-muted">Suggested from nearby text: {active.human_name}. The label becomes the object's name; the tag is derived from it.</span></label>
            {err && <div className="text-xs text-bad">{err}</div>}
            <div className="flex gap-2 flex-wrap">
              <button className="btn btn-primary" disabled={busy || !label.trim() || active.action !== 'PENDING'} onClick={() => act('CONFIRM')}>Confirm and next</button>
              <button className="btn btn-ghost" disabled={busy || active.action !== 'PENDING'} onClick={() => act('IGNORE')}>Not an object</button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => step(-1)}>Previous</button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => step(1)}>Skip</button>
            </div>
          </>}
          <div className="text-xs text-muted pt-2 border-t border-line">Rooms and walls confirmed here become the object model. Openings attach to their wall. Schedules and notes are not read from the drawing; they are generated later from the model.</div>
        </div>
      </Card>
    </div>
  )
}

function describe(c: Candidate): string {
  const v = c.detected_value as Record<string, number> | null
  if (!v) return c.kind
  if (c.kind === 'WALL' || c.kind === 'BEAM') return `${c.kind === 'BEAM' ? 'Beam' : 'Wall'} · ${ftIn(v.length_ft)} long · ${c.method ?? ''}`
  if (c.kind === 'ROOM') return `Outline · ${Math.round(v.area_sf ?? 0)} sf · ${c.method ?? ''}`
  return `${c.kind === 'DOOR' ? 'Door' : 'Window'} block · ${c.method ?? ''}`
}
