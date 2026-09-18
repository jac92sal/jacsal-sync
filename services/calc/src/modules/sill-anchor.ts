import type { CalcModule, Inputs } from '../types'
import { Calc } from '../util'

/** 30_SILL_ANCHOR — anchor bolt spacing for sill plate shear transfer. */
export const sillAnchor: CalcModule = {
  id: 'sill-anchor', title: 'Sill / Anchors', version: '1.0.0', sheet: '30_SILL_ANCHOR',
  inputs: [
    { key: 'mark', label: 'Sill line mark', source: 'Object model', required: true },
    { key: 'v_plf', label: 'Unit shear at sill', unit: 'plf', source: 'Shear wall module', required: true },
    { key: 'Z_bolt_lb', label: 'Allowable per anchor (parallel to grain)', unit: 'lb', source: 'NDS Table 12E / ESR', required: true },
    { key: 'max_spacing_in', label: 'Max code spacing', unit: 'in', source: 'CBC 2308 / IRC R403.1.6', default: 72 },
    { key: 'spacing_provided_in', label: 'Spacing provided', unit: 'in', source: 'Detail' },
  ],
  run(inputs: Inputs) {
    const c = new Calc(this.id, this.version, this.inputs, inputs)
    c.text('mark', c.str('mark'))
    const v = c.num('v_plf'); const Z = c.num('Z_bolt_lb'); const smax = c.num('max_spacing_in') ?? 72; const sp = c.num('spacing_provided_in')
    const sReq = c.result('spacing_required_in', v && Z !== null ? Math.min((Z / v) * 12, smax) : null, 'in', 's = min(Z/v · 12, code max)')
    if (sp !== null) c.check('Anchor spacing', sp, sReq, 'in', 'provided ≤ required')
    else c.check('Anchor spacing', null, sReq, 'in', 'spacing_provided_in not given')
    c.gate('Plate washers / edge distance', '3×3 plate washers and 7-bolt-diameter end distance per CBC/SDPWS are not automated.')
    return c.finish()
  },
}
