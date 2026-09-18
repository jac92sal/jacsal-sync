import type { CalcResult, Check, Gate, Inputs, InputSpec, ResultValue, Status, TraceStep } from './types'

/** Builder that keeps each module short and its output uniform. */
export class Calc {
  readonly missing: string[] = []
  readonly results: Record<string, ResultValue> = {}
  readonly checks: Check[] = []
  readonly gates: Gate[] = []
  readonly trace: TraceStep[] = []
  readonly notes: string[] = []

  readonly module: string
  readonly version: string
  readonly specs: InputSpec[]
  readonly inputs: Inputs
  constructor(module: string, version: string, specs: InputSpec[], inputs: Inputs) { this.module = module; this.version = version; this.specs = specs; this.inputs = inputs }

  /** Numeric input by key; records MISSING for required keys, applies defaults. */
  num(key: string): number | null {
    const spec = this.specs.find((s) => s.key === key)
    const raw = this.inputs[key]
    const v = raw === '' || raw === undefined || raw === null ? spec?.default : raw
    if (v === undefined || v === null || v === '') {
      if (spec?.required) this.missing.push(key)
      return null
    }
    const n = typeof v === 'number' ? v : Number(v)
    if (!Number.isFinite(n)) { this.missing.push(key); return null }
    return n
  }

  str(key: string): string | null {
    const spec = this.specs.find((s) => s.key === key)
    const raw = this.inputs[key]
    const v = raw === '' || raw === undefined || raw === null ? spec?.default : raw
    if (v === undefined || v === null || v === '') { if (spec?.required) this.missing.push(key); return null }
    return String(v)
  }

  /** Record a primary result with its equation, and an optional independent check. */
  result(key: string, value: number | null, unit: string | undefined, equation: string, check?: number | null): number | null {
    const checkStatus = value === null || check === undefined || check === null ? null : Math.abs(value - check) <= Math.max(1e-3, Math.abs(value) * 1e-6) ? 'PASS' : 'REVIEW'
    this.results[key] = { value, unit, equation, check: check ?? null, checkStatus }
    this.trace.push({ step: key, expression: equation, value, unit })
    return value
  }

  text(key: string, value: string | null, equation = ''): void {
    this.results[key] = { value, equation }
  }

  check(name: string, demand: number | null, capacity: number | null, unit?: string, note?: string): void {
    const ratio = demand === null || capacity === null || capacity === 0 ? null : demand / capacity
    const status: Status = ratio === null ? 'PENDING' : ratio <= 1 ? 'PASS' : 'FAIL'
    this.checks.push({ name, demand, capacity, unit, ratio, status, note })
  }

  gate(control: string, reason: string, status: 'REVIEW' | 'OK' = 'REVIEW'): void {
    this.gates.push({ control, status, reason })
  }

  finish(): CalcResult {
    const ratios = this.checks.map((c) => c.ratio).filter((r): r is number => r !== null)
    const utilization = ratios.length ? Math.max(...ratios) : null
    const anyFail = this.checks.some((c) => c.status === 'FAIL')
    const anyPending = this.checks.some((c) => c.status === 'PENDING') || this.missing.length > 0
    const crossCheckReview = Object.values(this.results).some((r) => r.checkStatus === 'REVIEW')
    const status: Status = anyFail ? 'FAIL' : anyPending ? 'PENDING' : crossCheckReview ? 'REVIEW' : 'PASS'
    return { module: this.module, version: this.version, status, utilization, missing: [...new Set(this.missing)], results: this.results, checks: this.checks, gates: this.gates, trace: this.trace, notes: this.notes }
  }
}

export const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d
