import { WorkerEntrypoint } from 'cloudflare:workers'
import { DxfStreamParser, parseDxf, type DxfDocument, type DxfEntity } from './dxf'
import { detect, type Candidate } from './detect'
import { findModels } from './models'
import * as aps from './aps'
import puppeteer from '@cloudflare/puppeteer'
import { patchDxf } from './patch'
import type { WriteOp } from './aps'

export type { DxfDocument, DxfEntity, Candidate, WriteOp }
export type { WorkItemStatus } from './aps'

/** CadService — DXF understanding in-Worker; DWG conversion and write-back via APS Design Automation. */
export class CadService extends WorkerEntrypoint<Env> {
  /** Run fn with a headless browser parked on the Autodesk API origin (see apsFetch). Falls back to direct fetch if the binding is unavailable. */
  private async withAps<T>(fn: () => Promise<T>): Promise<T> {
    if (aps.apsSession.getStore() || !this.env.BROWSER || this.env.APS_RELAY_URL || String(this.env.APS_VIA_BROWSER) !== 'true') return fn()
    const browser = await puppeteer.launch(this.env.BROWSER)
    try {
      const page = await browser.newPage()
      await page.goto('https://developer.api.autodesk.com/authentication/v2/keys', { waitUntil: 'domcontentloaded', timeout: 30_000 })
      return await aps.apsSession.run(page as unknown as aps.ApsPage, fn)
    } finally {
      await browser.close()
    }
  }

  private async creds(): Promise<aps.ApsCreds> {
    const [clientId, clientSecret, relayKey] = await Promise.all([this.env.APS_CLIENT_ID.get(), this.env.APS_CLIENT_SECRET.get(), this.env.APS_RELAY_KEY.get().catch(() => '')])
    aps.configureRelay(this.env.APS_RELAY_URL && relayKey ? { url: this.env.APS_RELAY_URL, key: relayKey } : null)
    return { clientId, clientSecret }
  }

  /** Parse DXF text into entities with handles. */
  parseDxf(text: string): DxfDocument {
    return parseDxf(text)
  }
  /** Parse + detect candidate objects/fields in one call (small DXF text only; large files go through analyzeR2). */
  analyzeDxf(text: string): { doc: DxfDocument; candidates: Candidate[] } {
    const doc = parseDxf(text)
    return { doc, candidates: detect(doc) }
  }

  /**
   * Parse + detect straight from an R2 object, streaming, so a 100 MB+ DXF never has to be
   * held whole or cross the service-binding RPC limit. Detection runs over every retained
   * entity; the returned entity list is capped (the app stores that many) and doc.stats says how much was kept.
   */
  async analyzeR2(key: string, returnEntities = 20_000): Promise<{ doc: DxfDocument; candidates: Candidate[]; entityCount: number }> {
    const obj = await this.env.FILES.get(key)
    if (!obj) throw new Error(`DXF not found in storage: ${key}`)
    const parser = new DxfStreamParser()
    const reader = obj.body.pipeThrough(new TextDecoderStream()).getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parser.push(value)
    }
    const doc = parser.end()
    // Model pages: when a sheet set is found, detection runs on the floor plans only and their entities are returned first.
    const models = findModels(doc)
    doc.models = models
    const scoped = models.length ? doc.entities.filter((e) => e.model !== undefined) : doc.entities
    const candidates = detect({ ...doc, entities: scoped })
    const ordered = models.length ? [...scoped, ...doc.entities.filter((e) => e.model === undefined)] : doc.entities
    return { doc: { ...doc, entities: ordered.slice(0, returnEntities) }, candidates, entityCount: doc.entities.length }
  }

  /** Design Automation: submit a job. `kind` decides the script. Returns the workitem id. */
  async submitJob(kind: 'CONVERT' | 'WRITEBACK' | 'RESCAN', jobId: string, inputR2Key: string, ops: WriteOp[] = [], onComplete?: string): Promise<{ workitemId: string; bucketKey: string; keys: { input: string; script: string; result: string; dxf: string }; uploadKeys: { result: string; dxf: string } }> {
    return this.withAps(() => this.submitJobInner(kind, jobId, inputR2Key, ops, onComplete))
  }
  private async submitJobInner(kind: 'CONVERT' | 'WRITEBACK' | 'RESCAN', jobId: string, inputR2Key: string, ops: WriteOp[], onComplete?: string) {
    // The DWG is read from shared storage rather than passed over RPC (32 MiB cap on service-binding arguments).
    const input = await this.env.FILES.get(inputR2Key)
    if (!input) throw new Error(`Drawing not found in storage: ${inputR2Key}`)
    const inputDwg = await input.arrayBuffer()
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
    return this.withAps(async () => {
      const token = await aps.apsToken(await this.creds())
      const w = await aps.getWorkItem(token, workitemId)
      return { status: w.status, reportUrl: w.reportUrl }
    })
  }

  /** Connectivity + credentials diagnostic: token, nickname, engines. */
  async diagnose(): Promise<{ ok: boolean; nickname?: string; engines?: string[]; error?: string; via: string }> {
    const via = this.env.APS_RELAY_URL ? 'relay' : String(this.env.APS_VIA_BROWSER) === 'true' && this.env.BROWSER ? 'browser' : 'socket'
    try {
      return await this.withAps(async () => {
        const token = await aps.apsToken(await this.creds())
        const nick = await aps.nickname(token)
        const engines = await aps.listEngines(token)
        return { ok: true, nickname: nick, engines: engines.filter((e) => e.includes('AutoCAD')), via }
      })
    } catch (e) { return { ok: false, error: String(e instanceof Error ? e.message : e), via } }
  }

  /** After success: finalize the S3 uploads DA performed and fetch the outputs. */
  async fetchOutputs(bucketKey: string, keys: { result: string; dxf: string }, uploadKeys: { result: string; dxf: string }, want: { result: boolean; dxf: boolean }): Promise<{ result?: ArrayBuffer; dxf?: string }> {
    return this.withAps(() => this.fetchOutputsInner(bucketKey, keys, uploadKeys, want))
  }
  private async fetchOutputsInner(bucketKey: string, keys: { result: string; dxf: string }, uploadKeys: { result: string; dxf: string }, want: { result: boolean; dxf: boolean }): Promise<{ result?: ArrayBuffer; dxf?: string }> {
    const token = await aps.apsToken(await this.creds())
    const out: { result?: ArrayBuffer; dxf?: string } = {}
    if (want.dxf) { await aps.completeUpload(token, bucketKey, keys.dxf, uploadKeys.dxf).catch(() => undefined); out.dxf = await (await fetch(await aps.signedDownloadUrl(token, bucketKey, keys.dxf))).text() }
    if (want.result) { await aps.completeUpload(token, bucketKey, keys.result, uploadKeys.result).catch(() => undefined); out.result = await (await fetch(await aps.signedDownloadUrl(token, bucketKey, keys.result))).arrayBuffer() }
    return out
  }

  /**
   * Stream Design Automation outputs from Autodesk OSS straight into R2 under the given keys.
   * Nothing is buffered in memory or returned over RPC; the caller gets byte counts.
   */
  async fetchOutputsToR2(bucketKey: string, keys: { result: string; dxf: string }, uploadKeys: { result: string; dxf: string }, targets: { result?: string; dxf?: string }): Promise<{ result?: number; dxf?: number }> {
    return this.withAps(async () => {
      const token = await aps.apsToken(await this.creds())
      const out: { result?: number; dxf?: number } = {}
      for (const name of ['dxf', 'result'] as const) {
        const r2Key = targets[name]
        if (!r2Key) continue
        await aps.completeUpload(token, bucketKey, keys[name], uploadKeys[name]).catch(() => undefined)
        const r = await fetch(await aps.signedDownloadUrl(token, bucketKey, keys[name]))
        if (!r.ok || !r.body) throw new Error(`Design Automation output ${name} download failed: ${r.status}`)
        const contentType = name === 'dxf' ? 'application/dxf' : 'application/acad'
        const len = Number(r.headers.get('content-length'))
        if (Number.isFinite(len) && len > 0) {
          // R2 needs a known length for streamed bodies.
          const { readable, writable } = new FixedLengthStream(len)
          const piping = r.body.pipeTo(writable)
          const put = await this.env.FILES.put(r2Key, readable, { httpMetadata: { contentType } })
          await piping
          out[name] = put?.size ?? len
        } else {
          const buf = await r.arrayBuffer()
          await this.env.FILES.put(r2Key, buf, { httpMetadata: { contentType } })
          out[name] = buf.byteLength
        }
      }
      return out
    })
  }

  /** Viewer: make sure the OSS object is translated for the Autodesk Viewer; returns the urn and current status. */
  async ensureViewable(bucketKey: string, objectKey: string, force = false): Promise<{ urn: string; status: string; progress: string; messages: string[] }> {
    return this.withAps(async () => {
      const token = await aps.apsToken(await this.creds())
      const urn = aps.urnify(bucketKey, objectKey)
      let m = force ? null : await aps.getManifest(token, urn)
      if (!m || m.status === 'failed' || m.status === 'timeout') { await aps.translateObject(token, urn, force || !!m); m = await aps.getManifest(token, urn) }
      return { urn, status: m?.status ?? 'pending', progress: m?.progress ?? '0% complete', messages: m?.messages ?? [] }
    })
  }
  async viewableStatus(urn: string): Promise<{ status: string; progress: string; messages: string[] }> {
    return this.withAps(async () => {
      const m = await aps.getManifest(await aps.apsToken(await this.creds()), urn)
      return { status: m?.status ?? 'pending', progress: m?.progress ?? '0% complete', messages: m?.messages ?? [] }
    })
  }
  /** Browser token for the Viewer (viewables:read only). */
  async viewerToken(): Promise<{ access_token: string; expires_in: number }> {
    return this.withAps(async () => aps.viewerToken(await this.creds()))
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
