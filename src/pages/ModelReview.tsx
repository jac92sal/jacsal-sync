import { useEffect, useMemo, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import type { ShellCtx } from './ProjectShell'
import { api, ftIn, unitsToFeet, type AgentReview, type CadEntity, type CadFile, type Candidate, type ModelRegion, type Obj } from '../lib/api'
import { Card, Pill } from '../components/ui'
import { focusBox } from '../components/PlanViewer'
import { ApsViewer, type ViewerHandle } from '../components/ApsViewer'
import { useRef } from 'react'

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
  const [plans, setPlans] = useState<Obj[]>([])
  const [planName, setPlanName] = useState<Record<string, string>>({})
  const [opened, setOpened] = useState(false)
  const [viewer, setViewer] = useState<{ urn: string; status: string; progress: string; messages: string[] } | null>(null)
  const [viewerErr, setViewerErr] = useState('')
  const vh = useRef<ViewerHandle | null>(null)
  const [review, setReview] = useState<AgentReview | null>(null)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [reviewErr, setReviewErr] = useState('')
  const loadReview = async () => { if (!fileId) return; setReview((await api.get<{ review: AgentReview | null }>(`/files/${fileId}/review`)).review) }
  useEffect(() => { void loadReview() }, [fileId]) // eslint-disable-line react-hooks/exhaustive-deps
  const runReview = async () => {
    setReviewBusy(true); setReviewErr('')
    try { setReview((await api.post<{ review: AgentReview }>(`/files/${fileId}/review`)).review); await loadPlans(); await ctx.reload() } catch (e) { setReviewErr((e as Error).message) } finally { setReviewBusy(false) }
  }

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
  const loadPlans = async () => { const o = (await api.get<{ objects: Obj[] }>(`/projects/${ctx.project.id}/objects`)).objects.filter((x) => x.type === 'FLOOR_PLAN' && x.properties.fileId === fileId); setPlans(o); setPlanName(Object.fromEntries(o.map((x) => [x.id, x.humanName]))) }
  useEffect(() => { if (fileId) void loadPlans() }, [fileId, models.length]) // eslint-disable-line react-hooks/exhaustive-deps
  const planOf = (m: ModelRegion) => plans.find((p) => p.id === m.objectId || p.properties.modelIx === m.ix)
  const savePlan = async (p: Obj, patch: { humanName?: string; properties?: Record<string, unknown> }) => { await api.patch(`/objects/${p.id}`, patch); await loadPlans(); await ctx.reload() }
  const pageProgress = (m: ModelRegion) => {
    const b = { minX: m.bbox.minX * k, minY: m.bbox.minY * k, maxX: m.bbox.maxX * k, maxY: m.bbox.maxY * k }
    const on = cands.filter((c) => ['WALL', 'ROOM', 'WINDOW', 'DOOR', 'BEAM'].includes(c.kind)).filter((c) => { const f = focusBox(c, 0); return f && f.minX >= b.minX - 1 && f.maxX <= b.maxX + 1 && f.minY >= b.minY - 1 && f.maxY <= b.maxY + 1 })
    return { total: on.length, done: on.filter((c) => c.action !== 'PENDING').length }
  }
  useEffect(() => { if (!fileId) return; (async () => {
    const q = models.length ? `?model=${modelIx}` : ''
    const e = await api.get<{ entities: CadEntity[] }>(`/files/${fileId}/entities${q}`)
    setEntities(e.entities); await loadCands()
  })() }, [fileId, modelIx, models.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Autodesk Viewer: ask the server to translate the DWG (once), then poll until the manifest says success.
  useEffect(() => {
    if (!fileId) return
    let stop = false
    const tick = async () => {
      try {
        const v = await api.post<{ urn: string; status: string; progress: string; messages: string[] }>(`/files/${fileId}/viewer`)
        if (stop) return
        setViewer(v); setViewerErr('')
        if (v.status !== 'success' && v.status !== 'failed' && v.status !== 'timeout') setTimeout(() => { if (!stop) void tick() }, 5000)
      } catch (e) { if (!stop) setViewerErr((e as Error).message) }
    }
    void tick()
    return () => { stop = true }
  }, [fileId])
  const getToken = () => api.get<{ access_token: string; expires_in: number }>('/viewer/token')
  // Viewer → walk-through: selecting an entity in the drawing picks the candidate that references its handle.
  const onSelectHandles = (handles: string[]) => {
    const set = new Set(handles)
    const hit = cands.find((c) => c.source_handles.some((h) => set.has(h.toUpperCase())))
    if (hit) pick(hit)
  }
  // Walk-through → viewer: frame the active element, or the whole floor plan when nothing is active.
  useEffect(() => {
    if (!vh.current) return
    if (active) vh.current.focusHandles(active.source_handles)
    else if (entities.length) vh.current.fitHandles(entities.map((e) => e.handle))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, modelIx, entities.length, viewer?.status])

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
  const usable = models.filter((m) => planOf(m)?.properties.use !== false)
  if (!opened && models.length > 0) return (
    <Card title="Floor plans in this drawing" right={<div className="flex items-center gap-2 text-xs">{files.length > 1 && <select className="input py-1" value={fileId} onChange={(e) => setFileId(e.target.value)}>{files.map((f) => <option key={f.id} value={f.id}>{f.filename}</option>)}</select>}<Link className="text-accent underline" to="list">table view</Link></div>}>
      <div className="px-4 py-3 text-sm border-b border-line space-y-2">
        <p className="text-muted">Each floor plan came in as one unit. Claude reviews what the scan found and keeps only the basic floor plans; you can override any decision, then open a plan to break it down into walls, rooms, and openings. Elevations, sections, and schedules are built from these plans later.</p>
        <div className="flex items-center gap-3 flex-wrap">
          <button className="btn btn-primary py-1" disabled={reviewBusy} onClick={runReview}>{reviewBusy ? 'Claude is reviewing…' : review ? 'Ask Claude to review again' : 'Ask Claude to review'}</button>
          {review && <span className="text-xs text-muted">Reviewed {new Date(review.at).toLocaleString()} · {review.pages.filter((p) => p.keep).length} of {review.pages.length} kept · {review.model}</span>}
          {reviewErr && <span className="text-xs text-bad">{reviewErr}</span>}
        </div>
        {review && <p className="text-xs">{review.summary}{review.buildings.length ? <> Buildings: {review.buildings.join(', ')}.</> : null}</p>}
      </div>
      <div className="p-4 grid gap-3 md:grid-cols-2">
        {models.map((m) => { const p = planOf(m); const use = p?.properties.use !== false; const pr = pageProgress(m); return (
          <div key={m.ix} className={`border border-line rounded p-3 text-sm ${use ? '' : 'opacity-50'}`}>
            <div className="flex items-center justify-between gap-2">
              <input className="input font-bold" value={p ? planName[p.id] ?? p.humanName : m.title} disabled={!p} onChange={(e) => p && setPlanName({ ...planName, [p.id]: e.target.value })} onBlur={() => p && planName[p.id] && planName[p.id] !== p.humanName && savePlan(p, { humanName: planName[p.id] })} />
              <Pill v={use ? (pr.total && pr.done === pr.total ? 'DONE' : pr.done ? 'IN PROGRESS' : 'NEW') : 'SKIPPED'} />
            </div>
            <div className="text-xs text-muted mt-1">Labels seen: {m.labels.slice(0, 8).join(', ')}{m.labels.length > 8 ? '…' : ''}</div>
            {(() => { const a = p?.properties.agent as { kind?: string; state?: string; reason?: string; keep?: boolean } | undefined; return a ? <div className={`text-xs mt-1 ${a.keep ? 'text-ok' : 'text-muted'}`}>Claude: {a.keep ? 'keep' : 'set aside'} · {a.kind?.replace('_', ' ')}{a.state && a.state !== 'unknown' ? `, ${a.state}` : ''} · {a.reason}</div> : null })()}
            <div className="text-xs text-muted">{m.entityCount.toLocaleString()} drawing entities · {m.wallCount} wall-layer elements · {pr.done} of {pr.total} elements reviewed</div>
            <div className="flex gap-2 mt-2">
              <button className="btn btn-primary py-1" disabled={!use} onClick={() => { setModelIx(m.ix); setActiveId(null); setOpened(true) }}>Open and break down</button>
              {p && <button className="btn btn-ghost py-1" onClick={() => savePlan(p, { properties: { use: !use } })}>{use ? 'Not a plan' : 'Use as plan'}</button>}
            </div>
          </div>) })}
      </div>
      <div className="px-4 pb-4 text-xs text-muted">{usable.length} plan{usable.length === 1 ? '' : 's'} in use.</div>
    </Card>
  )
  return (
    <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
      <Card title="What we see" right={<div className="flex items-center gap-2 text-xs">
        {files.length > 1 && <select className="input py-1" value={fileId} onChange={(e) => setFileId(e.target.value)}>{files.map((f) => <option key={f.id} value={f.id}>{f.filename}</option>)}</select>}
        <Link className="text-accent underline" to="list">table view</Link></div>}>
        {models.length > 0 && <div className="flex gap-1 px-3 pt-3 flex-wrap items-center"><button className="btn btn-ghost py-1 px-3" onClick={() => setOpened(false)}>← All plans</button>{usable.map((m) => <button key={m.ix} className={`btn py-1 px-3 ${m.ix === modelIx ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setModelIx(m.ix); setActiveId(null) }}>{planOf(m)?.humanName ?? m.title}</button>)}</div>}
        {models.length === 0 && file && <div className="px-4 pt-3 text-xs text-muted">No separate model pages were recognised in {file.filename}; showing the whole drawing.</div>}
        <div className="p-3" style={{ height: 620 }}>
          {viewer?.status === 'success'
            ? <ApsViewer urn={viewer.urn} getToken={getToken} onSelectHandles={onSelectHandles} onReady={(h) => { vh.current = h; if (entities.length) h.fitHandles(entities.map((e) => e.handle)) }} />
            : <div className="h-full grid place-items-center text-sm text-muted text-center px-6">
                {viewerErr ? <span className="text-bad">{viewerErr}</span>
                  : viewer?.status === 'failed' || viewer?.status === 'timeout' ? <span className="text-bad">Autodesk could not translate this drawing ({viewer.status}). {viewer.messages.join(' ')} <button className="underline text-accent" onClick={() => api.post(`/files/${fileId}/viewer?force=1`).then(() => window.location.reload())}>Retry</button></span>
                  : <span>Preparing the AutoCAD view with Autodesk Model Derivative… {viewer?.progress ?? ''}<br /><span className="text-xs">First time takes one to three minutes for a drawing this size; after that it opens instantly.</span></span>}
              </div>}
        </div>
        <div className="px-4 pb-3 text-xs text-muted">This is AutoCAD's own rendering of the DWG (Autodesk Viewer). Click an entity to review it, or use Next to walk through; the view frames each element as you go. Layers, measure, and the sheet browser are in the viewer toolbar.</div>
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
