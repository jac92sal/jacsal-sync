/** Thin D1 helpers. Every table is tenant-scoped by project_id; callers pass it explicitly. */
import { parseJson } from './http'

export type Row = Record<string, unknown>

export async function one<T extends Row = Row>(db: D1Database, sql: string, ...bind: unknown[]): Promise<T | null> {
  return (await db.prepare(sql).bind(...bind).first<T>()) ?? null
}
export async function all<T extends Row = Row>(db: D1Database, sql: string, ...bind: unknown[]): Promise<T[]> {
  return (await db.prepare(sql).bind(...bind).all<T>()).results
}
export async function run(db: D1Database, sql: string, ...bind: unknown[]): Promise<D1Result> {
  return db.prepare(sql).bind(...bind).run()
}

/** Insert a row from an object; JSON-serialises object/array values. */
export function insertStmt(db: D1Database, table: string, row: Row): D1PreparedStatement {
  const keys = Object.keys(row)
  const vals = keys.map((k) => serialize(row[k]))
  return db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).bind(...vals)
}
export function updateStmt(db: D1Database, table: string, id: string, patch: Row): D1PreparedStatement {
  const keys = Object.keys(patch)
  return db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).bind(...keys.map((k) => serialize(patch[k])), id)
}
function serialize(v: unknown): unknown {
  if (v === undefined) return null
  if (v !== null && typeof v === 'object') return JSON.stringify(v)
  return v
}

/** Objects keep JSON columns; hydrate them for the API. */
export interface ObjectRow extends Row {
  id: string; project_id: string; type: string; human_name: string; semantic_tag: string; parent_id: string | null; host_id: string | null
  function: string | null; anchor_rule: string | null; anchor_params: string | null; geometry: string | null; geometry_source: string | null
  derived: string | null; properties: string | null; verification_state: string; approval_state: string; revision: number; created_at: string; updated_at: string
}
export type Geometry = { x1?: number; y1?: number; x2?: number; y2?: number; x?: number; y?: number; points?: { x: number; y: number }[] }
export interface ObjectDto {
  id: string; projectId: string; type: string; humanName: string; semanticTag: string; parentId: string | null; hostId: string | null; function: string | null
  anchorRule: string | null; anchorParams: Record<string, unknown>; geometry: Geometry; geometrySource: string | null; derived: Record<string, unknown>
  properties: Record<string, unknown>; verificationState: string; approvalState: string; revision: number; createdAt: string; updatedAt: string
}
export function toObjectDto(r: ObjectRow): ObjectDto {
  return {
    id: r.id, projectId: r.project_id, type: r.type, humanName: r.human_name, semanticTag: r.semantic_tag, parentId: r.parent_id, hostId: r.host_id, function: r.function,
    anchorRule: r.anchor_rule, anchorParams: parseJson(r.anchor_params, {}), geometry: parseJson<Geometry>(r.geometry, {}), geometrySource: r.geometry_source,
    derived: parseJson(r.derived, {}), properties: parseJson(r.properties, {}), verificationState: r.verification_state, approvalState: r.approval_state, revision: r.revision, createdAt: r.created_at, updatedAt: r.updated_at,
  }
}
export function deriveGeometry(g: Geometry): Record<string, unknown> {
  const d: Record<string, unknown> = {}
  if (g.x1 !== undefined && g.y1 !== undefined && g.x2 !== undefined && g.y2 !== undefined) {
    d.length_ft = Math.round(Math.hypot(g.x2 - g.x1, g.y2 - g.y1) * 1e4) / 1e4
    d.orientation = Math.abs(g.x2 - g.x1) >= Math.abs(g.y2 - g.y1) ? 'HORIZONTAL' : 'VERTICAL'
  }
  if (g.points && g.points.length >= 3) {
    let s = 0; const p = g.points
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += (p[j].x + p[i].x) * (p[j].y - p[i].y)
    d.area_sf = Math.round(Math.abs(s / 2) * 100) / 100
    d.perimeter_ft = Math.round(p.reduce((acc, pt, i) => acc + Math.hypot(pt.x - p[(i + 1) % p.length].x, pt.y - p[(i + 1) % p.length].y), 0) * 100) / 100
  }
  return d
}
