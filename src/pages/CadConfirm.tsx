import { useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { ShellCtx } from './ProjectShell'
import { api, ftIn, type Candidate } from '../lib/api'
import { Card, Pill } from '../components/ui'

export default function CadConfirm() {
  const ctx = useOutletContext<ShellCtx>()
  const [cands, setCands] = useState<Candidate[]>([]); const [filter, setFilter] = useState<'PENDING' | 'ALL'>('PENDING'); const [edit, setEdit] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false)
  const load = async () => setCands((await api.get<{ candidates: Candidate[] }>(`/projects/${ctx.project.id}/candidates`)).candidates)
  useEffect(() => { void load() }, [ctx.project.id])
  const act = async (c: Candidate, action: 'CONFIRM' | 'EDIT' | 'IGNORE') => {
    setBusy(true)
    try {
      const body: Record<string, unknown> = { action }
      if (action === 'EDIT') { const raw = edit[c.id]; body.value = c.kind === 'FIELD' ? Number(raw) : JSON.parse(raw) }
      await api.post(`/candidates/${c.id}`, body); await load(); await ctx.reload()
    } catch (e) { alert((e as Error).message) } finally { setBusy(false) }
  }
  const confirmAll = async () => { setBusy(true); try { await api.post(`/projects/${ctx.project.id}/candidates/confirm-all?minConfidence=0.6`); await load(); await ctx.reload() } finally { setBusy(false) } }
  const shown = cands.filter((c) => filter === 'ALL' || c.action === 'PENDING')
  return (
    <Card title="CAD / model detection → human confirmation queue" right={<div className="flex gap-2"><button className="btn btn-ghost" onClick={() => setFilter(filter === 'ALL' ? 'PENDING' : 'ALL')}>{filter === 'ALL' ? 'Show pending' : 'Show all'}</button><button className="btn btn-ok" disabled={busy || !cands.some((c) => c.action === 'PENDING')} onClick={confirmAll}>Confirm all ≥ 60%</button></div>}>
      <p className="px-4 py-3 text-sm text-muted border-b border-line">Detection is a proposal. Nothing becomes authoritative until you confirm it. Confirming a window confirms its wall and room first.</p>
      {shown.length === 0 ? <div className="p-6 text-sm text-muted">Nothing to confirm.</div> :
        <table className="tbl"><thead><tr><th>Human object / field</th><th>Semantic tag</th><th>Detected value</th><th>Source</th><th>Confidence</th><th>Action</th></tr></thead><tbody>
          {shown.map((c) => <tr key={c.id}>
            <td><div className="font-bold">{c.human_name}</div><div className="text-xs text-muted">{c.kind}{c.anchor_rule && <> · {c.anchor_rule} {c.anchor_params.offset_ft !== undefined && `(${ftIn(Number(c.anchor_params.offset_ft))})`}</>}</div></td>
            <td className="font-mono text-xs">{c.semantic_tag}</td>
            <td className="text-xs">{describe(c)}{c.action === 'PENDING' && <input className="input mt-1" placeholder={c.kind === 'FIELD' ? 'Edit value' : 'Edit geometry JSON'} value={edit[c.id] ?? ''} onChange={(e) => setEdit({ ...edit, [c.id]: e.target.value })} />}</td>
            <td className="text-xs">{c.method}<div className="text-muted">{(c.source_handles ?? []).slice(0, 4).join(', ')}</div></td>
            <td>{c.confidence !== null ? `${Math.round(c.confidence * 100)}%` : '—'}</td>
            <td className="whitespace-nowrap">{c.action === 'PENDING' ? <div className="flex gap-1"><button className="btn btn-ok px-2 py-1" disabled={busy} onClick={() => act(c, 'CONFIRM')}>Confirm</button><button className="btn btn-primary px-2 py-1" disabled={busy || !edit[c.id]} onClick={() => act(c, 'EDIT')}>Edit</button><button className="btn btn-ghost px-2 py-1" disabled={busy} onClick={() => act(c, 'IGNORE')}>Ignore</button></div> : <Pill v={c.action} />}</td>
          </tr>)}
        </tbody></table>}
    </Card>
  )
}
function describe(c: Candidate): string {
  const v = c.detected_value as Record<string, unknown> | number | string | null
  if (v === null || v === undefined) return '—'
  if (typeof v !== 'object') return `${v}${c.unit ? ` ${c.unit}` : ''}`
  if ('length_ft' in v) return `${ftIn(v.length_ft as number)} (${(v.x1 as number).toFixed(2)},${(v.y1 as number).toFixed(2)}) → (${(v.x2 as number).toFixed(2)},${(v.y2 as number).toFixed(2)})`
  if ('area_sf' in v) return `${(v.area_sf as number).toFixed(0)} sf, ${(v.points as unknown[]).length} vertices`
  if ('x' in v) return `(${(v.x as number).toFixed(2)}, ${(v.y as number).toFixed(2)})${v.block ? ` block ${v.block}` : ''}`
  return JSON.stringify(v).slice(0, 80)
}
