/**
 * Address verification.
 *
 * Primary: US Census Bureau Geocoder (free, no key, US only). Returns the matched
 * address, coordinates, and the geographies the point falls in (incorporated place,
 * county, state), which is what "jurisdiction" needs for permitting.
 *
 * Optional: ArcGIS World Geocoding (findAddressCandidates) when the API key carries a
 * geocoding privilege; used only when Census finds nothing.
 */
import { socketFetch } from '../../../shared/socket-http'

export type GeocodeInput = { address: string; city?: string; state?: string; zip?: string }
export type GeocodeResult = {
  matchedAddress: string
  lat: number
  lng: number
  street: string | null
  city: string | null
  county: string | null
  state: string | null
  zip: string | null
  /** Permitting authority: the incorporated city when inside one, else "<County> (unincorporated)". */
  jurisdiction: string
  incorporated: boolean
  censusTract: string | null
  source: 'census' | 'arcgis'
}

const CENSUS = 'https://geocoding.geo.census.gov/geocoder/geographies'
const ARCGIS_GEOCODE = 'https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates'

/** fetch() first; some origins answer Workers with a synthetic 525, in which case fall back to a raw TLS socket. */
async function robustFetch(url: string, init?: { headers?: Record<string, string> }): Promise<Response> {
  try {
    const r = await fetch(url, { headers: init?.headers })
    if (r.status !== 525) return r
  } catch { /* fall through */ }
  return socketFetch(url, { method: 'GET', headers: init?.headers })
}

const tidy = (s: string | undefined | null) => (s ?? '').replace(/\s+/g, ' ').trim()
const titleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bCa\b/, 'CA')

export function jurisdictionFor(place: string | null, county: string | null): { jurisdiction: string; incorporated: boolean } {
  if (place) {
    const name = place.replace(/\s+(city|town|village|borough|municipality|CDP)$/i, '').trim()
    return { jurisdiction: name, incorporated: !/\bCDP$/i.test(place) }
  }
  return { jurisdiction: county ? `${county} (unincorporated)` : 'Unknown', incorporated: false }
}

type CensusMatch = {
  matchedAddress: string
  coordinates: { x: number; y: number }
  addressComponents: { streetName?: string; preDirection?: string; suffixType?: string; fromAddress?: string; city?: string; state?: string; zip?: string }
  geographies?: Record<string, { NAME?: string; BASENAME?: string }[]>
}

export async function geocodeCensus(input: GeocodeInput): Promise<GeocodeResult | null> {
  const q = new URLSearchParams({ benchmark: 'Public_AR_Current', vintage: 'Current_Current', format: 'json' })
  const parts = { street: tidy(input.address), city: tidy(input.city), state: tidy(input.state), zip: tidy(input.zip) }
  let url: string
  if (parts.city || parts.state || parts.zip) {
    q.set('street', parts.street); if (parts.city) q.set('city', parts.city); if (parts.state) q.set('state', parts.state); if (parts.zip) q.set('zip', parts.zip)
    url = `${CENSUS}/address?${q}`
  } else {
    q.set('address', parts.street)
    url = `${CENSUS}/onelineaddress?${q}`
  }
  const r = await robustFetch(url)
  if (!r.ok) throw new Error(`Census geocoder ${r.status}`)
  const j = (await r.json()) as { result?: { addressMatches?: CensusMatch[] } }
  const m = j.result?.addressMatches?.[0]
  if (!m) return null
  const g = m.geographies ?? {}
  const first = (key: string) => g[key]?.[0]?.NAME ?? null
  const place = first('Incorporated Places')
  const county = first('Counties')
  const state = m.addressComponents.state ?? null
  const { jurisdiction, incorporated } = jurisdictionFor(place, county)
  const ac = m.addressComponents
  // addressComponents.fromAddress is the block range start, not the house number; the matched line has the real one.
  const street = tidy(m.matchedAddress.split(',')[0])
  return {
    matchedAddress: titleCase(m.matchedAddress),
    lat: m.coordinates.y, lng: m.coordinates.x,
    street: street ? titleCase(street) : null,
    city: ac.city ? titleCase(ac.city) : null,
    county, state, zip: ac.zip ?? null,
    jurisdiction, incorporated,
    censusTract: first('Census Tracts'),
    source: 'census',
  }
}

export async function geocodeArcgis(input: GeocodeInput, token: string, referer: string): Promise<GeocodeResult | null> {
  const single = [input.address, input.city, input.state, input.zip].map(tidy).filter(Boolean).join(', ')
  const q = new URLSearchParams({ f: 'json', singleLine: single, maxLocations: '1', outFields: 'Match_addr,City,Subregion,Region,RegionAbbr,Postal,StAddr', countryCode: 'USA', forStorage: 'false', token })
  const r = await socketFetch(`${ARCGIS_GEOCODE}?${q}`, { method: 'GET', headers: { Referer: referer } })
  const j = (await r.json()) as { candidates?: { address: string; location: { x: number; y: number }; score: number; attributes: Record<string, string> }[]; error?: { code: number; message: string } }
  if (j.error) throw new Error(`arcgis geocode ${j.error.code}: ${j.error.message}`)
  const c = j.candidates?.[0]
  if (!c || c.score < 80) return null
  const a = c.attributes
  const { jurisdiction, incorporated } = jurisdictionFor(a.City || null, a.Subregion || null)
  return { matchedAddress: c.address, lat: c.location.y, lng: c.location.x, street: a.StAddr || null, city: a.City || null, county: a.Subregion || null, state: a.RegionAbbr || a.Region || null, zip: a.Postal || null, jurisdiction, incorporated, censusTract: null, source: 'arcgis' }
}
