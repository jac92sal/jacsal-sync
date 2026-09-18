/**
 * jacsal-sync — the Worker behind sync.jacsalservices.com.
 *
 * Function first → verification second → design as the synchronized by-product.
 * Humans work with named building objects; the engine works with geometry.
 * Static assets never invoke this Worker; only /api/* is forced through it.
 */
import { connect } from 'cloudflare:sockets'
import { HttpError, badRequest, fail, forbidden, notFound, readJson, timingSafeEqual, unauthorized, uuid } from './lib/http'
import { all, insertStmt, one, run, updateStmt } from './lib/db'
import { confirmCandidate, createObject, getObject, listObjects, patchObject, type CandidateRow } from './lib/objects'
import { applyToModel, approveChange, getChange, listChanges, proposeChange } from './lib/impact'
import { getCalcRun, listCalcRuns, runCalc } from './lib/calcs'
import { issueGate } from './lib/gate'
import { getFile, pendingJobs, processJob, uploadFile, writeBack } from './lib/cad'
import type { CalcService } from '../services/calc/src/index'
import type { CadService } from '../services/cad/src/index'
import type { GisService } from '../services/gis/src/index'

const SESSION_COOKIE = 'jacsal_session'
interface AuthUser { id: string; email: string; name: string | null; emailVerified: boolean }
/** Typed view of the jacsal-auth RPC surface reached over the Service Binding. */
interface AuthService {
  requestCode(email: string): Promise<{ ok: boolean; error?: string }>
  verifyCode(email: string, code: string, meta?: { userAgent?: string; ip?: string }): Promise<{ ok: true; sessionToken: string; ttlSeconds: number; user: AuthUser } | { ok: false; error: string }>
  getSession(token: string): Promise<AuthUser | null>
  logout(token: string): Promise<void>
}
const auth = (env: Env) => env.AUTH as unknown as AuthService
const calc = (env: Env) => env.CALC as unknown as CalcService
const cad = (env: Env) => env.CAD as unknown as CadService
const gis = (env: Env) => env.GIS as unknown as GisService

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request)
    try {
      return await route(request, env, ctx, url)
    } catch (err) {
      if (err instanceof HttpError) return err.toResponse()
      console.error(JSON.stringify({ level: 'error', msg: 'unhandled', path: url.pathname, err: String(err instanceof Error ? err.stack ?? err.message : err) }))
      return fail(500, 'internal_error', err instanceof Error ? err.message : 'Something went wrong.')
    }
  },
  /** Poll Design Automation jobs the callback may have missed. */
  async scheduled(_event, env, ctx) {
    const jobs = await pendingJobs(env.DB)
    ctx.waitUntil(Promise.all(jobs.map((j) => processJob(env.DB, env.FILES, cad(env), j.id).catch((e) => console.error(JSON.stringify({ level: 'error', msg: 'job poll failed', job: j.id, err: String(e) }))))))
  },
} satisfies ExportedHandler<Env>

async function route(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const seg = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean)
  const method = request.method.toUpperCase()
  if (seg[0] === 'health') return ok({ service: 'jacsal-sync', time: new Date().toISOString() })
  if (seg[0] === 'auth') return authRoutes(request, env, method, seg.slice(1))
  if (seg[0] === 'cad' && seg[1] === 'callback' && seg[2]) return cadCallback(request, env, ctx, seg[2], url)
  // Temporary: echo selected request headers so service Workers can verify what their HTTP client sends.
  if (seg[0] === 'debug' && seg[1] === 'echo') {
    const pick = ['host', 'referer', 'user-agent', 'accept-encoding', 'connection', 'content-type', 'content-length', 'x-forwarded-proto', 'cf-connecting-ip']
    return ok({ method: request.method, headers: Object.fromEntries(pick.map((k) => [k, request.headers.get(k)])) })
  }

  const user = await currentUser(request, env)
  if (!user) throw unauthorized()
  const actor = user.email
  const db = env.DB

  // ---- temporary diagnostics for outbound connectivity (remove after Design Automation is verified)
  if (seg[0] === 'debug' && seg[1] === 'aps') {
    const probe = async (label: string, u: string, init?: RequestInit) => { try { const r = await fetch(u, init); const t = await r.text(); return { label, status: r.status, cfRay: r.headers.get('cf-ray'), server: r.headers.get('server'), body: t.slice(0, 200) } } catch (e) { return { label, error: String(e) } } }
    const results = await Promise.all([
      probe('token-post', 'https://developer.api.autodesk.com/authentication/v2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' }),
      probe('engines-get', 'https://developer.api.autodesk.com/da/us-east/v3/engines'),
      probe('oss-get', 'https://developer.api.autodesk.com/oss/v2/buckets'),
      probe('aps-root', 'https://developer.api.autodesk.com/'),
      probe('autodesk-www', 'https://www.autodesk.com/'),
      probe('arcgis-www', 'https://www.arcgis.com/sharing/rest/info?f=json'),
      probe('arcgis-elevation', 'https://elevation-api.arcgis.com/arcgis/rest/info?f=json'),
      probe('arcgis-static', 'https://static-maps-api.arcgis.com/arcgis/rest/info?f=json'),
      probe('dcgis', 'https://maps2.dcgis.dc.gov/dcgis/rest/services?f=json'),
      probe('cloudflare-www', 'https://www.cloudflare.com/'),
      probe('cf-docs', 'https://developers.cloudflare.com/'),
      probe('discord', 'https://discord.com/api/v10/gateway'),
      probe('openai', 'https://api.openai.com/'),
      probe('npmjs', 'https://registry.npmjs.org/-/ping'),
      probe('google', 'https://www.google.com/generate_204'),
      probe('github-api', 'https://api.github.com/'),
      probe('usgs', 'https://earthquake.usgs.gov/fdsnws/event/1/version'),
    ])
    const sock = async (host: string, path = '/') => {
      try {
        const s = connect({ hostname: host, port: 443 }, { secureTransport: 'on', allowHalfOpen: false })
        const w = s.writable.getWriter()
        await w.write(new TextEncoder().encode(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: jacsal-sync/diag\r\nAccept: */*\r\nConnection: close\r\n\r\n`))
        const r = s.readable.getReader(); let out = ''
        while (out.length < 600) { const { value, done } = await r.read(); if (done) break; out += new TextDecoder().decode(value) }
        await s.close().catch(() => undefined)
        return { host, ok: true, head: out.split('\r\n\r\n')[0].slice(0, 300) }
      } catch (e) { return { host, ok: false, error: String(e) } }
    }
    const sockets = await Promise.all([sock('api.github.com'), sock('elevation-api.arcgis.com', '/arcgis/rest/info?f=json'), sock('developer.api.autodesk.com', '/da/us-east/v3/engines'), sock('maps2.dcgis.dc.gov', '/dcgis/rest/services?f=json')])
    const viaCad = await cad(env).diagnose()
    const viaGis = await gis(env).diagnose().catch((e) => ({ error: String(e) }))
    return ok({ results, sockets, viaCad, viaGis })
  }

  // ---- calc catalogue (no project needed)
  if (seg[0] === 'calc' && seg[1] === 'modules') return ok({ modules: await calc(env).list() })
  if (seg[0] === 'calc' && seg[1] === 'benchmarks') return ok({ benchmarks: await calc(env).benchmarks() })
  if (seg[0] === 'calc' && seg[1] === 'runs' && seg[2]) { const r = await getCalcRun(db, seg[2]); if (!r) throw notFound(); return ok({ run: r }) }

  // ---- projects
  if (seg[0] === 'projects' && !seg[1]) {
    if (method === 'GET') return ok({ projects: await all(db, `SELECT p.*, (SELECT COUNT(*) FROM objects o WHERE o.project_id = p.id) AS object_count, (SELECT COUNT(*) FROM candidates c WHERE c.project_id = p.id AND c.action = 'PENDING') AS pending_candidates, (SELECT COUNT(*) FROM change_requests c WHERE c.project_id = p.id AND c.status IN ('PENDING','APPROVED','APPLIED','MISMATCH')) AS open_changes FROM projects p ORDER BY updated_at DESC`) })
    if (method === 'POST') {
      const b = await readJson<Record<string, unknown>>(request)
      if (!b.name || typeof b.name !== 'string') throw badRequest('name is required.')
      const id = uuid()
      const fields = ['address', 'city', 'county', 'jurisdiction', 'apn', 'prepared_for', 'prepared_by', 'project_no', 'code_path', 'risk_category', 'design_method', 'occupancy', 'stories', 'lat', 'lng']
      const row: Record<string, unknown> = { id, name: b.name, created_by: actor, status: 'SETUP' }
      for (const f of fields) if (b[f] !== undefined) row[f] = b[f]
      await insertStmt(db, 'projects', row).run()
      await createObject(db, id, { type: 'PROJECT', humanName: b.name, semanticTag: 'PROJECT' })
      const lvl = await createObject(db, id, { type: 'LEVEL', humanName: 'Level 01', semanticTag: 'LEVEL.01', parentId: (await one<{ id: string }>(db, 'SELECT id FROM objects WHERE project_id = ? AND type = ?', id, 'PROJECT'))?.id })
      await insertStmt(db, 'audit_log', { id: uuid(), project_id: id, actor, action: 'project.created', target_kind: 'PROJECT', target_id: id, detail: { level: lvl.id } }).run()
      return ok({ project: await one(db, 'SELECT * FROM projects WHERE id = ?', id) })
    }
  }
  if (seg[0] === 'projects' && seg[1]) {
    const pid = seg[1]
    const project = await one<Record<string, unknown>>(db, 'SELECT * FROM projects WHERE id = ?', pid)
    if (!project) throw notFound('Project not found.')
    const rest = seg.slice(2)
    if (!rest.length) {
      if (method === 'GET') return ok({ project, gate: await issueGate(db, pid), counts: await counts(db, pid) })
      if (method === 'PATCH') {
        const b = await readJson<Record<string, unknown>>(request)
        const allowed = ['name', 'address', 'city', 'county', 'jurisdiction', 'apn', 'prepared_for', 'prepared_by', 'project_no', 'code_path', 'risk_category', 'design_method', 'occupancy', 'stories', 'lat', 'lng', 'status']
        const patch: Record<string, unknown> = {}; for (const k of allowed) if (b[k] !== undefined) patch[k] = b[k]
        if (Object.keys(patch).length) await updateStmt(db, 'projects', pid, patch).run()
        return ok({ project: await one(db, 'SELECT * FROM projects WHERE id = ?', pid) })
      }
    }
    if (rest[0] === 'inputs') {
      if (method === 'GET') return ok({ inputs: await all(db, 'SELECT * FROM project_inputs WHERE project_id = ? ORDER BY key', pid) })
      if (method === 'PUT') {
        const b = await readJson<{ inputs: Record<string, { value: unknown; unit?: string; source?: string }> }>(request)
        const stmts = Object.entries(b.inputs ?? {}).map(([key, v]) => db.prepare(`INSERT INTO project_inputs (project_id, key, value, unit, source, status, updated_by) VALUES (?, ?, ?, ?, ?, 'READY', ?) ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value, unit = excluded.unit, source = excluded.source, status = 'READY', updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`).bind(pid, key, JSON.stringify(v.value), v.unit ?? null, v.source ?? 'USER', actor))
        if (stmts.length) await db.batch(stmts)
        return ok({ inputs: await all(db, 'SELECT * FROM project_inputs WHERE project_id = ? ORDER BY key', pid) })
      }
    }
    if (rest[0] === 'files') {
      if (method === 'GET') return ok({ files: await all(db, 'SELECT id, filename, kind, status, revision, entity_count, error, size, created_at, updated_at FROM cad_files WHERE project_id = ? ORDER BY created_at DESC', pid) })
      if (method === 'POST') {
        const filename = url.searchParams.get('filename') ?? request.headers.get('x-filename') ?? 'drawing.dxf'
        const bytes = await request.arrayBuffer()
        const file = await uploadFile(db, env.FILES, cad(env), pid, filename, bytes, actor, callbackBase(env, url))
        return ok({ file })
      }
    }
    if (rest[0] === 'candidates') {
      if (method === 'GET') return ok({ candidates: (await all<CandidateRow>(db, 'SELECT * FROM candidates WHERE project_id = ? ORDER BY CASE kind WHEN "FIELD" THEN 0 WHEN "ROOM" THEN 1 WHEN "WALL" THEN 2 ELSE 3 END, human_name', pid)).map(hydrateCandidate) })
      if (method === 'POST' && rest[1] === 'confirm-all') {
        const cands = await all<CandidateRow>(db, `SELECT * FROM candidates WHERE project_id = ? AND action = 'PENDING' AND confidence >= ? ORDER BY CASE kind WHEN "FIELD" THEN 0 WHEN "ROOM" THEN 1 WHEN "WALL" THEN 2 ELSE 3 END`, pid, Number(url.searchParams.get('minConfidence') ?? 0))
        let n = 0; for (const c of cands) { await confirmCandidate(db, c, actor); n++ }
        return ok({ confirmed: n })
      }
    }
    if (rest[0] === 'objects') {
      if (method === 'GET') return ok({ objects: await listObjects(db, pid), relations: await all(db, 'SELECT * FROM object_relations WHERE project_id = ?', pid), representations: await all(db, 'SELECT id, object_id, file_id, handle, rep_type, role, synced FROM representations WHERE project_id = ?', pid) })
      if (method === 'POST') { const b = await readJson<Parameters<typeof createObject>[2]>(request); return ok({ object: await createObject(db, pid, b) }) }
    }
    if (rest[0] === 'relations' && method === 'POST') {
      const b = await readJson<{ fromId: string; toId: string; kind: string; params?: Record<string, unknown> }>(request)
      if (!b.fromId || !b.toId || !b.kind) throw badRequest('fromId, toId and kind are required.')
      const id = uuid(); await insertStmt(db, 'object_relations', { id, project_id: pid, from_id: b.fromId, to_id: b.toId, kind: b.kind, params: b.params ?? {} }).run()
      return ok({ relation: await one(db, 'SELECT * FROM object_relations WHERE id = ?', id) })
    }
    if (rest[0] === 'changes') {
      if (method === 'GET') return ok({ changes: await listChanges(db, pid) })
      if (method === 'POST') { const b = await readJson<Parameters<typeof proposeChange>[2]>(request); return ok({ change: await proposeChange(db, pid, b, actor) }) }
    }
    if (rest[0] === 'calcs') {
      if (method === 'GET') return ok({ runs: await listCalcRuns(db, pid) })
      if (method === 'POST') { const b = await readJson<{ module: string; objectId?: string; inputs?: Record<string, unknown> }>(request); return ok({ run: await runCalc(db, calc(env), pid, b.module, b.objectId ?? null, b.inputs ?? {}, 'USER') }) }
    }
    if (rest[0] === 'gate' && method === 'GET') return ok({ gate: await issueGate(db, pid) })
    if (rest[0] === 'audit' && method === 'GET') return ok({ audit: await all(db, 'SELECT * FROM audit_log WHERE project_id = ? ORDER BY created_at DESC LIMIT 200', pid) })
    if (rest[0] === 'site' && method === 'GET') {
      const lat = Number(project.lat), lng = Number(project.lng)
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw badRequest('Project has no coordinates.')
      const g = gis(env)
      const [elevation, soil, zoning] = await Promise.all([g.elevationAt(lng, lat).catch((e) => ({ error: String(e) })), g.dcSoilAt(lng, lat).catch((e) => ({ error: String(e) })), g.dcZoningAt(lng, lat).catch((e) => ({ error: String(e) }))])
      return ok({ elevation, soil, zoning })
    }
  }

  // ---- candidates / objects / changes / files by id
  if (seg[0] === 'candidates' && seg[1] && method === 'POST') {
    const cand = await one<CandidateRow>(db, 'SELECT * FROM candidates WHERE id = ?', seg[1])
    if (!cand) throw notFound('Candidate not found.')
    const b = await readJson<{ action: 'CONFIRM' | 'EDIT' | 'IGNORE'; value?: unknown; humanName?: string; semanticTag?: string; anchorRule?: string }>(request)
    if (b.humanName || b.semanticTag || b.anchorRule) await run(db, 'UPDATE candidates SET human_name = COALESCE(?, human_name), semantic_tag = COALESCE(?, semantic_tag), anchor_rule = COALESCE(?, anchor_rule) WHERE id = ?', b.humanName ?? null, b.semanticTag ?? null, b.anchorRule ?? null, cand.id)
    const fresh = (await one<CandidateRow>(db, 'SELECT * FROM candidates WHERE id = ?', cand.id))!
    if (b.action === 'IGNORE') { await run(db, `UPDATE candidates SET action = 'IGNORE', confirmed_by = ?, confirmed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, actor, cand.id); return ok({ candidate: hydrateCandidate((await one<CandidateRow>(db, 'SELECT * FROM candidates WHERE id = ?', cand.id))!) }) }
    if (b.action !== 'CONFIRM' && b.action !== 'EDIT') throw badRequest('action must be CONFIRM, EDIT or IGNORE.')
    const object = await confirmCandidate(db, fresh, actor, b.action === 'EDIT' ? b.value : undefined)
    return ok({ candidate: hydrateCandidate((await one<CandidateRow>(db, 'SELECT * FROM candidates WHERE id = ?', cand.id))!), object })
  }
  if (seg[0] === 'objects' && seg[1]) {
    if (method === 'GET') return ok({ object: await getObject(db, seg[1]), representations: await all(db, 'SELECT * FROM representations WHERE object_id = ?', seg[1]), calcs: await all(db, 'SELECT id, module, status, utilization, created_at FROM calc_runs WHERE object_id = ? ORDER BY created_at DESC LIMIT 10', seg[1]) })
    if (method === 'PATCH') { const b = await readJson<Parameters<typeof patchObject>[2]>(request); return ok({ object: await patchObject(db, seg[1], b) }) }
  }
  if (seg[0] === 'changes' && seg[1]) {
    const id = seg[1]
    if (!seg[2] && method === 'GET') return ok({ change: await getChange(db, id) })
    if (seg[2] === 'approve' && method === 'POST') { const b = await readJson<{ roles?: ('engineer' | 'drafter')[]; decision?: 'APPROVE' | 'REJECT'; impactIds?: string[] }>(request); return ok({ change: await approveChange(db, id, b.roles ?? ['engineer', 'drafter'], b.decision ?? 'APPROVE', b.impactIds ?? null, actor) }) }
    if (seg[2] === 'apply' && method === 'POST') {
      const { projectId, opsByFile, calcJobs } = await applyToModel(db, id, actor)
      const calcResults = []
      for (const j of calcJobs) calcResults.push(await runCalc(db, calc(env), projectId, j.module, j.objectId, {}, `CHANGE:${id}`))
      const jobs = await writeBack(db, env.FILES, cad(env), projectId, id, opsByFile, callbackBase(env, url))
      return ok({ change: await getChange(db, id), calcs: calcResults.map((c) => ({ id: c.id, module: c.module, status: c.status, utilization: c.utilization })), jobs })
    }
    if (seg[2] === 'script' && method === 'GET') {
      const change = await getChange(db, id)
      const ops = (change.impacts as { target_kind: string; proposed: { op?: unknown } | null }[]).filter((i) => i.target_kind === 'REPRESENTATION' && i.proposed?.op).map((i) => i.proposed!.op)
      return new Response(await cad(env).previewScript(ops as never), { headers: { 'content-type': 'text/plain' } })
    }
  }
  if (seg[0] === 'files' && seg[1]) {
    const file = await getFile(db, seg[1])
    if (seg[2] === 'download' && method === 'GET') {
      const key = url.searchParams.get('format') === 'dxf' ? file.dxf_r2_key ?? file.r2_key : file.r2_key
      const obj = await env.FILES.get(key); if (!obj) throw notFound('File bytes not found.')
      return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream', 'content-disposition': `attachment; filename="${key.split('/').pop()}"` } })
    }
    if (seg[2] === 'entities' && method === 'GET') return ok({ file, entities: (await all(db, 'SELECT handle, layer, etype, geometry, attributes FROM cad_entities WHERE file_id = ? LIMIT 5000', file.id)).map((e) => ({ ...e, geometry: JSON.parse(e.geometry as string), attributes: JSON.parse(e.attributes as string) })) })
    if (seg[2] === 'jobs' && method === 'GET') return ok({ jobs: await all(db, 'SELECT * FROM cad_jobs WHERE file_id = ? ORDER BY created_at DESC', file.id) })
    if (!seg[2] && method === 'GET') return ok({ file })
  }
  if (seg[0] === 'jobs' && seg[1] && seg[2] === 'poll' && method === 'POST') return ok(await processJob(db, env.FILES, cad(env), seg[1]))
  throw notFound('Unknown endpoint.')
}

async function counts(db: D1Database, pid: string) {
  const r = await one<Record<string, number>>(db, `SELECT (SELECT COUNT(*) FROM objects WHERE project_id = ?) AS objects, (SELECT COUNT(*) FROM candidates WHERE project_id = ? AND action = 'PENDING') AS pending_candidates, (SELECT COUNT(*) FROM cad_files WHERE project_id = ?) AS files, (SELECT COUNT(*) FROM change_requests WHERE project_id = ? AND status IN ('PENDING','APPROVED','APPLIED','MISMATCH')) AS open_changes, (SELECT COUNT(*) FROM calc_runs WHERE project_id = ?) AS calc_runs`, pid, pid, pid, pid, pid)
  return r ?? {}
}
function hydrateCandidate(c: CandidateRow) {
  const j = (v: string | null) => { try { return v ? JSON.parse(v) : null } catch { return v } }
  return { ...c, detected_value: j(c.detected_value), edited_value: j(c.edited_value), confirmed_value: j(c.confirmed_value), source_handles: j(c.source_handles) ?? [], anchor_params: j(c.anchor_params) ?? {}, representations: j(c.representations) ?? [] }
}
const callbackBase = (env: Env, url: URL) => env.PUBLIC_BASE_URL || `${url.protocol}//${url.host}`

// ---- Design Automation onComplete callback: verify the shared secret, then process.
async function cadCallback(_request: Request, env: Env, ctx: ExecutionContext, jobId: string, url: URL): Promise<Response> {
  const secret = await env.SYNC_CALLBACK_SECRET.get()
  if (!timingSafeEqual(url.searchParams.get('s') ?? '', secret)) throw forbidden('Bad callback signature.')
  ctx.waitUntil(processJob(env.DB, env.FILES, cad(env), jobId).catch((e) => console.error(JSON.stringify({ level: 'error', msg: 'callback processing failed', job: jobId, err: String(e) }))))
  return ok({ accepted: true })
}

// ---- Auth (staff) — same passwordless flow as the other JacSal apps.
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie'); if (!header) return null
  for (const part of header.split(';')) { const [k, ...v] = part.trim().split('='); if (k === name) return decodeURIComponent(v.join('=')) }
  return null
}
async function currentUser(request: Request, env: Env): Promise<AuthUser | null> {
  const token = readCookie(request, SESSION_COOKIE); if (!token) return null
  return auth(env).getSession(token)
}
async function authRoutes(request: Request, env: Env, method: string, seg: string[]): Promise<Response> {
  if (seg[0] === 'me' && method === 'GET') { const user = await currentUser(request, env); return ok({ user }) }
  if (seg[0] === 'request-code' && method === 'POST') {
    const { email } = await readJson<{ email?: string }>(request)
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('Enter a valid email address.')
    const r = await auth(env).requestCode(email.toLowerCase())
    if (!r.ok) throw badRequest(r.error ?? 'Could not send a code.')
    return ok({})
  }
  if (seg[0] === 'verify' && method === 'POST') {
    const { email, code } = await readJson<{ email?: string; code?: string }>(request)
    if (!email || !code) throw badRequest('Email and code are required.')
    const r = await auth(env).verifyCode(email.toLowerCase(), code.trim(), { userAgent: request.headers.get('user-agent') ?? undefined, ip: request.headers.get('cf-connecting-ip') ?? undefined })
    if (!r.ok) throw unauthorized(r.error)
    return ok({ user: r.user }, { headers: { 'set-cookie': `${SESSION_COOKIE}=${encodeURIComponent(r.sessionToken)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${r.ttlSeconds}` } })
  }
  if (seg[0] === 'logout' && method === 'POST') {
    const token = readCookie(request, SESSION_COOKIE); if (token) await auth(env).logout(token)
    return ok({}, { headers: { 'set-cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` } })
  }
  throw notFound('Unknown auth endpoint.')
}
function ok(data: Record<string, unknown>, init?: ResponseInit): Response { return new Response(JSON.stringify({ ok: true, ...data }), { ...init, headers: { 'content-type': 'application/json; charset=utf-8', ...(init?.headers ?? {}) } }) }
