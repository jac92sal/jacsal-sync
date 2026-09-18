/** Small HTTP helpers shared by every route (same conventions as jacsal-intake). */
export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), { ...init, headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers ?? {}) } })
}
export const ok = (data: Record<string, unknown> = {}) => json({ ok: true, ...data })
export const fail = (status: number, error: string, message: string) => json({ ok: false, error, message }, { status })

export class HttpError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code }
  toResponse(): Response { return fail(this.status, this.code, this.message) }
}
export const badRequest = (message: string) => new HttpError(400, 'bad_request', message)
export const unauthorized = (message = 'Sign in to continue.') => new HttpError(401, 'unauthorized', message)
export const forbidden = (message = 'You do not have access to this.') => new HttpError(403, 'forbidden', message)
export const notFound = (message = 'Not found.') => new HttpError(404, 'not_found', message)
export const conflict = (message: string) => new HttpError(409, 'conflict', message)

export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  try { return (await request.json()) as T } catch { throw badRequest('Request body was not valid JSON.') }
}
export const uuid = () => crypto.randomUUID()
export const nowIso = () => new Date().toISOString()
export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try { return JSON.parse(raw) as T } catch { return fallback }
}
export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b)
  if (ea.byteLength !== eb.byteLength) return false
  return crypto.subtle.timingSafeEqual(ea, eb)
}
