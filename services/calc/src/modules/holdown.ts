import type { CalcModule, Inputs } from '../types'
import { Calc } from '../util'

/** 29_HOLDOWN — holdown/anchor rod tension against ESR allowable. */
export const holdown: CalcModule = {
  id: 'holdown', title: 'Holdowns', version: '1.0.0', sheet: '29_HOLDOWN',
  inputs: [
    { key: 'mark', label: 'Holdown mark', source: 'Object model', required: true },
    { key: 'T_lb', label: 'Tension demand (ASD)', unit: 'lb', source: 'Shear wall module', required: true },
    { key: 'product', label: 'Product', source: 'ESR', required: true },
    { key: 'allow_lb', label: 'Allowable tension', unit: 'lb', source: 'ESR table (post size, fasteners)', required: true },
    { key: 'anchor_allow_lb', label: 'Anchor rod / embed allowable', unit: 'lb', source: 'ESR / ACI 318 Ch. 17', required: true },
    { key: 'CD', label: 'Load duration CD', source: 'NDS 2.3.2', default: 1.6 },
  ],
  run(inputs: Inputs) {
    const c = new Calc(this.id, this.version, this.inputs, inputs)
    c.text('mark', c.str('mark')); c.text('product', c.str('product'))
    const T = c.num('T_lb'); const a = c.num('allow_lb'); const an = c.num('anchor_allow_lb')
    c.check('Holdown tension', T, a, 'lb', 'ESR allowable already includes CD unless noted')
    c.check('Anchor rod / embed', T, an, 'lb', 'ACI 318 Ch. 17 or ESR')
    c.gate('Deflection / rod elongation', 'Holdown displacement contributes to wall drift; verify against ESR deflection at allowable.')
    return c.finish()
  },
}
