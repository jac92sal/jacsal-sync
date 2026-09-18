import type { CalcModule, Inputs } from '../types'
import { Calc } from '../util'

/** 31_COLLECTOR_CHORD — collector force accumulation and member check against a source-controlled capacity. */
export const collectorChord: CalcModule = {
  id: 'collector-chord', title: 'Collectors / Chords', version: '1.0.0', sheet: '31_COLLECTOR_CHORD',
  inputs: [
    { key: 'mark', label: 'Collector mark', source: 'Object model', required: true },
    { key: 'v_diaphragm_plf', label: 'Diaphragm unit shear', unit: 'plf', source: 'Diaphragm module', required: true },
    { key: 'v_wall_plf', label: 'Shear wall unit shear', unit: 'plf', source: 'Shear wall module', default: 0 },
    { key: 'collector_length_ft', label: 'Collector length beyond wall', unit: 'ft', source: 'CAD confirm', required: true },
    { key: 'capacity_lb', label: 'Member/connection allowable axial', unit: 'lb', source: 'NDS / ESR', required: true },
    { key: 'omega0', label: 'Overstrength Ω0 (if required)', source: 'ASCE 7-22 12.10.2.1', default: 1.0 },
  ],
  run(inputs: Inputs) {
    const c = new Calc(this.id, this.version, this.inputs, inputs)
    c.text('mark', c.str('mark'))
    const vd = c.num('v_diaphragm_plf'); const vw = c.num('v_wall_plf') ?? 0; const Lc = c.num('collector_length_ft'); const cap = c.num('capacity_lb'); const om = c.num('omega0') ?? 1
    const F = c.result('F_lb', vd !== null && Lc !== null ? (vd + vw) * Lc * om : null, 'lb', 'F = (v_diaph + v_wall)·Lc·Ω0')
    c.check('Collector axial', F, cap, 'lb', 'F vs allowable')
    c.gate('Overstrength applicability', 'Ω0 applies to collectors in SDC C–F per ASCE 7-22 12.10.2.1; engineer sets omega0.')
    return c.finish()
  },
}
