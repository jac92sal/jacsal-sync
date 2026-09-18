import type { CalcModule, Inputs } from '../types'
import { Calc } from '../util'

/** 22_WOOD_COLUMN — solid sawn rectangular column, NDS 2024 ASD, column stability factor CP. */
export const woodColumn: CalcModule = {
  id: 'wood-column', title: 'Wood Column / Post', version: '1.0.0', sheet: '22_WOOD_COLUMN',
  inputs: [
    { key: 'member_mark', label: 'Member mark', source: 'Object model', required: true },
    { key: 'P_lb', label: 'Axial demand P (ASD)', unit: 'lb', source: 'Supported member reaction', required: true },
    { key: 'b_in', label: 'Width b', unit: 'in', source: 'CAD confirm', required: true },
    { key: 'd_in', label: 'Depth d', unit: 'in', source: 'CAD confirm', required: true },
    { key: 'le_ft', label: 'Effective length le', unit: 'ft', source: 'Framing / bracing', required: true },
    { key: 'Fc_psi', label: 'Fc reference', unit: 'psi', source: '2024 NDS Supplement', required: true },
    { key: 'Emin_psi', label: 'Emin reference', unit: 'psi', source: '2024 NDS Supplement', required: true },
    { key: 'CD', label: 'Load duration CD', source: 'NDS 2.3.2', default: 1.0 },
    { key: 'CM', label: 'Wet service CM', source: 'NDS Supplement', default: 1.0 },
    { key: 'Ct', label: 'Temperature Ct', source: 'NDS 2.3.3', default: 1.0 },
    { key: 'CF', label: 'Size factor CF', source: 'NDS Supplement', default: 1.0 },
    { key: 'Ci', label: 'Incising Ci', source: 'NDS 4.3.8', default: 1.0 },
    { key: 'c', label: 'Column parameter c', source: 'NDS 3.7.1 (0.8 sawn, 0.9 glulam)', default: 0.8 },
  ],
  run(inputs: Inputs) {
    const c = new Calc(this.id, this.version, this.inputs, inputs)
    c.text('member_mark', c.str('member_mark'))
    const P = c.num('P_lb'); const b = c.num('b_in'); const d = c.num('d_in'); const le = c.num('le_ft')
    const Fc = c.num('Fc_psi'); const Emin = c.num('Emin_psi'); const cc = c.num('c') ?? 0.8
    const f = (k: string) => c.num(k) ?? 1
    const A = c.result('A_in2', b !== null && d !== null ? b * d : null, 'in²', 'A = b·d')
    const dmin = b !== null && d !== null ? Math.min(b, d) : null
    const led = c.result('le_over_d', le !== null && dmin ? (le * 12) / dmin : null, '', 'le/d (weak axis)')
    const FcStar = c.result('Fc_star_psi', Fc !== null ? Fc * f('CD') * f('CM') * f('Ct') * f('CF') * f('Ci') : null, 'psi', 'Fc* = Fc·CD·CM·Ct·CF·Ci')
    const EminAdj = c.result('Emin_adj_psi', Emin !== null ? Emin * f('CM') * f('Ct') : null, 'psi', "Emin′ = Emin·CM·Ct")
    const FcE = c.result('FcE_psi', EminAdj !== null && led ? (0.822 * EminAdj) / led ** 2 : null, 'psi', "FcE = 0.822·Emin′/(le/d)²")
    const alpha = FcE !== null && FcStar ? FcE / FcStar : null
    const CP = c.result('CP', alpha !== null ? (1 + alpha) / (2 * cc) - Math.sqrt(((1 + alpha) / (2 * cc)) ** 2 - alpha / cc) : null, '', 'CP = (1+α)/2c − √[((1+α)/2c)² − α/c]')
    const FcAdj = c.result('Fc_adj_psi', FcStar !== null && CP !== null ? FcStar * CP : null, 'psi', "Fc′ = Fc*·CP")
    const fc = c.result('fc_psi', P !== null && A ? P / A : null, 'psi', 'fc = P/A')
    c.check('Axial compression', fc, FcAdj, 'psi', "fc vs Fc′")
    c.check('Slenderness le/d ≤ 50', led, 50, '', 'NDS 3.7.1.4')
    c.gate('Combined bending + axial', 'Eccentric or side loads require NDS 3.9 interaction; not automated.')
    c.gate('End conditions / Ke', 'Effective length assumes Ke applied by the engineer in le.')
    return c.finish()
  },
}
