import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type Project } from '../lib/api'
import { Card, Pill } from '../components/ui'
import { useSession } from '../lib/store'

export default function Projects() {
  const { user, logout } = useSession()
  const [projects, setProjects] = useState<Project[]>([]); const [name, setName] = useState(''); const [address, setAddress] = useState(''); const [err, setErr] = useState('')
  const load = async () => setProjects((await api.get<{ projects: Project[] }>('/projects')).projects)
  useEffect(() => { void load() }, [])
  const create = async () => { setErr(''); try { await api.post('/projects', { name, address, code_path: 'CBC', risk_category: 'II', design_method: 'ASD' }); setName(''); setAddress(''); await load() } catch (e) { setErr((e as Error).message) } }
  return (
    <div className="h-full flex flex-col">
      <header className="bg-side text-white px-5 py-3 flex items-center justify-between"><div><span className="font-bold tracking-wider">ENGINEERING SYNC</span><span className="text-xs text-gray-400 ml-3">JacSal Services</span></div><div className="text-xs text-gray-300"><Link className="underline mr-3" to="/settings">Settings</Link>{user?.email} · <button className="underline" onClick={logout}>Sign out</button></div></header>
      <main className="p-6 grid gap-6 md:grid-cols-[2fr_1fr] max-w-6xl w-full mx-auto">
        <Card title="Projects">
          {projects.length === 0 ? <div className="p-6 text-sm text-muted">No projects yet. Create one on the right, then upload a DWG or DXF.</div> :
            <table className="tbl"><thead><tr><th>Project</th><th>Address</th><th>Objects</th><th>To confirm</th><th>Open changes</th><th>Status</th></tr></thead><tbody>
              {projects.map((p) => <tr key={p.id}><td><Link className="font-bold text-accent" to={`/p/${p.id}`}>{p.name}</Link></td><td>{p.address ?? '—'}</td><td>{p.object_count}</td><td>{p.pending_candidates}</td><td>{p.open_changes}</td><td><Pill v={p.status} /></td></tr>)}
            </tbody></table>}
        </Card>
        <Card title="New project"><div className="p-4">
          <label className="block text-xs font-bold uppercase text-muted mb-1">Name</label><input className="input mb-3" value={name} onChange={(e) => setName(e.target.value)} placeholder="Smith Residence ADU" />
          <label className="block text-xs font-bold uppercase text-muted mb-1">Address</label><input className="input mb-3" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="123 Main St, Washington, DC" />
          {err && <div className="text-sm text-bad mb-2">{err}</div>}
          <button className="btn btn-primary w-full" disabled={!name} onClick={create}>Create project</button>
          <p className="text-xs text-muted mt-3">Defaults: CBC · Risk Category II · ASD. Edit on the dashboard.</p>
        </div></Card>
      </main>
    </div>
  )
}
