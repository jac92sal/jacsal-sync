import { useEffect, useState } from 'react'
import { useOutletContext, Link } from 'react-router-dom'
import type { ShellCtx } from './ProjectShell'
import { api, type CadFile, type Obj } from '../lib/api'
import { Card, Pill } from '../components/ui'
import { GeometryViewer } from '../components/GeometryViewer'

export default function Dashboard() {
  const ctx = useOutletContext<ShellCtx>()
  const [files, setFiles] = useState<CadFile[]>([]); const [objects, setObjects] = useState<Obj[]>([]); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState('')
  const [form, setForm] = useState({ address: ctx.project.address ?? '', jurisdiction: ctx.project.jurisdiction ?? '', code_path: ctx.project.code_path ?? 'CBC', risk_category: ctx.project.risk_category ?? 'II', design_method: ctx.project.design_method ?? 'ASD', stories: ctx.project.stories ?? 1, lat: ctx.project.lat ?? '', lng: ctx.project.lng ?? '' })
  const load = async () => { const [f, o] = await Promise.all([api.get<{ files: CadFile[] }>(`/projects/${ctx.project.id}/files`), api.get<{ objects: Obj[] }>(`/projects/${ctx.project.id}/objects`)]); setFiles(f.files); setObjects(o.objects) }
  useEffect(() => { void load() }, [ctx.project.id])
  const upload = async (file: File) => { setBusy(true); setMsg(''); try { const r = await api.upload<{ file: CadFile }>(`/projects/${ctx.project.id}/files`, await file.arrayBuffer(), file.name); setMsg(r.file.kind === 'DWG' ? 'DWG sent to AutoCAD Design Automation for conversion; detection runs when it completes (about a minute).' : 'DXF parsed. Review the detected objects in 00_CAD_CONFIRM.'); await load(); await ctx.reload() } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) } }
  const save = async () => { await api.patch(`/projects/${ctx.project.id}`, { ...form, stories: Number(form.stories) || null, lat: form.lat === '' ? null : Number(form.lat), lng: form.lng === '' ? null : Number(form.lng) }); await ctx.reload() }
  const poll = async (id: string) => { const j = await api.get<{ jobs: { id: string; status: string }[] }>(`/files/${id}/jobs`); for (const job of j.jobs.filter((x) => ['PENDING', 'INPROGRESS', 'QUEUED'].includes(x.status))) await api.post(`/jobs/${job.id}/poll`); await load(); await ctx.reload() }
  return (
    <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
      <h1 className="lg:col-span-2 text-lg font-bold uppercase tracking-wide">Project: {ctx.project.name}</h1>
      <Card title="Project geometry" className="min-h-[420px]"><GeometryViewer objects={objects} /></Card>
      <div className="grid gap-4 content-start">
        <Card title="Drawings" right={<label className="btn btn-primary cursor-pointer">{busy ? 'Uploading…' : 'Upload DWG / DXF'}<input type="file" accept=".dwg,.dxf" className="hidden" disabled={busy} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} /></label>}>
          {msg && <div className="p-3 text-sm bg-blue-50 border-b border-line">{msg}</div>}
          {files.length === 0 ? <div className="p-4 text-sm text-muted">No drawings yet.</div> : <table className="tbl"><thead><tr><th>File</th><th>Kind</th><th>Rev</th><th>Entities</th><th>Status</th><th></th></tr></thead><tbody>
            {files.map((f) => <tr key={f.id}><td>{f.filename}{f.error && <div className="text-xs text-bad">{f.error.slice(0, 160)}</div>}</td><td>{f.kind}</td><td>{f.revision}</td><td>{f.entity_count ?? '—'}</td><td><Pill v={f.status} /></td><td className="whitespace-nowrap"><a className="text-accent text-xs mr-2" href={`/api/files/${f.id}/download`}>DWG/DXF</a><a className="text-accent text-xs mr-2" href={`/api/files/${f.id}/download?format=dxf`}>DXF</a>{f.status === 'CONVERTING' && <button className="text-accent text-xs" onClick={() => poll(f.id)}>Check</button>}</td></tr>)}
          </tbody></table>}
        </Card>
        <Card title="Setup"><div className="p-4 grid grid-cols-2 gap-3 text-sm">
          {(['address', 'jurisdiction', 'code_path', 'risk_category', 'design_method', 'stories', 'lat', 'lng'] as const).map((k) => <label key={k} className="text-xs font-bold uppercase text-muted">{k.replace('_', ' ')}<input className="input mt-1 font-normal normal-case" value={String(form[k] ?? '')} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></label>)}
          <button className="btn btn-ghost col-span-2" onClick={save}>Save setup</button>
        </div></Card>
        <Card title="Next step"><div className="p-4 text-sm">
          {ctx.counts.files === 0 ? 'Upload a DWG or DXF plan.' : ctx.counts.pending_candidates > 0 ? <>Confirm {ctx.counts.pending_candidates} detected objects in <Link className="text-accent font-bold" to="cad">00_CAD_CONFIRM</Link>.</> : ctx.counts.objects <= 2 ? 'Confirm detected objects to build the model.' : <>Model ready. Propose a change in <Link className="text-accent font-bold" to="changes">00_CHANGE_IMPACT</Link> or run calculations.</>}
        </div></Card>
      </div>
    </div>
  )
}
