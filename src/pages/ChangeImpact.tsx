import { type ReactElement, useEffect, useMemo, useState } from 'react'
import { useNavigate, useOutletContext, useParams } from 'react-router-dom'
import type { ShellCtx } from './ProjectShell'
import { api, ftIn, type Change, type Geometry, type Impact, type Obj } from '../lib/api'
import { Card, Field, Pill } from '../components/ui'
import { GeometryViewer } from '../components/GeometryViewer'
import { Building2, PenLine, FolderOpen, CheckCircle2, AlertTriangle, Info } from 'lucide-react'

export default function ChangeImpact() {
  const ctx = useOutletContext<ShellCtx>(); const { changeId } = useParams(); const nav = useNavigate()
  const [changes, setChanges] = useState<Change[]>([]); const [change, setChange] = useState<Change | null>(null); const [objects, setObjects] = useState<Obj[]>([]); const [sel, setSel] = useState<Impact | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set()); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState(''); const [script, setScript] = useState('')
  const loadList = async () => setChanges((await api.get<{ changes: Change[] }>(`/projects/${ctx.project.id}/changes`)).changes)
  const loadOne = async () => { if (!changeId) { setChange(null); return } const r = await api.get<{ change: Change }>(`/changes/${changeId}`); setChange(r.change); setSelected(new Set(r.change.impacts.filter((i) => i.status === 'PROPOSED' || i.status === 'APPROVED').map((i) => i.id))) }
  useEffect(() => { void loadList(); void api.get<{ objects: Obj[] }>(`/projects/${ctx.project.id}/objects`).then((r) => setObjects(r.objects)) }, [ctx.project.id])
  useEffect(() => { void loadOne() }, [changeId])
  const proposed = useMemo(() => { const m: Record<string, Geometry> = {}; for (const i of change?.impacts ?? []) if (i.target_kind === 'OBJECT' && i.target_id && i.proposed?.geometry) m[i.target_id] = i.proposed.geometry as Geometry; return m }, [change])
  const groups = useMemo(() => ({ STRUCTURAL: (change?.impacts ?? []).filter((i) => i.domain === 'STRUCTURAL'), DESIGN: (change?.impacts ?? []).filter((i) => i.domain === 'DESIGN'), DOCUMENTATION: (change?.impacts ?? []).filter((i) => i.domain === 'DOCUMENTATION') }), [change])
  const obj = change ? objects.find((o) => o.id === change.object_id) : null
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setMsg(''); try { await fn(); await loadOne(); await loadList(); await ctx.reload() } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) } }
  const approve = () => act(() => api.post(`/changes/${change!.id}/approve`, { roles: ['engineer', 'drafter'], decision: 'APPROVE', impactIds: [...selected] }))
  const reject = () => act(() => api.post(`/changes/${change!.id}/approve`, { roles: ['engineer', 'drafter'], decision: 'REJECT' }))
  const apply = () => act(async () => { const r = await api.post<{ jobs: { mode: string; jobId?: string }[]; calcs: { module: string; status: string }[] }>(`/changes/${change!.id}/apply`); setMsg(`Applied. Calcs: ${r.calcs.map((c) => `${c.module}=${c.status}`).join(', ') || 'none'}. Write-back: ${r.jobs.map((j) => j.mode).join(', ') || 'no drawing representations'}.`) })
  const reconcile = () => act(async () => { for (const j of change!.jobs.filter((x) => ['PENDING', 'INPROGRESS', 'QUEUED'].includes(x.status))) await api.post(`/jobs/${j.id}/poll`) })
  const preview = async () => setScript(await (await fetch(`/api/changes/${change!.id}/script`)).text())
  if (!changeId) return (
    <Card title="Design change → impact → approval → synchronized revision">
      <p className="px-4 py-3 text-sm text-muted border-b border-line">Start a change from an object in 00_OBJECT_MODEL (select a wall → "Analyze impact"). Every dependent calc and drawing representation is listed before anything is written.</p>
      {changes.length === 0 ? <div className="p-6 text-sm text-muted">No changes yet.</div> : <table className="tbl"><thead><tr><th>Object</th><th>Property</th><th>Current → proposed</th><th>Impacts</th><th>Eng</th><th>Draft</th><th>Reconcile</th><th>Status</th></tr></thead><tbody>
        {changes.map((c) => <tr key={c.id} className="cursor-pointer" onClick={() => nav(`/p/${ctx.project.id}/changes/${c.id}`)}><td className="font-bold">{c.object_name}</td><td>{c.property}</td><td>{fmtVal(c.property, c.current_value)} → {fmtVal(c.property, c.proposed_value)}</td><td>{c.impact_count}</td><td><Pill v={c.engineer_approval} /></td><td><Pill v={c.drafter_approval} /></td><td><Pill v={c.reconciliation ?? '—'} /></td><td><Pill v={c.status} /></td></tr>)}
      </tbody></table>}
    </Card>)
  if (!change) return <div className="text-sm text-muted">Loading change…</div>
  const toggle = (id: string) => { const s = new Set(selected); s.has(id) ? s.delete(id) : s.add(id); setSelected(s) }
  const Group = ({ k, icon, label, tone }: { k: keyof typeof groups; icon: ReactElement; label: string; tone: string }) => groups[k].length ? <div>
    <div className={`px-3 py-2 text-[12px] font-bold uppercase flex items-center gap-2 ${tone}`}>{icon}{label} <span className="font-normal normal-case">({groups[k].length})</span></div>
    {groups[k].map((i) => <div key={i.id} onClick={() => setSel(i)} className={`flex items-start gap-2 px-3 py-2 text-[13px] border-b border-[#eef1f4] cursor-pointer ${sel?.id === i.id ? 'bg-blue-50' : k === 'STRUCTURAL' ? 'bg-crit' : ''}`}>
      {change.status === 'PENDING' ? <input type="checkbox" className="mt-1" checked={selected.has(i.id)} onChange={() => toggle(i.id)} onClick={(e) => e.stopPropagation()} /> : <Pill v={i.status} />}
      {i.severity === 'CRITICAL' ? <AlertTriangle size={14} className="mt-0.5 text-bad" /> : i.severity === 'ATTENTION' ? <PenLine size={14} className="mt-0.5 text-warn" /> : i.status === 'VERIFIED' ? <CheckCircle2 size={14} className="mt-0.5 text-ok" /> : <Info size={14} className="mt-0.5 text-accent" />}
      <span className="flex-1"><b>{i.summary.split(':')[0]}</b>{i.summary.includes(':') ? `:${i.summary.split(':').slice(1).join(':')}` : ''}</span>
    </div>)}
  </div> : null
  return (
    <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr_320px] min-h-[calc(100vh-100px)]">
      <h1 className="lg:col-span-3 text-lg font-bold uppercase tracking-wide">Change impact: {obj?.humanName ?? change.object_id} · {change.property} {fmtVal(change.property, change.current_value)} → {fmtVal(change.property, change.proposed_value)} <Pill v={change.status} /></h1>
      <Card title="Project geometry & anchor viewer"><GeometryViewer objects={objects} selectedId={sel?.target_kind === 'OBJECT' ? sel.target_id : change.object_id} proposed={proposed} /></Card>
      <Card title={`Impact analysis`} className="flex flex-col">
        <div className="flex-1 overflow-auto">
          <Group k="STRUCTURAL" icon={<Building2 size={14} />} label="Structural (Critical)" tone="text-bad" />
          <Group k="DESIGN" icon={<PenLine size={14} />} label="Design (Attention required)" tone="text-warn" />
          <Group k="DOCUMENTATION" icon={<FolderOpen size={14} />} label={`Documentation (${groups.DOCUMENTATION.length} revisions proposed)`} tone="text-ink" />
        </div>
        <div className="p-3 border-t border-line grid gap-2">
          {msg && <div className="text-xs bg-blue-50 p-2 rounded">{msg}</div>}
          {change.status === 'PENDING' && <><button className="btn btn-ok" disabled={busy || !selected.size} onClick={approve}>Approve selected changes</button><button className="btn btn-bad" disabled={busy} onClick={reject}>Reject changes</button></>}
          {change.status === 'APPROVED' && <button className="btn btn-primary" disabled={busy} onClick={apply}>Apply approved revisions (model + calcs + write-back)</button>}
          {(change.status === 'APPLIED') && <button className="btn btn-ghost" disabled={busy} onClick={reconcile}>Reconcile drawings (check write-back)</button>}
          {(change.status === 'RECONCILED') && <div className="text-sm text-ok font-bold text-center">Verified project model == drawing set</div>}
          {(change.status === 'MISMATCH') && <div className="text-sm text-bad font-bold text-center">Mismatch remains — issue is blocked. See jobs below.</div>}
          {change.jobs.length > 0 && <div className="text-xs text-muted">{change.jobs.map((j) => <div key={j.id}>{j.kind} <Pill v={j.status} /> {j.error && <span className="text-bad">{j.error.slice(0, 200)}</span>}</div>)}</div>}
          <button className="text-xs text-accent text-left" onClick={preview}>Preview AutoCAD script</button>
          {script && <pre className="text-[10px] bg-[#f3f5f8] p-2 max-h-40 overflow-auto">{script}</pre>}
        </div>
      </Card>
      <Card title={sel ? `Inspector: ${sel.summary.split(':')[0]}` : 'Object inspector'}>{!sel ? <div className="p-4 text-sm text-muted">Select an impact.</div> : <div className="p-4 text-sm">
        <Field label="Target">{sel.target_kind} {sel.target_id && objects.find((o) => o.id === sel.target_id)?.semanticTag}</Field>
        <Field label="Severity"><Pill v={sel.severity} /> <Pill v={sel.status} /></Field>
        {sel.module && <Field label="Calc module">{sel.module}</Field>}
        <Field label="Rule / reason"><pre className="text-xs whitespace-pre-wrap">{JSON.stringify(sel.detail, null, 1)}</pre></Field>
        <Field label="Proposed revision"><pre className="text-xs whitespace-pre-wrap">{sel.proposed ? JSON.stringify(sel.proposed, null, 1) : 'No data change (informational)'}</pre></Field>
        <Field label="Approvals"><div>Engineer <Pill v={change.engineer_approval} /></div><div className="mt-1">Drafter <Pill v={change.drafter_approval} /></div></Field>
      </div>}</Card>
    </div>
  )
}
function fmtVal(prop: string, v: unknown) { return prop === 'length_ft' && typeof v === 'number' ? ftIn(v) : typeof v === 'object' ? 'geometry' : String(v ?? '—') }
