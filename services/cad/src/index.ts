import { WorkerEntrypoint } from 'cloudflare:workers'
import { parseDxf, type DxfDocument, type DxfEntity } from './dxf'
import { detect, type Candidate } from './detect'
import * as aps from './aps'
import { patchDxf } from './patch'
import type { WriteOp } from './aps'

export type { DxfDocument, DxfEntity, Candidate, WriteOp }
export type { WorkItemStatus } from './aps'

/** CadService — DXF understanding in-Worker; DWG conversion and write-back via APS Design Automation. */
export class CadService extends WorkerEntrypoint<Env> {
  private async creds(): Promise<aps.ApsCreds> {
    const [clientId, clientSecret] = await Promise.all([this.env.APS_CLIENT_ID.get(), this.env.APS_CLIENT_SECRET.get()])
    return { clientId, clientSecret }
  }

  /** Parse DXF text into entities with handles. */
  parseDxf(text: string): DxfDocument {
    return parseDxf(text)
  }
  /** Parse + detect candidate objects/fields in one call (the common path). */
  analyzeDxf(text: string): { doc: DxfDocument; candidates: Candidate[] } {
    const doc = parseDxf(text)
    return { doc, candidates: detect(doc) }
  }

  /** Design Automation: submit a job. `kind` decides the script. Returns the workitem id. */
  async submitJob(kind: 'CONVERT' | 'WRITEBACK' | 'RESCAN', jobId: string, inputDwg: ArrayBuffer, ops: WriteOp[] = [], onComplete?: string): Promise<{ workitemId: string; bucketKey: string; keys: { input: string; script: string; result: string; dxf: string }; uploadKeys: { result: string; dxf: string } }> {
    const c = await this.creds(); const token = await aps.apsToken(c)
    const bucketKey = aps.bucketKeyFor(c.clientId)
    await aps.ensureBucket(token, bucketKey, this.env.APS_REGION)
    const nick = await aps.nickname(token)
    const activityId = await aps.ensureActivity(token, nick, this.env.APS_ACTIVITY, this.env.APS_ALIAS, this.env.APS_ENGINE)
    const keys = { input: `${jobId}/input.dwg`, script: `${jobId}/script.scr`, result: `${jobId}/result.dwg`, dxf: `${jobId}/result.dxf` }
    const script = kind === 'WRITEBACK' ? aps.writebackScript(ops) : aps.convertScript()
    await Promise.all([aps.uploadObject(token, bucketKey, keys.input, inputDwg), aps.uploadObject(token, bucketKey, keys.script, new TextEncoder().encode(script).buffer as ArrayBuffer)])
    const [inputUrl, scriptUrl, resultTarget, dxfTarget] = await Promise.all([
      aps.signedDownloadUrl(token, bucketKey, keys.input), aps.signedDownloadUrl(token, bucketKey, keys.script),
      aps.signedUploadTarget(token, bucketKey, keys.result), aps.signedUploadTarget(token, bucketKey, keys.dxf),
    ])
    const wi = await aps.createWorkItem(token, activityId, { input: inputUrl, script: scriptUrl, result: kind === 'WRITEBACK' ? resultTarget.url : undefined, dxf: dxfTarget.url, onComplete })
    return { workitemId: wi.id, bucketKey, keys, uploadKeys: { result: resultTarget.uploadKey, dxf: dxfTarget.uploadKey } }
  }

  async jobStatus(workitemId: string): Promise<{ status: aps.WorkItemStatus; reportUrl?: string }> {
    const token = await aps.apsToken(await this.creds())
    const w = await aps.getWorkItem(token, workitemId)
    return { status: w.status, reportUrl: w.reportUrl }
  }

  /** After success: finalize the S3 uploads DA performed and fetch the outputs. */
  async fetchOutputs(bucketKey: string, keys: { result: string; dxf: string }, uploadKeys: { result: string; dxf: string }, want: { result: boolean; dxf: boolean }): Promise<{ result?: ArrayBuffer; dxf?: string }> {
    const token = await aps.apsToken(await this.creds())
    const out: { result?: ArrayBuffer; dxf?: string } = {}
    if (want.dxf) { await aps.completeUpload(token, bucketKey, keys.dxf, uploadKeys.dxf).catch(() => undefined); out.dxf = await (await fetch(await aps.signedDownloadUrl(token, bucketKey, keys.dxf))).text() }
    if (want.result) { await aps.completeUpload(token, bucketKey, keys.result, uploadKeys.result).catch(() => undefined); out.result = await (await fetch(await aps.signedDownloadUrl(token, bucketKey, keys.result))).arrayBuffer() }
    return out
  }

  /** Fetch a Design Automation report (plain text log) for diagnostics. */
  async report(reportUrl: string): Promise<string> {
    return (await fetch(reportUrl)).text()
  }

  /** Apply write operations to DXF text directly (DXF-only sources). */
  patchDxf(text: string, ops: WriteOp[]): { text: string; applied: number; missing: string[] } {
    return patchDxf(text, ops)
  }

  /** Expose script generation so the app can preview exactly what will be written. */
  previewScript(ops: WriteOp[]): string {
    return aps.writebackScript(ops)
  }
}

export default { fetch: () => new Response('jacsal-sync-cad: service binding only', { status: 404 }) } satisfies ExportedHandler<Env>
