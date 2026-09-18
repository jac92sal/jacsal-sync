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

const slug = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40)

/** Words that mark a text as a room name on architectural plans. */
const ROOM_WORDS = /\b(KITCHEN|KIT|BATH(ROOM)?|BA|BED(ROOM)?|BR|MASTER|MBR|LIVING|LIV|DINING|DIN|FAMILY|FAM|GREAT|HALL(WAY)?|ENTRY|FOYER|PORCH|PATIO|DECK|GARAGE|GAR|CARPORT|CLOSET|CL|WIC|LAUNDRY|LNDRY|UTILITY|UTIL|MECH|STORAGE|STOR|OFFICE|STUDY|DEN|LOFT|NOOK|PANTRY|MUD ?ROOM|POWDER|STAIR(S)?|ADU|UNIT|SUITE|ROOM|RM|W\/D|WC|SHOWER|VESTIBULE|LOBBY|CORRIDOR|BALCONY|LANAI|SUNROOM|BONUS|MEDIA|GYM|SHOP|BASEMENT|ATTIC|CRAWL ?SPACE)\b/i
/** Texts that live in title blocks, notes, and schedules: never a room name. */
const NOT_A_ROOM = /\b(SCOPE|NOTE|NOTES|DATE|SHEET|SCALE|CHAPTER|ELEVATION|ELEVATIONS|SECTION|DETAIL|LEGEND|REVISION|ISSUED|DRAWN|CHECKED|PROJECT|CLIENT|OWNER|ADDRESS|TITLE|GENERAL|EXISTING|PROPOSED|DEMO|PLAN|SITE|ROOF|FLOOR PLAN|SCHEDULE|SPECIFICATION|CONTRACTOR|INSTALL|SHALL|PER\b|CODE|AVE|STREET|ST\b|CA \d{5})\b/i

/** Is this text plausible as the label of one room? */
export function roomLabelScore(text: string): number {
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t || t.length > 32 || t.split(' ').length > 4) return 0
  if (/^[\d'"\-\.\s x×]+$/i.test(t)) return 0            // dimensions like 12'-6" or 10x12
  if (NOT_A_ROOM.test(t)) return 0
  if (ROOM_WORDS.test(t)) return 1
  return /^[A-Z][A-Z ]{1,20}\d?$/i.test(t) ? 0.5 : 0
}
const isWallLayer = (l: string) => /WALL|A-WALL|S-WALL|PARTITION|MURO|BEARING|WAND|MUR\b/i.test(l)
const isWindowBlock = (n = '') => /WIN|WDW|WINDOW/i.test(n)
const isDoorBlock = (n = '') => /DOOR|DR[_-]|DOR/i.test(n)

export function detect(doc: DxfDocument): Candidate[] {
  const k = unitsToFeet(doc.insunits)
  const out: Candidate[] = []
  const texts = doc.entities.filter((e) => (e.type === 'TEXT' || e.type === 'MTEXT') && e.text)
  const dims = doc.entities.filter((e) => e.type === 'DIMENSION')

  // Rooms: closed polylines with a plausible floor area (15–2,500 sf, simple outline); label = the best room-like text inside.
  // Title blocks, note boxes and sheet borders are closed polylines too, so the label and area filters matter on real sheet sets.
  const rooms = doc.entities.filter((e) => { if (e.type !== 'LWPOLYLINE' || !e.closed || e.points.length < 4 || e.points.length > 24 || /HATCH|PATTERN|FILL/i.test(e.layer)) return false; const a = polygonArea(e.points) * k * k; return a >= 15 && a <= 2500 })
  // Room-name texts, for nearest-label matching when no label sits inside the outline (common in PDF-derived drawings).
  const roomTexts = texts.map((t) => ({ t, score: roomLabelScore(t.text ?? '') })).filter((x) => x.score >= 1)
  const claimed = new Set<string>()
  const roomKeys = new Map<DxfEntity, string>()
  const seenNames = new Map<string, number>()
  for (const r of rooms) {
    const inside = texts.filter((t) => pointInPolygon(t.points[0], r.points)).map((t) => ({ t, score: roomLabelScore(t.text ?? '') })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || (a.t.text?.length ?? 0) - (b.t.text?.length ?? 0))
    const area = polygonArea(r.points) * k * k
    let label = inside[0]?.t
    let labelScore = inside[0]?.score ?? 0
    let method = 'closed-polyline + room label'
    if (!label) {
      // Nearest unclaimed room-word text to the centroid, within roughly one room-width.
      const cx0 = r.points.reduce((s, p) => s + p.x, 0) / r.points.length; const cy0 = r.points.reduce((s, p) => s + p.y, 0) / r.points.length
      const reach = Math.sqrt(area) * 0.75 / k
      let best: { t: DxfEntity; d: number } | null = null
      for (const { t } of roomTexts) { if (claimed.has(t.handle)) continue; const d = dist(t.points[0], { x: cx0, y: cy0 }); if (d < reach && (!best || d < best.d)) best = { t, d } }
      if (best) { label = best.t; labelScore = 0.8; method = 'closed-polyline + nearest room label' }
    }
    if (label) claimed.add(label.handle)
    if (!label && (area < 40 || area > 1500)) continue           // unlabeled and not room-sized: almost certainly a border or a box
    let name = label?.text?.replace(/\s+/g, ' ').trim() || `Room ${r.handle}`
    // Same name twice on one sheet set (existing vs proposed, two bedrooms): number them so tags stay unique.
    const n = (seenNames.get(name.toUpperCase()) ?? 0) + 1; seenNames.set(name.toUpperCase(), n); if (n > 1) name = `${name} ${n}`
    const key = `ROOM:${r.handle}`; roomKeys.set(r, key)
    out.push({ key, kind: 'ROOM', humanName: titleCase(name), semanticTag: `ROOM.${slug(name)}`, detectedValue: { points: r.points.map((p) => ({ x: p.x * k, y: p.y * k })), area_sf: area }, unit: 'ft', confidence: labelScore >= 1 ? 0.85 : labelScore >= 0.8 ? 0.7 : label ? 0.6 : 0.4, sourceHandles: [r.handle, ...(label ? [label.handle] : [])], method: label ? method : 'closed-polyline (unlabeled)',
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

  // Walls straight from wall layers. PDF-derived sets and ArchiCAD/Revit exports draw walls as outlines on a wall
  // layer without closed room polygons, so room-edge walls above find nothing; each outline segment becomes a wall,
  // named by the nearest room label (within 30 ft) so the drafter recognises it.
  const covered = new Set(out.filter((c) => c.kind === 'WALL').flatMap((c) => c.sourceHandles))
  // Collect every wall-layer segment, then merge the two faces of an outlined wall into one centerline.
  type Seg = { a: Pt; b: Pt; handle: string; i: number; layer: string; used: boolean }
  const segsAll: Seg[] = []
  for (const e of doc.entities) {
    if ((e.type !== 'LWPOLYLINE' && e.type !== 'LINE') || !isWallLayer(e.layer) || covered.has(e.handle)) continue
    const pts = e.points; const n = e.type === 'LINE' ? 1 : e.closed ? pts.length : pts.length - 1
    for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; if (dist(a, b) * k >= 1) segsAll.push({ a, b, handle: e.handle, i, layer: e.layer, used: false }) }
  }
  const merged: { a: Pt; b: Pt; handles: string[]; roles: string[]; layer: string; thickness: number }[] = []
  for (let p = 0; p < segsAll.length; p++) {
    const s1 = segsAll[p]; if (s1.used) continue
    const d1 = { x: s1.b.x - s1.a.x, y: s1.b.y - s1.a.y }; const L1 = Math.hypot(d1.x, d1.y); const u = { x: d1.x / L1, y: d1.y / L1 }
    let mate: Seg | null = null; let mateOff = 0
    for (let q = p + 1; q < segsAll.length; q++) {
      const s2 = segsAll[q]; if (s2.used) continue
      const d2 = { x: s2.b.x - s2.a.x, y: s2.b.y - s2.a.y }; const L2 = Math.hypot(d2.x, d2.y)
      const cos = Math.abs((d1.x * d2.x + d1.y * d2.y) / (L1 * L2)); if (cos < 0.9986) continue          // within ~3°
      const off = Math.abs((s2.a.x - s1.a.x) * -u.y + (s2.a.y - s1.a.y) * u.x) * k                     // perpendicular gap in ft
      if (off < 0.25 || off > 1.5) continue                                                             // wall thickness 3"–18"
      const t1 = [0, L1], t2 = [((s2.a.x - s1.a.x) * u.x + (s2.a.y - s1.a.y) * u.y), ((s2.b.x - s1.a.x) * u.x + (s2.b.y - s1.a.y) * u.y)].sort((x, y) => x - y)
      const overlap = Math.min(t1[1], t2[1]) - Math.max(t1[0], t2[0])
      if (overlap * k < 1.5 || overlap < 0.5 * Math.min(L1, L2)) continue
      mate = s2; mateOff = off; break
    }
    s1.used = true
    if (mate) {
      mate.used = true
      // Centerline: midway between the faces, spanning the union of both extents.
      const ts = [0, L1, ((mate.a.x - s1.a.x) * u.x + (mate.a.y - s1.a.y) * u.y), ((mate.b.x - s1.a.x) * u.x + (mate.b.y - s1.a.y) * u.y)]
      const t0 = Math.min(...ts), t1 = Math.max(...ts)
      const nrm = { x: -u.y, y: u.x }; const side = Math.sign((mate.a.x - s1.a.x) * nrm.x + (mate.a.y - s1.a.y) * nrm.y) || 1
      const shift = (mateOff / k / 2) * side
      merged.push({ a: { x: s1.a.x + u.x * t0 + nrm.x * shift, y: s1.a.y + u.y * t0 + nrm.y * shift }, b: { x: s1.a.x + u.x * t1 + nrm.x * shift, y: s1.a.y + u.y * t1 + nrm.y * shift }, handles: [...new Set([s1.handle, mate.handle])], roles: [`wall-edge-${s1.i}`, `wall-edge-${mate.i}`], layer: s1.layer, thickness: mateOff })
    } else if (L1 * k >= 3) {
      merged.push({ a: s1.a, b: s1.b, handles: [s1.handle], roles: [`wall-edge-${s1.i}`], layer: s1.layer, thickness: 0 })
    }
  }
  // Chain collinear pieces (split at openings, intersections, or PDF line breaks) into whole wall runs.
  for (let changed = true; changed;) {
    changed = false
    for (let i = 0; i < merged.length && !changed; i++) for (let j = i + 1; j < merged.length; j++) {
      const A = merged[i], B = merged[j]
      const da = { x: A.b.x - A.a.x, y: A.b.y - A.a.y }, db = { x: B.b.x - B.a.x, y: B.b.y - B.a.y }
      const La = Math.hypot(da.x, da.y), Lb = Math.hypot(db.x, db.y); if (!La || !Lb) continue
      if (Math.abs((da.x * db.x + da.y * db.y) / (La * Lb)) < 0.9986) continue
      const u = { x: da.x / La, y: da.y / La }
      const offA = Math.abs((B.a.x - A.a.x) * -u.y + (B.a.y - A.a.y) * u.x) * k, offB = Math.abs((B.b.x - A.a.x) * -u.y + (B.b.y - A.a.y) * u.x) * k
      if (offA > 0.35 || offB > 0.35) continue                                                   // not collinear
      const ts = [0, La, (B.a.x - A.a.x) * u.x + (B.a.y - A.a.y) * u.y, (B.b.x - A.a.x) * u.x + (B.b.y - A.a.y) * u.y]
      const tb = [ts[2], ts[3]].sort((x, y) => x - y)
      const gap = Math.max(tb[0] - La, 0 - tb[1], 0)
      if (gap * k > 0.75) continue                                                                 // not touching
      const t0 = Math.min(...ts), t1 = Math.max(...ts)
      merged[i] = { a: { x: A.a.x + u.x * t0, y: A.a.y + u.y * t0 }, b: { x: A.a.x + u.x * t1, y: A.a.y + u.y * t1 }, handles: [...new Set([...A.handles, ...B.handles])], roles: [...A.roles, ...B.roles], layer: A.layer, thickness: A.thickness || B.thickness }
      merged.splice(j, 1); changed = true; break
    }
  }
  let wn = 0
  for (const m of merged) {
    if (wn >= 400) break
    {
      const a = m.a, b = m.b
      const len = dist(a, b) * k
      const e = { handle: m.handles[0], layer: m.layer, type: 'LWPOLYLINE' } as DxfEntity
      const i = 0
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
      let near: { t: DxfEntity; d: number } | null = null
      for (const { t } of roomTexts) { const d = dist(t.points[0], { x: mx, y: my }) * k; if (d < 30 && (!near || d < near.d)) near = { t, d } }
      const nm = near ? titleCase(near.t.text!.replace(/\s+/g, ' ').trim()) : 'Bearing'
      const horiz = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)
      const orient = horiz ? 'EW' : 'NS'
      const num = String(++wn).padStart(2, '0')
      void i
      out.push({ key: `WALL:${m.handles.join('+')}:${m.roles.join('+')}`, kind: 'WALL', humanName: `${nm} Wall ${orient} ${num}`, semanticTag: `WALL.${slug(nm)}.${orient}.${num}`,
        detectedValue: { x1: a.x * k, y1: a.y * k, x2: b.x * k, y2: b.y * k, length_ft: round3(len), thickness_ft: round3(m.thickness) }, unit: 'ft', confidence: m.thickness ? (near ? 0.75 : 0.65) : near ? 0.6 : 0.5, sourceHandles: [...m.handles, ...(near ? [near.t.handle] : [])], method: `${m.thickness ? 'wall outline centerline' : 'wall-layer line'} (${e.layer})`,
        anchorRule: 'FREE', representations: m.handles.map((h, j) => ({ handle: h, repType: 'GEOMETRY', role: m.roles[j] })) })
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
