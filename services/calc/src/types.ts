/** Shared calculation contract. Mirrors the workbook module sheets: inputs with
 * provenance, primary results with equations, independent cross-checks, D/C
 * checks, review gates, and a longhand trace. No silent assumptions. */

export type Status = 'PASS' | 'FAIL' | 'REVIEW' | 'PENDING'

export interface InputSpec {
  key: string
  label: string
  unit?: string
  required?: boolean
  /** Where the value must come from (NDS Supplement, ASCE 7, CAD confirm, geotech...). */
  source: string
  default?: number | string
  options?: string[]
}

export interface ResultValue {
  value: number | string | null
  unit?: string
  equation?: string
  /** Independent check value and whether it matched (workbook "Independent Check"). */
  check?: number | null
  checkStatus?: 'PASS' | 'REVIEW' | null
}

export interface Check {
  name: string
  demand: number | null
  capacity: number | null
  unit?: string
  ratio: number | null
  status: Status
  note?: string
}

export interface Gate {
  control: string
  status: 'REVIEW' | 'OK'
  reason: string
}

export interface TraceStep {
  step: string
  expression: string
  value: number | string | null
  unit?: string
}

export interface CalcResult {
  module: string
  version: string
  status: Status
  utilization: number | null
  missing: string[]
  results: Record<string, ResultValue>
  checks: Check[]
  gates: Gate[]
  trace: TraceStep[]
  notes: string[]
}

export interface CalcModule {
  id: string
  title: string
  version: string
  /** Workbook sheet this mirrors, for the report and the issue gate. */
  sheet: string
  inputs: InputSpec[]
  run(inputs: Inputs): CalcResult
}

export type Inputs = Record<string, unknown>

export interface ModuleMeta {
  id: string
  title: string
  version: string
  sheet: string
  inputs: InputSpec[]
}
