import { useEffect, useState } from 'react'
import { useOutletContext, Link } from 'react-router-dom'
import type { ShellCtx } from './ProjectShell'
import { api, CODE_PATHS, DESIGN_METHODS, RISK_CATEGORIES, type CadFile, type GeocodeResult, type Obj } from '../lib/api'
import { Card, Pill } from '../components/ui'
import { GeometryViewer } from '../components/GeometryViewer'

export default function Dashboard() {
  const ctx = useOutletContext<ShellCtx>()
  const [files, setFiles] = useState<CadFile[]>([]); const [objects, setObjects] = useState<Obj[]>([]); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState('')
  const fromProject = (p: typeof ctx.project) => ({ address: p.address ?? '', city: p.city ?? '', state: p.state ?? '', zip: p.zip ?? '', county: p.county ?? '', jurisdiction: p.jurisdiction ?? '', code_path: p.code_path ?? 'CBC', risk_category: p.risk_category ?? 'II', design_method: p.design_method ?? 'ASD', stories: p.stories ?? 1, lat: p.lat ?? '', lng: p.lng ?? '' })
  const [form, setForm] = useState(fromProject(ctx.project))
  const [verifyMsg, setVerifyMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [verifying, setVerifying] = useState(false)
  const canVerify = !!form.address.trim() && (!!form.zip.trim() || (!!form.city.trim() && !!form.state.trim()))
  const load = async () => { const [f, o] = await Promise.all([api.get<{ files: CadFile[] }>(`/projects/${ctx.project.id}/files`), api.get<{ objects: Obj[] }>(`/projects/${ctx.project.id}/objects`)]); setFiles(f.files); setObjects(o.objects) }
  useEffect(() => { void load() }, [ctx.project.id])
  const upload = async (file: File) => { setBusy(true); setMsg(''); try { const r = await api.upload<{ file: CadFile }>(`/projects/${ctx.project.id}/files`, await file.arrayBuffer(), file.name); setMsg(r.file.kind === 'DWG' ? 'DWG sent to AutoCAD Design Automation. This page checks progress every few seconds; large drawings take one to three minutes to convert and parse.' : 'DXF parsed. Review the detected objects in 00_CAD_CONFIRM.'); await load(); await ctx.reload() } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) } }
  const payload = () => ({ ...form, stories: Number(form.stories) || null, lat: form.lat === '' ? null : Number(form.lat), lng: form.lng === '' ? null : Number(form.lng) })
  const save = async () => { setVerifyMsg(null); await api.patch(`/projects/${ctx.project.id}`, payload()); await ctx.reload() }
  // Verify: geocode the typed address, then save the filled-in fields in one round trip.
  const verify = async () => {
    setVerifying(true); setVerifyMsg(null)
    try {
      const r = await api.patch<{ project: typeof ctx.project; geocode: GeocodeResult | null }>(`/projects/${ctx.project.id}`, { ...payload(), verify: true })
      setForm(fromProject(r.project))
      setVerifyMsg(r.geocode ? { ok: true, text: `Verified: ${r.geocode.matchedAddress} · ${r.geocode.jurisdiction}${r.geocode.county ? `, ${r.geocode.county}` : ''} (${r.geocode.source === 'census' ? 'US Census' : 'ArcGIS'})` } : { ok: false, text: 'No match.' })
      await ctx.reload()
    } catch (e) { setVerifyMsg({ ok: false, text: (e as Error).message }) } finally { setVerifying(false) }
  }
  const remove = async (f: CadFile) => {
    if (!confirm(`Remove ${f.filename}? This deletes the drawing, its revisions, and every element and object built from it. Confirmed labels on this drawing are lost.`)) return
    setBusy(true); setMsg('')
    try { const r = await api.delete<{ removed: { objects: number; candidates: number } }>(`/files/${f.id}`); setMsg(`Removed ${f.filename}: ${r.removed.objects} objects and ${r.removed.candidates} detected elements deleted. Upload the new drawing.`); await load(); await ctx.reload() } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
  }
  const rescan = async (id: string) => { setBusy(true); setMsg(''); try { const r = await api.post<{ entities: number; candidates: number }>(`/files/${id}/rescan`); setMsg(`Re-detected: ${r.entities} entities, ${r.candidates} new candidates to confirm in 00_CAD_CONFIRM.`); await load(); await ctx.reload() } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) } }
  const poll = async (id: string) => { const j = await api.get<{ jobs: { id: string; status: string }[] }>(`/files/${id}/jobs`); for (const job of j.jobs.filter((x) => ['PENDING', 'INPROGRESS', 'QUEUED'].includes(x.status))) await api.post(`/jobs/${job.id}/poll`); await load(); await ctx.reload() }
  // While a DWG is converting, keep checking Design Automation so the row advances without a manual refresh.
  const converting = files.filter((f) => f.status === 'CONVERTING').map((f) => f.id).join(',')
  useEffect(() => {
    if (!converting) return
    let stopped = false
    const tick = async () => { for (const id of converting.split(',')) { try { await poll(id) } catch { /* next tick */ } } }
    const t = setInterval(() => { if (!stopped) void tick() }, 8000)
    return () => { stopped = true; clearInterval(t) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [converting])
  return (
    <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
      <h1 className="lg:col-span-2 text-lg font-bold uppercase tracking-wide">Project: {ctx.project.name}</h1>
      <Card title="Project geometry" className="min-h-[420px]"><GeometryViewer objects={objects} /></Card>
      <div className="grid gap-4 content-start">
        <Card title="Drawings" right={<label className="btn btn-primary cursor-pointer">{busy ? 'Uploading…' : 'Upload DWG / DXF'}<input type="file" accept=".dwg,.dxf" className="hidden" disabled={busy} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} /></label>}>
          {msg && <div className="p-3 text-sm bg-blue-50 border-b border-line">{msg}</div>}
          {files.length === 0 ? <div className="p-4 text-sm text-muted">No drawings yet.</div> : <table className="tbl"><thead><tr><th>File</th><th>Kind</th><th>Rev</th><th>Entities</th><th>Status</th><th></th></tr></thead><tbody>
            {files.map((f) => <tr key={f.id}><td>{f.filename}{f.error && <div className="text-xs text-bad">{f.error.slice(0, 160)}</div>}</td><td>{f.kind}</td><td>{f.revision}</td><td>{f.entity_count ?? '—'}</td><td><Pill v={f.status} /></td><td className="whitespace-nowrap"><a className="text-accent text-xs mr-2" href={`/api/files/${f.id}/download`}>DWG/DXF</a><a className="text-accent text-xs mr-2" href={`/api/files/${f.id}/download?format=dxf`}>DXF</a>{f.status === 'CONVERTING' && <span className="text-xs text-muted">converting… <button className="text-accent" onClick={() => poll(f.id)}>check now</button></span>}{f.status === 'PARSED' && <button className="text-accent text-xs mr-2" title="Run object detection again on the stored drawing" onClick={() => rescan(f.id)}>Re-detect</button>}<button className="text-bad text-xs" disabled={busy} onClick={() => remove(f)}>Remove</button></td></tr>)}
          </tbody></table>}
        </Card>
        <Card title="Setup"><div className="p-4 grid grid-cols-2 gap-3 text-sm">
          <label className="col-span-2 text-xs font-bold uppercase text-muted">Street address<input className="input mt-1 font-normal normal-case" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="1531 C Ave" /></label>
          <label className="text-xs font-bold uppercase text-muted">City<input className="input mt-1 font-normal normal-case" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs font-bold uppercase text-muted">State<input className="input mt-1 font-normal normal-case" value={form.state} maxLength={2} onChange={(e) => setForm({ ...form, state: e.target.value.toUpperCase() })} /></label>
            <label className="text-xs font-bold uppercase text-muted">ZIP<input className="input mt-1 font-normal normal-case" value={form.zip} inputMode="numeric" onChange={(e) => setForm({ ...form, zip: e.target.value })} /></label>
          </div>
          <button className="btn btn-primary col-span-2" disabled={!canVerify || verifying} onClick={verify}>{verifying ? 'Verifying…' : 'Verify address and fill in'}</button>
          {verifyMsg && <div className={`col-span-2 text-xs ${verifyMsg.ok ? 'text-ok' : 'text-bad'}`}>{verifyMsg.text}</div>}
          {ctx.project.matched_address && !verifyMsg && <div className="col-span-2 text-xs text-muted">Verified as {ctx.project.matched_address}</div>}
          <label className="text-xs font-bold uppercase text-muted">Jurisdiction<input className="input mt-1 font-normal normal-case" value={form.jurisdiction} onChange={(e) => setForm({ ...form, jurisdiction: e.target.value })} placeholder="filled by verification" /></label>
          <label className="text-xs font-bold uppercase text-muted">County<input className="input mt-1 font-normal normal-case" value={form.county} onChange={(e) => setForm({ ...form, county: e.target.value })} placeholder="filled by verification" /></label>
          <label className="text-xs font-bold uppercase text-muted">Code path<select className="input mt-1 font-normal normal-case" value={form.code_path} onChange={(e) => setForm({ ...form, code_path: e.target.value })}>{CODE_PATHS.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
          <label className="text-xs font-bold uppercase text-muted">Risk category<select className="input mt-1 font-normal normal-case" value={form.risk_category} onChange={(e) => setForm({ ...form, risk_category: e.target.value })}>{RISK_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
          <label className="text-xs font-bold uppercase text-muted">Design method<select className="input mt-1 font-normal normal-case" value={form.design_method} onChange={(e) => setForm({ ...form, design_method: e.target.value })}>{DESIGN_METHODS.map((c) => <option key={c} value={c}>{c === 'ASD' ? 'ASD (allowable stress)' : 'LRFD (load and resistance factor)'}</option>)}</select></label>
          <label className="text-xs font-bold uppercase text-muted">Stories<input className="input mt-1 font-normal normal-case" type="number" min={1} max={6} value={String(form.stories)} onChange={(e) => setForm({ ...form, stories: Number(e.target.value) })} /></label>
          <label className="text-xs font-bold uppercase text-muted">Lat<input className="input mt-1 font-normal normal-case" value={String(form.lat)} onChange={(e) => setForm({ ...form, lat: e.target.value })} placeholder="filled by verification" /></label>
          <label className="text-xs font-bold uppercase text-muted">Lng<input className="input mt-1 font-normal normal-case" value={String(form.lng)} onChange={(e) => setForm({ ...form, lng: e.target.value })} placeholder="filled by verification" /></label>
          <button className="btn btn-ghost col-span-2" onClick={save}>Save setup</button>
        </div></Card>
        <Card title="Next step"><div className="p-4 text-sm">
          {ctx.counts.files === 0 ? 'Upload a DWG or DXF plan.' : ctx.counts.pending_candidates > 0 ? <>Confirm {ctx.counts.pending_candidates} detected objects in <Link className="text-accent font-bold" to="cad">00_CAD_CONFIRM</Link>.</> : ctx.counts.objects <= 2 ? 'Confirm detected objects to build the model.' : <>Model ready. Propose a change in <Link className="text-accent font-bold" to="changes">00_CHANGE_IMPACT</Link> or run calculations.</>}
        </div></Card>
      </div>
    </div>
  )
}
