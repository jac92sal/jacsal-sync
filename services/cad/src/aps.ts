/** Autodesk Platform Services: 2-legged auth, OSS storage, Design Automation v3 (AutoCAD). */

const AUTH = 'https://developer.api.autodesk.com/authentication/v2/token'
const OSS = 'https://developer.api.autodesk.com/oss/v2'
const DA = 'https://developer.api.autodesk.com/da/us-east/v3'
const SCOPES = 'code:all data:read data:write data:create bucket:create bucket:read'

export interface ApsCreds { clientId: string; clientSecret: string }
export type WorkItemStatus = 'pending' | 'inprogress' | 'success' | 'failedInstructions' | 'failedUpload' | 'failedDownload' | 'failedLimitProcessingTime' | 'cancelled' | string

let cached: { token: string; exp: number } | null = null

/** Optional relay for the Autodesk API host (Workers → developer.api.autodesk.com fails with 525). Set once per isolate. */
let relay: { url: string; key: string } | null = null
export function configureRelay(r: { url: string; key: string } | null): void { relay = r }
import { AsyncLocalStorage } from 'node:async_hooks'
/** A headless-browser page parked on the Autodesk API origin. Calls made with page.evaluate(fetch) are
 *  same-origin browser requests, which reach Autodesk normally (Worker subrequests get HTTP 525). */
export interface ApsPage { evaluate<T, A>(fn: (arg: A) => Promise<T>, arg: A): Promise<T> }
export const apsSession = new AsyncLocalStorage<ApsPage>()
const APS_HOST = 'https://developer.api.autodesk.com/'

/** fetch() for Autodesk API calls: relay if configured, else the browser session if one is active, else direct. */
export async function apsFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (!url.startsWith(APS_HOST)) return fetch(url, init)
  if (relay) {
    const headers = new Headers(init.headers ?? {})
    headers.set('x-relay-key', relay.key)
    return fetch(`${relay.url.replace(/\/$/, '')}/api/aps?u=${encodeURIComponent(url)}`, { ...init, headers })
  }
  const page = apsSession.getStore()
  if (!page) return fetch(url, init)
  const headers: Record<string, string> = {}
  new Headers(init.headers ?? {}).forEach((v, k) => { headers[k] = v })
  const body = typeof init.body === 'string' ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : init.body ? new TextDecoder().decode(init.body as ArrayBuffer) : undefined
  const r = await page.evaluate(async ({ url, method, headers, body }: { url: string; method: string; headers: Record<string, string>; body?: string }) => {
    const res = await fetch(url, { method, headers, body })
    const h: Record<string, string> = {}
    res.headers.forEach((v, k) => { h[k] = v })
    return { status: res.status, headers: h, text: await res.text() }
  }, { url, method: init.method ?? 'GET', headers, body })
  return new Response(r.text, { status: r.status, headers: r.headers })
}

export async function apsToken(c: ApsCreds): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token
  const r = await apsFetch(AUTH, { method: 'POST', headers: { Authorization: 'Basic ' + btoa(`${c.clientId}:${c.clientSecret}`), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', scope: SCOPES }) })
  const j = (await r.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string }
  if (!j.access_token) throw new Error(`aps auth: ${j.error_description ?? j.error ?? r.status}`)
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 }
  return j.access_token
}

async function api<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const r = await apsFetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
  const text = await r.text()
  if (!r.ok) throw new Error(`aps ${init.method ?? 'GET'} ${url.replace(DA, 'da').replace(OSS, 'oss')} → ${r.status}: ${text.slice(0, 400)}`)
  return (text ? JSON.parse(text) : {}) as T
}

/** Bucket keys must be globally unique, lowercase; derive from the client id like the existing one. */
export const bucketKeyFor = (clientId: string) => `jacsal-aps-${clientId.toLowerCase()}`.slice(0, 128)

export async function ensureBucket(token: string, bucketKey: string, region = 'US'): Promise<void> {
  const r = await apsFetch(`${OSS}/buckets/${bucketKey}/details`, { headers: { Authorization: `Bearer ${token}` } })
  if (r.ok) return
  await api(token, `${OSS}/buckets`, { method: 'POST', headers: { 'x-ads-region': region }, body: JSON.stringify({ bucketKey, policyKey: 'transient' }) })
}

/** Upload bytes with the signed S3 flow (init → PUT → complete). Single part is fine for drawings under 100 MB. */
export async function uploadObject(token: string, bucketKey: string, objectKey: string, bytes: ArrayBuffer): Promise<void> {
  const init = await api<{ uploadKey: string; urls: string[] }>(token, `${OSS}/buckets/${bucketKey}/objects/${encodeURIComponent(objectKey)}/signeds3upload?parts=1`)
  const put = await fetch(init.urls[0], { method: 'PUT', body: bytes })
  if (!put.ok) throw new Error(`aps s3 put ${put.status}`)
  await api(token, `${OSS}/buckets/${bucketKey}/objects/${encodeURIComponent(objectKey)}/signeds3upload`, { method: 'POST', body: JSON.stringify({ uploadKey: init.uploadKey }) })
}

/** Signed S3 download URL for an object (used for Design Automation `get` arguments and our own fetches). */
export async function signedDownloadUrl(token: string, bucketKey: string, objectKey: string, minutes = 60): Promise<string> {
  const j = await api<{ url: string }>(token, `${OSS}/buckets/${bucketKey}/objects/${encodeURIComponent(objectKey)}/signeds3download?minutesExpiration=${minutes}`)
  return j.url
}

/** Signed S3 upload URL that Design Automation can PUT its output to. Caller must complete the upload afterwards. */
export async function signedUploadTarget(token: string, bucketKey: string, objectKey: string, minutes = 60): Promise<{ url: string; uploadKey: string }> {
  const j = await api<{ uploadKey: string; urls: string[] }>(token, `${OSS}/buckets/${bucketKey}/objects/${encodeURIComponent(objectKey)}/signeds3upload?parts=1&minutesExpiration=${minutes}`)
  return { url: j.urls[0], uploadKey: j.uploadKey }
}
export async function completeUpload(token: string, bucketKey: string, objectKey: string, uploadKey: string): Promise<void> {
  await api(token, `${OSS}/buckets/${bucketKey}/objects/${encodeURIComponent(objectKey)}/signeds3upload`, { method: 'POST', body: JSON.stringify({ uploadKey }) })
}

export async function listEngines(token: string): Promise<string[]> {
  return (await api<{ data: string[] }>(token, `${DA}/engines`)).data
}

export async function nickname(token: string): Promise<string> {
  return api<string>(token, `${DA}/forgeapps/me`)
}

/**
 * One generic activity: open input.dwg in accoreconsole and run script.scr.
 * The script decides what happens (DXFOUT for conversion, LISP entmod for write-back,
 * SAVEAS for the result). Outputs are optional so the same activity serves every job.
 */
export async function ensureActivity(token: string, nick: string, activity: string, alias: string, engine: string): Promise<string> {
  const id = `${nick}.${activity}+${alias}`
  const existing = await apsFetch(`${DA}/activities/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } })
  if (existing.ok) return id
  const body = {
    id: activity,
    engine,
    description: 'jacsal-sync: run a script against a DWG (convert, write-back, rescan)',
    commandLine: ['$(engine.path)\\accoreconsole.exe /i "$(args[input].path)" /s "$(args[script].path)"'],
    parameters: {
      input: { verb: 'get', description: 'Input DWG', required: true, localName: 'input.dwg' },
      script: { verb: 'get', description: 'AutoCAD script (.scr)', required: true, localName: 'script.scr' },
      result: { verb: 'put', description: 'Modified DWG', required: false, localName: 'result.dwg' },
      dxf: { verb: 'put', description: 'DXF export', required: false, localName: 'result.dxf' },
    },
  }
  const created = await apsFetch(`${DA}/activities`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!created.ok && created.status !== 409) throw new Error(`aps create activity ${created.status}: ${(await created.text()).slice(0, 300)}`)
  if (created.status === 409) {
    // Activity exists without this alias: add a new version and re-alias.
    await api(token, `${DA}/activities/${activity}/versions`, { method: 'POST', body: JSON.stringify(body) })
  }
  const ver = await api<{ version: number }>(token, `${DA}/activities/${activity}/versions/1`).catch(() => ({ version: 1 }))
  const al = await apsFetch(`${DA}/activities/${activity}/aliases`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: alias, version: ver.version }) })
  if (!al.ok && al.status !== 409) throw new Error(`aps alias ${al.status}: ${(await al.text()).slice(0, 300)}`)
  return id
}

export interface WorkItemArgs { input: string; script: string; result?: string; dxf?: string; onComplete?: string }
export async function createWorkItem(token: string, activityId: string, a: WorkItemArgs): Promise<{ id: string; status: WorkItemStatus }> {
  const args: Record<string, unknown> = {
    input: { url: a.input, verb: 'get' },
    script: { url: a.script, verb: 'get' },
  }
  if (a.result) args.result = { url: a.result, verb: 'put' }
  if (a.dxf) args.dxf = { url: a.dxf, verb: 'put' }
  if (a.onComplete) args.onComplete = { verb: 'post', url: a.onComplete }
  return api(token, `${DA}/workitems`, { method: 'POST', body: JSON.stringify({ activityId, arguments: args }) })
}
export async function getWorkItem(token: string, id: string): Promise<{ id: string; status: WorkItemStatus; reportUrl?: string; stats?: unknown }> {
  return api(token, `${DA}/workitems/${id}`)
}

// ---------------------------------------------------------------------------
// Scripts. Plain AutoCAD .scr files: each line is a command/answer, and lines
// starting with "(" are AutoLISP evaluated inline, so no .lsp loading is needed.
// ---------------------------------------------------------------------------

/** Export the opened drawing to result.dxf (2018 format, 16 decimal places). */
export function convertScript(): string {
  return ['_.DXFOUT', 'result.dxf', 'V', '2018', '16', ''].join('\r\n')
}

export type WriteOp =
  | { op: 'move-line-end'; handle: string; end: 'start' | 'end'; x: number; y: number }
  | { op: 'set-line'; handle: string; x1: number; y1: number; x2: number; y2: number }
  | { op: 'move-insert'; handle: string; x: number; y: number }
  | { op: 'set-text'; handle: string; text: string }
  | { op: 'set-poly-vertex'; handle: string; index: number; x: number; y: number }
  | { op: 'set-dim-points'; handle: string; x13: number; y13: number; x14: number; y14: number }

const lispStr = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
const n = (v: number) => (Math.round(v * 1e6) / 1e6).toFixed(6)

/** Apply approved representation changes to the opened DWG and save as result.dwg, then also DXFOUT for reconciliation. */
export function writebackScript(ops: WriteOp[]): string {
  const lines: string[] = ['(setq *jsync-log* (list))']
  for (const o of ops) {
    const e = `(handent ${lispStr(o.handle)})`
    switch (o.op) {
      case 'move-line-end':
        lines.push(`(if (setq e ${e}) (progn (setq d (entget e)) (setq d (subst (cons ${o.end === 'start' ? 10 : 11} (list ${n(o.x)} ${n(o.y)} 0.0)) (assoc ${o.end === 'start' ? 10 : 11} d) d)) (entmod d) (entupd e)))`)
        break
      case 'set-line':
        lines.push(`(if (setq e ${e}) (progn (setq d (entget e)) (setq d (subst (cons 10 (list ${n(o.x1)} ${n(o.y1)} 0.0)) (assoc 10 d) d)) (setq d (subst (cons 11 (list ${n(o.x2)} ${n(o.y2)} 0.0)) (assoc 11 d) d)) (entmod d) (entupd e)))`)
        break
      case 'move-insert':
        lines.push(`(if (setq e ${e}) (progn (setq d (entget e)) (setq d (subst (cons 10 (list ${n(o.x)} ${n(o.y)} 0.0)) (assoc 10 d) d)) (entmod d) (entupd e)))`)
        break
      case 'set-text':
        lines.push(`(if (setq e ${e}) (progn (setq d (entget e)) (setq d (subst (cons 1 ${lispStr(o.text)}) (assoc 1 d) d)) (entmod d) (entupd e)))`)
        break
      case 'set-poly-vertex':
        // Replace the Nth group-10 vertex of an LWPOLYLINE.
        lines.push(`(if (setq e ${e}) (progn (setq d (entget e) i -1 nd (list)) (foreach g d (if (= (car g) 10) (progn (setq i (1+ i)) (setq nd (cons (if (= i ${o.index}) (cons 10 (list ${n(o.x)} ${n(o.y)})) g) nd))) (setq nd (cons g nd)))) (entmod (reverse nd)) (entupd e)))`)
        break
      case 'set-dim-points':
        lines.push(`(if (setq e ${e}) (progn (setq d (entget e)) (setq d (subst (cons 13 (list ${n(o.x13)} ${n(o.y13)} 0.0)) (assoc 13 d) d)) (setq d (subst (cons 14 (list ${n(o.x14)} ${n(o.y14)} 0.0)) (assoc 14 d) d)) (entmod d) (entupd e)))`)
        break
    }
  }
  lines.push('(command "_.REGEN")')
  lines.push('_.SAVEAS', '2018', 'result.dwg')
  lines.push('_.DXFOUT', 'result.dxf', 'V', '2018', '16', '')
  return lines.join('\r\n')
}
