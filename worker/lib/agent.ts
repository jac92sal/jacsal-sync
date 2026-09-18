/**
 * Claude review agent: after a drawing is parsed, look at every page-like region the scan found
 * and decide which ones are the basic floor plans to bring in, what to call them, and what the
 * rest are (duplicates, demolition plans, elevations, schedules). Decisions are applied to the
 * FLOOR_PLAN units and recorded on the file so the review page can show the reasoning.
 *
 * Only a compact summary of each page is sent (labels, counts, layer names, a few text samples),
 * never the drawing itself.
 */
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'
import { socketFetch } from '../../shared/socket-http'
import { all, one, updateStmt } from './db'
import { getSealed } from './settings'
import { findByTag, patchObject } from './objects'

export const CLAUDE_KEY = 'anthropic_api_key'
export const CLAUDE_MODEL = 'claude-opus-5'

const PageDecision = z.object({
  ix: z.number().int(),
  keep: z.boolean(),
  kind: z.enum(['floor_plan', 'demolition_plan', 'roof_plan', 'site_plan', 'elevation', 'section', 'schedule', 'notes', 'duplicate', 'other']),
  name: z.string(),
  building: z.string(),
  state: z.enum(['existing', 'proposed', 'demolition', 'unknown']),
  level: z.string(),
  confidence: z.number(),
  reason: z.string(),
})
const Review = z.object({
  summary: z.string(),
  buildings: z.array(z.string()),
  pages: z.array(PageDecision),
})
export type AgentReview = z.infer<typeof Review> & { model: string; at: string; usage?: { input: number; output: number }; source?: string }

/** Some origins answer Workers' fetch with a synthetic 525; fall back to a raw TLS socket for those. */
async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  try {
    const r = await fetch(input, init)
    if (r.status !== 525) return r
  } catch { /* fall through */ }
  const headers: Record<string, string> = {}
  new Headers(init?.headers ?? {}).forEach((v, k) => { headers[k] = v })
  const body = typeof init?.body === 'string' ? init.body : init?.body ? await new Response(init.body as BodyInit).text() : undefined
  return socketFetch(url, { method: init?.method ?? 'GET', headers, body, timeoutMs: 120_000 })
}

/**
 * Key resolution, in order: the account's Secrets Store entries bound to the Worker, then a key
 * entered in Settings. The first key Anthropic accepts is remembered for the life of the isolate.
 */
type KeySource = { name: string; get: () => Promise<string | null> }
function keySources(env: Env): KeySource[] {
  return [
    { name: 'Secrets Store: default_anthropic_default', get: () => env.ANTHROPIC_API_KEY.get().catch(() => null) },
    { name: 'Secrets Store: CASE_4667_ANTHROPIC_KEY', get: () => env.ANTHROPIC_API_KEY_ALT.get().catch(() => null) },
    { name: 'Settings (sealed)', get: () => getSealed(env, CLAUDE_KEY) },
  ]
}
let workingSource: string | null = null
const mk = (apiKey: string) => new Anthropic({ apiKey, fetch: apiFetch as typeof fetch, maxRetries: 1, timeout: 120_000 })

/** Find a key Anthropic accepts. Returns the client and which source it came from. */
export async function claudeClient(env: Env): Promise<{ client: Anthropic; source: string; models: string[] } | { client: null; source: null; error: string }> {
  const sources = keySources(env)
  const ordered = workingSource ? [...sources.filter((s) => s.name === workingSource), ...sources.filter((s) => s.name !== workingSource)] : sources
  const errors: string[] = []
  for (const src of ordered) {
    const key = (await src.get())?.trim()
    if (!key) { errors.push(`${src.name}: empty`); continue }
    const client = mk(key)
    try {
      const page = await client.models.list({ limit: 50 })
      workingSource = src.name
      return { client, source: src.name, models: page.data.map((m) => m.id) }
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) { errors.push(`${src.name}: rejected (${e.status})`); continue }
      if (e instanceof Anthropic.APIError) { errors.push(`${src.name}: API ${e.status} ${e.message}`); continue }
      errors.push(`${src.name}: ${String((e as Error).message ?? e)}`)
    }
  }
  return { client: null, source: null, error: `No working Anthropic key. ${errors.join('; ')}` }
}

/** Connectivity check: which key source works and what models it can see. */
export async function testClaude(env: Env): Promise<{ ok: true; models: string[]; source: string } | { ok: false; error: string }> {
  const c = await claudeClient(env)
  return c.client ? { ok: true, models: c.models, source: c.source } : { ok: false, error: c.error }
}

type ModelRow = { ix: number; title: string; labels: string[]; bbox: { minX: number; minY: number; maxX: number; maxY: number }; entityCount: number; wallCount: number; objectId?: string | null }

/** Build the compact per-page summary Claude reviews. */
async function pageSummaries(db: D1Database, fileId: string, models: ModelRow[], k: number) {
  const layers = await all<{ model_ix: number; layer: string; etype: string; n: number }>(db, 'SELECT model_ix, layer, etype, COUNT(*) AS n FROM cad_entities WHERE file_id = ? AND model_ix IS NOT NULL GROUP BY model_ix, layer, etype', fileId)
  const texts = await all<{ model_ix: number; t: string }>(db, `SELECT model_ix, json_extract(attributes,'$.text') AS t FROM cad_entities WHERE file_id = ? AND model_ix IS NOT NULL AND etype IN ('TEXT','MTEXT') AND length(json_extract(attributes,'$.text')) BETWEEN 2 AND 60`, fileId)
  const cands = await all<{ kind: string; n: number; model_ix: number | null }>(db, `SELECT c.kind, COUNT(*) AS n, e.model_ix FROM candidates c LEFT JOIN cad_entities e ON e.file_id = c.file_id AND e.handle = json_extract(c.source_handles,'$[0]') WHERE c.file_id = ? GROUP BY c.kind, e.model_ix`, fileId)
  return models.map((m) => {
    const ls = layers.filter((l) => l.model_ix === m.ix)
    const byLayer = new Map<string, number>(); for (const l of ls) byLayer.set(l.layer, (byLayer.get(l.layer) ?? 0) + l.n)
    const byType = new Map<string, number>(); for (const l of ls) byType.set(l.etype, (byType.get(l.etype) ?? 0) + l.n)
    const seen = new Set<string>(); const sample: string[] = []
    for (const t of texts.filter((x) => x.model_ix === m.ix)) { const s = t.t.replace(/\s+/g, ' ').trim(); const key = s.toUpperCase(); if (!seen.has(key)) { seen.add(key); sample.push(s) } if (sample.length >= 40) break }
    return {
      ix: m.ix, title: m.title, roomLabels: m.labels,
      sizeFt: { width: Math.round((m.bbox.maxX - m.bbox.minX) * k), height: Math.round((m.bbox.maxY - m.bbox.minY) * k) },
      origin: { x: Math.round(m.bbox.minX * k), y: Math.round(m.bbox.minY * k) },
      entities: m.entityCount, wallLayerEntities: m.wallCount,
      entityTypes: Object.fromEntries([...byType.entries()].sort((a, b) => b[1] - a[1])),
      topLayers: Object.fromEntries([...byLayer.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)),
      detected: Object.fromEntries(cands.filter((c) => c.model_ix === m.ix).map((c) => [c.kind, c.n])),
      textSamples: sample,
    }
  })
}

const SYSTEM = `You review architectural CAD drawings for an engineering platform. A drawing set was uploaded; model space held many sheets side by side, and a scan found page-like regions that each contain room labels. Your job is step one of the workflow: decide which regions are the BASIC FLOOR PLANS to bring in as model units. Everything else (elevations, sections, roof plans, site plans, schedules, notes, demolition plans, duplicate existing/proposed copies) is generated later from the plans and must NOT be brought in.

Rules:
- A floor plan region shows walls, rooms and openings for one level of one building. Keep it.
- When the same building/level appears as existing and proposed, keep the PROPOSED one (the design going forward) and mark the existing as a duplicate (keep=false) unless there is no proposed version, in which case keep the existing.
- Demolition plans, roof plans, site plans, elevations, sections, schedules, fixture lists and note blocks are keep=false.
- Name each kept plan the way an engineer would label it: building + level + state, e.g. "Main House - First Floor (Proposed)", "Unit 2 - First Floor", "ADU - Floor Plan".
- Use the text samples and layer names (they may be in Spanish; MURO = wall, piso = floor, techo = roof, cristal = glass) and geometry counts as evidence. Explain each decision in one sentence.
- Be decisive. If two regions are nearly identical, keep exactly one.`

export async function reviewPlans(env: Env, fileId: string, actor: string): Promise<AgentReview | null> {
  const c = await claudeClient(env)
  const db = env.DB
  if (!c.client) {
    await updateStmt(db, 'cad_files', fileId, { agent_review: JSON.stringify({ error: c.error, at: new Date().toISOString() }) }).run()
    throw new Error(c.error)
  }
  const client = c.client
  const file = await one<{ id: string; project_id: string; filename: string; models: string | null; insunits: number | null }>(db, 'SELECT id, project_id, filename, models, insunits FROM cad_files WHERE id = ?', fileId)
  if (!file) throw new Error('File not found.')
  const models = JSON.parse(file.models ?? '[]') as ModelRow[]
  if (!models.length) return null
  const k = ({ 1: 1 / 12, 2: 1, 4: 1 / 304.8, 5: 1 / 30.48, 6: 1 / 0.3048 } as Record<number, number>)[file.insunits ?? 0] ?? 1 / 12
  const project = await one<{ name: string; address: string | null; city: string | null; state: string | null }>(db, 'SELECT name, address, city, state FROM projects WHERE id = ?', file.project_id)
  const pages = await pageSummaries(db, fileId, models, k)

  const response = await client.messages.parse({
    model: CLAUDE_MODEL,
    max_tokens: 8000,
    output_config: { effort: 'medium', format: zodOutputFormat(Review) },
    system: SYSTEM,
    messages: [{ role: 'user', content: `Project: ${project?.name ?? ''} at ${[project?.address, project?.city, project?.state].filter(Boolean).join(', ')}\nDrawing file: ${file.filename}\nUnits: ${file.insunits === 1 ? 'inches' : file.insunits === 2 ? 'feet' : file.insunits === 4 ? 'millimetres' : 'unknown'}\n\nRegions found (JSON):\n${JSON.stringify(pages, null, 1)}\n\nDecide for every region (by ix). Return one entry per region.` }],
  })
  if (response.stop_reason === 'refusal') throw new Error(`Claude declined the review: ${response.stop_details?.explanation ?? 'no explanation'}`)
  const parsed = response.parsed_output
  if (!parsed) throw new Error('Claude returned an unreadable review.')
  const review: AgentReview = { ...parsed, model: response.model, at: new Date().toISOString(), usage: { input: response.usage.input_tokens, output: response.usage.output_tokens }, source: c.source }

  // Apply: rename kept plans, park the rest. Names stay editable by the person afterwards.
  for (const d of review.pages) {
    const m = models.find((x) => x.ix === d.ix)
    if (!m) continue
    const tag = `PLAN.${fileId.slice(0, 8).toUpperCase()}.${String(m.ix + 1).padStart(2, '0')}`
    const obj = m.objectId ? { id: m.objectId } : await findByTag(db, file.project_id, tag)
    if (!obj) continue
    await patchObject(db, obj.id, { humanName: d.keep ? d.name : `${d.name} (${d.kind.replace('_', ' ')})`, properties: { use: d.keep, agent: { kind: d.kind, state: d.state, building: d.building, level: d.level, confidence: d.confidence, reason: d.reason, keep: d.keep } } })
  }
  await updateStmt(db, 'cad_files', fileId, { agent_review: JSON.stringify(review) }).run()
  void actor
  return review
}
