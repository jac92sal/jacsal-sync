import { describe, expect, it } from 'vitest'
import { woodBeam, woodBeamBenchmarks } from '../src/modules/wood-beam'
import { MODULES } from '../src/registry'

describe('locked QA benchmarks (20_WOOD_BEAM!M4:O8)', () => {
  for (const b of woodBeamBenchmarks) it(b.id, () => expect(Math.abs(b.actual() - b.expected)).toBeLessThanOrEqual(b.tol))
})

describe('wood-beam module', () => {
  const inputs = { member_mark: 'B4', load_basis: 'Floor', span_ft: 12, trib_width_ft: 9, b_in: 5.5, d_in: 11.25, bearing_left_in: 3, bearing_right_in: 3,
    floor_dead_psf: 15, floor_live_psf: 35, species: 'DF-L', grade: 'No.1', Fb_psi: 1000, Fv_psi: 180, Fcp_psi: 625, E_psi: 1.6e6, live_defl_limit: 360, total_defl_limit: 240, CF: 1.0 }
  it('reproduces the workbook arithmetic', () => {
    const r = woodBeam.run(inputs)
    expect(r.results.w_plf.value).toBe(450)
    expect(r.results.M_ftlb.value).toBe(8100)
    expect(r.results.S_in3.value).toBeCloseTo(116.015625, 6)
    expect(r.results.fb_psi.value).toBeCloseTo(837.8181818, 4)
    expect(r.results.fv_psi.value).toBeCloseTo(65.4545454, 4)
    expect(r.results.deflT_in.value).toBeCloseTo(0.2010763636, 6)
    expect(r.missing).toEqual([])
    expect(r.status).toBe('PASS')
    expect(r.gates.length).toBe(3)
  })
  it('reports MISSING and PENDING when inputs are absent', () => {
    const r = woodBeam.run({ member_mark: 'B4', load_basis: 'Roof' })
    expect(r.status).toBe('PENDING')
    expect(r.missing).toContain('span_ft')
  })
  it('fails when overstressed', () => {
    const r = woodBeam.run({ ...inputs, Fb_psi: 500 })
    expect(r.status).toBe('FAIL')
    expect(r.utilization).toBeGreaterThan(1)
  })
})

describe('registry', () => {
  it('every module runs with empty inputs without throwing', () => {
    for (const m of MODULES) { const r = m.run({}); expect(r.module).toBe(m.id); expect(['PENDING', 'PASS', 'REVIEW', 'FAIL']).toContain(r.status) }
  })
})
