// Autodesk Platform Services relay.
// Cloudflare Workers cannot reach developer.api.autodesk.com (Autodesk's own Cloudflare edge answers 525 to
// Worker subrequests), so the jacsal-sync-cad Worker sends APS calls through this function instead.
// Only the single Autodesk API host is allowed, and every call must carry the shared relay key.
const ALLOWED_HOST = 'developer.api.autodesk.com'
const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'x-relay-key', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-vercel-id', 'x-real-ip', 'forwarded', 'x-vercel-deployment-url', 'x-vercel-forwarded-for', 'x-vercel-ip-country', 'x-vercel-proxy-signature', 'x-vercel-proxy-signature-ts', 'x-vercel-ip-city', 'x-vercel-ip-latitude', 'x-vercel-ip-longitude', 'x-vercel-ip-timezone', 'x-vercel-ip-country-region', 'x-vercel-ip-postal-code', 'x-vercel-ip-continent', 'x-vercel-ip-as-number'])

import { createHash, timingSafeEqual } from 'node:crypto'
// SHA-256 of the relay key (the key itself lives only in the Cloudflare Secrets Store as APS_RELAY_KEY).
// Set env RELAY_KEY_SHA256 to rotate without redeploying; the constant is the deploy-time fallback.
const RELAY_KEY_SHA256 = process.env.RELAY_KEY_SHA256 ?? 'b6b96c676f04fdf70e9934c7de1cf87b25d32ad4218b84b30f845c341a3bbc5f'
const keyOk = (h) => { if (typeof h !== 'string' || !h) return false; const a = Buffer.from(createHash('sha256').update(h).digest('hex')); const b = Buffer.from(RELAY_KEY_SHA256); return a.length === b.length && timingSafeEqual(a, b) }

export default async function handler(request) {
  if (!keyOk(request.headers.get('x-relay-key'))) return Response.json({ error: 'forbidden' }, { status: 403 })
  const target = new URL(request.url).searchParams.get('u')
  let u
  try { u = new URL(target ?? '') } catch { return Response.json({ error: 'bad target' }, { status: 400 }) }
  if (u.protocol !== 'https:' || u.host !== ALLOWED_HOST) return Response.json({ error: 'host not allowed' }, { status: 400 })
  const headers = new Headers()
  request.headers.forEach((v, k) => { if (!HOP.has(k.toLowerCase())) headers.set(k, v) })
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer()
  const r = await fetch(u, { method: request.method, headers, body, redirect: 'manual' })
  const out = new Headers()
  for (const h of ['content-type', 'location', 'x-ads-region']) { const v = r.headers.get(h); if (v) out.set(h, v) }
  return new Response(await r.arrayBuffer(), { status: r.status, headers: out })
}
