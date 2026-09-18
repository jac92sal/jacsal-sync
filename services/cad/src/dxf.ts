/** Minimal DXF (ASCII) reader for the entity types the object model needs.
 *  Retains every entity handle so write-back can target the exact source entity. */

export type Pt = { x: number; y: number }
export interface DxfEntity {
  handle: string
  type: string
  layer: string
  /** LINE: [start,end]; LWPOLYLINE: vertices; TEXT/MTEXT/INSERT: [insertion]; DIMENSION: [defPoint, p13, p14] */
  points: Pt[]
  closed?: boolean
  text?: string
  blockName?: string
  rotation?: number
  height?: number
  attribs?: Record<string, string>
  dimMeasurement?: number
  dimType?: number
}
export interface DxfDocument {
  /** $INSUNITS: 1 = inches, 2 = feet, 4 = mm, 5 = cm, 6 = m, 0 = unitless */
  insunits: number
  extmin?: Pt
  extmax?: Pt
  entities: DxfEntity[]
}
type Raw = Record<string, string[]>

/** Units → feet multiplier. Unitless drawings are assumed to be inches (architectural default). */
export function unitsToFeet(insunits: number): number {
  const m: Record<number, number> = { 1: 1 / 12, 2: 1, 3: 1 / 63360, 4: 1 / 304.8, 5: 1 / 30.48, 6: 1 / 0.3048 }
  return m[insunits] ?? 1 / 12
}

export function parseDxf(text: string): DxfDocument {
  const lines = text.split(/\r?\n/)
  const doc: DxfDocument = { insunits: 0, entities: [] }
  let section = ''
  let i = 0
  let cur: { type: string; raw: Raw } | null = null
  let lastInsert: DxfEntity | null = null
  let headerVar = ''

  const flush = () => {
    if (!cur) return
    const { type, raw } = cur
    cur = null
    if (type === 'ATTRIB' && lastInsert) {
      const tag = raw['2']?.[0] ?? ''
      lastInsert.attribs = { ...(lastInsert.attribs ?? {}), [tag]: raw['1']?.[0] ?? '' }
      return
    }
    if (!['LINE', 'LWPOLYLINE', 'CIRCLE', 'ARC', 'TEXT', 'MTEXT', 'INSERT', 'DIMENSION'].includes(type)) return
    const e = finalize(type, raw)
    if (type === 'INSERT') lastInsert = e
    doc.entities.push(e)
  }

  while (i + 1 < lines.length) {
    const code = lines[i].trim(); const value = lines[i + 1].trim(); i += 2
    if (code === '0' && value === 'SECTION') { section = lines[i + 1]?.trim() ?? ''; i += 2; continue }
    if (code === '0' && value === 'ENDSEC') { flush(); section = ''; continue }
    if (section === 'HEADER') {
      if (code === '9') headerVar = value
      else if (headerVar === '$INSUNITS' && code === '70') doc.insunits = Number(value)
      else if (headerVar === '$EXTMIN' && code === '10') doc.extmin = { x: Number(value), y: 0 }
      else if (headerVar === '$EXTMIN' && code === '20' && doc.extmin) doc.extmin.y = Number(value)
      else if (headerVar === '$EXTMAX' && code === '10') doc.extmax = { x: Number(value), y: 0 }
      else if (headerVar === '$EXTMAX' && code === '20' && doc.extmax) doc.extmax.y = Number(value)
      continue
    }
    if (section !== 'ENTITIES') continue
    if (code === '0') { flush(); cur = { type: value, raw: {} }; continue }
    if (!cur) continue
    ;(cur.raw[code] ??= []).push(value)
  }
  flush()
  return doc
}

function finalize(type: string, r: Raw): DxfEntity {
  const e: DxfEntity = { handle: r['5']?.[0] ?? '', type, layer: r['8']?.[0] ?? '0', points: [] }
  const xs = (r['10'] ?? []).map(Number); const ys = (r['20'] ?? []).map(Number)
  switch (type) {
    case 'LINE':
      e.points = [{ x: xs[0], y: ys[0] }, { x: Number(r['11']?.[0]), y: Number(r['21']?.[0]) }]
      break
    case 'LWPOLYLINE':
      e.points = xs.map((x, k) => ({ x, y: ys[k] }))
      e.closed = (Number(r['70']?.[0] ?? 0) & 1) === 1
      break
    case 'CIRCLE': case 'ARC':
      e.points = [{ x: xs[0], y: ys[0] }]; e.height = Number(r['40']?.[0])
      break
    case 'TEXT': case 'MTEXT': {
      e.points = [{ x: xs[0], y: ys[0] }]
      const t = type === 'MTEXT' ? [...(r['3'] ?? []), ...(r['1'] ?? [])].join('') : (r['1']?.[0] ?? '')
      e.text = t.replace(/\\P/g, ' ').replace(/\\[A-Za-z][^;]*;/g, '').replace(/[{}]/g, '').trim()
      e.height = Number(r['40']?.[0]); e.rotation = Number(r['50']?.[0] ?? 0)
      break
    }
    case 'INSERT':
      e.points = [{ x: xs[0], y: ys[0] }]; e.blockName = r['2']?.[0]; e.rotation = Number(r['50']?.[0] ?? 0)
      break
    case 'DIMENSION':
      e.points = [{ x: xs[0], y: ys[0] }, { x: Number(r['13']?.[0]), y: Number(r['23']?.[0]) }, { x: Number(r['14']?.[0]), y: Number(r['24']?.[0]) }]
      e.text = r['1']?.[0] ?? ''; e.blockName = r['2']?.[0]; e.dimMeasurement = Number(r['42']?.[0]); e.dimType = Number(r['70']?.[0] ?? 0) & 15
      break
  }
  return e
}

export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
export function polygonArea(pts: Pt[]): number {
  let s = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y)
  return Math.abs(s / 2)
}
export function pointInPolygon(p: Pt, pts: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}
/** Distance from point p to segment ab, and the parameter t along ab. */
export function pointToSegment(p: Pt, a: Pt, b: Pt): { d: number; t: number } {
  const dx = b.x - a.x, dy = b.y - a.y; const l2 = dx * dx + dy * dy
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2))
  return { d: dist(p, { x: a.x + t * dx, y: a.y + t * dy }), t }
}
