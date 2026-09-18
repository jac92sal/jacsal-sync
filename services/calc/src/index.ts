import { WorkerEntrypoint } from 'cloudflare:workers'
import { MODULES, MODULES_FOR_TYPE, byId } from './registry'
import type { CalcResult, Inputs, ModuleMeta } from './types'
import { woodBeamBenchmarks } from './modules/wood-beam'

export type { CalcResult, Inputs, ModuleMeta, Check, Gate, TraceStep, InputSpec } from './types'

/** CalcService — the calculation engine over a Service Binding. */
export class CalcService extends WorkerEntrypoint<Env> {
  list(): ModuleMeta[] {
    return MODULES.map(({ id, title, version, sheet, inputs }) => ({ id, title, version, sheet, inputs }))
  }
  modulesForType(type: string): string[] {
    return MODULES_FOR_TYPE[type] ?? []
  }
  run(module: string, inputs: Inputs): CalcResult {
    const m = byId.get(module)
    if (!m) throw new Error(`unknown calc module: ${module}`)
    return m.run(inputs)
  }
  runMany(jobs: { module: string; inputs: Inputs }[]): CalcResult[] {
    return jobs.map((j) => this.run(j.module, j.inputs))
  }
  /** Locked QA benchmarks (05_QA_VALIDATION / module M-columns). */
  benchmarks(): { id: string; expected: number; actual: number; status: 'PASS' | 'REVIEW' }[] {
    return woodBeamBenchmarks.map((b) => { const actual = b.actual(); return { id: b.id, expected: b.expected, actual, status: Math.abs(actual - b.expected) <= b.tol ? 'PASS' : 'REVIEW' } })
  }
}

export default { fetch: () => new Response('jacsal-sync-calc: service binding only', { status: 404 }) } satisfies ExportedHandler<Env>
