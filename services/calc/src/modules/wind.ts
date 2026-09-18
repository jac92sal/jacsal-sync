import type { CalcModule, Inputs } from '../types'
import { Calc } from '../util'

/** 16_WIND — ASCE 7-22 velocity pressure. Kd applied in the pressure equation (7-22), not in qz. */
const EXPOSURE: Record<string, { alpha: number; zg: number; zmin: number }> = {
  B: { alpha: 7.5, zg: 3280, zmin: 30 }, C: { alpha: 9.8, zg: 2460, zmin: 15 }, D: { alpha: 11.5, zg: 1935, zmin: 7 },
}
export const wind: CalcModule = {
  id: 'wind', title: 'Wind (ASCE 7-22)', version: '1.0.0', sheet: '16_WIND',
  inputs: [
    { key: 'V_mph', label: 'Basic wind speed Vult', unit: 'mph', source: 'ASCE 7-22 hazard tool / AHJ', required: true },
    { key: 'exposure', label: 'Exposure', source: 'Site', options: ['B', 'C', 'D'], required: true },
    { key: 'mean_roof_height_ft', label: 'Mean roof height h', unit: 'ft', source: 'CAD confirm', required: true },
    { key: 'Kzt', label: 'Topographic factor Kzt', source: 'ASCE 7-22 26.8', default: 1.0 },
    { key: 'Ke', label: 'Ground elevation factor Ke', source: 'ASCE 7-22 26.9', default: 1.0 },
    { key: 'Kd', label: 'Directionality Kd', source: 'ASCE 7-22 Table 26.6-1', default: 0.85 },
    { key: 'G', label: 'Gust effect G', source: 'ASCE 7-22 26.11', default: 0.85 },
    { key: 'GCpi', label: 'Internal pressure ±GCpi', source: 'ASCE 7-22 Table 26.13-1', default: 0.18 },
    { key: 'Cp_windward', label: 'Cp windward wall', source: 'ASCE 7-22 Fig 27.3-1', default: 0.8 },
    { key: 'Cp_leeward', label: 'Cp leeward wall', source: 'ASCE 7-22 Fig 27.3-1', default: -0.5 },
  ],
  run(inputs: Inputs) {
    const c = new Calc(this.id, this.version, this.inputs, inputs)
    const V = c.num('V_mph'); const ex = c.str('exposure'); const h = c.num('mean_roof_height_ft')
    const Kzt = c.num('Kzt') ?? 1; const Ke = c.num('Ke') ?? 1; const Kd = c.num('Kd') ?? 0.85; const G = c.num('G') ?? 0.85; const GCpi = c.num('GCpi') ?? 0.18
    const e = ex ? EXPOSURE[ex] : undefined
    if (ex && !e) c.missing.push('exposure')
    const z = e && h !== null ? Math.max(h, e.zmin) : null
    const Kz = c.result('Kz', e && z !== null ? 2.01 * (z / e.zg) ** (2 / e.alpha) : null, '', 'Kz = 2.01·(z/zg)^(2/α), z ≥ zmin')
    const qh = c.result('qh_psf', Kz !== null && V !== null ? 0.00256 * Kz * Kzt * Ke * V * V : null, 'psf', 'qh = 0.00256·Kz·Kzt·Ke·V²')
    const pw = c.result('p_windward_psf', qh !== null ? qh * Kd * (G * (c.num('Cp_windward') ?? 0.8) + GCpi) : null, 'psf', 'p = qh·Kd·[G·Cp − (−GCpi)] windward, +GCpi worst case')
    const pl = c.result('p_leeward_psf', qh !== null ? qh * Kd * (G * (c.num('Cp_leeward') ?? -0.5) - GCpi) : null, 'psf', 'p = qh·Kd·[G·Cp − GCpi] leeward')
    c.result('p_net_mwfrs_psf', pw !== null && pl !== null ? pw - pl : null, 'psf', 'Net MWFRS wall pressure = windward − leeward')
    c.gate('Procedure applicability', 'Directional procedure wall pressures only; roof pressures, C&C and envelope procedure require engineer selection.')
    c.gate('Kz table vs equation', 'Kz from the power-law equation; verify against Table 26.10-1 for the governing exposure.')
    return c.finish()
  },
}
