import { useCallback, useEffect, useState } from 'react'
import { NavLink, Outlet, useParams, Link } from 'react-router-dom'
import { api, type Project, type GateRow } from '../lib/api'
import { useSession } from '../lib/store'
import { LayoutDashboard, FileCheck2, Boxes, GitCompareArrows, Calculator, ShieldCheck, Bell, HelpCircle } from 'lucide-react'

export interface ShellCtx { project: Project; gate: { rows: GateRow[]; overall: string }; counts: Record<string, number>; reload: () => Promise<void> }

export default function ProjectShell() {
  const { id } = useParams(); const { user } = useSession()
  const [ctx, setCtx] = useState<ShellCtx | null>(null)
  const reload = useCallback(async () => { const r = await api.get<{ project: Project; gate: ShellCtx['gate']; counts: Record<string, number> }>(`/projects/${id}`); setCtx({ project: r.project, gate: r.gate, counts: r.counts, reload }) }, [id])
  useEffect(() => { void reload() }, [reload])
  const nav = [
    { to: '', label: 'Dashboard', icon: LayoutDashboard, end: true }, { to: 'cad', label: '01_MODEL_REVIEW', icon: FileCheck2, badge: ctx?.counts.pending_candidates },
    { to: 'objects', label: '00_OBJECT_MODEL', icon: Boxes, badge: ctx?.counts.objects }, { to: 'changes', label: '00_CHANGE_IMPACT', icon: GitCompareArrows, badge: ctx?.counts.open_changes },
    { to: 'calcs', label: 'CALCULATIONS', icon: Calculator, badge: ctx?.counts.calc_runs }, { to: 'gate', label: '00_ISSUE_GATE', icon: ShieldCheck },
  ]
  return (
    <div className="h-full grid grid-rows-[48px_1fr] grid-cols-[216px_1fr]">
      <header className="col-span-2 bg-side text-white px-4 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2"><span className="text-lg font-bold tracking-widest">ENGINEERING SYNC</span><span className="text-[10px] text-gray-400 tracking-widest">JACSAL PLATFORM</span></Link>
        <div className="flex items-center gap-4 text-gray-300"><Bell size={16} /><HelpCircle size={16} /><span className="w-7 h-7 rounded-full bg-gray-500 grid place-items-center text-xs font-bold text-white">{user?.email?.[0]?.toUpperCase()}</span></div>
      </header>
      <aside className="bg-side-2 text-gray-200 py-2">
        {nav.map((n) => <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `flex items-center gap-3 px-4 py-3 text-[13px] font-bold tracking-wide border-l-4 ${isActive ? 'bg-side border-accent text-white' : 'border-transparent hover:bg-side/60'}`}><n.icon size={16} /><span className="flex-1">{n.label}</span>{n.badge ? <span className="text-[10px] bg-gray-600 rounded-full px-2">{n.badge}</span> : null}</NavLink>)}
        {ctx && <div className="mt-6 px-4 text-[11px] text-gray-400"><div className="uppercase tracking-wider mb-1">Issue status</div><div className={`font-bold ${ctx.gate.overall === 'FAIL' ? 'text-red-300' : ctx.gate.overall === 'PENDING' ? 'text-gray-200' : 'text-green-300'}`}>{ctx.gate.overall}</div></div>}
      </aside>
      <main className="min-h-0 overflow-auto p-4">{ctx ? <Outlet context={ctx} /> : <div className="text-sm text-muted">Loading project…</div>}</main>
    </div>
  )
}
