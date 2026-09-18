/**
 * Model pages inside a sheet set.
 *
 * Architectural DWGs frequently carry a whole drawing set in model space: floor plans,
 * elevations, notes, schedules and title blocks laid side by side (PDF imports, ArchiCAD
 * exports). Only the floor plans are the model; everything else is derived from them.
 *
 * A model page is found from its room labels: room-name texts within 60 ft of each other
 * form one plan. The plan's extent starts from the label bounding box and grows to include
 * nearby drawing geometry, but never entities wider than a room block (sheet borders, title
 * block frames), so a plan never swallows its sheet.
 */
import { type DxfDocument, type DxfEntity, type ModelRegion, unitsToFeet } from './dxf'
import { roomLabelScore } from './detect'

type Box = { minX: number; minY: number; maxX: number; maxY: number }

const bboxOf = (e: DxfEntity): Box | null => {
  if (!e.points.length) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of e.points) { if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue; if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y }
  if (!Number.isFinite(minX)) return null
  if (e.type === 'CIRCLE' || e.type === 'ARC') { const r = e.height ?? 0; minX -= r; maxX += r; minY -= r; maxY += r }
  return { minX, minY, maxX, maxY }
}
const intersects = (a: Box, b: Box) => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY
const expand = (b: Box, d: number): Box => ({ minX: b.minX - d, minY: b.minY - d, maxX: b.maxX + d, maxY: b.maxY + d })
const union = (a: Box, b: Box): Box => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) })
const titleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())

/** Finds model pages and tags every entity inside one with `model`. Coordinates in bbox are drawing units. */
export function findModels(doc: DxfDocument): ModelRegion[] {
  const k = unitsToFeet(doc.insunits)
  const ft = (n: number) => n / k                                         // feet → drawing units
  const labels = doc.entities.filter((e) => (e.type === 'TEXT' || e.type === 'MTEXT') && e.text && roomLabelScore(e.text) >= 1 && e.points[0])
  if (labels.length < 2) return []

  // 1. Single-link clustering of labels within 60 ft.
  const parent = labels.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const link = ft(60)
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
    const a = labels[i].points[0], b = labels[j].points[0]
    if (Math.hypot(a.x - b.x, a.y - b.y) <= link) parent[find(i)] = find(j)
  }
  const groups = new Map<number, DxfEntity[]>()
  labels.forEach((l, i) => { const r = find(i); (groups.get(r) ?? groups.set(r, []).get(r)!).push(l) })

  // 2. Grow each group's box over nearby geometry, ignoring sheet-scale entities.
  const boxes = doc.entities.map(bboxOf)
  const maxSpan = ft(80)
  const models: ModelRegion[] = []
  for (const group of groups.values()) {
    if (group.length < 2) continue
    let box: Box = group.map((l) => bboxOf(l)!).reduce(union)
    box = expand(box, ft(12))
    for (let pass = 0; pass < 3; pass++) {
      let grew = false
      const probe = expand(box, ft(4))
      doc.entities.forEach((e, i) => {
        const b = boxes[i]
        if (!b || e.type === 'TEXT' || e.type === 'MTEXT') return
        if (b.maxX - b.minX > maxSpan || b.maxY - b.minY > maxSpan) return
        if (!intersects(b, probe)) return
        const u = union(box, b)
        if (u.minX < box.minX || u.minY < box.minY || u.maxX > box.maxX || u.maxY > box.maxY) { box = u; grew = true }
      })
      if (!grew) break
    }
    // Cap the plan to a building-sized window around the labels so growth cannot run along a long sheet element.
    const lb = group.map((l) => bboxOf(l)!).reduce(union)
    const cap = expand(lb, ft(60))
    box = { minX: Math.max(box.minX, cap.minX), minY: Math.max(box.minY, cap.minY), maxX: Math.min(box.maxX, cap.maxX), maxY: Math.min(box.maxY, cap.maxY) }
    models.push({ ix: models.length, title: '', labels: [...new Set(group.map((l) => titleCase(l.text!.replace(/\s+/g, ' ').trim())))], bbox: box, entityCount: 0, wallCount: 0 })
  }
  if (!models.length) return []

  // 3. Assign entities by centroid; larger label groups win overlaps.
  models.sort((a, b) => b.labels.length - a.labels.length).forEach((m, i) => { m.ix = i })
  doc.entities.forEach((e, i) => {
    const b = boxes[i]; if (!b) return
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2
    for (const m of models) {
      if (cx >= m.bbox.minX && cx <= m.bbox.maxX && cy >= m.bbox.minY && cy <= m.bbox.maxY) { e.model = m.ix; m.entityCount++; if (/WALL|MURO|BEARING|PARTITION/i.test(e.layer)) m.wallCount++; break }
    }
  })
  // 4. Keep floor plans only: at least two short room names and real wall geometry. Schedules and fixture
  //    lists also mention "Kitchen" or "Shower" but have long product-style labels and no walls.
  const keep = models.filter((m) => m.labels.filter((l) => l.split(' ').length <= 2 && l.length <= 14).length >= 2 && m.wallCount >= 2)
  const remap = new Map(keep.map((m, i) => [m.ix, i]))
  doc.entities.forEach((e) => { if (e.model !== undefined) e.model = remap.get(e.model) })
  keep.forEach((m, i) => { m.ix = i })
  for (const m of keep) {
    const shown = m.labels.slice(0, 5).join(', ') + (m.labels.length > 5 ? '…' : '')
    m.title = `Model ${m.ix + 1}: ${shown}`
  }
  return keep
}
