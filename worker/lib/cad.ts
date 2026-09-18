/** CAD files, Design Automation jobs, and reconciliation. Raw uploads live in R2; nothing is parsed twice. */
import { all, insertStmt, one, run, updateStmt } from './db'
import { badRequest, notFound, parseJson, sha256Hex, uuid } from './http'
import type { CadService, Candidate, WriteOp } from '../../services/cad/src/index'
import { near } from './objects'

type Cad = Pick<CadService, 'analyzeDxf' | 'submitJob' | 'jobStatus' | 'fetchOutputs' | 'patchDxf' | 'report' | 'previewScript'>

export interface FileRow extends Record<string, unknown> { id: string; project_id: string; filename: string; kind: string; r2_key: string; dxf_r2_key: string | null; status: string; revision: number; entity_count: number | null; error: string | null }

export async function uploadFile(db: D1Database, bucket: R2Bucket, cad: Cad, projectId: string, filename: string, bytes: ArrayBuffer, actor: string, callbackBase: string) {
  const ext = filename.toLowerCase().split('.').pop()
  if (ext !== 'dwg' && ext !== 'dxf') throw badRequest('Upload a .dwg or .dxf file.')
  if (bytes.byteLength > 95 * 1024 * 1024) throw badRequest('File is larger than 95 MB.')
  const id = uuid(); const kind = ext.toUpperCase()
  const key = `projects/${projectId}/files/${id}/r1/${filename}`
  await bucket.put(key, bytes, { httpMetadata: { contentType: kind === 'DXF' ? 'application/dxf' : 'application/acad' } })
  await insertStmt(db, 'cad_files', { id, project_id: projectId, filename, kind, r2_key: key, size: bytes.byteLength, sha256: await sha256Hex(bytes), status: 'UPLOADED', uploaded_by: actor }).run()
  if (kind === 'DXF') {
    await ingestDxf(db, cad, projectId, id, new TextDecoder().decode(bytes), key)
  } else {
    await submitJob(db, cad, projectId, id, null, 'CONVERT', bytes, [], callbackBase)
    await run(db, `UPDATE cad_files SET status = 'CONVERTING' WHERE id = ?`, id)
  }
  return getFile(db, id)
}

export async function getFile(db: D1Database, id: string): Promise<FileRow> {
  const f = await one<FileRow>(db, 'SELECT * FROM cad_files WHERE id = ?', id)
  if (!f) throw notFound('File not found.')
  return f
}

/** Parse + detect, retain entities, and queue candidates for human confirmation. */
export async function ingestDxf(db: D1Database, cad: Cad, projectId: string, fileId: string, dxfText: string, dxfKey: string) {
  const { doc, candidates } = await cad.analyzeDxf(dxfText)
  const entityStmts = doc.entities.slice(0, 20000).map((e) => insertStmt(db, 'cad_entities', { id: uuid(), file_id: fileId, project_id: projectId, handle: e.handle, layer: e.layer, etype: e.type, geometry: { points: e.points, closed: e.closed, rotation: e.rotation, height: e.height }, attributes: { text: e.text, blockName: e.blockName, attribs: e.attribs, dimMeasurement: e.dimMeasurement, dimType: e.dimType } }))
  const existing = new Set((await all<{ ckey: string }>(db, `SELECT ckey FROM candidates WHERE project_id = ? AND action <> 'PENDING'`, projectId)).map((r) => r.ckey))
  const candStmts = candidates.filter((c) => !existing.has(c.key)).map((c: Candidate) => insertStmt(db, 'candidates', {
    id: uuid(), project_id: projectId, file_id: fileId, kind: c.kind, human_name: c.humanName, semantic_tag: c.semanticTag, detected_value: c.detectedValue, unit: c.unit ?? null, confidence: c.confidence,
    source_handles: c.sourceHandles, method: c.method, ckey: c.key, host_key: c.hostKey ?? null, anchor_rule: c.anchorRule ?? null, anchor_params: c.anchorParams ?? null, representations: c.representations ?? [], backend_target: c.backendTarget ?? null,
  }))
  await run(db, 'DELETE FROM cad_entities WHERE file_id = ?', fileId)
  await run(db, `DELETE FROM candidates WHERE file_id = ? AND action = 'PENDING'`, fileId)
  for (let i = 0; i < entityStmts.length; i += 200) await db.batch(entityStmts.slice(i, i + 200))
  for (let i = 0; i < candStmts.length; i += 200) await db.batch(candStmts.slice(i, i + 200))
  await updateStmt(db, 'cad_files', fileId, { status: 'PARSED', dxf_r2_key: dxfKey, entity_count: doc.entities.length, error: null }).run()
  return { entities: doc.entities.length, candidates: candStmts.length, insunits: doc.insunits }
}

export async function submitJob(db: D1Database, cad: Cad, projectId: string, fileId: string, changeId: string | null, kind: 'CONVERT' | 'WRITEBACK' | 'RESCAN', inputDwg: ArrayBuffer, ops: WriteOp[], callbackBase: string) {
  const id = uuid()
  await insertStmt(db, 'cad_jobs', { id, project_id: projectId, file_id: fileId, change_id: changeId, kind, status: 'QUEUED' }).run()
  try {
    const r = await cad.submitJob(kind, id, inputDwg, ops, `${callbackBase}/api/cad/callback/${id}`)
    await updateStmt(db, 'cad_jobs', id, { status: 'PENDING', workitem_id: r.workitemId, input_key: r.keys.input, script_key: r.keys.script, output_key: JSON.stringify({ bucketKey: r.bucketKey, keys: r.keys, uploadKeys: r.uploadKeys }) }).run()
  } catch (err) {
    await updateStmt(db, 'cad_jobs', id, { status: 'FAILED', error: String(err instanceof Error ? err.message : err) }).run()
    throw err
  }
  return id
}

/** Poll or callback: advance a job to its terminal state and process outputs. */
export async function processJob(db: D1Database, bucket: R2Bucket, cad: Cad, jobId: string): Promise<{ status: string }> {
  const job = await one<Record<string, unknown>>(db, 'SELECT * FROM cad_jobs WHERE id = ?', jobId)
  if (!job) throw notFound('Job not found.')
  if (!['QUEUED', 'PENDING', 'INPROGRESS'].includes(job.status as string)) return { status: job.status as string }
  const st = await cad.jobStatus(job.workitem_id as string)
  const status = st.status.toUpperCase()
  if (status === 'PENDING' || status === 'INPROGRESS') { await updateStmt(db, 'cad_jobs', jobId, { status }).run(); return { status } }
  if (status !== 'SUCCESS') {
    let error = status
    try { if (st.reportUrl) error = `${status}: ${(await cad.report(st.reportUrl)).slice(-1500)}` } catch { /* report optional */ }
    await updateStmt(db, 'cad_jobs', jobId, { status: 'FAILED', report_url: st.reportUrl ?? null, error }).run()
    if (job.kind === 'CONVERT') await updateStmt(db, 'cad_files', job.file_id as string, { status: 'ERROR', error }).run()
    if (job.change_id) await updateStmt(db, 'change_requests', job.change_id as string, { reconciliation: 'MISMATCH', status: 'MISMATCH' }).run()
    return { status: 'FAILED' }
  }
  const meta = parseJson<{ bucketKey: string; keys: { result: string; dxf: string }; uploadKeys: { result: string; dxf: string } }>(job.output_key as string, null as never)
  const out = await cad.fetchOutputs(meta.bucketKey, meta.keys, meta.uploadKeys, { result: job.kind === 'WRITEBACK', dxf: true })
  const file = await getFile(db, job.file_id as string)
  const projectId = job.project_id as string
  if (job.kind === 'CONVERT') {
    const dxfKey = `projects/${projectId}/files/${file.id}/r${file.revision}/${file.filename.replace(/\.dwg$/i, '')}.dxf`
    await bucket.put(dxfKey, out.dxf ?? '', { httpMetadata: { contentType: 'application/dxf' } })
    await ingestDxf(db, cad, projectId, file.id, out.dxf ?? '', dxfKey)
  } else if (job.kind === 'WRITEBACK') {
    const rev = file.revision + 1
    const dwgKey = `projects/${projectId}/files/${file.id}/r${rev}/${file.filename}`
    const dxfKey = dwgKey.replace(/\.dwg$/i, '.dxf')
    if (out.result) await bucket.put(dwgKey, out.result, { httpMetadata: { contentType: 'application/acad' } })
    await bucket.put(dxfKey, out.dxf ?? '', { httpMetadata: { contentType: 'application/dxf' } })
    await updateStmt(db, 'cad_files', file.id, { r2_key: out.result ? dwgKey : file.r2_key, dxf_r2_key: dxfKey, revision: rev }).run()
    await reconcile(db, cad, projectId, file.id, job.change_id as string | null, out.dxf ?? '')
  }
  await updateStmt(db, 'cad_jobs', jobId, { status: 'SUCCESS', report_url: st.reportUrl ?? null }).run()
  return { status: 'SUCCESS' }
}

/** Re-scan: does every representation now show what the verified model says? */
export async function reconcile(db: D1Database, cad: Cad, projectId: string, fileId: string, changeId: string | null, dxfText: string) {
  const { doc } = await cad.analyzeDxf(dxfText)
  const byHandle = new Map(doc.entities.map((e) => [e.handle, e]))
  const reps = await all<{ id: string; object_id: string; handle: string; role: string; rep_type: string }>(db, 'SELECT id, object_id, handle, role, rep_type FROM representations WHERE file_id = ?', fileId)
  const objects = new Map((await all<{ id: string; geometry: string }>(db, 'SELECT id, geometry FROM objects WHERE project_id = ?', projectId)).map((o) => [o.id, parseJson<Record<string, number | { x: number; y: number }[]>>(o.geometry, {})]))
  const k = 1 / 12 // drawing inches → model feet (matches detector default)
  let mismatches = 0
  const stmts: D1PreparedStatement[] = []
  for (const r of reps) {
    const e = byHandle.get(r.handle); const g = objects.get(r.object_id) ?? {}
    let match = !!e
    if (e) {
      if (r.role === 'wall-line' && typeof g.x1 === 'number') match = near(e.points[0], { x: (g.x1 as number) / k, y: (g.y1 as number) / k }, 0.05) && near(e.points[1], { x: (g.x2 as number) / k, y: (g.y2 as number) / k }, 0.05)
      else if (r.role === 'length-dim' && typeof g.x1 === 'number') match = (near(e.points[1], { x: (g.x1 as number) / k, y: (g.y1 as number) / k }, 0.05) && near(e.points[2], { x: (g.x2 as number) / k, y: (g.y2 as number) / k }, 0.05)) || (near(e.points[2], { x: (g.x1 as number) / k, y: (g.y1 as number) / k }, 0.05) && near(e.points[1], { x: (g.x2 as number) / k, y: (g.y2 as number) / k }, 0.05))
      else if (r.role === 'opening-block' && typeof g.x === 'number') match = near(e.points[0], { x: (g.x as number) / k, y: (g.y as number) / k }, 0.05)
      else if (r.role === 'room-boundary' && Array.isArray(g.points)) match = (g.points as { x: number; y: number }[]).every((p, i) => e.points[i] && near(e.points[i], { x: p.x / k, y: p.y / k }, 0.05))
    }
    if (!match) mismatches++
    stmts.push(db.prepare(`UPDATE representations SET synced = ?, last_value = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).bind(match ? 1 : 0, JSON.stringify(e ? { points: e.points, text: e.text } : null), r.id))
  }
  if (changeId) stmts.push(updateStmt(db, 'change_requests', changeId, { reconciliation: mismatches ? 'MISMATCH' : 'MATCH', status: mismatches ? 'MISMATCH' : 'RECONCILED' }))
  stmts.push(db.prepare(`UPDATE cad_files SET entity_count = ?, status = 'PARSED' WHERE id = ?`).bind(doc.entities.length, fileId))
  for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200))
  return { representations: reps.length, mismatches }
}

/** Write approved ops to each file: DWG sources go through Design Automation; DXF-only sources are patched in place. */
export async function writeBack(db: D1Database, bucket: R2Bucket, cad: Cad, projectId: string, changeId: string, opsByFile: Map<string, WriteOp[]>, callbackBase: string) {
  const jobs: { fileId: string; mode: 'APS' | 'DXF'; jobId?: string; result?: unknown }[] = []
  for (const [fileId, ops] of opsByFile) {
    const file = await getFile(db, fileId)
    if (file.kind === 'DWG') {
      const obj = await bucket.get(file.r2_key)
      if (!obj) throw notFound(`Drawing bytes missing for ${file.filename}.`)
      const jobId = await submitJob(db, cad, projectId, fileId, changeId, 'WRITEBACK', await obj.arrayBuffer(), ops, callbackBase)
      jobs.push({ fileId, mode: 'APS', jobId })
    } else {
      const obj = await bucket.get(file.dxf_r2_key ?? file.r2_key)
      if (!obj) throw notFound(`DXF bytes missing for ${file.filename}.`)
      const patched = await cad.patchDxf(await obj.text(), ops)
      const rev = file.revision + 1
      const key = `projects/${projectId}/files/${fileId}/r${rev}/${file.filename}`
      await bucket.put(key, patched.text, { httpMetadata: { contentType: 'application/dxf' } })
      await updateStmt(db, 'cad_files', fileId, { r2_key: key, dxf_r2_key: key, revision: rev }).run()
      const jobId = uuid()
      await insertStmt(db, 'cad_jobs', { id: jobId, project_id: projectId, file_id: fileId, change_id: changeId, kind: 'WRITEBACK', status: patched.missing.length ? 'FAILED' : 'SUCCESS', error: patched.missing.length ? `handles not found: ${patched.missing.join(', ')}` : null, output_key: key }).run()
      const rec = await reconcile(db, cad, projectId, fileId, changeId, patched.text)
      jobs.push({ fileId, mode: 'DXF', jobId, result: { ...patched, text: undefined, ...rec } })
    }
  }
  return jobs
}

export async function pendingJobs(db: D1Database, limit = 10) {
  return all<{ id: string }>(db, `SELECT id FROM cad_jobs WHERE status IN ('PENDING','INPROGRESS') ORDER BY created_at LIMIT ?`, limit)
}
