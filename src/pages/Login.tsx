import { useState } from 'react'
import { api } from '../lib/api'
import { useSession } from '../lib/store'

export default function Login() {
  const { refresh } = useSession()
  const [email, setEmail] = useState(''); const [code, setCode] = useState(''); const [sent, setSent] = useState(false); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false)
  const send = async () => { setBusy(true); setErr(''); try { await api.post('/auth/request-code', { email }); setSent(true) } catch (e) { setErr((e as Error).message) } finally { setBusy(false) } }
  const verify = async () => { setBusy(true); setErr(''); try { await api.post('/auth/verify', { email, code }); await refresh() } catch (e) { setErr((e as Error).message) } finally { setBusy(false) } }
  return (
    <div className="h-full grid place-items-center bg-side">
      <div className="card w-[380px] p-6">
        <div className="text-xs font-bold tracking-widest text-muted">JACSAL</div>
        <h1 className="text-xl font-bold mt-1 mb-4">Engineering Sync</h1>
        <p className="text-sm text-muted mb-4">Function first. Verification second. Design is the synchronized by-product.</p>
        <label className="block text-xs font-bold uppercase text-muted mb-1">Work email</label>
        <input className="input mb-3" value={email} onChange={(e) => setEmail(e.target.value)} disabled={sent} placeholder="you@jacsalservices.com" />
        {sent && <><label className="block text-xs font-bold uppercase text-muted mb-1">Code from your email</label><input className="input mb-3" value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code" /></>}
        {err && <div className="text-sm text-bad mb-3">{err}</div>}
        {!sent ? <button className="btn btn-primary w-full" onClick={send} disabled={busy || !email}>Send sign-in code</button> : <button className="btn btn-primary w-full" onClick={verify} disabled={busy || !code}>Sign in</button>}
      </div>
    </div>
  )
}
