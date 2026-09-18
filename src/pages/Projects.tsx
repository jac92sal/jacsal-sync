import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type GeocodeResult, type Project } from '../lib/api'
import { Card, Pill } from '../components/ui'
import { useSession } from '../lib/store'

export default function Projects() {
  const { user, logout } = useSession()
  const [projects, setProjects] = useState<Project[]>([]); const [name, setName] = useState(''); const [address, setAddress] = useState(''); const [city, setCity] = useState(''); const [state, setState] = useState(''); const [zip, setZip] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false)
  const load = async () => setProjects((await api.get<{ projects: Project[] }>('/projects')).projects)
  useEffect(() => { void load() }, [])
  const canLocate = address.trim() && (zip.trim() || (city.trim() && state.trim()))
  const create = async () => {
    setErr(''); setBusy(true)
    try {
      const r = await api.post<{ project: Project; geocode: GeocodeResult | null }>('/projects', { name, address, city, state, zip, risk_category: 'II', design_method: 'ASD', stories: 1 })
      if (address.trim() && !r.geocode) setErr(`Project created, but the address could not be verified. Open it and check the address in Setup.`)
      setName(''); setAddress(''); setCity(''); setState(''); setZip(''); await load()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
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
          <label className="block text-xs font-bold uppercase text-muted mb-1">Street address</label><input className="input mb-3" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="1531 C Ave" autoComplete="street-address" />
          <div className="grid grid-cols-[2fr_1fr_1.2fr] gap-2 mb-1">
            <label className="block text-xs font-bold uppercase text-muted">City<input className="input mt-1 font-normal normal-case" value={city} onChange={(e) => setCity(e.target.value)} placeholder="National City" /></label>
            <label className="block text-xs font-bold uppercase text-muted">State<input className="input mt-1 font-normal normal-case" value={state} onChange={(e) => setState(e.target.value.toUpperCase())} placeholder="CA" maxLength={2} /></label>
            <label className="block text-xs font-bold uppercase text-muted">ZIP<input className="input mt-1 font-normal normal-case" value={zip} onChange={(e) => setZip(e.target.value)} placeholder="91950" inputMode="numeric" /></label>
          </div>
          <p className="text-xs text-muted mb-3">Street plus ZIP, or street plus city and state. The address is verified and jurisdiction, county, coordinates, and code path fill in automatically.</p>
          {err && <div className="text-sm text-bad mb-2">{err}</div>}
          <button className="btn btn-primary w-full" disabled={!name || busy || (!!address.trim() && !canLocate)} onClick={create}>{busy ? 'Verifying address…' : 'Create project'}</button>
          <p className="text-xs text-muted mt-3">Defaults: Risk Category II · ASD · 1 story. Code path follows the state (CBC in California). Edit on the dashboard.</p>
        </div></Card>
      </main>
    </div>
  )
}
