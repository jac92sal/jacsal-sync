import { WorkerEntrypoint } from 'cloudflare:workers'
import { socketFetch } from '../../../shared/socket-http'
import { open, seal } from '../../../shared/secretbox'
import { ArcgisPortalError, createArcgisApiKey } from './apikey'
import { geocodeArcgis, geocodeCensus, type GeocodeInput, type GeocodeResult } from './geocode'

export type { GeocodeInput, GeocodeResult }

/**
 * GisService — shared GIS capability over a Service Binding.
 *
 * ArcGIS location services need an ArcGIS Location Platform token. We use the
 * app's OAuth 2.0 client credentials (client_credentials grant) and cache the
 * token in-isolate until shortly before expiry. Public ArcGIS Server layers
 * (DC GIS) need no token.
 */

const ARCGIS_TOKEN_URL = 'https://www.arcgis.com/sharing/rest/oauth2/token'
const ELEVATION = 'https://elevation-api.arcgis.com/arcgis/rest/services/elevation-service/v1/elevation'
const STATIC_MAPS = 'https://static-maps-api.arcgis.com/arcgis/rest/services/static-maps-service/v1/static-maps/arcgis'
const DCGIS = 'https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA'

export type LonLat = [number, number]
export type ElevationPoint = { x: number; y: number; z: number }
export type StaticMapStyle = 'streets' | 'streets-night' | 'navigation' | 'navigation-night' | 'imagery'
export type ArcgisFeature = { attributes: Record<string, unknown>; geometry?: unknown }

type ArcgisError = { error?: { code: number; message: string; details?: string[] } }

// Token cache is not request-scoped state: it is a process-wide credential cache
// keyed by nothing but time, so sharing it across requests is the intent.
let cachedToken: { value: string; expiresAt: number } | null = null
// Same for the app-created key: one D1 read + AES-GCM open per minute per isolate, not per call.
let storedKeyCache: { value: string | null; at: number } | null = null

const KEY_ROW = 'arcgis_api_key'
const META_ROW = 'arcgis_api_key_meta'

export type ArcgisKeyMeta = { itemId: string; itemUrl: string; username: string; expiresAt: string; privileges: string[]; referrers: string[]; createdAt: string; createdBy: string }
export type ArcgisKeyStatus = { source: 'app' | 'secrets-store' | 'oauth' | 'none'; meta: ArcgisKeyMeta | null; referer: string; daysLeft: number | null }
export type CreateKeyRequest = { username: string; password: string; expiresDays: number; privileges: string[]; referrers: string[]; title?: string }

/** Privileges offered in Settings → ArcGIS. Identifiers are the portal's; unknown ones are rejected by registerApp. */
export const ARCGIS_PRIVILEGES: { id: string; label: string; default: boolean }[] = [
  { id: 'premium:user:basemaps', label: 'Basemaps (map tiles, static basemap tiles)', default: true },
  { id: 'premium:user:elevation', label: 'Elevation (site elevation, slope)', default: true },
  { id: 'premium:user:staticMaps', label: 'Static maps (PNG site maps)', default: true },
  { id: 'premium:user:geocode:temporary', label: 'Geocoding, temporary (address → point)', default: false },
  { id: 'premium:user:places', label: 'Places (nearby POIs)', default: false },
  { id: 'premium:user:networkanalysis:routing', label: 'Routing', default: false },
]

export class GisService extends WorkerEntrypoint<Env> {
  private get referer(): string { return this.env.ARCGIS_REFERER }
  private get refererOrigin(): string { return new URL(this.referer).origin }

  /** The key created from Settings → ArcGIS, if any (sealed in D1 under APP_KEK). */
  private async storedKey(): Promise<string | null> {
    if (storedKeyCache && Date.now() - storedKeyCache.at < 60_000) return storedKeyCache.value
    const row = await this.env.DB.prepare('SELECT value FROM app_settings WHERE key = ? AND sealed = 1').bind(KEY_ROW).first<{ value: string }>().catch(() => null)
    let value: string | null = null
    if (row?.value) {
      const kek = await this.env.APP_KEK.get()
      value = await open(kek, row.value)
    }
    storedKeyCache = { value, at: Date.now() }
    return value
  }

  private async storedMeta(): Promise<ArcgisKeyMeta | null> {
    const row = await this.env.DB.prepare('SELECT value FROM app_settings WHERE key = ?').bind(META_ROW).first<{ value: string }>().catch(() => null)
    return row?.value ? (JSON.parse(row.value) as ArcgisKeyMeta) : null
  }

  /** What the location-service calls will authenticate with right now. */
  async keyStatus(): Promise<ArcgisKeyStatus> {
    const meta = await this.storedMeta()
    const stored = await this.storedKey().catch(() => null)
    let source: ArcgisKeyStatus['source'] = 'none'
    if (stored) source = 'app'
    else if (await this.env.ARCGIS_API_KEY.get().catch(() => '')) source = 'secrets-store'
    else if (await this.env.ARCGIS_CLIENT_ID.get().catch(() => '')) source = 'oauth'
    const daysLeft = source === 'app' && meta ? Math.floor((Date.parse(meta.expiresAt) - Date.now()) / 86_400_000) : null
    return { source, meta: source === 'app' ? meta : null, referer: this.referer, daysLeft }
  }

  /**
   * Create a long-lived API key credential with the user's ArcGIS sign-in, then seal and store the key.
   * The password is used for one generateToken call and is never persisted or logged.
   */
  async createApiKey(req: CreateKeyRequest, actor: string): Promise<ArcgisKeyMeta> {
    const username = req.username.trim()
    if (!username || !req.password) throw new Error('ArcGIS username and password are required.')
    const privileges = [...new Set(req.privileges.filter((p) => ARCGIS_PRIVILEGES.some((k) => k.id === p)))]
    if (privileges.length === 0) throw new Error('Select at least one privilege.')
    const referrers = [...new Set([this.refererOrigin, ...req.referrers.map((r) => r.trim()).filter(Boolean)])]
    let created
    try {
      created = await createArcgisApiKey({ username, password: req.password, title: req.title, referrers, privileges, expiresDays: req.expiresDays, referer: this.refererOrigin })
    } catch (e) {
      if (e instanceof ArcgisPortalError) throw new Error(`ArcGIS (${e.step}): ${e.message}`)
      throw e
    }
    const kek = await this.env.APP_KEK.get()
    const sealed = await seal(kek, created.accessToken)
    const meta: ArcgisKeyMeta = { itemId: created.itemId, itemUrl: created.itemUrl, username: created.username, expiresAt: created.expiresAt, privileges: created.privileges, referrers: created.referrers, createdAt: new Date().toISOString(), createdBy: actor }
    const upsert = 'INSERT INTO app_settings (key, value, sealed, updated_by, updated_at) VALUES (?, ?, ?, ?, strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, sealed = excluded.sealed, updated_by = excluded.updated_by, updated_at = excluded.updated_at'
    await this.env.DB.batch([
      this.env.DB.prepare(upsert).bind(KEY_ROW, sealed, 1, actor),
      this.env.DB.prepare(upsert).bind(META_ROW, JSON.stringify(meta), 0, actor),
    ])
    storedKeyCache = null
    return meta
  }

  /** Forget the app-created key (falls back to the Secrets Store key or OAuth). The ArcGIS item is left for you to delete in the portal. */
  async clearStoredKey(): Promise<void> {
    await this.env.DB.prepare('DELETE FROM app_settings WHERE key IN (?, ?)').bind(KEY_ROW, META_ROW).run()
    storedKeyCache = null
  }

  /** One real elevation call with whatever key is active. */
  async testKey(): Promise<{ ok: true; elevationM: number; source: ArcgisKeyStatus['source'] } | { ok: false; error: string; source: ArcgisKeyStatus['source'] }> {
    const { source } = await this.keyStatus()
    try {
      const z = await this.elevationAt(-77.0369, 38.9072)
      return { ok: true, elevationM: z, source }
    } catch (e) {
      return { ok: false, error: String((e as Error).message ?? e), source }
    }
  }

  /** Location services: app-created key, else the Secrets Store key, else an OAuth app token. Every call sends ARCGIS_REFERER. */
  private async token(): Promise<string> {
    const stored = await this.storedKey().catch(() => null)
    if (stored) return stored
    const apiKey = await this.env.ARCGIS_API_KEY.get().catch(() => '')
    if (apiKey) return apiKey
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value
    const [id, secret] = await Promise.all([this.env.ARCGIS_CLIENT_ID.get(), this.env.ARCGIS_CLIENT_SECRET.get()])
    const body = new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials', expiration: '120', f: 'json' })
    const r = await socketFetch(ARCGIS_TOKEN_URL, { method: 'POST', body })
    const j = (await r.json()) as { access_token?: string; expires_in?: number } & ArcgisError
    if (!j.access_token) throw new Error(`arcgis token: ${j.error?.message ?? r.status}`)
    cachedToken = { value: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 7200) * 1000 }
    return j.access_token
  }

  /** fetch() for ArcGIS location services with the referrer the API key credential allows. */
  private esri(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers ?? {})
    if (this.env.ARCGIS_REFERER) headers.set('Referer', this.env.ARCGIS_REFERER)
    // Worker fetch() to these origins is answered with a synthetic 525 from the edge; a direct TLS socket works.
    return socketFetch(url, { method: init.method, headers, body: init.body as string | undefined })
  }

  /** Diagnostic: credential shape and a live elevation call (never returns the key itself). */
  async diagnose(): Promise<Record<string, unknown>> {
    const status = await this.keyStatus()
    const key = await this.token().catch(() => '')
    const r = await this.esri(`${ELEVATION}/at-point?lon=-77.0736&lat=38.9315&f=json&token=${key}`)
    return { source: status.source, keyLength: key.length, keyHead: key.slice(0, 4), referer: this.env.ARCGIS_REFERER, status: r.status, body: (await r.text()).slice(0, 160) }
  }

  /**
   * Verify a US address: Census geocoder first (free, returns city/county/state/ZIP + jurisdiction),
   * ArcGIS World Geocoding as a fallback when the active key has a geocoding privilege.
   */
  async geocode(input: GeocodeInput): Promise<GeocodeResult | null> {
    if (!input.address?.trim()) throw new Error('Street address is required.')
    const census = await geocodeCensus(input).catch(() => null)
    if (census) return census
    try {
      return await geocodeArcgis(input, await this.token(), this.referer)
    } catch {
      return null
    }
  }

  /** Elevation in metres (mean sea level) for one lon/lat. */
  async elevationAt(lon: number, lat: number, relativeTo: 'meanSeaLevel' | 'ellipsoid' = 'meanSeaLevel'): Promise<number> {
    const u = `${ELEVATION}/at-point?lon=${lon}&lat=${lat}&relativeTo=${relativeTo}&f=json&token=${await this.token()}`
    const j = (await (await this.esri(u)).json()) as { result?: { point: ElevationPoint } } & ArcgisError
    if (j.error) throw new Error(`elevation ${j.error.code}: ${j.error.message}`)
    return j.result!.point.z
  }

  /** Elevations for up to 100 points that lie within a 50 km box. Order preserved. */
  async elevationMany(coords: LonLat[], relativeTo: 'meanSeaLevel' | 'ellipsoid' = 'meanSeaLevel'): Promise<ElevationPoint[]> {
    const out: ElevationPoint[] = []
    const token = await this.token()
    for (let i = 0; i < coords.length; i += 100) {
      const r = await this.esri(`${ELEVATION}/at-many-points?token=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coordinates: coords.slice(i, i + 100), relativeTo, f: 'json' }),
      })
      const j = (await r.json()) as { result?: { points: ElevationPoint[] } } & ArcgisError
      if (j.error) throw new Error(`elevation ${j.error.code}: ${j.error.message}`)
      out.push(...j.result!.points)
    }
    return out
  }

  /** Site slope statistics from a grid of samples inside a lon/lat ring. */
  async slopeForRing(ring: LonLat[], n = 5): Promise<{ minZ: number; maxZ: number; meanGradePct: number; maxGradePct: number; samples: ElevationPoint[] }> {
    const xs = ring.map((p) => p[0]); const ys = ring.map((p) => p[1])
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    const pts: LonLat[] = []
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) pts.push([x0 + ((x1 - x0) * (i + 0.5)) / n, y0 + ((y1 - y0) * (j + 0.5)) / n])
    const inside = pts.filter((p) => pointInRing(p, ring))
    const samples = await this.elevationMany(inside.length >= 4 ? inside : pts)
    const grades: number[] = []
    const mPerDegLat = 111_320; const mPerDegLon = 111_320 * Math.cos((((y0 + y1) / 2) * Math.PI) / 180)
    for (let a = 0; a < samples.length; a++) for (let b = a + 1; b < samples.length; b++) {
      const dx = (samples[a].x - samples[b].x) * mPerDegLon; const dy = (samples[a].y - samples[b].y) * mPerDegLat
      const run = Math.hypot(dx, dy); if (run < 1) continue
      grades.push((Math.abs(samples[a].z - samples[b].z) / run) * 100)
    }
    const zs = samples.map((s) => s.z)
    return { minZ: Math.min(...zs), maxZ: Math.max(...zs), meanGradePct: grades.reduce((s, g) => s + g, 0) / Math.max(1, grades.length), maxGradePct: Math.max(0, ...grades), samples }
  }

  /** Static map PNG bytes. Attribution is burned in unless opts.attribution = 'none'. */
  async staticMap(style: StaticMapStyle, endpoint: 'with-point' | 'with-many-points' | 'with-polyline' | 'with-polygon', params: Record<string, string | number>): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    const q = new URLSearchParams({ format: 'png', ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), token: await this.token() })
    const r = await this.esri(`${STATIC_MAPS}/${style}/${endpoint}?${q}`)
    const contentType = r.headers.get('content-type') ?? ''
    if (!contentType.startsWith('image/')) throw new Error(`static map ${r.status}: ${await r.text()}`)
    return { bytes: await r.arrayBuffer(), contentType }
  }

  /** Generic ArcGIS layer point query (public layers). */
  async queryLayerAtPoint(layerUrl: string, lon: number, lat: number, outFields = '*', returnGeometry = false): Promise<ArcgisFeature[]> {
    const body = new URLSearchParams({ geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields, returnGeometry: String(returnGeometry), outSR: '4326', f: 'json' })
    const j = (await (await socketFetch(`${layerUrl}/query`, { method: 'POST', body })).json()) as { features?: ArcgisFeature[] } & ArcgisError
    if (j.error) throw new Error(`arcgis query ${j.error.code}: ${j.error.message}`)
    return j.features ?? []
  }

  /** DC soil map unit at a point (USDA NRCS via DC GIS layer 17). */
  async dcSoilAt(lon: number, lat: number) {
    const f = await this.queryLayerAtPoint(`${DCGIS}/Environment_Land_WebMercator/MapServer/17`, lon, lat, 'TYPE,TYPEDESC,DESC_,SLOPE,SLOPEDESC,TYPE_ORIG,MUKEY')
    return f[0]?.attributes ?? null
  }
  /** DC zoning district at a point (Zoning Regulations of 2016, layer 32). */
  async dcZoningAt(lon: number, lat: number) {
    const f = await this.queryLayerAtPoint(`${DCGIS}/Planning_Landuse_and_Zoning_WebMercator/MapServer/32`, lon, lat, 'ZONING,ZONE_DISTRICT,ZONE_DESCRIPTION,ZONING_WEB_URL,ZONING_STATUS')
    return f[0]?.attributes ?? null
  }
  /** DC ownership polygon at a point (layer 40). Owner names and tax fields are deliberately not requested. */
  async dcParcelAt(lon: number, lat: number) {
    const f = await this.queryLayerAtPoint(`${DCGIS}/Property_and_Land_WebMercator/MapServer/40`, lon, lat, 'SSL,SQUARE,LOT,LANDAREA,PROPTYPE,USECODE,PREMISEADD,NBHDNAME,PRMSWARD', true)
    return f[0] ?? null
  }
}

function pointInRing(p: LonLat, ring: LonLat[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]; const [xj, yj] = ring[j]
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

// A service Worker still needs a default export; it is never routed publicly.
export default { fetch: () => new Response('jacsal-sync-gis: service binding only', { status: 404 }) } satisfies ExportedHandler<Env>
