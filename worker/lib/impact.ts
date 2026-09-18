/**
 * Change impact engine. A change never silently edits the set: it resolves the
 * dependency graph and produces an impact set (objects, calcs, drawing
 * representations) with exact proposed revisions for humans to approve.
 */
import { all, insertStmt, one, run, toObjectDto, updateStmt, type Geometry, type ObjectDto, type ObjectRow } from './db'
import { badRequest, conflict, notFound, parseJson, uuid } from './http'
import { anchorEnd, getObject, listObjects, near, patchObject, r6, resizeSegment } from './objects'
import type { WriteOp } from '../../services/cad/src/index'

export interface Impact {
  id: string; targetKind: 'OBJECT' | 'CALC' | 'REPRESENTATION'; targetId: string | null; domain: 'STRUCTURAL' | 'DESIGN' | 'DOCUMENTATION'
  severity: 'CRITICAL' | 'ATTENTION' | 'INFO'; summary: string; detail: Record<string, unknown>; proposed: Record<string, unknown> | null; module: string | null
}
export interface ChangeRequest {
  objectId: string; property: string; proposedValue: unknown; reason?: string; movingEnd?: 'start' | 'end'
}

const STRUCTURAL = new Set(['BEAM', 'HEADER', 'POST', 'COLUMN', 'SHEAR_WALL', 'HOLDOWN', 'FOOTING', 'DIAPHRAGM', 'COLLECTOR', 'CONNECTION'])
const CALC_FOR: Record<string, string[]> = { BEAM: ['wood-beam'], HEADER: ['wood-beam'], POST: ['wood-column'], COLUMN: ['wood-column'], SHEAR_WALL: ['shear-wall', 'holdown', 'sill-anchor'], DIAPHRAGM: ['diaphragm', 'collector-chord'], HOLDOWN: ['holdown'], FOOTING: ['foundation'], CONNECTION: ['connections'], COLLECTOR: ['collector-chord'] }

export async function proposeChange(db: D1Database, projectId: string, req: ChangeRequest, actor: string) {
  const obj = await getObject(db, req.objectId)
  if (obj.projectId !== projectId) throw notFound('Object not found in this project.')
  const objects = await listObjects(db, projectId)
  const byId = new Map(objects.map((o) => [o.id, o]))
  const relations = await all<{ from_id: string; to_id: string; kind: string; params: string | null }>(db, 'SELECT from_id, to_id, kind, params FROM object_relations WHERE project_id = ?', projectId)
  const reps = await all<{ id: string; object_id: string; file_id: string; handle: string; rep_type: string; role: string; last_value: string | null }>(db, 'SELECT id, object_id, file_id, handle, rep_type, role, last_value FROM representations WHERE project_id = ?', projectId)
  const impacts: Impact[] = []
  const touched = new Map<string, Geometry>()           // objectId → proposed geometry
  const add = (i: Omit<Impact, 'id'>) => impacts.push({ id: uuid(), ...i })

  let currentValue: unknown; let proposedValue = req.proposedValue
  if (req.property === 'length_ft') {
    if (obj.type !== 'WALL' && obj.type !== 'BEAM' && obj.type !== 'SHEAR_WALL') throw badRequest('length_ft applies to linear objects only.')
    const newLen = Number(proposedValue); if (!Number.isFinite(newLen) || newLen <= 0) throw badRequest('proposedValue must be a positive length in feet.')
    currentValue = obj.derived.length_ft
    const movingEnd = req.movingEnd ?? 'end'
    const g = resizeSegment(obj.geometry, newLen, movingEnd)
    touched.set(obj.id, g)
    add({ targetKind: 'OBJECT', targetId: obj.id, domain: 'DESIGN', severity: 'ATTENTION', summary: `${obj.humanName.toUpperCase()}: LENGTH ${fmt(currentValue as number)} → ${fmt(newLen)} (${movingEnd} end moves)`, detail: { rule: 'RESIZE_KEEP_FIXED_END', movingEnd }, proposed: { geometry: g }, module: null })
    hostedImpacts(obj, g, movingEnd, objects, add, touched)
    roomAndSiblingImpacts(obj, g, movingEnd, objects, add, touched)
  } else if (req.property === 'geometry') {
    currentValue = obj.geometry
    const g = proposedValue as Geometry
    if (!g || typeof g !== 'object') throw badRequest('proposedValue must be a geometry object.')
    touched.set(obj.id, g)
    add({ targetKind: 'OBJECT', targetId: obj.id, domain: 'DESIGN', severity: 'ATTENTION', summary: `${obj.humanName.toUpperCase()}: GEOMETRY EDITED`, detail: { rule: 'DIRECT_GEOMETRY' }, proposed: { geometry: g }, module: null })
    if (obj.type === 'WALL') { hostedImpacts(obj, g, 'end', objects, add, touched); roomAndSiblingImpacts(obj, g, 'end', objects, add, touched) }
  } else if (req.property.startsWith('properties.')) {
    const key = req.property.slice('properties.'.length)
    currentValue = obj.properties[key]
    add({ targetKind: 'OBJECT', targetId: obj.id, domain: 'DESIGN', severity: 'INFO', summary: `${obj.humanName.toUpperCase()}: ${key.toUpperCase()} ${String(currentValue ?? '—')} → ${String(proposedValue)}`, detail: { rule: 'PROPERTY' }, proposed: { properties: { [key]: proposedValue } }, module: null })
  } else throw badRequest(`Unsupported property ${req.property}.`)

  // Structural dependents: anything supported by / hosted on a touched object, and their calcs.
  const structuralSeen = new Set<string>()
  const structuralFrom = (id: string, why: string, depth = 0) => {
    if (depth > 4) return
    const dependents = [
      ...relations.filter((r) => r.to_id === id && ['SUPPORTED_BY', 'LOADS', 'ANCHORS_TO', 'COLLECTS'].includes(r.kind)).map((r) => byId.get(r.from_id)),
      ...objects.filter((o) => o.hostId === id && STRUCTURAL.has(o.type)),
      ...relations.filter((r) => r.from_id === id && r.kind === 'SUPPORTS').map((r) => byId.get(r.to_id)),
    ].filter((o): o is ObjectDto => !!o && !structuralSeen.has(o.id))
    for (const d of dependents) {
      structuralSeen.add(d.id)
      const mods = CALC_FOR[d.type] ?? []
      const label = d.type === 'BEAM' || d.type === 'HEADER' ? 'SPAN CHANGED (Requires Recalculation)' : d.type === 'SHEAR_WALL' ? 'LENGTH / ASPECT RATIO CHANGED (Requires Recalculation)' : d.type === 'FOOTING' || d.type === 'POST' ? 'REACTION CHANGE (Pending Calculation)' : 'DEPENDENCY CHANGED (Requires Recalculation)'
      add({ targetKind: 'OBJECT', targetId: d.id, domain: 'STRUCTURAL', severity: 'CRITICAL', summary: `${d.humanName.toUpperCase()}: ${label}`, detail: { because: why, anchorRule: d.anchorRule }, proposed: d.hostId && touched.has(d.hostId) && d.type === 'SHEAR_WALL' ? { geometry: touched.get(d.hostId) } : null, module: null })
      for (const m of mods) add({ targetKind: 'CALC', targetId: d.id, domain: 'STRUCTURAL', severity: 'CRITICAL', summary: `${d.humanName.toUpperCase()}: RERUN ${m}`, detail: { because: why }, proposed: null, module: m })
      structuralFrom(d.id, `${d.humanName} changed`, depth + 1)
    }
  }
  for (const [id] of touched) structuralFrom(id, `${byId.get(id)?.humanName ?? id} changed`)
  if (req.property.startsWith('properties.')) for (const m of CALC_FOR[obj.type] ?? []) add({ targetKind: 'CALC', targetId: obj.id, domain: 'STRUCTURAL', severity: 'CRITICAL', summary: `${obj.humanName.toUpperCase()}: RERUN ${m}`, detail: {}, proposed: null, module: m })

  // Documentation: every representation of every touched object, with the exact write operation.
  const files = new Map<string, number>()
  for (const [id, g] of touched) {
    const o = byId.get(id)!
    for (const rep of reps.filter((r) => r.object_id === id)) {
      const op = writeOpFor(o, rep, g, touched)
      if (!op) continue
      files.set(rep.file_id, (files.get(rep.file_id) ?? 0) + 1)
      add({ targetKind: 'REPRESENTATION', targetId: rep.id, domain: 'DOCUMENTATION', severity: 'ATTENTION', summary: `${rep.rep_type} ${rep.handle} (${rep.role}) on ${o.humanName}`, detail: { fileId: rep.file_id, handle: rep.handle, role: rep.role, last: parseJson(rep.last_value, null) }, proposed: { op, fileId: rep.file_id }, module: null })
    }
  }
  for (const [id, g] of touched) {
    const o = byId.get(id)!
    if (!reps.some((r) => r.object_id === id)) add({ targetKind: 'REPRESENTATION', targetId: null, domain: 'DOCUMENTATION', severity: 'INFO', summary: `${o.humanName}: no linked drawing representation — model only`, detail: { geometry: g }, proposed: null, module: null })
  }

  const changeId = uuid()
  await db.batch([
    insertStmt(db, 'change_requests', { id: changeId, project_id: projectId, object_id: obj.id, property: req.property, current_value: currentValue ?? null, proposed_value: proposedValue ?? null, reason: req.reason ?? null, requested_by: actor }),
    ...impacts.map((i) => insertStmt(db, 'change_impacts', { id: i.id, change_id: changeId, project_id: projectId, target_kind: i.targetKind, target_id: i.targetId, domain: i.domain, severity: i.severity, summary: i.summary, detail: i.detail, proposed: i.proposed, module: i.module })),
    insertStmt(db, 'audit_log', { id: uuid(), project_id: projectId, actor, action: 'change.proposed', target_kind: 'CHANGE', target_id: changeId, detail: { property: req.property, proposedValue } }),
  ])
  return getChange(db, changeId)
}

function hostedImpacts(host: ObjectDto, g: Geometry, movingEnd: 'start' | 'end', objects: ObjectDto[], add: (i: Omit<Impact, 'id'>) => void, touched: Map<string, Geometry>) {
  for (const child of objects.filter((o) => o.hostId === host.id && !STRUCTURAL.has(o.type))) {
    const rule = child.anchorRule ?? 'ENGINEER_REVIEW_ON_HOST_CHANGE'
    const fixedEnd = anchorEnd(host.geometry, rule)
    const old = host.geometry; const cx = child.geometry.x ?? 0, cy = child.geometry.y ?? 0
    if (fixedEnd && fixedEnd !== movingEnd) {
      add({ targetKind: 'OBJECT', targetId: child.id, domain: 'DESIGN', severity: 'INFO', summary: `${child.humanName.toUpperCase()}: POSITION FIXED (Anchor rule applied: ${rule})`, detail: { rule, offset_ft: child.anchorParams.offset_ft }, proposed: null, module: null })
      continue
    }
    if (fixedEnd && fixedEnd === movingEnd) {
      // The anchor end itself moved: keep the stored offset from that end.
      const off = Number(child.anchorParams.offset_ft ?? 0)
      const ax = fixedEnd === 'start' ? g.x1! : g.x2!, ay = fixedEnd === 'start' ? g.y1! : g.y2!
      const len = Math.hypot(g.x2! - g.x1!, g.y2! - g.y1!) || 1
      const dir = fixedEnd === 'start' ? 1 : -1
      const nx = r6(ax + (dir * (g.x2! - g.x1!) / len) * off), ny = r6(ay + (dir * (g.y2! - g.y1!) / len) * off)
      touched.set(child.id, { x: nx, y: ny })
      add({ targetKind: 'OBJECT', targetId: child.id, domain: 'DESIGN', severity: 'ATTENTION', summary: `${child.humanName.toUpperCase()}: MOVES WITH ANCHOR END (${rule}, offset ${fmt(off)})`, detail: { rule, from: { x: cx, y: cy } }, proposed: { geometry: { x: nx, y: ny } }, module: null })
      continue
    }
    if (rule === 'CENTER_ON_HOST') {
      const nx = r6((g.x1! + g.x2!) / 2), ny = r6((g.y1! + g.y2!) / 2)
      touched.set(child.id, { x: nx, y: ny })
      add({ targetKind: 'OBJECT', targetId: child.id, domain: 'DESIGN', severity: 'ATTENTION', summary: `${child.humanName.toUpperCase()}: RE-CENTERED ON HOST`, detail: { rule, from: { x: cx, y: cy } }, proposed: { geometry: { x: nx, y: ny } }, module: null })
      continue
    }
    if (rule === 'FIXED_WORLD_POSITION') { add({ targetKind: 'OBJECT', targetId: child.id, domain: 'DESIGN', severity: 'INFO', summary: `${child.humanName.toUpperCase()}: FIXED WORLD POSITION`, detail: { rule }, proposed: null, module: null }); continue }
    const oldLen = Math.hypot(old.x2! - old.x1!, old.y2! - old.y1!)
    add({ targetKind: 'OBJECT', targetId: child.id, domain: 'DESIGN', severity: 'ATTENTION', summary: `${child.humanName.toUpperCase()}: ENGINEER REVIEW ON HOST CHANGE (${fmt(oldLen)} → ${fmt(Math.hypot(g.x2! - g.x1!, g.y2! - g.y1!))})`, detail: { rule }, proposed: null, module: null })
  }
}

function roomAndSiblingImpacts(wall: ObjectDto, g: Geometry, movingEnd: 'start' | 'end', objects: ObjectDto[], add: (i: Omit<Impact, 'id'>) => void, touched: Map<string, Geometry>) {
  const room = wall.parentId ? objects.find((o) => o.id === wall.parentId && o.type === 'ROOM') : null
  const oldPt = movingEnd === 'end' ? { x: wall.geometry.x2!, y: wall.geometry.y2! } : { x: wall.geometry.x1!, y: wall.geometry.y1! }
  const newPt = movingEnd === 'end' ? { x: g.x2!, y: g.y2! } : { x: g.x1!, y: g.y1! }
  if (room?.geometry.points) {
    const idx = room.geometry.points.findIndex((p) => near(p, oldPt))
    if (idx >= 0) {
      const pts = room.geometry.points.map((p, i) => (i === idx ? newPt : p))
      touched.set(room.id, { points: pts })
      add({ targetKind: 'OBJECT', targetId: room.id, domain: 'DESIGN', severity: 'ATTENTION', summary: `${room.humanName.toUpperCase()}: DIMENSION UPDATED (vertex ${idx} moves)`, detail: { vertexIndex: idx, from: oldPt, to: newPt }, proposed: { geometry: { points: pts } }, module: null })
    }
  }
  // Sibling walls sharing the moved corner follow it (their end moves too).
  for (const sib of objects.filter((o) => o.type === 'WALL' && o.id !== wall.id && o.parentId === wall.parentId)) {
    const sg = sib.geometry
    const end = near({ x: sg.x1!, y: sg.y1! }, oldPt) ? 'start' : near({ x: sg.x2!, y: sg.y2! }, oldPt) ? 'end' : null
    if (!end) continue
    const ng: Geometry = end === 'start' ? { ...sg, x1: newPt.x, y1: newPt.y } : { ...sg, x2: newPt.x, y2: newPt.y }
    touched.set(sib.id, ng)
    add({ targetKind: 'OBJECT', targetId: sib.id, domain: 'DESIGN', severity: 'ATTENTION', summary: `${sib.humanName.toUpperCase()}: SHARED CORNER MOVES (${fmt(sib.derived.length_ft as number)} → ${fmt(Math.hypot(ng.x2! - ng.x1!, ng.y2! - ng.y1!))})`, detail: { sharedCorner: oldPt, end }, proposed: { geometry: ng }, module: null })
    hostedImpacts(sib, ng, end, objects, add, touched)
  }
}

/** Translate a proposed object geometry into the exact CAD write operation for one representation. */
function writeOpFor(o: ObjectDto, rep: { rep_type: string; role: string; handle: string }, g: Geometry, touched: Map<string, Geometry>): WriteOp | null {
  const k = 12 // model geometry is feet; drawings are assumed in inches ($INSUNITS handled at parse; write-back uses the file's units via cad job)
  if (rep.role === 'wall-line' && g.x1 !== undefined) return { op: 'set-line', handle: rep.handle, x1: g.x1 * k, y1: g.y1! * k, x2: g.x2! * k, y2: g.y2! * k }
  if (rep.role.startsWith('room-edge-') && g.x1 !== undefined) {
    // The room polyline vertex that moved: identify by comparing with the room's proposed points if present.
    const roomG = o.parentId ? touched.get(o.parentId) : undefined
    if (roomG?.points) return null // handled by the room's own representation below
    return null
  }
  if (rep.role === 'room-boundary' && g.points) {
    const prev = o.geometry.points ?? []
    const i = g.points.findIndex((p, idx) => !prev[idx] || !near(p, prev[idx]))
    if (i < 0) return null
    return { op: 'set-poly-vertex', handle: rep.handle, index: i, x: g.points[i].x * k, y: g.points[i].y * k }
  }
  if (rep.role === 'length-dim' && g.x1 !== undefined) return { op: 'set-dim-points', handle: rep.handle, x13: g.x1 * k, y13: g.y1! * k, x14: g.x2! * k, y14: g.y2! * k }
  if (rep.role === 'opening-block' && g.x !== undefined) return { op: 'move-insert', handle: rep.handle, x: g.x * k, y: g.y! * k }
  return null
}

const fmt = (ft: number | undefined) => (ft === undefined || ft === null ? '—' : `${Math.floor(ft)}'-${(Math.round(((ft % 1) * 12) * 4) / 4).toString()}"`)

export type ChangeDto = Record<string, unknown> & { impacts: Record<string, unknown>[]; jobs: Record<string, unknown>[] }
export async function getChange(db: D1Database, id: string): Promise<ChangeDto> {
  const c = await one(db, 'SELECT * FROM change_requests WHERE id = ?', id)
  if (!c) throw notFound('Change not found.')
  const impacts = await all(db, 'SELECT * FROM change_impacts WHERE change_id = ? ORDER BY CASE domain WHEN "STRUCTURAL" THEN 0 WHEN "DESIGN" THEN 1 ELSE 2 END, created_at', id)
  const jobs = await all(db, 'SELECT id, kind, status, workitem_id, report_url, error, created_at, updated_at FROM cad_jobs WHERE change_id = ? ORDER BY created_at', id)
  return { ...hydrate(c), impacts: impacts.map(hydrate), jobs }
}
function hydrate(r: Record<string, unknown>) {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(r)) out[k] = ['current_value', 'proposed_value', 'detail', 'proposed'].includes(k) ? parseJson(v as string, null) : v
  return out
}

export async function approveChange(db: D1Database, id: string, roles: ('engineer' | 'drafter')[], decision: 'APPROVE' | 'REJECT', impactIds: string[] | null, actor: string) {
  const c = await one<{ status: string; engineer_approval: string; drafter_approval: string }>(db, 'SELECT status, engineer_approval, drafter_approval FROM change_requests WHERE id = ?', id)
  if (!c) throw notFound('Change not found.')
  if (c.status !== 'PENDING') throw conflict(`Change is ${c.status}; only PENDING changes can be approved or rejected.`)
  const patch: Record<string, unknown> = {}
  if (roles.includes('engineer')) patch.engineer_approval = decision
  if (roles.includes('drafter')) patch.drafter_approval = decision
  const eng = (patch.engineer_approval as string) ?? c.engineer_approval, dra = (patch.drafter_approval as string) ?? c.drafter_approval
  patch.status = decision === 'REJECT' ? 'REJECTED' : eng === 'APPROVE' && dra === 'APPROVE' ? 'APPROVED' : 'PENDING'
  const stmts = [updateStmt(db, 'change_requests', id, patch)]
  if (decision === 'REJECT') stmts.push(run0(db, `UPDATE change_impacts SET status = 'REJECTED' WHERE change_id = ?`, id))
  else if (impactIds) stmts.push(run0(db, `UPDATE change_impacts SET status = 'APPROVED' WHERE change_id = ? AND id IN (${impactIds.map(() => '?').join(',')})`, id, ...impactIds), run0(db, `UPDATE change_impacts SET status = 'REJECTED' WHERE change_id = ? AND status = 'PROPOSED' AND id NOT IN (${impactIds.map(() => '?').join(',')})`, id, ...impactIds))
  else stmts.push(run0(db, `UPDATE change_impacts SET status = 'APPROVED' WHERE change_id = ? AND status = 'PROPOSED'`, id))
  stmts.push(insertStmt(db, 'audit_log', { id: uuid(), project_id: null, actor, action: `change.${decision.toLowerCase()}`, target_kind: 'CHANGE', target_id: id, detail: { roles, impactIds } }))
  await db.batch(stmts)
  return getChange(db, id)
}
const run0 = (db: D1Database, sql: string, ...bind: unknown[]) => db.prepare(sql).bind(...bind)

/** Apply an APPROVED change to the model. Returns the write-ops grouped by file for the CAD layer, and the calc jobs to run. */
export async function applyToModel(db: D1Database, id: string, actor: string) {
  const change = await getChange(db, id)
  if (change.status !== 'APPROVED') throw conflict(`Change is ${change.status}; approve it first.`)
  const impacts = change.impacts as unknown as (Impact & { status: string; target_kind: string; target_id: string | null; proposed: Record<string, unknown> | null })[]
  const opsByFile = new Map<string, WriteOp[]>()
  const calcJobs: { objectId: string; module: string }[] = []
  const projectId = change.project_id as string
  for (const i of impacts) {
    if (i.status !== 'APPROVED') continue
    if (i.target_kind === 'OBJECT' && i.target_id && i.proposed) {
      const p = i.proposed as { geometry?: Geometry; properties?: Record<string, unknown> }
      await patchObject(db, i.target_id, { ...(p.geometry ? { geometry: p.geometry, geometrySource: `CHANGE:${id}` } : {}), ...(p.properties ? { properties: p.properties } : {}), verificationState: 'INCOMPLETE' })
    }
    if (i.target_kind === 'OBJECT' && i.target_id && i.domain === 'STRUCTURAL') await patchObject(db, i.target_id, { verificationState: 'INCOMPLETE' })
    if (i.target_kind === 'CALC' && i.target_id && i.module) calcJobs.push({ objectId: i.target_id, module: i.module })
    if (i.target_kind === 'REPRESENTATION' && i.proposed?.op) {
      const fileId = i.proposed.fileId as string
      opsByFile.set(fileId, [...(opsByFile.get(fileId) ?? []), i.proposed.op as WriteOp])
      await run(db, 'UPDATE representations SET synced = 0 WHERE id = ?', i.target_id)
    }
  }
  await db.batch([
    run0(db, `UPDATE change_impacts SET status = 'APPLIED' WHERE change_id = ? AND status = 'APPROVED'`, id),
    updateStmt(db, 'change_requests', id, { status: 'APPLIED', applied_at: new Date().toISOString(), reconciliation: opsByFile.size ? 'PENDING' : 'MATCH' }),
    insertStmt(db, 'audit_log', { id: uuid(), project_id: projectId, actor, action: 'change.applied', target_kind: 'CHANGE', target_id: id, detail: { files: [...opsByFile.keys()], calcs: calcJobs.length } }),
  ])
  return { projectId, opsByFile, calcJobs }
}

export async function listChanges(db: D1Database, projectId: string) {
  const rows = await all(db, `SELECT c.*, o.human_name AS object_name, o.semantic_tag AS object_tag, (SELECT COUNT(*) FROM change_impacts i WHERE i.change_id = c.id) AS impact_count FROM change_requests c JOIN objects o ON o.id = c.object_id WHERE c.project_id = ? ORDER BY c.created_at DESC`, projectId)
  return rows.map(hydrate)
}
export { toObjectDto, type ObjectRow }
