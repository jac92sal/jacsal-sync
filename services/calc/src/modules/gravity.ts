import type { CalcModule, Inputs } from '../types'
import { Calc } from '../util'

/** 03_GRAVITY — line loads and simple-span effects for a member from area loads. */
export const gravity: CalcModule = {
  id: 'gravity', title: 'Gravity Effects', version: '1.0.0', sheet: '03_GRAVITY',
  inputs: [
    { key: 'load_basis', label: 'Load basis', source: 'Project', options: ['Roof', 'Floor'], required: true },
    { key: 'trib_width_ft', label: 'Tributary width', unit: 'ft', source: 'CAD confirm', required: true },
    { key: 'span_ft', label: 'Span', unit: 'ft', source: 'CAD confirm', required: true },
    { key: 'roof_dead_psf', label: 'Roof dead load', unit: 'psf', source: 'Project criteria' },
    { key: 'roof_live_psf', label: 'Roof live load', unit: 'psf', source: 'CBC / ASCE 7' },
    { key: 'floor_dead_psf', label: 'Floor dead load', unit: 'psf', source: 'Project criteria' },
    { key: 'floor_live_psf', label: 'Floor live load', unit: 'psf', source: 'CBC / ASCE 7' },
  ],
  run(inputs: Inputs) {
    const c = new Calc(this.id, this.version, this.inputs, inputs)
    const basis = c.str('load_basis'); const tw = c.num('trib_width_ft'); const L = c.num('span_ft')
    const qD = basis === 'Roof' ? c.num('roof_dead_psf') : c.num('floor_dead_psf')
    const qL = basis === 'Roof' ? c.num('roof_live_psf') : c.num('floor_live_psf')
    if (qD === null) c.missing.push(basis === 'Roof' ? 'roof_dead_psf' : 'floor_dead_psf')
    if (qL === null) c.missing.push(basis === 'Roof' ? 'roof_live_psf' : 'floor_live_psf')
    const wD = c.result('wD_plf', qD !== null && tw !== null ? qD * tw : null, 'plf', 'wD = qD · tributary width')
    const wL = c.result('wL_plf', qL !== null && tw !== null ? qL * tw : null, 'plf', 'wL = qL · tributary width')
    const w = c.result('w_plf', wD !== null && wL !== null ? wD + wL : null, 'plf', 'w = wD + wL')
    c.result('R_lb', w !== null && L !== null ? (w * L) / 2 : null, 'lb', 'R = wL/2', w !== null && L !== null ? w * L * 0.5 : null)
    c.result('M_ftlb', w !== null && L !== null ? (w * L * L) / 8 : null, 'ft-lb', 'M = wL²/8', w !== null && L !== null ? ((w * L) / 2) * (L / 2) - (w * (L / 2) ** 2) / 2 : null)
    return c.finish()
  },
}
