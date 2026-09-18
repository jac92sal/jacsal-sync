import type { CalcModule, Inputs } from '../types'
import { Calc } from '../util'

/** 28_CONNECTIONS — dowel-type fastener group: adjusted Z′ and required count. */
export const connections: CalcModule = {
  id: 'connections', title: 'Connections', version: '1.0.0', sheet: '28_CONNECTIONS',
  inputs: [
    { key: 'mark', label: 'Connection mark', source: 'Object model', required: true },
    { key: 'demand_lb', label: 'Force demand (ASD)', unit: 'lb', source: 'Member reaction', required: true },
    { key: 'Z_lb', label: 'Reference lateral design value Z', unit: 'lb', source: 'NDS Ch. 12 tables', required: true },
    { key: 'CD', label: 'Load duration CD', source: 'NDS 2.3.2', default: 1.0 },
    { key: 'CM', label: 'Wet service CM', source: 'NDS Table 11.3.3', default: 1.0 },
    { key: 'Ct', label: 'Temperature Ct', source: 'NDS Table 11.3.4', default: 1.0 },
    { key: 'Cg', label: 'Group action Cg', source: 'NDS 11.3.6', default: 1.0 },
    { key: 'Cdelta', label: 'Geometry CΔ', source: 'NDS 12.5.1', default: 1.0 },
    { key: 'Ceg', label: 'End grain Ceg', source: 'NDS 12.5.2', default: 1.0 },
    { key: 'Cdi', label: 'Diaphragm Cdi', source: 'NDS 12.5.3', default: 1.0 },
    { key: 'Ctn', label: 'Toe-nail Ctn', source: 'NDS 12.5.4', default: 1.0 },
    { key: 'n_provided', label: 'Fasteners provided', source: 'Detail' },
  ],
  run(inputs: Inputs) {
    const c = new Calc(this.id, this.version, this.inputs, inputs)
    c.text('mark', c.str('mark'))
    const P = c.num('demand_lb'); const Z = c.num('Z_lb'); const f = (k: string) => c.num(k) ?? 1
    const Zadj = c.result('Z_adj_lb', Z !== null ? Z * f('CD') * f('CM') * f('Ct') * f('Cg') * f('Cdelta') * f('Ceg') * f('Cdi') * f('Ctn') : null, 'lb', "Z′ = Z·CD·CM·Ct·Cg·CΔ·Ceg·Cdi·Ctn")
    const nReq = c.result('n_required', P !== null && Zadj ? Math.ceil(P / Zadj) : null, 'ea', "n = ⌈P/Z′⌉")
    const nProv = c.num('n_provided')
    if (nProv !== null) c.check('Fastener count', nReq, nProv, 'ea', 'required vs provided')
    else c.check('Fastener count', nReq, null, 'ea', 'n_provided not given')
    c.gate('Spacing / end / edge distances', 'Geometry minimums per NDS 12.5 are not automated; CΔ is a controlled input.')
    return c.finish()
  },
}
