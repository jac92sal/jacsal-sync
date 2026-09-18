import type { CalcModule, Inputs } from '../types'
import { Calc } from '../util'

/** 14_LOAD_COMBOS — ASCE 7-22 §2.4 basic ASD combinations; returns each and the governing. */
export const loadCombos: CalcModule = {
  id: 'load-combos', title: 'Load Combinations (ASD)', version: '1.0.0', sheet: '14_LOAD_COMBOS',
  inputs: [
    { key: 'D', label: 'Dead', source: 'Gravity', required: true },
    { key: 'L', label: 'Live', source: 'Gravity', default: 0 },
    { key: 'Lr', label: 'Roof live', source: 'Gravity', default: 0 },
    { key: 'S', label: 'Snow', source: 'ASCE 7', default: 0 },
    { key: 'W', label: 'Wind', source: 'Wind module', default: 0 },
    { key: 'E', label: 'Seismic (strength level)', source: 'Seismic module', default: 0 },
    { key: 'unit', label: 'Unit of all effects', source: 'Caller', default: 'lb' },
  ],
  run(inputs: Inputs) {
    const c = new Calc(this.id, this.version, this.inputs, inputs)
    const D = c.num('D') ?? 0; const L = c.num('L') ?? 0; const Lr = c.num('Lr') ?? 0; const S = c.num('S') ?? 0; const W = c.num('W') ?? 0; const E = c.num('E') ?? 0
    const u = c.str('unit') ?? 'lb'; const LrS = Math.max(Lr, S)
    const combos: [string, string, number][] = [
      ['1', 'D', D], ['2', 'D + L', D + L], ['3', 'D + (Lr or S)', D + LrS], ['4', 'D + 0.75L + 0.75(Lr or S)', D + 0.75 * L + 0.75 * LrS],
      ['5', 'D + 0.6W', D + 0.6 * W], ['6a', 'D + 0.75L + 0.75(0.6W) + 0.75(Lr or S)', D + 0.75 * L + 0.75 * 0.6 * W + 0.75 * LrS],
      ['7', '0.6D + 0.6W', 0.6 * D + 0.6 * W], ['8', 'D + 0.7E', D + 0.7 * E], ['9', 'D + 0.75L + 0.75(0.7E) + 0.75S', D + 0.75 * L + 0.75 * 0.7 * E + 0.75 * S], ['10', '0.6D + 0.7E', 0.6 * D + 0.7 * E],
    ]
    let gov: [string, string, number] = combos[0]
    for (const k of combos) { c.result(`combo_${k[0]}`, k[2], u, k[1]); if (Math.abs(k[2]) > Math.abs(gov[2])) gov = k }
    c.result('governing', gov[2], u, `Governing: (${gov[0]}) ${gov[1]}`)
    c.text('governing_combo', gov[0])
    c.gate('Uplift / overturning', 'Combination 7 and 10 sign conventions must match the member; verify uplift cases explicitly.')
    return c.finish()
  },
}
