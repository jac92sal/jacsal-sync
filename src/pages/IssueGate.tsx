import { useOutletContext } from 'react-router-dom'
import type { ShellCtx } from './ProjectShell'
import { Card, Pill } from '../components/ui'

export default function IssueGate() {
  const ctx = useOutletContext<ShellCtx>()
  return (
    <Card title="Project issue gate — function → verification → design sync → approval" right={<button className="btn btn-ghost" onClick={ctx.reload}>Refresh</button>}>
      <p className="px-4 py-3 text-sm text-muted border-b border-line">A project is not ready because a drawing looks complete. It is ready when each required working object is defined, verified, synchronized to the set, and approved.</p>
      <table className="tbl"><thead><tr><th>Domain</th><th>Function</th><th>Verification</th><th>Design sync</th><th>Approval</th><th>Gate</th><th>Where</th></tr></thead><tbody>
        {ctx.gate.rows.map((r) => <tr key={r.domain}><td className="font-bold">{r.domain}</td><td>{r.functionState}</td><td>{r.verificationState}</td><td>{r.designSync}</td><td>{r.approval}</td><td><Pill v={r.gate} /></td><td className="text-xs text-muted">{r.location}</td></tr>)}
      </tbody></table>
      <div className="p-4 flex items-center gap-3 border-t border-line"><span className="text-sm font-bold uppercase">Overall project issue status</span><Pill v={ctx.gate.overall} /><span className="text-xs text-muted">No issue until all applicable gates are cleared.</span></div>
    </Card>
  )
}
