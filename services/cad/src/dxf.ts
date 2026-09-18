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
  /** Index into DxfDocument.models when the entity belongs to a detected model page. */
  model?: number
}
export interface DxfDocument {
  /** $INSUNITS: 1 = inches, 2 = feet, 4 = mm, 5 = cm, 6 = m, 0 = unitless */
  insunits: number
  extmin?: Pt
  extmax?: Pt
  entities: DxfEntity[]
  /** Present after parsing: how much of the file was retained. */
  stats?: DxfStats
  /** Model pages (floor plans) found in model space; see models.ts. */
  models?: ModelRegion[]
}
export interface ModelRegion { ix: number; title: string; labels: string[]; bbox: { minX: number; minY: number; maxX: number; maxY: number }; entityCount: number; wallCount: number }
type Raw = Record<string, string[]>

/** Units → feet multiplier. Unitless drawings are assumed to be inches (architectural default). */
export function unitsToFeet(insunits: number): number {
  const m: Record<number, number> = { 1: 1 / 12, 2: 1, 3: 1 / 63360, 4: 1 / 304.8, 5: 1 / 30.48, 6: 1 / 0.3048 }
  return m[insunits] ?? 1 / 12
}

const KEEP = new Set(['LINE', 'LWPOLYLINE', 'CIRCLE', 'ARC', 'TEXT', 'MTEXT', 'INSERT', 'DIMENSION'])
/** Never dropped by the entity cap: they carry the semantics (labels, blocks, dimensions, room outlines). */
const PRIORITY = new Set(['TEXT', 'MTEXT', 'INSERT', 'DIMENSION', 'LWPOLYLINE'])
/** Upper bound on retained entities so a 100 MB+ DXF cannot exhaust Worker memory. */
export const MAX_ENTITIES = 150_000

export interface DxfStats { seen: number; kept: number; dropped: number; paperSpace: number; bytes: number }

/**
 * Incremental DXF reader: feed text chunks with push(), finish with end().
 * Only the HEADER variables we need and model-space entities of the kept types are retained;
 * BLOCKS, OBJECTS, binary chunks (310) and paper-space entities are skipped without allocation.
 */
export class DxfStreamParser {
  readonly doc: DxfDocument = { insunits: 0, entities: [] }
  readonly stats: DxfStats = { seen: 0, kept: 0, dropped: 0, paperSpace: 0, bytes: 0 }
  private tail = ''
  private pendingCode: string | null = null
  private section = ''
  private afterSection = false
  private cur: { type: string; raw: Raw } | null = null
  private lastInsert: DxfEntity | null = null
  private headerVar = ''

  push(chunk: string): void {
    this.stats.bytes += chunk.length
    const text = this.tail ? this.tail + chunk : chunk
    let start = 0
    for (;;) {
      const nl = text.indexOf('\n', start)
      if (nl < 0) break
      this.line(text.slice(start, nl))
      start = nl + 1
    }
    this.tail = text.slice(start)
  }

  end(): DxfDocument {
    if (this.tail.length) { this.line(this.tail); this.tail = '' }
    this.flush()
    this.doc.stats = this.stats
    return this.doc
  }

  private line(raw: string): void {
    const l = raw.trim()
    if (this.pendingCode === null) { this.pendingCode = l; return }
    const code = this.pendingCode; this.pendingCode = null
    this.pair(code, l)
  }

  private pair(code: string, value: string): void {
    if (this.afterSection) { this.afterSection = false; if (code === '2') { this.section = value; return } }
    if (code === '0' && value === 'SECTION') { this.afterSection = true; return }
    if (code === '0' && value === 'ENDSEC') { this.flush(); this.section = ''; return }
    if (this.section === 'HEADER') {
      if (code === '9') this.headerVar = value
      else if (this.headerVar === '$INSUNITS' && code === '70') this.doc.insunits = Number(value)
      else if (this.headerVar === '$EXTMIN' && code === '10') this.doc.extmin = { x: Number(value), y: 0 }
      else if (this.headerVar === '$EXTMIN' && code === '20' && this.doc.extmin) this.doc.extmin.y = Number(value)
      else if (this.headerVar === '$EXTMAX' && code === '10') this.doc.extmax = { x: Number(value), y: 0 }
      else if (this.headerVar === '$EXTMAX' && code === '20' && this.doc.extmax) this.doc.extmax.y = Number(value)
      return
    }
    if (this.section !== 'ENTITIES') return
    if (code === '0') {
      this.flush()
      this.stats.seen++
      this.cur = KEEP.has(value) || value === 'ATTRIB' ? { type: value, raw: {} } : null
      return
    }
    if (!this.cur || code === '310') return
    ;(this.cur.raw[code] ??= []).push(value)
  }

  private flush(): void {
    if (!this.cur) return
    const { type, raw } = this.cur
    this.cur = null
    if (raw['67']?.[0] === '1') { this.stats.paperSpace++; return }
    if (type === 'ATTRIB') {
      if (this.lastInsert) { const tag = raw['2']?.[0] ?? ''; this.lastInsert.attribs = { ...(this.lastInsert.attribs ?? {}), [tag]: raw['1']?.[0] ?? '' } }
      return
    }
    if (this.doc.entities.length >= MAX_ENTITIES && !PRIORITY.has(type)) { this.stats.dropped++; return }
    const e = finalize(type, raw)
    if (type === 'INSERT') this.lastInsert = e
    this.doc.entities.push(e)
    this.stats.kept++
  }
}

export function parseDxf(text: string): DxfDocument {
  const p = new DxfStreamParser()
  p.push(text)
  return p.end()
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
