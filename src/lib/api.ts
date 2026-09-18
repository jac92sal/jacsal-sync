export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code }
}
async function call<T>(method: string, path: string, body?: unknown, raw?: { bytes: ArrayBuffer; filename: string }): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} }
  if (raw) { init.body = raw.bytes; (init.headers as Record<string, string>)['x-filename'] = raw.filename; (init.headers as Record<string, string>)['content-type'] = 'application/octet-stream' }
  else if (body !== undefined) { init.body = JSON.stringify(body); (init.headers as Record<string, string>)['content-type'] = 'application/json' }
  const r = await fetch(`/api${path}`, init)
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string } & T
  if (!r.ok || j.ok === false) throw new ApiError(r.status, j.error ?? 'error', j.message ?? `Request failed (${r.status})`)
  return j
}
export const api = {
  get: <T>(p: string) => call<T>('GET', p),
  post: <T>(p: string, b?: unknown) => call<T>('POST', p, b),
  put: <T>(p: string, b?: unknown) => call<T>('PUT', p, b),
  patch: <T>(p: string, b?: unknown) => call<T>('PATCH', p, b),
  upload: <T>(p: string, bytes: ArrayBuffer, filename: string) => call<T>('POST', `${p}?filename=${encodeURIComponent(filename)}`, undefined, { bytes, filename }),
}

export interface User { id: string; email: string; name: string | null }
export interface Project { id: string; name: string; address?: string; city?: string; state?: string; zip?: string; county?: string; matched_address?: string; geocode_source?: string; jurisdiction?: string; code_path?: string; risk_category?: string; design_method?: string; stories?: number; lat?: number; lng?: number; status: string; object_count?: number; pending_candidates?: number; open_changes?: number; updated_at: string }
export interface Geometry { x1?: number; y1?: number; x2?: number; y2?: number; x?: number; y?: number; points?: { x: number; y: number }[] }
export interface Obj { id: string; projectId: string; type: string; humanName: string; semanticTag: string; parentId: string | null; hostId: string | null; function: string | null; anchorRule: string | null; anchorParams: Record<string, unknown>; geometry: Geometry; geometrySource: string | null; derived: Record<string, unknown>; properties: Record<string, unknown>; verificationState: string; approvalState: string; revision: number }
export interface Candidate { id: string; kind: string; human_name: string; semantic_tag: string | null; detected_value: unknown; unit: string | null; confidence: number | null; source_handles: string[]; method: string | null; action: string; confirmed_value: unknown; backend_target: string | null; object_id: string | null; anchor_rule: string | null; anchor_params: Record<string, unknown>; host_key: string | null; ckey: string | null; file_id: string | null }
export interface Impact { id: string; target_kind: 'OBJECT' | 'CALC' | 'REPRESENTATION'; target_id: string | null; domain: 'STRUCTURAL' | 'DESIGN' | 'DOCUMENTATION'; severity: 'CRITICAL' | 'ATTENTION' | 'INFO'; summary: string; detail: Record<string, unknown> | null; proposed: Record<string, unknown> | null; module: string | null; status: string }
export interface Change { id: string; project_id: string; object_id: string; property: string; current_value: unknown; proposed_value: unknown; reason: string | null; status: string; engineer_approval: string; drafter_approval: string; reconciliation: string | null; created_at: string; impacts: Impact[]; jobs: { id: string; kind: string; status: string; error: string | null }[]; object_name?: string; impact_count?: number }
export interface GateRow { domain: string; functionState: string; verificationState: string; designSync: string; approval: string; gate: string; location: string }
export interface CadFile { id: string; filename: string; kind: string; status: string; revision: number; entity_count: number | null; error: string | null; created_at: string; models?: string | null; insunits?: number | null }
export interface ModelRegion { ix: number; title: string; labels: string[]; bbox: { minX: number; minY: number; maxX: number; maxY: number }; entityCount: number; wallCount: number; objectId?: string | null }
export interface CadEntity { handle: string; layer: string; etype: string; model_ix: number | null; geometry: { points: { x: number; y: number }[]; closed?: boolean; rotation?: number; height?: number }; attributes: { text?: string; blockName?: string } }
export const unitsToFeet = (insunits: number | null | undefined) => ({ 1: 1 / 12, 2: 1, 3: 1 / 63360, 4: 1 / 304.8, 5: 1 / 30.48, 6: 1 / 0.3048 } as Record<number, number>)[insunits ?? 0] ?? 1 / 12

export const ftIn = (ft: number | undefined | null) => (ft === undefined || ft === null || Number.isNaN(ft)) ? '—' : `${Math.floor(ft)}'-${(Math.round((ft % 1) * 12 * 4) / 4).toString().replace(/\.0+$/, '')}"`
export interface GeocodeResult { matchedAddress: string; lat: number; lng: number; street: string | null; city: string | null; county: string | null; state: string | null; zip: string | null; jurisdiction: string; incorporated: boolean; source: string }
export const CODE_PATHS = ['CBC', 'CRC', 'IBC', 'IRC'] as const
export const RISK_CATEGORIES = ['I', 'II', 'III', 'IV'] as const
export const DESIGN_METHODS = ['ASD', 'LRFD'] as const
