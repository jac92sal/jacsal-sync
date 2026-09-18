/**
 * Minimal HTTP/1.1 client over `cloudflare:sockets`.
 *
 * Why: from this account, Worker `fetch()` to several ordinary origins (developer.api.autodesk.com,
 * elevation-api.arcgis.com, maps2.dcgis.dc.gov, api.github.com) is answered by the edge with a synthetic
 * "error code: 525" (TLS handshake failed), while a direct TLS socket to the same hosts works. This client
 * speaks just enough HTTP/1.1 (Content-Length, chunked, read-to-close; no compression, no redirects) to
 * carry JSON API traffic and small uploads. Large binary transfers should still use fetch() to S3 etc.
 */
import { connect } from 'cloudflare:sockets'

export interface SocketFetchInit {
  method?: string
  headers?: HeadersInit
  body?: string | ArrayBuffer | Uint8Array | URLSearchParams
  timeoutMs?: number
}

export async function socketFetch(url: string, init: SocketFetchInit = {}): Promise<Response> {
  const u = new URL(url)
  if (u.protocol !== 'https:') throw new Error('socketFetch: https only')
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers ?? {})
  let body: Uint8Array | undefined
  if (init.body !== undefined) {
    if (typeof init.body === 'string') body = new TextEncoder().encode(init.body)
    else if (init.body instanceof URLSearchParams) { body = new TextEncoder().encode(init.body.toString()); if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded') }
    else if (init.body instanceof ArrayBuffer) body = new Uint8Array(init.body)
    else body = init.body
  }
  headers.set('host', u.host)
  headers.set('connection', 'close')
  headers.set('accept-encoding', 'identity')
  if (!headers.has('user-agent')) headers.set('user-agent', 'jacsal-sync/1.0 (+cloudflare-workers)')
  if (body) headers.set('content-length', String(body.byteLength))
  else if (method !== 'GET' && method !== 'HEAD') headers.set('content-length', '0')

  const head = [`${method} ${u.pathname}${u.search} HTTP/1.1`]
  headers.forEach((v, k) => head.push(`${k}: ${v}`))
  const reqHead = new TextEncoder().encode(head.join('\r\n') + '\r\n\r\n')

  const socket = connect({ hostname: u.hostname, port: Number(u.port || 443) }, { secureTransport: 'on', allowHalfOpen: false })
  const timeout = setTimeout(() => { socket.close().catch(() => undefined) }, init.timeoutMs ?? 60_000)
  try {
    const w = socket.writable.getWriter()
    await w.write(reqHead)
    if (body) await w.write(body)
    // Do not close the writable side: with allowHalfOpen=false that tears down the socket before the
    // response arrives. We sent Connection: close, so the server ends the stream when it is done.
    w.releaseLock()

    const reader = socket.readable.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) { const { value, done } = await reader.read(); if (done) break; chunks.push(value); total += value.byteLength }
    const buf = new Uint8Array(total); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.byteLength }
    return parseResponse(buf, method === 'HEAD')
  } finally {
    clearTimeout(timeout)
    socket.close().catch(() => undefined)
  }
}

function indexOfSeq(buf: Uint8Array, seq: number[], from = 0): number {
  outer: for (let i = from; i <= buf.length - seq.length; i++) { for (let j = 0; j < seq.length; j++) if (buf[i + j] !== seq[j]) continue outer; return i }
  return -1
}

function parseResponse(buf: Uint8Array, isHead: boolean): Response {
  const CRLF2 = [13, 10, 13, 10]
  let hEnd = indexOfSeq(buf, CRLF2)
  if (hEnd < 0) throw new Error('socketFetch: malformed response (no header terminator)')
  let headText = new TextDecoder().decode(buf.subarray(0, hEnd))
  // Skip interim 1xx responses.
  while (/^HTTP\/1\.[01] 1\d\d/.test(headText)) {
    const next = indexOfSeq(buf, CRLF2, hEnd + 4); if (next < 0) break
    headText = new TextDecoder().decode(buf.subarray(hEnd + 4, next)); hEnd = next
  }
  const lines = headText.split('\r\n')
  const m = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines[0])
  if (!m) throw new Error(`socketFetch: bad status line ${lines[0].slice(0, 80)}`)
  const status = Number(m[1])
  const headers = new Headers()
  for (const l of lines.slice(1)) { const i = l.indexOf(':'); if (i > 0) headers.append(l.slice(0, i).trim(), l.slice(i + 1).trim()) }
  let payload = buf.subarray(hEnd + 4)
  if (isHead || status === 204 || status === 304) payload = new Uint8Array(0)
  else if ((headers.get('transfer-encoding') ?? '').toLowerCase().includes('chunked')) payload = dechunk(payload)
  else if (headers.has('content-length')) payload = payload.subarray(0, Number(headers.get('content-length')))
  headers.delete('transfer-encoding'); headers.delete('content-length'); headers.delete('connection')
  return new Response(payload.byteLength ? payload : null, { status, statusText: m[2] ?? '', headers })
}

function dechunk(src: Uint8Array): Uint8Array {
  const out: Uint8Array[] = []; let pos = 0; let total = 0
  for (;;) {
    const lineEnd = indexOfSeq(src, [13, 10], pos); if (lineEnd < 0) break
    const size = parseInt(new TextDecoder().decode(src.subarray(pos, lineEnd)).split(';')[0].trim(), 16)
    if (!Number.isFinite(size)) break
    pos = lineEnd + 2
    if (size === 0) break
    out.push(src.subarray(pos, pos + size)); total += size; pos += size + 2
  }
  const buf = new Uint8Array(total); let o = 0; for (const c of out) { buf.set(c, o); o += c.byteLength }
  return buf
}
