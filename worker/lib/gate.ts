/** 00_ISSUE_GATE — a set is ready when every applicable domain is defined, verified, synced and approved. */
import { all, one } from './db'

const CRITERIA_KEYS = ['floor_dead_psf', 'floor_live_psf', 'roof_dead_psf', 'roof_live_psf', 'V_mph', 'exposure', 'SDS', 'SD1']
const CALC_DOMAINS: [string, string, string][] = [
  ['Wind', 'wind', '16_WIND'], ['Seismic', 'seismic', '18_SEISMIC'], ['Wood Beam / Header', 'wood-beam', '20_WOOD_BEAM'], ['Wood Column / Post', 'wood-column', '22_WOOD_COLUMN'],
  ['Shear Wall', 'shear-wall', '24_SHEAR_WALL'], ['Diaphragm', 'diaphragm', '25_DIAPHRAGM'], ['Connections', 'connections', '28_CONNECTIONS'], ['Holdowns', 'holdown', '29_HOLDOWN'],
  ['Sill / Anchors', 'sill-anchor', '30_SILL_ANCHOR'], ['Collectors / Chords', 'collector-chord', '31_COLLECTOR_CHORD'], ['Foundation', 'foundation', '36_FOUNDATION'],
]
export interface GateRow { domain: string; functionState: string; verificationState: string; designSync: string; approval: string; gate: 'READY' | 'REVIEW' | 'PENDING' | 'FAIL' | 'N/A'; location: string }

export async function issueGate(db: D1Database, projectId: string): Promise<{ rows: GateRow[]; overall: string }> {
  const p = await one<Record<string, unknown>>(db, 'SELECT * FROM projects WHERE id = ?', projectId)
  const rows: GateRow[] = []
  const setupOk = !!(p?.name && p?.address && p?.code_path && p?.risk_category && p?.design_method)
  rows.push({ domain: 'Project Setup', functionState: setupOk ? 'COMPLETE' : 'INCOMPLETE', verificationState: setupOk ? 'VERIFIED' : 'PENDING', designSync: 'N/A', approval: setupOk ? 'APPROVED' : 'PENDING', gate: setupOk ? 'READY' : 'PENDING', location: 'Project' })

  const files = await one<{ n: number; parsed: number }>(db, `SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'PARSED' THEN 1 ELSE 0 END) AS parsed FROM cad_files WHERE project_id = ?`, projectId)
  const pendingCands = (await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM candidates WHERE project_id = ? AND action = 'PENDING'`, projectId))?.n ?? 0
  const cadDefined = (files?.n ?? 0) > 0
  const cadSynced = cadDefined && pendingCands === 0
  rows.push({ domain: 'CAD / Geometry', functionState: cadDefined ? 'DEFINED' : 'INCOMPLETE', verificationState: 'CONFIRMATION REQUIRED', designSync: cadSynced ? 'SYNCED / CONFIRMED' : `PENDING (${pendingCands} candidates)`, approval: cadSynced ? 'APPROVED' : 'PENDING', gate: cadDefined && cadSynced ? 'READY' : 'PENDING', location: 'CAD Confirm / Object Model' })

  const inputs = new Set((await all<{ key: string }>(db, 'SELECT key FROM project_inputs WHERE project_id = ?', projectId)).map((r) => r.key))
  const missing = CRITERIA_KEYS.filter((k) => !inputs.has(k))
  rows.push({ domain: 'Design Criteria / Hazards', functionState: missing.length ? `INCOMPLETE (${missing.join(', ')})` : 'DEFINED', verificationState: missing.length ? 'PENDING' : 'REVIEW', designSync: 'N/A', approval: 'ENGINEER REVIEW', gate: missing.length ? 'PENDING' : 'REVIEW', location: 'Inputs' })

  const latest = await all<{ module: string; status: string }>(db, `SELECT module, status FROM calc_runs r WHERE project_id = ? AND created_at = (SELECT MAX(created_at) FROM calc_runs r2 WHERE r2.project_id = r.project_id AND r2.module = r.module)`, projectId)
  const byModule = new Map(latest.map((r) => [r.module, r.status]))
  for (const [domain, module, sheet] of CALC_DOMAINS) {
    const st = byModule.get(module)
    const fn = st ?? 'PENDING'
    const ver = st === 'PASS' || st === 'REVIEW' ? 'VERIFIED / REVIEW' : 'PENDING'
    const gate: GateRow['gate'] = st === 'FAIL' ? 'FAIL' : !st || st === 'PENDING' ? 'PENDING' : 'REVIEW'
    rows.push({ domain, functionState: fn, verificationState: ver, designSync: 'PENDING', approval: 'ENGINEER REVIEW', gate, location: sheet })
  }

  const changes = await all<{ status: string; reconciliation: string | null }>(db, 'SELECT status, reconciliation FROM change_requests WHERE project_id = ?', projectId)
  if (!changes.length) rows.push({ domain: 'Change / Revision Reconciliation', functionState: 'N/A', verificationState: 'N/A', designSync: 'N/A', approval: 'N/A', gate: 'N/A', location: 'Change Impact' })
  else {
    const rejected = changes.some((c) => c.status === 'REJECTED'), mismatch = changes.some((c) => c.reconciliation === 'MISMATCH'), open = changes.some((c) => ['PENDING', 'APPROVED', 'APPLIED'].includes(c.status) && c.reconciliation !== 'MATCH')
    rows.push({ domain: 'Change / Revision Reconciliation', functionState: 'DEFINED', verificationState: rejected ? 'FAIL' : 'REVIEW', designSync: mismatch ? 'MISMATCH' : open ? 'PENDING' : 'MATCH', approval: open ? 'PENDING' : 'APPROVED', gate: mismatch ? 'FAIL' : open ? 'PENDING' : 'REVIEW', location: 'Change Impact' })
  }
  const applicable = rows.filter((r) => r.gate !== 'N/A')
  const overall = applicable.some((r) => r.gate === 'FAIL') ? 'FAIL' : applicable.some((r) => r.gate === 'PENDING') ? 'PENDING' : 'REVIEW / APPROVAL'
  return { rows, overall }
}
