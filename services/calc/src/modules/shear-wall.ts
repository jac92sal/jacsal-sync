import type { CalcModule, Inputs } from '../types'
import { Calc } from '../util'

/** 24_SHEAR_WALL — wood structural panel shear wall unit shear, aspect ratio, overturning. */
export const shearWall: CalcModule = {
  id: 'shear-wall', title: 'Shear Wall', version: '1.0.0', sheet: '24_SHEAR_WALL',
  inputs: [
    { key: 'mark', label: 'Shear wall mark', source: 'Object model', required: true },
    { key: 'V_lb', label: 'Shear demand V (ASD)', unit: 'lb', source: 'Lateral distribution', required: true },
    { key: 'L_ft', label: 'Wall length L', unit: 'ft', source: 'CAD confirm', required: true },
    { key: 'h_ft', label: 'Wall height h', unit: 'ft', source: 'CAD confirm', required: true },
    { key: 'v_allow_plf', label: 'Allowable unit shear', unit: 'plf', source: 'SDPWS Table 4.3A (ASD) / ESR', required: true },
    { key: 'lateral_type', label: 'Lateral load type', source: 'Project', options: ['seismic', 'wind'], default: 'seismic' },
    { key: 'PD_lb', label: 'Dead load resisting overturning', unit: 'lb', source: 'Gravity', default: 0 },
    { key: 'holdown_allow_lb', label: 'Holdown allowable tension', unit: 'lb', source: 'ESR', },
  ],
  run(inputs: Inputs) {
    const c = new Calc(this.id, this.version, this.inputs, inputs)
    c.text('mark', c.str('mark'))
    const V = c.num('V_lb'); const L = c.num('L_ft'); const h = c.num('h_ft'); const vAllow = c.num('v_allow_plf'); const PD = c.num('PD_lb') ?? 0; const type = c.str('lateral_type') ?? 'seismic'
    const v = c.result('v_plf', V !== null && L ? V / L : null, 'plf', 'v = V/L')
    const ar = c.result('aspect_ratio', h !== null && L ? h / L : null, '', 'h/L')
    // SDPWS 4.3.3.4: 2 < h/b ≤ 3.5 requires capacity reduction (2b/h for wind; 1.25 − 0.125h/b for seismic).
    let factor: number | null = null
    if (ar !== null) factor = ar <= 2 ? 1 : ar <= 3.5 ? (type === 'wind' ? 2 / ar : 1.25 - 0.125 * ar) : 0
    c.result('aspect_factor', factor, '', 'SDPWS 4.3.3.4 reduction')
    const vAdj = c.result('v_allow_adj_plf', vAllow !== null && factor !== null ? vAllow * factor : null, 'plf', 'v_allow · aspect factor')
    c.check('Unit shear', v, vAdj, 'plf', 'v vs adjusted allowable unit shear')
    c.check('Aspect ratio ≤ 3.5', ar, 3.5, '', 'SDPWS 4.3.4')
    const OTM = c.result('OTM_ftlb', V !== null && h !== null ? V * h : null, 'ft-lb', 'OTM = V·h')
    const RM = c.result('RM_ftlb', L !== null ? 0.6 * PD * (L / 2) : null, 'ft-lb', 'RM = 0.6·PD·L/2 (ASD 0.6D)')
    const T = c.result('T_lb', OTM !== null && RM !== null && L ? Math.max(0, (OTM - RM) / L) : null, 'lb', 'T = (OTM − RM)/L')
    const hd = c.num('holdown_allow_lb')
    if (hd !== null) c.check('Holdown tension', T, hd, 'lb', 'T vs ESR allowable')
    c.gate('Nailing / sheathing schedule', 'Allowable unit shear is a source-controlled table value; nail size, spacing and panel grade must match the schedule.')
    c.gate('Perforated / FTAO walls', 'Only segmented walls are automated.')
    return c.finish()
  },
}
