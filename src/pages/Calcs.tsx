import { useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { ShellCtx } from './ProjectShell'
import { api, type Obj } from '../lib/api'
import { Card, Pill } from '../components/ui'

interface ModuleMeta { id: string; title: string; sheet: string; inputs: { key: string; label: string; unit?: string; required?: boolean; source: string; default?: unknown; options?: string[] }[] }
interface Run { id: string; module: string; object_id: string | null; object_name: string | null; status: string; utilization: number | null; triggered_by: string; created_at: string }
interface RunDetail { id: string; module: string; status: string; inputs: Record<string, unknown>; outputs: { results: Record<string, { value: unknown; unit?: string; equation?: string; checkStatus?: string | null }>; checks: { name: string; demand: number | null; capacity: number | null; unit?: string; ratio: number | null; status: string; note?: string }[]; gates: { control: string; status: string; reason: string }[]; missing: string[] }; trace: { step: string; expression: string; value: unknown; unit?: string }[] }

export default function Calcs() {
  const ctx = useOutletContext<ShellCtx>()
  const [modules, setModules] = useState<ModuleMeta[]>([]); const [runs, setRuns] = useState<Run[]>([]); const [objects, setObjects] = useState<Obj[]>([]); const [detail, setDetail] = useState<RunDetail | null>(null)
  const [mod, setMod] = useState('wood-beam'); const [objectId, setObjectId] = useState(''); const [overrides, setOverrides] = useState<Record<string, string>>({}); const [inputs, setInputs] = useState<Record<string, unknown>>({}); const [busy, setBusy] = useState(false); const [err, setErr] = useState('')
  const load = async () => { const [m, r, o, i] = await Promise.all([api.get<{ modules: ModuleMeta[] }>('/calc/modules'), api.get<{ runs: Run[] }>(`/projects/${ctx.project.id}/calcs`), api.get<{ objects: Obj[] }>(`/projects/${ctx.project.id}/objects`), api.get<{ inputs: { key: string; value: string }[] }>(`/projects/${ctx.project.id}/inputs`)]); setModules(m.modules); setRuns(r.runs); setObjects(o.objects); setInputs(Object.fromEntries(i.inputs.map((x) => [x.key, safe(x.value)]))) }
  useEffect(() => { void load() }, [ctx.project.id])
  const m = modules.find((x) => x.id === mod)
  const run = async () => { setBusy(true); setErr(''); try { const body = { module: mod, objectId: objectId || undefined, inputs: Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== '').map(([k, v]) => [k, isNaN(Number(v)) ? v : Number(v)])) }; const r = await api.post<{ run: { id: string } }>(`/projects/${ctx.project.id}/calcs`, body); await load(); await open(r.run.id); await ctx.reload() } catch (e) { setErr((e as Error).message) } finally { setBusy(false) } }
  const open = async (id: string) => setDetail((await api.get<{ run: RunDetail }>(`/calc/runs/${id}`)).run)
  const saveInputs = async () => { const payload: Record<string, { value: unknown }> = {}; for (const [k, v] of Object.entries(overrides)) if (v !== '') payload[k] = { value: isNaN(Number(v)) ? v : Number(v) }; await api.put(`/projects/${ctx.project.id}/inputs`, { inputs: payload }); setOverrides({}); await load() }
  return (
    <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
      <div className="grid gap-4 content-start">
        <Card title="Run a calculation"><div className="p-4 text-sm grid gap-2">
          <select className="input" value={mod} onChange={(e) => { setMod(e.target.value); setOverrides({}) }}>{modules.map((x) => <option key={x.id} value={x.id}>{x.sheet} — {x.title}</option>)}</select>
          <select className="input" value={objectId} onChange={(e) => setObjectId(e.target.value)}><option value="">No object (project-level)</option>{objects.filter((o) => !['PROJECT', 'LEVEL', 'ROOM'].includes(o.type)).map((o) => <option key={o.id} value={o.id}>{o.type} · {o.humanName}</option>)}</select>
          <div className="text-xs text-muted">Inputs come from the project schema (01_INPUTS), then the object's properties, then what you type here. Blank = use stored value.</div>
          <div className="max-h-[50vh] overflow-auto border border-line rounded">{m?.inputs.map((i) => <label key={i.key} className="flex items-center gap-2 px-2 py-1 border-b border-[#eef1f4] text-xs"><span className="w-40 shrink-0">{i.label}{i.required && <span className="text-bad">*</span>}<div className="text-[10px] text-muted">{i.source}</div></span>{i.options ? <select className="input py-1" value={overrides[i.key] ?? ''} onChange={(e) => setOverrides({ ...overrides, [i.key]: e.target.value })}><option value="">{String(inputs[i.key] ?? i.default ?? '')}</option>{i.options.map((o) => <option key={o}>{o}</option>)}</select> : <input className="input py-1" placeholder={String(inputs[i.key] ?? i.default ?? '')} value={overrides[i.key] ?? ''} onChange={(e) => setOverrides({ ...overrides, [i.key]: e.target.value })} />}<span className="w-10 text-muted">{i.unit}</span></label>)}</div>
          {err && <div className="text-bad text-xs">{err}</div>}
          <div className="flex gap-2"><button className="btn btn-primary flex-1" disabled={busy} onClick={run}>Run</button><button className="btn btn-ghost" disabled={busy || !Object.values(overrides).some(Boolean)} onClick={saveInputs}>Save typed values to project</button></div>
        </div></Card>
        <Card title="Runs">{runs.length === 0 ? <div className="p-4 text-sm text-muted">No runs yet.</div> : <table className="tbl"><tbody>{runs.map((r) => <tr key={r.id} className="cursor-pointer" onClick={() => open(r.id)}><td className="font-bold">{r.module}</td><td>{r.object_name ?? '—'}</td><td>{r.utilization !== null ? r.utilization.toFixed(2) : '—'}</td><td><Pill v={r.status} /></td></tr>)}</tbody></table>}</Card>
      </div>
      <Card title={detail ? `${detail.module} — ${detail.status}` : 'Result'}>{!detail ? <div className="p-4 text-sm text-muted">Run or select a calculation.</div> : <div className="p-4 text-sm grid gap-4">
        {detail.outputs.missing.length > 0 && <div className="bg-amber-50 border border-amber-200 p-2 text-xs">Missing inputs: {detail.outputs.missing.join(', ')}</div>}
        <div><div className="text-xs font-bold uppercase text-muted mb-1">Strength & serviceability checks</div><table className="tbl"><thead><tr><th>Check</th><th>Demand</th><th>Capacity / limit</th><th>D/C</th><th>Status</th><th>Note</th></tr></thead><tbody>{detail.outputs.checks.map((c) => <tr key={c.name}><td className="font-bold">{c.name}</td><td>{num(c.demand)} {c.unit}</td><td>{num(c.capacity)} {c.unit}</td><td>{num(c.ratio)}</td><td><Pill v={c.status} /></td><td className="text-xs text-muted">{c.note}</td></tr>)}</tbody></table></div>
        <div><div className="text-xs font-bold uppercase text-muted mb-1">Results (with independent checks)</div><table className="tbl"><thead><tr><th>Quantity</th><th>Value</th><th>Equation</th><th>Check</th></tr></thead><tbody>{Object.entries(detail.outputs.results).map(([k, v]) => <tr key={k}><td className="font-mono text-xs">{k}</td><td>{typeof v.value === 'number' ? num(v.value) : String(v.value ?? '—')} {v.unit}</td><td className="text-xs">{v.equation}</td><td>{v.checkStatus ? <Pill v={v.checkStatus} /> : ''}</td></tr>)}</tbody></table></div>
        <div><div className="text-xs font-bold uppercase text-muted mb-1">Scope / engineering review gates</div>{detail.outputs.gates.map((g) => <div key={g.control} className="text-xs py-1 border-b border-[#eef1f4]"><Pill v={g.status} /> <b>{g.control}</b> — {g.reason}</div>)}</div>
        <details><summary className="text-xs font-bold uppercase text-muted cursor-pointer">Longhand trace & inputs</summary><table className="tbl mt-2"><tbody>{detail.trace.map((t, i) => <tr key={i}><td className="font-mono text-xs">{t.step}</td><td className="text-xs">{t.expression}</td><td>{typeof t.value === 'number' ? num(t.value) : String(t.value ?? '')} {t.unit}</td></tr>)}</tbody></table><pre className="text-[10px] mt-2 bg-[#f3f5f8] p-2">{JSON.stringify(detail.inputs, null, 1)}</pre></details>
      </div>}</Card>
    </div>
  )
}
const num = (v: number | null | undefined) => (v === null || v === undefined ? '—' : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4))
const safe = (v: string) => { try { return JSON.parse(v) } catch { return v } }
