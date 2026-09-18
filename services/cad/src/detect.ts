import { type DxfDocument, type DxfEntity, type Pt, dist, pointInPolygon, pointToSegment, polygonArea, unitsToFeet } from './dxf'

/** A detection is a proposal. Nothing here becomes authoritative until a human confirms it. */
export interface Candidate {
  key: string                      // stable within one file: e.g. 'ROOM:1A2F' (handle based)
  kind: 'FIELD' | 'ROOM' | 'WALL' | 'WINDOW' | 'DOOR' | 'BEAM' | 'TEXT'
  humanName: string
  semanticTag: string
  detectedValue: unknown           // FIELD: number; ROOM: {points}; WALL/WINDOW: {x1,y1,x2,y2} or {x,y}
  unit?: string
  confidence: number               // 0..1
  sourceHandles: string[]
  method: string
  backendTarget?: string           // project_inputs key for FIELD
  hostKey?: string                 // WALL key for WINDOW/DOOR; ROOM key for WALL
  anchorRule?: string
  anchorParams?: Record<string, unknown>
  representations?: { handle: string; repType: string; role: string }[]
}

const slug = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')
const isWallLayer = (l: string) => /WALL|A-WALL|S-WALL|PARTITION/i.test(l)
const isWindowBlock = (n = '') => /WIN|WDW|WINDOW/i.test(n)
const isDoorBlock = (n = '') => /DOOR|DR[_-]|DOR/i.test(n)

export function detect(doc: DxfDocument): Candidate[] {
  const k = unitsToFeet(doc.insunits)
  const out: Candidate[] = []
  const texts = doc.entities.filter((e) => (e.type === 'TEXT' || e.type === 'MTEXT') && e.text)
  const dims = doc.entities.filter((e) => e.type === 'DIMENSION')

  // Rooms: closed polylines with a plausible floor area; label = text inside.
  const rooms = doc.entities.filter((e) => e.type === 'LWPOLYLINE' && e.closed && e.points.length >= 4 && polygonArea(e.points) * k * k > 20)
  const roomKeys = new Map<DxfEntity, string>()
  for (const r of rooms) {
    const label = texts.find((t) => pointInPolygon(t.points[0], r.points))
    const name = label?.text?.replace(/\s+/g, ' ').trim() || `Room ${r.handle}`
    const key = `ROOM:${r.handle}`; roomKeys.set(r, key)
    out.push({ key, kind: 'ROOM', humanName: titleCase(name), semanticTag: `ROOM.${slug(name)}`, detectedValue: { points: r.points.map((p) => ({ x: p.x * k, y: p.y * k })), area_sf: polygonArea(r.points) * k * k }, unit: 'ft', confidence: label ? 0.8 : 0.5, sourceHandles: [r.handle, ...(label ? [label.handle] : [])], method: 'closed-polyline + label',
      representations: [{ handle: r.handle, repType: 'GEOMETRY', role: 'room-boundary' }, ...(label ? [{ handle: label.handle, repType: 'TEXT', role: 'room-label' }] : [])] })
    // Walls from room edges, named by compass direction relative to the room centroid.
    const cx = r.points.reduce((s, p) => s + p.x, 0) / r.points.length; const cy = r.points.reduce((s, p) => s + p.y, 0) / r.points.length
    const used = new Map<string, number>()
    for (let i = 0; i < r.points.length; i++) {
      const a = r.points[i], b = r.points[(i + 1) % r.points.length]
      if (dist(a, b) * k < 1) continue
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
      const horiz = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)
      let side = horiz ? (my > cy ? 'NORTH' : 'SOUTH') : (mx > cx ? 'EAST' : 'WEST')
      const n = (used.get(side) ?? 0) + 1; used.set(side, n); if (n > 1) side = `${side}_${n}`
      const wallHandles = wallLinesNear(doc, a, b, k).map((w) => w.handle)
      const dimHandles = dims.filter((d) => d.points[1] && d.points[2] && ((dist(d.points[1], a) * k < 0.5 && dist(d.points[2], b) * k < 0.5) || (dist(d.points[1], b) * k < 0.5 && dist(d.points[2], a) * k < 0.5))).map((d) => d.handle)
      out.push({ key: `WALL:${r.handle}:${i}`, kind: 'WALL', hostKey: key, humanName: `${titleCase(name)} ${titleCase(side.replace('_', ' '))} Wall`, semanticTag: `ROOM.${slug(name)}.WALL.${side}`,
        detectedValue: { x1: a.x * k, y1: a.y * k, x2: b.x * k, y2: b.y * k, length_ft: dist(a, b) * k }, unit: 'ft', confidence: wallHandles.length ? 0.85 : 0.6, sourceHandles: [r.handle, ...wallHandles, ...dimHandles], method: 'room-edge' + (wallHandles.length ? ' + wall-layer lines' : ''),
        anchorRule: 'ENDS_CONTROLLED_BY_ROOM_BOUNDARY',
        representations: [{ handle: r.handle, repType: 'GEOMETRY', role: `room-edge-${i}` }, ...wallHandles.map((h) => ({ handle: h, repType: 'GEOMETRY', role: 'wall-line' })), ...dimHandles.map((h) => ({ handle: h, repType: 'DIMENSION', role: 'length-dim' }))] })
    }
  }

  // Openings: block inserts named like windows/doors, hosted on the nearest wall edge.
  const walls = out.filter((c) => c.kind === 'WALL')
  let win = 0, door = 0
  for (const e of doc.entities) {
    if (e.type !== 'INSERT') continue
    const kind = isWindowBlock(e.blockName) ? 'WINDOW' : isDoorBlock(e.blockName) ? 'DOOR' : null
    if (!kind) continue
    const p = e.points[0]
    let best: { wall: Candidate; d: number; t: number } | null = null
    for (const w of walls) {
      const v = w.detectedValue as { x1: number; y1: number; x2: number; y2: number }
      const r = pointToSegment({ x: p.x * k, y: p.y * k }, { x: v.x1, y: v.y1 }, { x: v.x2, y: v.y2 })
      if (r.d < 1.5 && (!best || r.d < best.d)) best = { wall: w, d: r.d, t: r.t }
    }
    const n = kind === 'WINDOW' ? ++win : ++door
    const v = best?.wall.detectedValue as { x1: number; y1: number; x2: number; y2: number } | undefined
    // Anchor to the south (lower y) or west (lower x) end, matching the workbook's KEEP_OFFSET_FROM_SOUTH_END example.
    let anchorRule: string | undefined, anchorParams: Record<string, unknown> | undefined
    if (best && v) {
      const horiz = Math.abs(v.x2 - v.x1) >= Math.abs(v.y2 - v.y1)
      const fromStart = horiz ? v.x1 <= v.x2 : v.y1 <= v.y2
      const len = Math.hypot(v.x2 - v.x1, v.y2 - v.y1)
      const offset = fromStart ? best.t * len : (1 - best.t) * len
      anchorRule = horiz ? 'KEEP_OFFSET_FROM_WEST_END' : 'KEEP_OFFSET_FROM_SOUTH_END'
      anchorParams = { offset_ft: Math.round(offset * 1000) / 1000 }
    }
    const tagBase = best ? best.wall.semanticTag : 'UNHOSTED'
    out.push({ key: `${kind}:${e.handle}`, kind, hostKey: best?.wall.key, humanName: `${best ? best.wall.humanName.replace(/ Wall$/, '') : ''} ${kind === 'WINDOW' ? 'Window' : 'Door'} ${String(n).padStart(2, '0')}`.trim(),
      semanticTag: `${tagBase}.${kind}.${String(n).padStart(2, '0')}`, detectedValue: { x: p.x * k, y: p.y * k, block: e.blockName, rotation: e.rotation, attribs: e.attribs ?? {} }, unit: 'ft',
      confidence: best ? 0.75 : 0.4, sourceHandles: [e.handle], method: 'block-name + nearest wall', anchorRule, anchorParams, representations: [{ handle: e.handle, repType: 'GEOMETRY', role: 'opening-block' }] })
  }

  // Building extents from wall geometry → 01_INPUTS fields (00_CAD_CONFIRM CAD-001/002).
  const wallPts = walls.flatMap((w) => { const v = w.detectedValue as { x1: number; y1: number; x2: number; y2: number }; return [{ x: v.x1, y: v.y1 }, { x: v.x2, y: v.y2 }] })
  if (wallPts.length) {
    const xs = wallPts.map((p) => p.x), ys = wallPts.map((p) => p.y)
    out.push({ key: 'FIELD:BUILDING.LENGTH', kind: 'FIELD', humanName: 'Building Length', semanticTag: 'BUILDING.LENGTH', detectedValue: round3(Math.max(...xs) - Math.min(...xs)), unit: 'ft', confidence: 0.6, sourceHandles: [], method: 'wall extents', backendTarget: 'BUILDING.LENGTH' })
    out.push({ key: 'FIELD:BUILDING.WIDTH', kind: 'FIELD', humanName: 'Building Width', semanticTag: 'BUILDING.WIDTH', detectedValue: round3(Math.max(...ys) - Math.min(...ys)), unit: 'ft', confidence: 0.6, sourceHandles: [], method: 'wall extents', backendTarget: 'BUILDING.WIDTH' })
  }

  // Beam marks: text like B1, B4, HDR-2 → candidate members (span resolved later from supports).
  for (const t of texts) {
    const m = /^(B|HDR|BM)[- ]?(\d{1,3})$/i.exec(t.text ?? '')
    if (!m) continue
    out.push({ key: `BEAM:${t.handle}`, kind: 'BEAM', humanName: `Beam ${m[1].toUpperCase()}${m[2]}`, semanticTag: `STRUCT.BEAM.${m[1].toUpperCase()}${m[2]}`, detectedValue: { x: t.points[0].x * k, y: t.points[0].y * k }, unit: 'ft', confidence: 0.5, sourceHandles: [t.handle], method: 'member-mark text', representations: [{ handle: t.handle, repType: 'TAG', role: 'mark-text' }] })
  }

  // Title-block style fields.
  for (const t of texts) {
    const m = /^(SCALE|PROJECT(?: NAME)?|DATE|SHEET)\s*[:=]?\s*(.+)$/i.exec(t.text ?? '')
    if (!m || !m[2]) continue
    out.push({ key: `TEXT:${t.handle}`, kind: 'TEXT', humanName: titleCase(m[1]), semanticTag: `TITLEBLOCK.${slug(m[1])}`, detectedValue: m[2].trim(), confidence: 0.5, sourceHandles: [t.handle], method: 'title-block text', representations: [{ handle: t.handle, repType: 'TEXT', role: 'title-field' }] })
  }
  return out
}

function wallLinesNear(doc: DxfDocument, a: Pt, b: Pt, k: number): DxfEntity[] {
  return doc.entities.filter((e) => e.type === 'LINE' && isWallLayer(e.layer) && e.points.length === 2 && pointToSegment(e.points[0], a, b).d * k < 1 && pointToSegment(e.points[1], a, b).d * k < 1)
}
const round3 = (n: number) => Math.round(n * 1000) / 1000
function titleCase(s: string) { return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) }
