import type { CalcModule, Inputs } from '../types'
import { Calc } from '../util'

/** 18_SEISMIC — ASCE 7-22 equivalent lateral force base shear. */
export const seismic: CalcModule = {
  id: 'seismic', title: 'Seismic (ELF, ASCE 7-22)', version: '1.0.0', sheet: '18_SEISMIC',
  inputs: [
    { key: 'SDS', label: 'SDS', unit: 'g', source: 'USGS / ASCE 7-22', required: true },
    { key: 'SD1', label: 'SD1', unit: 'g', source: 'USGS / ASCE 7-22', required: true },
    { key: 'R', label: 'Response modification R', source: 'ASCE 7-22 Table 12.2-1', required: true, default: 6.5 },
    { key: 'Ie', label: 'Importance factor Ie', source: 'ASCE 7-22 Table 1.5-2', default: 1.0 },
    { key: 'hn_ft', label: 'Structural height hn', unit: 'ft', source: 'CAD confirm', required: true },
    { key: 'Ct', label: 'Period coefficient Ct', source: 'ASCE 7-22 Table 12.8-2', default: 0.02 },
    { key: 'x', label: 'Period exponent x', source: 'ASCE 7-22 Table 12.8-2', default: 0.75 },
    { key: 'TL_s', label: 'Long-period transition TL', unit: 's', source: 'ASCE 7-22 Fig 22-14', default: 8 },
    { key: 'W_lb', label: 'Effective seismic weight W', unit: 'lb', source: 'Gravity takeoff', required: true },
    { key: 'sdc', label: 'Seismic design category', source: 'ASCE 7-22 11.6' },
  ],
  run(inputs: Inputs) {
    const c = new Calc(this.id, this.version, this.inputs, inputs)
    const SDS = c.num('SDS'); const SD1 = c.num('SD1'); const R = c.num('R') ?? 6.5; const Ie = c.num('Ie') ?? 1; const hn = c.num('hn_ft'); const Ct = c.num('Ct') ?? 0.02; const x = c.num('x') ?? 0.75; const TL = c.num('TL_s') ?? 8; const W = c.num('W_lb')
    const Ta = c.result('Ta_s', hn !== null ? Ct * hn ** x : null, 's', 'Ta = Ct·hn^x')
    const Cs0 = c.result('Cs_basic', SDS !== null ? SDS / (R / Ie) : null, '', 'Cs = SDS/(R/Ie)')
    const CsMax = c.result('Cs_max', SD1 !== null && Ta ? (Ta <= TL ? SD1 / (Ta * (R / Ie)) : (SD1 * TL) / (Ta * Ta * (R / Ie))) : null, '', 'Cs ≤ SD1/(T·R/Ie) (T ≤ TL)')
    const CsMin = c.result('Cs_min', SDS !== null ? Math.max(0.044 * SDS * Ie, 0.01) : null, '', 'Cs ≥ max(0.044·SDS·Ie, 0.01)')
    const Cs = c.result('Cs', Cs0 !== null && CsMax !== null && CsMin !== null ? Math.max(Math.min(Cs0, CsMax), CsMin) : null, '', 'Cs = clamp(Cs_basic, Cs_min, Cs_max)')
    c.result('V_lb', Cs !== null && W !== null ? Cs * W : null, 'lb', 'V = Cs·W (strength level)')
    c.result('V_asd_lb', Cs !== null && W !== null ? 0.7 * Cs * W : null, 'lb', '0.7·V for ASD combinations')
    c.text('sdc', c.str('sdc'))
    c.gate('S1 ≥ 0.6g check', 'Additional Cs minimum for S1 ≥ 0.6g not evaluated; verify when applicable.')
    c.gate('Vertical distribution / irregularities', 'Story forces, redundancy ρ and irregularity checks are engineer-controlled.')
    return c.finish()
  },
}
