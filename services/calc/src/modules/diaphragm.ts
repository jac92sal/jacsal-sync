import type { CalcModule, Inputs } from '../types'
import { Calc } from '../util'

/** 25_DIAPHRAGM — simple rectangular diaphragm: unit shear at supports and chord force. */
export const diaphragm: CalcModule = {
  id: 'diaphragm', title: 'Diaphragm', version: '1.0.0', sheet: '25_DIAPHRAGM',
  inputs: [
    { key: 'mark', label: 'Diaphragm mark', source: 'Object model', required: true },
    { key: 'w_plf', label: 'Lateral line load w', unit: 'plf', source: 'Wind / seismic', required: true },
    { key: 'L_ft', label: 'Span between shear walls L', unit: 'ft', source: 'CAD confirm', required: true },
    { key: 'W_ft', label: 'Diaphragm depth W', unit: 'ft', source: 'CAD confirm', required: true },
    { key: 'v_allow_plf', label: 'Allowable unit shear', unit: 'plf', source: 'SDPWS Table 4.2A/B', required: true },
  ],
  run(inputs: Inputs) {
    const c = new Calc(this.id, this.version, this.inputs, inputs)
    c.text('mark', c.str('mark'))
    const w = c.num('w_plf'); const L = c.num('L_ft'); const W = c.num('W_ft'); const vA = c.num('v_allow_plf')
    const R = c.result('R_lb', w !== null && L !== null ? (w * L) / 2 : null, 'lb', 'R = wL/2')
    const v = c.result('v_plf', R !== null && W ? R / W : null, 'plf', 'v = R/W')
    const M = c.result('M_ftlb', w !== null && L !== null ? (w * L * L) / 8 : null, 'ft-lb', 'M = wL²/8')
    c.result('chord_lb', M !== null && W ? M / W : null, 'lb', 'Chord T = C = M/W')
    c.check('Unit shear', v, vA, 'plf', 'v vs allowable')
    c.check('Aspect ratio L/W ≤ 4', L !== null && W ? L / W : null, 4, '', 'SDPWS Table 4.2.4 (blocked WSP)')
    c.gate('Openings / irregular shape', 'Only simple rectangular diaphragms are automated.')
    return c.finish()
  },
}
