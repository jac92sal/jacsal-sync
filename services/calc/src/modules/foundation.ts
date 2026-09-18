import type { CalcModule, Inputs } from '../types'
import { Calc } from '../util'

/** 36_FOUNDATION — spread/continuous footing bearing against allowable soil pressure. */
export const foundation: CalcModule = {
  id: 'foundation', title: 'Foundation', version: '1.0.0', sheet: '36_FOUNDATION',
  inputs: [
    { key: 'mark', label: 'Footing mark', source: 'Object model', required: true },
    { key: 'type', label: 'Footing type', source: 'Detail', options: ['spread', 'continuous'], required: true },
    { key: 'P_lb', label: 'Service load P (spread) or plf (continuous)', unit: 'lb or plf', source: 'Post / wall reaction', required: true },
    { key: 'B_ft', label: 'Width B', unit: 'ft', source: 'CAD confirm', required: true },
    { key: 'L_ft', label: 'Length L (spread only)', unit: 'ft', source: 'CAD confirm' },
    { key: 't_in', label: 'Thickness', unit: 'in', source: 'Detail', required: true },
    { key: 'q_allow_psf', label: 'Allowable soil bearing', unit: 'psf', source: 'Geotech report / CBC Table 1806.2', required: true },
    { key: 'conc_pcf', label: 'Concrete unit weight', unit: 'pcf', source: 'Project', default: 150 },
  ],
  run(inputs: Inputs) {
    const c = new Calc(this.id, this.version, this.inputs, inputs)
    c.text('mark', c.str('mark'))
    const type = c.str('type'); const P = c.num('P_lb'); const B = c.num('B_ft'); const L = c.num('L_ft'); const t = c.num('t_in'); const qa = c.num('q_allow_psf'); const gc = c.num('conc_pcf') ?? 150
    const selfW = t !== null ? (t / 12) * gc : null
    let q: number | null = null
    if (type === 'spread') { if (L === null) c.missing.push('L_ft'); q = P !== null && B && L ? P / (B * L) + (selfW ?? 0) : null; c.result('q_psf', q, 'psf', 'q = P/(B·L) + footing self-weight') }
    else { q = P !== null && B ? P / B + (selfW ?? 0) : null; c.result('q_psf', q, 'psf', 'q = (P/ft)/B + footing self-weight') }
    c.check('Soil bearing', q, qa, 'psf', 'q vs allowable')
    c.gate('Concrete flexure / one-way shear / reinforcing', 'ACI 318 checks are not automated; plain footing minimums per CBC 1809 require review.')
    c.gate('Geotechnical basis', 'Allowable bearing must come from a geotech report or CBC presumptive table with the source recorded.')
    return c.finish()
  },
}
