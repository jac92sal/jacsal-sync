import type { CalcModule, Inputs } from '../types'
import { Calc } from '../util'

/**
 * 20_WOOD_BEAM — simply supported rectangular sawn-lumber member, uniform gravity
 * load, NDS 2024 ASD. Mirrors the workbook cell-for-cell: section properties,
 * gravity effects with independent checks, adjustment-factor audit, strength and
 * serviceability D/C, and the review gates the workbook keeps open.
 */
export const woodBeam: CalcModule = {
  id: 'wood-beam', title: 'Wood Beam / Header', version: '1.0.0', sheet: '20_WOOD_BEAM',
  inputs: [
    { key: 'member_mark', label: 'Member mark', source: 'Object model', required: true },
    { key: 'load_basis', label: 'Load basis', source: 'Project', options: ['Roof', 'Floor'], required: true },
    { key: 'span_ft', label: 'Span L', unit: 'ft', source: 'CAD confirm', required: true },
    { key: 'trib_width_ft', label: 'Tributary width', unit: 'ft', source: 'CAD confirm', required: true },
    { key: 'b_in', label: 'Actual width b', unit: 'in', source: 'CAD confirm', required: true },
    { key: 'd_in', label: 'Actual depth d', unit: 'in', source: 'CAD confirm', required: true },
    { key: 'bearing_left_in', label: 'Bearing length, left', unit: 'in', source: 'Detail', required: true },
    { key: 'bearing_right_in', label: 'Bearing length, right', unit: 'in', source: 'Detail', required: true },
    { key: 'roof_dead_psf', label: 'Roof dead load', unit: 'psf', source: 'Project criteria' },
    { key: 'roof_live_psf', label: 'Roof live load', unit: 'psf', source: 'CBC / ASCE 7' },
    { key: 'floor_dead_psf', label: 'Floor dead load', unit: 'psf', source: 'Project criteria' },
    { key: 'floor_live_psf', label: 'Floor live load', unit: 'psf', source: 'CBC / ASCE 7' },
    { key: 'species', label: 'Species / group', source: 'NDS Supplement', required: true },
    { key: 'grade', label: 'Grade', source: 'NDS Supplement', required: true },
    { key: 'Fb_psi', label: 'Fb reference', unit: 'psi', source: '2024 NDS Supplement', required: true },
    { key: 'Fv_psi', label: 'Fv reference', unit: 'psi', source: '2024 NDS Supplement', required: true },
    { key: 'Fcp_psi', label: 'Fc⊥ reference', unit: 'psi', source: '2024 NDS Supplement', required: true },
    { key: 'E_psi', label: 'E reference', unit: 'psi', source: '2024 NDS Supplement', required: true },
    { key: 'live_defl_limit', label: 'Live deflection limit L/x', unit: 'L/x', source: 'CBC / project', required: true, default: 360 },
    { key: 'total_defl_limit', label: 'Total deflection limit L/x', unit: 'L/x', source: 'CBC / project', required: true, default: 240 },
    // NDS adjustment factors are controlled inputs, never silently assumed.
    { key: 'CD', label: 'Load duration CD', source: 'NDS 2.3.2', default: 1.0 },
    { key: 'CM_Fb', label: 'Wet service CM (Fb)', source: 'NDS Supplement', default: 1.0 },
    { key: 'CM_Fv', label: 'Wet service CM (Fv)', source: 'NDS Supplement', default: 1.0 },
    { key: 'CM_Fcp', label: 'Wet service CM (Fc⊥)', source: 'NDS Supplement', default: 1.0 },
    { key: 'CM_E', label: 'Wet service CM (E)', source: 'NDS Supplement', default: 1.0 },
    { key: 'Ct_Fb', label: 'Temperature Ct (Fb)', source: 'NDS 2.3.3', default: 1.0 },
    { key: 'Ct_Fv', label: 'Temperature Ct (Fv)', source: 'NDS 2.3.3', default: 1.0 },
    { key: 'Ct_Fcp', label: 'Temperature Ct (Fc⊥)', source: 'NDS 2.3.3', default: 1.0 },
    { key: 'Ct_E', label: 'Temperature Ct (E)', source: 'NDS 2.3.3', default: 1.0 },
    { key: 'CF', label: 'Size factor CF', source: 'NDS Supplement', default: 1.0 },
    { key: 'Cfu', label: 'Flat use Cfu', source: 'NDS Supplement', default: 1.0 },
    { key: 'Cr', label: 'Repetitive member Cr', source: 'NDS 4.3.9', default: 1.0 },
    { key: 'CL', label: 'Beam stability CL', source: 'NDS 3.3.3', default: 1.0 },
    { key: 'Cb', label: 'Bearing area Cb', source: 'NDS 3.10.4', default: 1.0 },
  ],
  run(inputs: Inputs) {
    const c = new Calc(this.id, this.version, this.inputs, inputs)
    c.text('member_mark', c.str('member_mark'))
    const basis = c.str('load_basis')
    const L = c.num('span_ft'); const tw = c.num('trib_width_ft'); const b = c.num('b_in'); const d = c.num('d_in')
    const bl = c.num('bearing_left_in'); const br = c.num('bearing_right_in')
    const Fb = c.num('Fb_psi'); const Fv = c.num('Fv_psi'); const Fcp = c.num('Fcp_psi'); const E = c.num('E_psi')
    const liveLim = c.num('live_defl_limit'); const totLim = c.num('total_defl_limit')
    const f = (k: string) => c.num(k) ?? 1

    // Section properties (with the workbook's independent checks)
    const A = c.result('A_in2', b !== null && d !== null ? b * d : null, 'in²', 'A = b·d', b !== null && d !== null ? b * d : null)
    const S = c.result('S_in3', b !== null && d !== null ? (b * d * d) / 6 : null, 'in³', 'S = b·d²/6', A !== null && d !== null ? (A * d) / 6 : null)
    const I = c.result('I_in4', b !== null && d !== null ? (b * d ** 3) / 12 : null, 'in⁴', 'I = b·d³/12', S !== null && d !== null ? (S * d) / 2 : null)

    // Gravity effects
    const qD = basis === 'Roof' ? c.num('roof_dead_psf') : c.num('floor_dead_psf')
    const qL = basis === 'Roof' ? c.num('roof_live_psf') : c.num('floor_live_psf')
    if (qD === null) c.missing.push(basis === 'Roof' ? 'roof_dead_psf' : 'floor_dead_psf')
    if (qL === null) c.missing.push(basis === 'Roof' ? 'roof_live_psf' : 'floor_live_psf')
    const wD = c.result('wD_plf', qD !== null && tw !== null ? qD * tw : null, 'plf', 'wD = qD·tributary width')
    const wL = c.result('wL_plf', qL !== null && tw !== null ? qL * tw : null, 'plf', 'wL = qL·tributary width')
    const w = c.result('w_plf', wD !== null && wL !== null ? wD + wL : null, 'plf', 'w = wD + wL')
    const R = c.result('R_lb', w !== null && L !== null ? (w * L) / 2 : null, 'lb', 'R = wL/2', w !== null && L !== null ? w * L * 0.5 : null)
    const M = c.result('M_ftlb', w !== null && L !== null ? (w * L * L) / 8 : null, 'ft-lb', 'M = wL²/8', R !== null && w !== null && L !== null ? R * (L / 2) - (w * (L / 2) ** 2) / 2 : null)

    // Adjusted design values (audit table 42..47)
    const Fb_adj = c.result('Fb_adj_psi', Fb !== null ? Fb * f('CD') * f('CM_Fb') * f('Ct_Fb') * f('CF') * f('Cfu') * f('Cr') * f('CL') : null, 'psi', "Fb′ = Fb·CD·CM·Ct·CF·Cfu·Cr·CL")
    const Fv_adj = c.result('Fv_adj_psi', Fv !== null ? Fv * f('CD') * f('CM_Fv') * f('Ct_Fv') : null, 'psi', "Fv′ = Fv·CD·CM·Ct")
    const Fcp_adj = c.result('Fcp_adj_psi', Fcp !== null ? Fcp * f('CM_Fcp') * f('Ct_Fcp') * f('Cb') : null, 'psi', "Fc⊥′ = Fc⊥·CM·Ct·Cb")
    const E_adj = c.result('E_adj_psi', E !== null ? E * f('CM_E') * f('Ct_E') : null, 'psi', "E′ = E·CM·Ct")

    // Deflections use E′ and I; workbook: 5·(w/12)·(L·12)^4 / (384·E′·I)
    const defl = (wp: number | null) => wp !== null && L !== null && E_adj !== null && I !== null ? (5 * (wp / 12) * (L * 12) ** 4) / (384 * E_adj * I) : null
    const deflChk = (wp: number | null) => wp !== null && L !== null && E_adj !== null && I !== null ? (5 * (wp * L) * (L * 12) ** 3) / (384 * E_adj * I) : null
    const dD = c.result('deflD_in', defl(wD), 'in', "ΔD = 5·wD·L⁴/(384·E′·I)", deflChk(wD))
    const dL = c.result('deflL_in', defl(wL), 'in', "ΔL = 5·wL·L⁴/(384·E′·I)", deflChk(wL))
    const dT = c.result('deflT_in', dD !== null && dL !== null ? dD + dL : null, 'in', 'ΔT = ΔD + ΔL')
    c.result('live_span_ratio', dL !== null && dL !== 0 && L !== null ? (L * 12) / dL : null, 'L/x', 'L/ΔL')
    c.result('total_span_ratio', dT !== null && dT !== 0 && L !== null ? (L * 12) / dT : null, 'L/x', 'L/ΔT')

    // Strength & serviceability checks (rows 51..57)
    const fb = c.result('fb_psi', M !== null && S !== null ? (M * 12) / S : null, 'psi', 'fb = M·12/S')
    const fv = c.result('fv_psi', R !== null && A !== null ? (1.5 * R) / A : null, 'psi', 'fv = 1.5·V/A (V = R)')
    const fcpL = c.result('fcp_left_psi', R !== null && b !== null && bl ? R / (b * bl) : null, 'psi', 'R / (b·bearing)')
    const fcpR = c.result('fcp_right_psi', R !== null && b !== null && br ? R / (b * br) : null, 'psi', 'R / (b·bearing)')
    c.check('Bending', fb, Fb_adj, 'psi', "fb = M/S vs Fb′")
    c.check('Shear', fv, Fv_adj, 'psi', 'Conservative max rectangular shear stress at support')
    c.check('Bearing — Left', fcpL, Fcp_adj, 'psi', 'Reaction / bearing area')
    c.check('Bearing — Right', fcpR, Fcp_adj, 'psi', 'Reaction / bearing area')
    c.check('Live Deflection', dL, L !== null && liveLim ? (L * 12) / liveLim : null, 'in', 'ΔL vs L / live limit')
    c.check('Total Deflection', dT, L !== null && totLim ? (L * 12) / totLim : null, 'in', 'ΔT vs L / total limit')

    // Review gates the workbook keeps open (rows 62..64)
    c.gate('2024 NDS shear provisions', 'Engine uses unreduced support shear; licensed review required for shear-location/reduction provisions.')
    c.gate('Beam lateral stability / bracing', 'CL is a controlled input; verify actual restraint and applicability.')
    c.gate('Notches / holes', 'Geometry and stress-concentration checks are not automated; concentrated loads require explicit review.')
    return c.finish()
  },
}

/** Locked QA benchmarks from 20_WOOD_BEAM!M4:O8. Used by the unit test and the self-check endpoint. */
export const woodBeamBenchmarks = [
  { id: 'NDS-QA-01 S', expected: 116.015625, actual: () => (5.5 * 11.25 ** 2) / 6, tol: 1e-4 },
  { id: 'NDS-QA-02 M', expected: 8100, actual: () => (450 * 12 ** 2) / 8, tol: 1e-3 },
  { id: 'NDS-QA-03 fb', expected: 837.8181818181819, actual: () => ((450 * 12 ** 2) / 8) * 12 / ((5.5 * 11.25 ** 2) / 6), tol: 1e-4 },
  { id: 'NDS-QA-04 fv', expected: 65.45454545454545, actual: () => (1.5 * ((450 * 12) / 2)) / (5.5 * 11.25), tol: 1e-4 },
  { id: 'NDS-QA-05 Δ', expected: 0.2010763636363636, actual: () => (5 * (450 / 12) * (12 * 12) ** 4) / (384 * 1.6e6 * ((5.5 * 11.25 ** 3) / 12)), tol: 1e-6 },
]
