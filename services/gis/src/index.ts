import { WorkerEntrypoint } from 'cloudflare:workers'

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

export class GisService extends WorkerEntrypoint<Env> {
  private async token(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value
    const [id, secret] = await Promise.all([this.env.ARCGIS_CLIENT_ID.get(), this.env.ARCGIS_CLIENT_SECRET.get()])
    const body = new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials', expiration: '120', f: 'json' })
    const r = await fetch(ARCGIS_TOKEN_URL, { method: 'POST', body })
    const j = (await r.json()) as { access_token?: string; expires_in?: number } & ArcgisError
    if (!j.access_token) throw new Error(`arcgis token: ${j.error?.message ?? r.status}`)
    cachedToken = { value: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 7200) * 1000 }
    return j.access_token
  }

  /** Elevation in metres (mean sea level) for one lon/lat. */
  async elevationAt(lon: number, lat: number, relativeTo: 'meanSeaLevel' | 'ellipsoid' = 'meanSeaLevel'): Promise<number> {
    const u = `${ELEVATION}/at-point?lon=${lon}&lat=${lat}&relativeTo=${relativeTo}&f=json&token=${await this.token()}`
    const j = (await (await fetch(u)).json()) as { result?: { point: ElevationPoint } } & ArcgisError
    if (j.error) throw new Error(`elevation ${j.error.code}: ${j.error.message}`)
    return j.result!.point.z
  }

  /** Elevations for up to 100 points that lie within a 50 km box. Order preserved. */
  async elevationMany(coords: LonLat[], relativeTo: 'meanSeaLevel' | 'ellipsoid' = 'meanSeaLevel'): Promise<ElevationPoint[]> {
    const out: ElevationPoint[] = []
    const token = await this.token()
    for (let i = 0; i < coords.length; i += 100) {
      const r = await fetch(`${ELEVATION}/at-many-points?token=${token}`, {
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
    const r = await fetch(`${STATIC_MAPS}/${style}/${endpoint}?${q}`)
    const contentType = r.headers.get('content-type') ?? ''
    if (!contentType.startsWith('image/')) throw new Error(`static map ${r.status}: ${await r.text()}`)
    return { bytes: await r.arrayBuffer(), contentType }
  }

  /** Generic ArcGIS layer point query (public layers). */
  async queryLayerAtPoint(layerUrl: string, lon: number, lat: number, outFields = '*', returnGeometry = false): Promise<ArcgisFeature[]> {
    const body = new URLSearchParams({ geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields, returnGeometry: String(returnGeometry), outSR: '4326', f: 'json' })
    const j = (await (await fetch(`${layerUrl}/query`, { method: 'POST', body })).json()) as { features?: ArcgisFeature[] } & ArcgisError
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
