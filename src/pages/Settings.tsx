import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { Card, Pill } from '../components/ui'
import { useSession } from '../lib/store'

type KeyMeta = { itemId: string; itemUrl: string; username: string; expiresAt: string; privileges: string[]; referrers: string[]; createdAt: string; createdBy: string }
type KeyStatus = { source: 'app' | 'secrets-store' | 'oauth' | 'none'; meta: KeyMeta | null; referer: string; daysLeft: number | null }
type Privilege = { id: string; label: string; default: boolean }
type TestResult = { ok: true; elevationM: number; source: string } | { ok: false; error: string; source: string }

const SOURCE_LABEL: Record<KeyStatus['source'], string> = {
  app: 'Key created here',
  'secrets-store': 'Key pasted into the Secrets Store (may be temporary)',
  oauth: 'OAuth app credentials (no location-service privileges)',
  none: 'No credential',
}

export default function Settings() {
  const { user, logout } = useSession()
  const [status, setStatus] = useState<KeyStatus | null>(null)
  const [privs, setPrivs] = useState<Privilege[]>([])
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [expiresDays, setExpiresDays] = useState(365)
  const [extraReferrer, setExtraReferrer] = useState('https://adufeasibility.jacsalservices.com')
  const [busy, setBusy] = useState<'create' | 'test' | 'clear' | null>(null)
  const [err, setErr] = useState('')
  const [test, setTest] = useState<TestResult | null>(null)
  const [done, setDone] = useState<KeyMeta | null>(null)

  const load = async () => {
    const r = await api.get<{ status: KeyStatus; privileges: Privilege[] }>('/settings/arcgis')
    setStatus(r.status); setPrivs(r.privileges)
    setChosen((prev) => (prev.size ? prev : new Set(r.privileges.filter((p) => p.default).map((p) => p.id))))
  }
  useEffect(() => { void load() }, [])

  const toggle = (id: string) => setChosen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const create = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setDone(null); setTest(null); setBusy('create')
    try {
      const r = await api.post<{ meta: KeyMeta; test: TestResult }>('/settings/arcgis/key', {
        username, password, expiresDays, privileges: [...chosen], referrers: extraReferrer.trim() ? [extraReferrer.trim()] : [],
      })
      setPassword('')            // the field is cleared as soon as the request returns; the server never stored it
      setDone(r.meta); setTest(r.test); await load()
    } catch (ex) { setErr((ex as Error).message) } finally { setBusy(null) }
  }
  const runTest = async () => { setBusy('test'); setErr(''); try { setTest((await api.post<{ test: TestResult }>('/settings/arcgis/test')).test) } catch (ex) { setErr((ex as Error).message) } finally { setBusy(null) } }
  const clear = async () => {
    if (!confirm('Forget the key created here? The app falls back to the Secrets Store key or OAuth. The credential item stays in ArcGIS until you delete it there.')) return
    setBusy('clear'); setErr('')
    try { await fetch('/api/settings/arcgis/key', { method: 'DELETE', credentials: 'same-origin' }); setDone(null); setTest(null); await load() } catch (ex) { setErr((ex as Error).message) } finally { setBusy(null) }
  }

  const fmt = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

  return (
    <div className="h-full flex flex-col">
      <header className="bg-side text-white px-5 py-3 flex items-center justify-between">
        <div><Link to="/" className="font-bold tracking-wider">ENGINEERING SYNC</Link><span className="text-xs text-gray-400 ml-3">Settings</span></div>
        <div className="text-xs text-gray-300">{user?.email} · <button className="underline" onClick={logout}>Sign out</button></div>
      </header>
      <main className="p-6 grid gap-6 md:grid-cols-[1fr_1fr] max-w-6xl w-full mx-auto">
        <Card title="ArcGIS location services" right={status && <Pill v={status.source === 'app' ? 'ACTIVE' : status.source === 'none' ? 'MISSING' : 'FALLBACK'} />}>
          <div className="p-4 text-sm space-y-3">
            {!status ? <div className="text-muted">Loading…</div> : <>
              <div><span className="text-muted">In use:</span> {SOURCE_LABEL[status.source]}</div>
              {status.meta && <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <dt className="text-muted">Expires</dt><dd>{fmt(status.meta.expiresAt)}{status.daysLeft !== null && <span className={status.daysLeft < 30 ? 'text-bad ml-2' : 'text-muted ml-2'}>({status.daysLeft} days left)</span>}</dd>
                <dt className="text-muted">ArcGIS user</dt><dd>{status.meta.username}</dd>
                <dt className="text-muted">Referrers</dt><dd>{status.meta.referrers.join(', ')}</dd>
                <dt className="text-muted">Privileges</dt><dd>{status.meta.privileges.map((p) => p.replace('premium:user:', '')).join(', ')}</dd>
                <dt className="text-muted">Credential item</dt><dd><a className="text-accent underline" href={status.meta.itemUrl} target="_blank" rel="noreferrer">open in ArcGIS</a></dd>
                <dt className="text-muted">Created</dt><dd>{fmt(status.meta.createdAt)} by {status.meta.createdBy}</dd>
              </dl>}
              <div className="text-xs text-muted">Every ArcGIS call is sent with referrer <code>{status.referer}</code>, so the key is useless from anywhere else.</div>
              <div className="flex gap-2 pt-1">
                <button className="btn" disabled={busy !== null} onClick={runTest}>{busy === 'test' ? 'Testing…' : 'Test elevation call'}</button>
                {status.source === 'app' && <button className="btn" disabled={busy !== null} onClick={clear}>Forget this key</button>}
              </div>
              {test && (test.ok
                ? <div className="text-ok">Elevation service answered: {test.elevationM.toFixed(1)} m at the White House (via {test.source}).</div>
                : <div className="text-bad">Elevation call failed: {test.error}</div>)}
            </>}
          </div>
        </Card>

        <Card title="Create a long-lived API key">
          <form className="p-4 text-sm space-y-3" onSubmit={create} autoComplete="off">
            <p className="text-muted">Sign in with your ArcGIS account once. The server uses the password for a single sign-in request to create an API key credential in your ArcGIS content, stores only the resulting key (encrypted), and discards the password. Nothing is written to logs.</p>
            <div className="grid grid-cols-2 gap-3">
              <label className="block"><span className="block text-xs font-bold uppercase text-muted mb-1">ArcGIS username</span><input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required /></label>
              <label className="block"><span className="block text-xs font-bold uppercase text-muted mb-1">Password</span><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
            </div>
            <label className="block"><span className="block text-xs font-bold uppercase text-muted mb-1">Valid for</span>
              <select className="input" value={expiresDays} onChange={(e) => setExpiresDays(Number(e.target.value))}>
                <option value={30}>30 days</option><option value={90}>90 days</option><option value={180}>180 days</option><option value={365}>1 year (maximum)</option>
              </select></label>
            <label className="block"><span className="block text-xs font-bold uppercase text-muted mb-1">Extra allowed referrer (optional)</span><input className="input" value={extraReferrer} onChange={(e) => setExtraReferrer(e.target.value)} placeholder="https://another.jacsalservices.com" /><span className="text-xs text-muted">{status?.referer ? new URL(status.referer).origin : 'This app'} is always included.</span></label>
            <fieldset><legend className="text-xs font-bold uppercase text-muted mb-1">Privileges</legend>
              {privs.map((p) => <label key={p.id} className="flex items-center gap-2 py-0.5"><input type="checkbox" checked={chosen.has(p.id)} onChange={() => toggle(p.id)} /><span>{p.label}</span></label>)}
              <span className="text-xs text-muted">If ArcGIS rejects a privilege your account lacks, the error names it; untick it and retry.</span>
            </fieldset>
            {err && <div className="text-sm text-bad whitespace-pre-wrap">{err}</div>}
            {done && <div className="text-ok">Key created and stored. It expires {fmt(done.expiresAt)}. The password was not saved.</div>}
            <button className="btn btn-primary w-full" type="submit" disabled={busy !== null || !username || !password || chosen.size === 0}>{busy === 'create' ? 'Signing in and creating key…' : 'Create key'}</button>
          </form>
        </Card>
      </main>
    </div>
  )
}
