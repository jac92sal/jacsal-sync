/** Semantic object model: candidates → objects, host chains, relations, and geometry maths. */
import { all, deriveGeometry, insertStmt, one, run, toObjectDto, updateStmt, type Geometry, type ObjectDto, type ObjectRow } from './db'
import { badRequest, conflict, notFound, parseJson, uuid } from './http'

export interface CandidateRow extends Record<string, unknown> {
  id: string; project_id: string; file_id: string | null; kind: string; human_name: string; semantic_tag: string | null; detected_value: string | null; unit: string | null
  confidence: number | null; source_handles: string | null; method: string | null; ckey: string | null; host_key: string | null; anchor_rule: string | null; anchor_params: string | null
  representations: string | null; action: string; edited_value: string | null; confirmed_value: string | null; backend_target: string | null; object_id: string | null
}

export async function getObject(db: D1Database, id: string): Promise<ObjectDto> {
  const r = await one<ObjectRow>(db, 'SELECT * FROM objects WHERE id = ?', id)
  if (!r) throw notFound('Object not found.')
  return toObjectDto(r)
}
export async function listObjects(db: D1Database, projectId: string): Promise<ObjectDto[]> {
  return (await all<ObjectRow>(db, 'SELECT * FROM objects WHERE project_id = ? ORDER BY created_at', projectId)).map(toObjectDto)
}
export async function findByTag(db: D1Database, projectId: string, tag: string): Promise<ObjectDto | null> {
  const r = await one<ObjectRow>(db, 'SELECT * FROM objects WHERE project_id = ? AND semantic_tag = ?', projectId, tag)
  return r ? toObjectDto(r) : null
}

export interface NewObject {
  type: string; humanName: string; semanticTag: string; parentId?: string | null; hostId?: string | null; function?: string | null
  anchorRule?: string | null; anchorParams?: Record<string, unknown>; geometry?: Geometry; geometrySource?: string | null; properties?: Record<string, unknown>
}
export async function createObject(db: D1Database, projectId: string, n: NewObject): Promise<ObjectDto> {
  if (!n.type || !n.humanName || !n.semanticTag) throw badRequest('type, humanName and semanticTag are required.')
  if (await findByTag(db, projectId, n.semanticTag)) throw conflict(`An object already uses the tag ${n.semanticTag}.`)
  const id = uuid()
  await insertStmt(db, 'objects', {
    id, project_id: projectId, type: n.type, human_name: n.humanName, semantic_tag: n.semanticTag, parent_id: n.parentId ?? null, host_id: n.hostId ?? null,
    function: n.function ?? DEFAULT_FUNCTION[n.type] ?? null, anchor_rule: n.anchorRule ?? null, anchor_params: n.anchorParams ?? {}, geometry: n.geometry ?? {},
    geometry_source: n.geometrySource ?? 'USER', derived: deriveGeometry(n.geometry ?? {}), properties: n.properties ?? {},
  }).run()
  return getObject(db, id)
}

const DEFAULT_FUNCTION: Record<string, string> = {
  ROOM: 'Spatial assembly / host container', WALL: 'Enclose room / host openings', WINDOW: 'Opening / daylight / egress as applicable', DOOR: 'Opening / egress',
  BEAM: 'Transfer gravity load', HEADER: 'Transfer gravity load over opening', POST: 'Transfer beam reaction to foundation', SHEAR_WALL: 'Resist lateral load / transfer to foundation',
  FOOTING: 'Transfer building load to soil', HOLDOWN: 'Resist overturning tension', DIAPHRAGM: 'Distribute lateral load to shear walls', LEVEL: 'Vertical project container',
}

export async function patchObject(db: D1Database, id: string, patch: Partial<NewObject> & { verificationState?: string; approvalState?: string }): Promise<ObjectDto> {
  const cur = await getObject(db, id)
  const row: Record<string, unknown> = {}
  if (patch.humanName !== undefined) row.human_name = patch.humanName
  if (patch.semanticTag !== undefined && patch.semanticTag !== cur.semanticTag) {
    if (await findByTag(db, cur.projectId, patch.semanticTag)) throw conflict(`An object already uses the tag ${patch.semanticTag}.`)
    row.semantic_tag = patch.semanticTag
  }
  if (patch.function !== undefined) row.function = patch.function
  if (patch.anchorRule !== undefined) row.anchor_rule = patch.anchorRule
  if (patch.anchorParams !== undefined) row.anchor_params = patch.anchorParams
  if (patch.properties !== undefined) row.properties = { ...cur.properties, ...patch.properties }
  if (patch.hostId !== undefined) row.host_id = patch.hostId
  if (patch.parentId !== undefined) row.parent_id = patch.parentId
  if (patch.geometry !== undefined) { row.geometry = patch.geometry; row.derived = deriveGeometry(patch.geometry); row.geometry_source = patch.geometrySource ?? 'USER'; row.revision = cur.revision + 1 }
  if (patch.verificationState !== undefined) row.verification_state = patch.verificationState
  if (patch.approvalState !== undefined) row.approval_state = patch.approvalState
  if (Object.keys(row).length) await updateStmt(db, 'objects', id, row).run()
  return getObject(db, id)
}

/** Confirm a candidate (and its host chain first). Returns the created/linked object, or null for FIELD candidates. */
export async function confirmCandidate(db: D1Database, cand: CandidateRow, actor: string, editedValue?: unknown): Promise<ObjectDto | null> {
  if (cand.object_id) return getObject(db, cand.object_id)
  const value = editedValue !== undefined ? editedValue : parseJson<unknown>(cand.detected_value, null)
  if (cand.kind === 'FIELD' || cand.kind === 'TEXT') {
    if (cand.backend_target) {
      await run(db, `INSERT INTO project_inputs (project_id, key, value, unit, source, status, updated_by) VALUES (?, ?, ?, ?, ?, 'READY', ?)
        ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value, unit = excluded.unit, source = excluded.source, status = 'READY', updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        cand.project_id, cand.backend_target, JSON.stringify(value), cand.unit, `CAD:${cand.id}`, actor)
    }
    await run(db, `UPDATE candidates SET action = ?, edited_value = ?, confirmed_value = ?, confirmed_by = ?, confirmed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      editedValue !== undefined ? 'EDIT' : 'CONFIRM', editedValue !== undefined ? JSON.stringify(editedValue) : null, JSON.stringify(value), actor, cand.id)
    return null
  }
  // Host chain: a WINDOW needs its WALL, a WALL needs its ROOM.
  let hostId: string | null = null
  if (cand.host_key) {
    const host = await one<CandidateRow>(db, 'SELECT * FROM candidates WHERE project_id = ? AND file_id IS ? AND ckey = ?', cand.project_id, cand.file_id, cand.host_key)
    if (host) hostId = (await confirmCandidate(db, host, actor))?.id ?? null
  }
  const v = (value ?? {}) as Record<string, unknown>
  const geometry: Geometry = cand.kind === 'ROOM' ? { points: v.points as Geometry['points'] } : cand.kind === 'WALL' ? { x1: v.x1 as number, y1: v.y1 as number, x2: v.x2 as number, y2: v.y2 as number } : { x: v.x as number, y: v.y as number }
  const props: Record<string, unknown> = {}
  if (cand.kind === 'WINDOW' || cand.kind === 'DOOR') Object.assign(props, { block: v.block, rotation: v.rotation, attribs: v.attribs })
  const existing = cand.semantic_tag ? await findByTag(db, cand.project_id, cand.semantic_tag) : null
  // The floor-plan unit this element sits on (rooms and free walls hang off it; hosted elements follow their host).
  const plan = await planContaining(db, cand.project_id, geometry)
  const obj = existing ?? (await createObject(db, cand.project_id, {
    type: cand.kind, humanName: cand.human_name, semanticTag: cand.semantic_tag ?? `${cand.kind}.${cand.id.slice(0, 8).toUpperCase()}`,
    parentId: cand.kind === 'WALL' ? (hostId ?? plan) : cand.kind === 'WINDOW' || cand.kind === 'DOOR' ? (hostId ? (await getObject(db, hostId)).parentId : plan) : plan,
    hostId: cand.kind === 'WALL' ? null : hostId, anchorRule: cand.anchor_rule, anchorParams: parseJson(cand.anchor_params, {}), geometry, geometrySource: `CAD:${cand.id}`, properties: props,
  }))
  // Representations: every drawing entity that shows this object.
  const reps = parseJson<{ handle: string; repType: string; role: string }[]>(cand.representations, [])
  if (cand.file_id && reps.length) {
    await db.batch(reps.map((r) => insertStmt(db, 'representations', { id: uuid(), project_id: cand.project_id, object_id: obj.id, file_id: cand.file_id, handle: r.handle, rep_type: r.repType, role: r.role, last_value: geometry, synced: 1 })))
  }
  await run(db, `UPDATE candidates SET action = ?, edited_value = ?, confirmed_value = ?, confirmed_by = ?, object_id = ?, confirmed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    editedValue !== undefined ? 'EDIT' : 'CONFIRM', editedValue !== undefined ? JSON.stringify(editedValue) : null, JSON.stringify(value), actor, obj.id, cand.id)
  return obj
}

/** Resolve a wall's new geometry for a length change, keeping one end fixed. */
export function resizeSegment(g: Geometry, newLength: number, movingEnd: 'start' | 'end'): Geometry {
  const { x1 = 0, y1 = 0, x2 = 0, y2 = 0 } = g
  const len = Math.hypot(x2 - x1, y2 - y1) || 1
  const ux = (x2 - x1) / len, uy = (y2 - y1) / len
  return movingEnd === 'end' ? { x1, y1, x2: r6(x1 + ux * newLength), y2: r6(y1 + uy * newLength) } : { x1: r6(x2 - ux * newLength), y1: r6(y2 - uy * newLength), x2, y2 }
}
export const r6 = (n: number) => Math.round(n * 1e6) / 1e6
export const near = (a: { x: number; y: number }, b: { x: number; y: number }, tol = 0.01) => Math.hypot(a.x - b.x, a.y - b.y) <= tol

/** Which end of a segment is the "south" (lower y) or "west" (lower x) end. */
export function anchorEnd(g: Geometry, rule: string | null): 'start' | 'end' | null {
  const { x1 = 0, y1 = 0, x2 = 0, y2 = 0 } = g
  if (rule === 'KEEP_OFFSET_FROM_SOUTH_END') return y1 <= y2 ? 'start' : 'end'
  if (rule === 'KEEP_OFFSET_FROM_NORTH_END') return y1 <= y2 ? 'end' : 'start'
  if (rule === 'KEEP_OFFSET_FROM_WEST_END') return x1 <= x2 ? 'start' : 'end'
  if (rule === 'KEEP_OFFSET_FROM_EAST_END') return x1 <= x2 ? 'end' : 'start'
  return null
}

/** Id of the FLOOR_PLAN object whose extent contains the geometry (all points), or null. */
async function planContaining(db: D1Database, projectId: string, g: Geometry): Promise<string | null> {
  const pts: { x: number; y: number }[] = g.points ? g.points : g.x1 !== undefined ? [{ x: g.x1, y: g.y1! }, { x: g.x2!, y: g.y2! }] : g.x !== undefined ? [{ x: g.x, y: g.y! }] : []
  if (!pts.length) return null
  const plans = await all<{ id: string; geometry: string }>(db, `SELECT id, geometry FROM objects WHERE project_id = ? AND type = 'FLOOR_PLAN'`, projectId)
  for (const p of plans) {
    const box = (JSON.parse(p.geometry) as Geometry).points ?? []
    if (box.length < 4) continue
    const minX = Math.min(...box.map((q) => q.x)) - 1, maxX = Math.max(...box.map((q) => q.x)) + 1, minY = Math.min(...box.map((q) => q.y)) - 1, maxY = Math.max(...box.map((q) => q.y)) + 1
    if (pts.every((q) => q.x >= minX && q.x <= maxX && q.y >= minY && q.y <= maxY)) return p.id
  }
  return null
}
