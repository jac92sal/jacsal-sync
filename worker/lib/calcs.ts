/** Runs calculation modules through the calc service with inputs assembled from the project schema and the object. */
import { all, insertStmt, one } from './db'
import { badRequest, parseJson, uuid } from './http'
import { getObject, patchObject } from './objects'
import type { CalcService } from '../../services/calc/src/index'

type Calc = Pick<CalcService, 'run' | 'list' | 'modulesForType' | 'benchmarks'>

/** Object-derived keys the modules expect. */
const DERIVED_MAP: Record<string, Record<string, string>> = {
  BEAM: { length_ft: 'span_ft' }, HEADER: { length_ft: 'span_ft' }, SHEAR_WALL: { length_ft: 'L_ft' }, WALL: { length_ft: 'L_ft' }, DIAPHRAGM: { length_ft: 'L_ft' },
}

export async function assembleInputs(db: D1Database, projectId: string, objectId: string | null, overrides: Record<string, unknown>) {
  const rows = await all<{ key: string; value: string | null }>(db, 'SELECT key, value FROM project_inputs WHERE project_id = ?', projectId)
  const inputs: Record<string, unknown> = {}
  for (const r of rows) inputs[r.key] = parseJson<unknown>(r.value, r.value)
  if (objectId) {
    const o = await getObject(db, objectId)
    for (const [k, v] of Object.entries(DERIVED_MAP[o.type] ?? {})) if (o.derived[k] !== undefined) inputs[v] = o.derived[k]
    // A member with no line geometry (e.g. a beam known only by its mark) gets its span from its supports:
    // Beam B4 SUPPORTED_BY PB.WEST_WALL and PB.EAST_WALL → span = distance between the support lines.
    if ((o.type === 'BEAM' || o.type === 'HEADER') && inputs.span_ft === undefined) {
      const supports = await all<{ to_id: string }>(db, `SELECT to_id FROM object_relations WHERE from_id = ? AND kind = 'SUPPORTED_BY'`, o.id)
      const segs = (await Promise.all(supports.map((s) => getObject(db, s.to_id)))).map((w) => w.geometry).filter((g) => g.x1 !== undefined)
      if (segs.length >= 2) {
        const mid = (g: typeof segs[number]) => ({ x: (g.x1! + g.x2!) / 2, y: (g.y1! + g.y2!) / 2 })
        const a = mid(segs[0]), b = mid(segs[1])
        inputs.span_ft = Math.round(Math.hypot(a.x - b.x, a.y - b.y) * 1e4) / 1e4
        inputs.span_source = `supports: ${supports.map((s) => s.to_id).join(', ')}`
      }
    }
    Object.assign(inputs, o.properties)
    inputs.member_mark ??= o.humanName; inputs.mark ??= o.humanName
  }
  return { ...inputs, ...overrides }
}

export async function runCalc(db: D1Database, calc: Calc, projectId: string, module: string, objectId: string | null, overrides: Record<string, unknown>, triggeredBy: string) {
  if (!module) throw badRequest('module is required.')
  const inputs = await assembleInputs(db, projectId, objectId, overrides)
  const result = await calc.run(module, inputs)
  const id = uuid()
  await insertStmt(db, 'calc_runs', { id, project_id: projectId, object_id: objectId, module, inputs, outputs: { results: result.results, checks: result.checks, gates: result.gates, notes: result.notes, missing: result.missing }, trace: result.trace, status: result.status, utilization: result.utilization, triggered_by: triggeredBy }).run()
  if (objectId) await patchObject(db, objectId, { verificationState: result.status === 'PASS' ? 'CALCULATED' : 'INCOMPLETE' })
  return { id, ...result, inputs }
}

export async function listCalcRuns(db: D1Database, projectId: string, limit = 100) {
  const rows = await all(db, `SELECT r.id, r.module, r.object_id, o.human_name AS object_name, r.status, r.utilization, r.triggered_by, r.created_at FROM calc_runs r LEFT JOIN objects o ON o.id = r.object_id WHERE r.project_id = ? ORDER BY r.created_at DESC LIMIT ?`, projectId, limit)
  return rows
}
export async function getCalcRun(db: D1Database, id: string) {
  const r = await one(db, 'SELECT * FROM calc_runs WHERE id = ?', id)
  if (!r) return null
  return { ...r, inputs: parseJson(r.inputs as string, {}), outputs: parseJson(r.outputs as string, {}), trace: parseJson(r.trace as string, []) }
}
