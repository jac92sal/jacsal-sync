/**
 * Create an ArcGIS Location Platform API key credential programmatically.
 *
 * Mirrors @esri/arcgis-rest-developer-credentials createApiKey() step for step,
 * but over socketFetch (Worker fetch() to www.arcgis.com is answered with a
 * synthetic 525) and with the user's password used exactly once, in-request:
 *   1. generateToken (username + password, referer-bound, 20 min)
 *   2. community/self            → canonical username, org urlKey
 *   3. content/users/:u/addItem  → "Application" item
 *   4. oauth2/registerApp        → privileges + HTTP referrers
 *   5. items/:id/update          → apiToken1ExpirationDate
 *   6. oauth2/token              → the API key (apiToken slot 1)
 *   7. items/:id/registeredAppInfo → confirm active status
 */
import { socketFetch } from '../../../shared/socket-http'

const PORTAL = 'https://www.arcgis.com/sharing/rest'

export type CreateApiKeyInput = {
  username: string
  password: string
  title?: string
  /** Referrer origins allowed to use the key, e.g. https://sync.jacsalservices.com */
  referrers: string[]
  privileges: string[]
  /** 1–365. ArcGIS caps API key expiration at one year. */
  expiresDays: number
  /** The origin the token is bound to (client=referer). Must equal the Referer header sent on every portal call. */
  referer: string
}

export type CreateApiKeyResult = {
  itemId: string
  clientId: string
  accessToken: string
  expiresAt: string
  privileges: string[]
  referrers: string[]
  username: string
  orgUrlKey: string | null
  itemUrl: string
}

type PortalError = { error?: { code?: number; message?: string; messageCode?: string; details?: string[] } }

export class ArcgisPortalError extends Error {
  step: string
  code: number | undefined
  constructor(step: string, message: string, code?: number) { super(message); this.step = step; this.code = code }
}

async function post<T>(step: string, path: string, params: Record<string, string>, referer: string): Promise<T> {
  const body = new URLSearchParams({ f: 'json', ...params })
  const r = await socketFetch(`${PORTAL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: referer },
    body,
  })
  const text = await r.text()
  let j: T & PortalError
  try { j = JSON.parse(text) as T & PortalError } catch { throw new ArcgisPortalError(step, `ArcGIS returned a non-JSON response (${r.status})`) }
  if (j.error) {
    const d = j.error.details?.filter(Boolean).join(' ') ?? ''
    throw new ArcgisPortalError(step, `${j.error.message ?? 'ArcGIS error'}${d ? ` — ${d}` : ''}`, j.error.code)
  }
  return j
}

export async function createArcgisApiKey(input: CreateApiKeyInput): Promise<CreateApiKeyResult> {
  const referer = input.referer
  const days = Math.min(365, Math.max(1, Math.floor(input.expiresDays)))
  const expiresAtMs = Date.now() + days * 86_400_000

  // 1. Sign in. The token is bound to `referer`, so every later call carries that Referer header.
  const signIn = await post<{ token: string; expires: number }>('sign-in', '/generateToken', {
    username: input.username, password: input.password, client: 'referer', referer, expiration: '20',
  }, referer)
  const token = signIn.token

  // 2. Who am I (canonical username + org URL key for the item link).
  const self = await post<{ user?: { username: string; role?: string; userLicenseTypeId?: string; privileges?: string[] }; urlKey?: string | null }>('self', '/community/self', { token }, referer)
  const username = self.user?.username ?? input.username
  const canCreate = !self.user?.privileges || self.user.privileges.includes('portal:user:createItem')
  if (!canCreate) throw new ArcgisPortalError('self', `Account ${username} cannot create items (needs a Creator or Developer user type with the createItem privilege).`)

  // 3. Item that holds the credential.
  const title = input.title?.trim() || `jacsal-sync ${new Date().toISOString().slice(0, 10)}`
  const item = await post<{ id: string; success: boolean }>('create-item', `/content/users/${encodeURIComponent(username)}/addItem`, {
    token, type: 'Application', title,
    tags: 'jacsal-sync,api key,basemaps,elevation',
    description: `API key credential created from sync.jacsalservices.com Settings on ${new Date().toISOString()}. Referrers: ${input.referrers.join(', ')}.`,
  }, referer)
  const itemId = item.id

  // 4. Register it as an application with privileges and HTTP referrers.
  const reg = await post<{ client_id: string; client_secret: string; httpReferrers?: string[]; privileges?: string[] }>('register-app', '/oauth2/registerApp', {
    token, itemId, appType: 'multiple',
    redirect_uris: JSON.stringify(['urn:ietf:wg:oauth:2.0:oob']),
    httpReferrers: JSON.stringify(input.referrers),
    privileges: JSON.stringify(input.privileges),
  }, referer)

  // 5. Expiration dates live on the item and can only be set after registration.
  await post<{ success: boolean }>('set-expiration', `/content/users/${encodeURIComponent(username)}/items/${itemId}/update`, {
    token, apiToken1ExpirationDate: String(expiresAtMs), apiToken2ExpirationDate: '-1',
  }, referer)

  // 6. Mint the key in slot 1. client_secret authenticates this call; it is never stored.
  const minted = await post<{ access_token: string; expires_in?: number }>('generate-key', '/oauth2/token', {
    client_id: reg.client_id, client_secret: reg.client_secret, apiToken: '1', regenerateApiToken: 'true', grant_type: 'client_credentials',
  }, referer)
  if (!minted.access_token) throw new ArcgisPortalError('generate-key', 'ArcGIS did not return an API key.')

  // 7. Read back what the portal recorded.
  const info = await post<{ httpReferrers?: string[]; privileges?: string[]; apiToken1ExpirationDate?: number; isApiKey1Active?: boolean; apiKey1Active?: boolean }>('registered-app-info', `/content/users/${encodeURIComponent(username)}/items/${itemId}/registeredAppInfo`, { token }, referer)
  const orgUrlKey = self.urlKey ?? null
  return {
    itemId,
    clientId: reg.client_id,
    accessToken: minted.access_token,
    expiresAt: new Date(info.apiToken1ExpirationDate && info.apiToken1ExpirationDate > 0 ? info.apiToken1ExpirationDate : expiresAtMs).toISOString(),
    privileges: info.privileges ?? reg.privileges ?? input.privileges,
    referrers: info.httpReferrers ?? reg.httpReferrers ?? input.referrers,
    username,
    orgUrlKey,
    itemUrl: orgUrlKey ? `https://${orgUrlKey}.maps.arcgis.com/home/item.html?id=${itemId}` : `https://www.arcgis.com/home/item.html?id=${itemId}`,
  }
}
