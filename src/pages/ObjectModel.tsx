import { type ReactElement, useEffect, useMemo, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import type { ShellCtx } from './ProjectShell'
import { api, ftIn, type Obj } from '../lib/api'
import { Card, Field, Pill } from '../components/ui'
import { GeometryViewer } from '../components/GeometryViewer'

const ANCHORS = ['KEEP_OFFSET_FROM_SOUTH_END', 'KEEP_OFFSET_FROM_NORTH_END', 'KEEP_OFFSET_FROM_WEST_END', 'KEEP_OFFSET_FROM_EAST_END', 'CENTER_ON_HOST', 'FIXED_WORLD_POSITION', 'STRETCH_WITH_HOST', 'ENGINEER_REVIEW_ON_HOST_CHANGE']

export default function ObjectModel() {
  const ctx = useOutletContext<ShellCtx>(); const nav = useNavigate()
  const [objects, setObjects] = useState<Obj[]>([]); const [reps, setReps] = useState<{ object_id: string; handle: string; rep_type: string; role: string; synced: number }[]>([]); const [sel, setSel] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ humanName: string; semanticTag: string; anchorRule: string; offset: string; props: string }>({ humanName: '', semanticTag: '', anchorRule: '', offset: '', props: '{}' })
  const [newLen, setNewLen] = useState(''); const [movingEnd, setMovingEnd] = useState<'start' | 'end'>('end')
  const load = async () => { const r = await api.get<{ objects: Obj[]; representations: typeof reps }>(`/projects/${ctx.project.id}/objects`); setObjects(r.objects); setReps(r.representations) }
  useEffect(() => { void load() }, [ctx.project.id])
  const o = objects.find((x) => x.id === sel) ?? null
  useEffect(() => { if (o) setDraft({ humanName: o.humanName, semanticTag: o.semanticTag, anchorRule: o.anchorRule ?? '', offset: o.anchorParams.offset_ft !== undefined ? String(o.anchorParams.offset_ft) : '', props: JSON.stringify(o.properties, null, 1) }) }, [o?.id])
  const byId = useMemo(() => new Map(objects.map((x) => [x.id, x])), [objects])
  const tree = useMemo(() => { const kids = new Map<string | null, Obj[]>(); for (const x of objects) { const k = x.hostId ?? x.parentId ?? null; kids.set(k, [...(kids.get(k) ?? []), x]) } return kids }, [objects])
  const save = async () => { await api.patch(`/objects/${o!.id}`, { humanName: draft.humanName, semanticTag: draft.semanticTag, anchorRule: draft.anchorRule || null, anchorParams: draft.offset ? { ...o!.anchorParams, offset_ft: Number(draft.offset) } : o!.anchorParams, properties: JSON.parse(draft.props || '{}') }); await load() }
  const propose = async () => { const r = await api.post<{ change: { id: string } }>(`/projects/${ctx.project.id}/changes`, { objectId: o!.id, property: 'length_ft', proposedValue: Number(newLen), movingEnd, reason: 'Proposed from object model' }); await ctx.reload(); nav(`/p/${ctx.project.id}/changes/${r.change.id}`) }
  const render = (parent: string | null, depth: number): ReactElement[] => (tree.get(parent) ?? []).flatMap((x) => [
    <div key={x.id} onClick={() => setSel(x.id)} className={`flex items-center gap-2 px-3 py-1.5 text-[13px] cursor-pointer border-b border-[#eef1f4] ${sel === x.id ? 'bg-blue-50' : 'hover:bg-[#f7f9fc]'}`} style={{ paddingLeft: 12 + depth * 16 }}>
      <span className="text-[10px] font-bold text-muted w-16">{x.type}</span><span className="font-bold flex-1">{x.humanName}</span><span className="font-mono text-[11px] text-muted hidden xl:inline">{x.semanticTag}</span><Pill v={x.verificationState} />
    </div>, ...render(x.id, depth + 1)])
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1.3fr_340px] min-h-[calc(100vh-100px)]">
      <Card title="Semantic object model">{objects.length ? render(null, 0) : <div className="p-4 text-sm text-muted">No objects yet. Confirm CAD candidates first.</div>}</Card>
      <Card title="Geometry & anchor viewer"><GeometryViewer objects={objects} selectedId={sel} onSelect={setSel} /></Card>
      <Card title={o ? `Object inspector: ${o.humanName}` : 'Object inspector'}>{!o ? <div className="p-4 text-sm text-muted">Select an object.</div> : <div className="p-4 text-sm">
        <Field label="Permanent ID"><span className="font-mono text-xs">{o.id}</span></Field>
        <Field label="Human identity"><input className="input" value={draft.humanName} onChange={(e) => setDraft({ ...draft, humanName: e.target.value })} /></Field>
        <Field label="Semantic tag"><input className="input font-mono" value={draft.semanticTag} onChange={(e) => setDraft({ ...draft, semanticTag: e.target.value })} /></Field>
        <Field label="Function">{o.function ?? '—'}</Field>
        <Field label="Host / parent">{o.hostId ? byId.get(o.hostId)?.humanName : o.parentId ? byId.get(o.parentId)?.humanName : '—'}</Field>
        <Field label="Geometry (ft)">{o.geometry.x1 !== undefined ? `(${o.geometry.x1}, ${o.geometry.y1}) → (${o.geometry.x2}, ${o.geometry.y2}) · ${ftIn(o.derived.length_ft as number)}` : o.geometry.x !== undefined ? `(${o.geometry.x}, ${o.geometry.y})` : o.geometry.points ? `${o.geometry.points.length} vertices · ${o.derived.area_sf} sf` : '—'}</Field>
        {(o.type === 'WINDOW' || o.type === 'DOOR') && <><Field label="Anchor rule"><select className="input" value={draft.anchorRule} onChange={(e) => setDraft({ ...draft, anchorRule: e.target.value })}><option value="">—</option>{ANCHORS.map((a) => <option key={a}>{a}</option>)}</select></Field><Field label="Offset (ft)"><input className="input" value={draft.offset} onChange={(e) => setDraft({ ...draft, offset: e.target.value })} /></Field></>}
        <Field label="Properties (JSON)"><textarea className="input font-mono text-xs h-24" value={draft.props} onChange={(e) => setDraft({ ...draft, props: e.target.value })} /></Field>
        <Field label="States"><Pill v={o.verificationState} /> <Pill v={o.approvalState} /> <span className="text-xs text-muted">rev {o.revision}</span></Field>
        <Field label="CAD representations">{reps.filter((r) => r.object_id === o.id).map((r) => <div key={r.handle} className="text-xs font-mono">{r.rep_type} {r.handle} <span className="text-muted">{r.role}</span> {r.synced ? '' : <span className="text-bad">unsynced</span>}</div>)}{!reps.some((r) => r.object_id === o.id) && <span className="text-xs text-muted">none</span>}</Field>
        <button className="btn btn-ghost w-full mb-4" onClick={save}>Save object</button>
        {(o.type === 'WALL' || o.type === 'BEAM' || o.type === 'SHEAR_WALL') && <div className="border-t border-line pt-3">
          <div className="text-xs font-bold uppercase text-muted mb-2">Propose a length change</div>
          <div className="flex gap-2 mb-2"><input className="input" placeholder="New length (ft), e.g. 15.5" value={newLen} onChange={(e) => setNewLen(e.target.value)} /><select className="input w-32" value={movingEnd} onChange={(e) => setMovingEnd(e.target.value as 'start' | 'end')}><option value="end">end moves</option><option value="start">start moves</option></select></div>
          <button className="btn btn-primary w-full" disabled={!newLen} onClick={propose}>Analyze impact</button>
        </div>}
      </div>}</Card>
    </div>
  )
}
