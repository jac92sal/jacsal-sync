import { describe, expect, it } from 'vitest'
import { parseDxf } from '../src/dxf'
import { detect } from '../src/detect'
import { writebackScript } from '../src/aps'
import { patchDxf } from '../src/patch'

// A tiny hand-built DXF: one 14'x12' room (inches), a label, a window block on the east wall, a dimension on the east wall.
const pairs: [string, string][] = [
  ['0', 'SECTION'], ['2', 'HEADER'], ['9', '$INSUNITS'], ['70', '1'], ['0', 'ENDSEC'],
  ['0', 'SECTION'], ['2', 'ENTITIES'],
  ['0', 'LWPOLYLINE'], ['5', 'A1'], ['8', 'A-WALL'], ['90', '4'], ['70', '1'], ['10', '0'], ['20', '0'], ['10', '168'], ['20', '0'], ['10', '168'], ['20', '144'], ['10', '0'], ['20', '144'],
  ['0', 'TEXT'], ['5', 'A2'], ['8', 'A-ANNO'], ['10', '60'], ['20', '70'], ['40', '6'], ['1', 'PRIMARY BEDROOM'],
  ['0', 'INSERT'], ['5', 'A3'], ['8', 'A-GLAZ'], ['2', 'WINDOW_36'], ['10', '168'], ['20', '30'],
  ['0', 'DIMENSION'], ['5', 'A4'], ['8', 'A-DIMS'], ['10', '190'], ['20', '72'], ['13', '168'], ['23', '0'], ['14', '168'], ['24', '144'], ['42', '144'], ['70', '32'],
  ['0', 'ENDSEC'], ['0', 'EOF'],
]
const dxf = pairs.map(([c, v]) => `${c}\n${v}`).join('\n') + '\n'

describe('dxf parser', () => {
  it('reads units, entities and handles', () => {
    const d = parseDxf(dxf)
    expect(d.insunits).toBe(1)
    expect(d.entities.map((e) => e.type)).toEqual(['LWPOLYLINE', 'TEXT', 'INSERT', 'DIMENSION'])
    expect(d.entities[0].closed).toBe(true)
    expect(d.entities[0].handle).toBe('A1')
    expect(d.entities[3].dimMeasurement).toBe(144)
  })
})

describe('detector', () => {
  it('proposes the room, four walls, a hosted window with a south-end anchor, and building extents', () => {
    const c = detect(parseDxf(dxf))
    const room = c.find((x) => x.kind === 'ROOM')!
    expect(room.semanticTag).toBe('ROOM.PRIMARY_BEDROOM')
    const walls = c.filter((x) => x.kind === 'WALL')
    expect(walls.map((w) => w.semanticTag).sort()).toEqual(['ROOM.PRIMARY_BEDROOM.WALL.EAST', 'ROOM.PRIMARY_BEDROOM.WALL.NORTH', 'ROOM.PRIMARY_BEDROOM.WALL.SOUTH', 'ROOM.PRIMARY_BEDROOM.WALL.WEST'])
    const east = walls.find((w) => w.semanticTag.endsWith('EAST'))!
    expect((east.detectedValue as { length_ft: number }).length_ft).toBeCloseTo(12, 6)
    expect(east.representations?.some((r) => r.repType === 'DIMENSION' && r.handle === 'A4')).toBe(true)
    const win = c.find((x) => x.kind === 'WINDOW')!
    expect(win.hostKey).toBe(east.key)
    expect(win.anchorRule).toBe('KEEP_OFFSET_FROM_SOUTH_END')
    expect((win.anchorParams as { offset_ft: number }).offset_ft).toBeCloseTo(2.5, 3)
    expect(c.find((x) => x.semanticTag === 'BUILDING.LENGTH')?.detectedValue).toBe(14)
  })
})

describe('write-back script', () => {
  it('emits inline LISP for each op and saves the result', () => {
    const s = writebackScript([{ op: 'set-poly-vertex', handle: 'A1', index: 2, x: 168, y: 162 }, { op: 'set-dim-points', handle: 'A4', x13: 168, y13: 0, x14: 168, y14: 162 }])
    expect(s).toContain('(handent "A1")')
    expect(s).toContain('(cons 14 (list 168.000000 162.000000 0.0))')
    expect(s).toContain('_.SAVEAS')
  })
})

describe('dxf patcher', () => {
  it('rewrites the targeted groups in place and re-parses', () => {
    const { text, applied, missing } = patchDxf(dxf, [{ op: 'set-poly-vertex', handle: 'A1', index: 2, x: 168, y: 162 }, { op: 'set-dim-points', handle: 'A4', x13: 168, y13: 0, x14: 168, y14: 162 }, { op: 'set-text', handle: 'A2', text: 'PRIMARY BEDROOM 2' }])
    expect(applied).toBe(3); expect(missing).toEqual([])
    const d = parseDxf(text)
    expect(d.entities[0].points[2]).toEqual({ x: 168, y: 162 })
    expect(d.entities[3].points[2]).toEqual({ x: 168, y: 162 })
    expect(d.entities[1].text).toBe('PRIMARY BEDROOM 2')
  })
})

import { DxfStreamParser } from '../src/dxf'
describe('DxfStreamParser', () => {
  const pairs = (rows: [string, string][]) => rows.map(([c, v]) => `${c}\n${v}`).join('\n') + '\n'
  const dxf = pairs([
    ['0', 'SECTION'], ['2', 'HEADER'], ['9', '$INSUNITS'], ['70', '1'], ['0', 'ENDSEC'],
    ['0', 'SECTION'], ['2', 'BLOCKS'], ['0', 'LINE'], ['5', 'B1'], ['8', '0'], ['10', '0'], ['20', '0'], ['11', '5'], ['21', '5'], ['0', 'ENDSEC'],
    ['0', 'SECTION'], ['2', 'ENTITIES'],
    ['0', 'LINE'], ['5', 'A1'], ['8', 'A-WALL'], ['10', '0'], ['20', '0'], ['11', '120'], ['21', '0'],
    ['0', 'LINE'], ['5', 'P1'], ['67', '1'], ['8', 'A-WALL'], ['10', '0'], ['20', '0'], ['11', '1'], ['21', '1'],
    ['0', 'HATCH'], ['5', 'H1'], ['310', 'DEADBEEF'],
    ['0', 'TEXT'], ['5', 'T1'], ['8', 'A-ANNO'], ['10', '60'], ['20', '2'], ['1', 'KITCHEN'],
    ['0', 'ENDSEC'], ['0', 'EOF'],
  ])
  it('streams across arbitrary chunk boundaries and skips blocks, paper space and unknown types', () => {
    for (const size of [1, 7, 64, 100_000]) {
      const p = new DxfStreamParser()
      for (let i = 0; i < dxf.length; i += size) p.push(dxf.slice(i, i + size))
      const doc = p.end()
      expect(doc.insunits).toBe(1)
      expect(doc.entities.map((e) => e.handle)).toEqual(['A1', 'T1'])
      expect(doc.stats?.paperSpace).toBe(1)
      expect(doc.stats?.seen).toBe(4)
    }
  })
})

import { findModels } from '../src/models'
describe('findModels', () => {
  it('groups room labels into model pages and tags nearby geometry', () => {
    const k = 12 // inches
    const text = (h: string, t: string, x: number, y: number) => ({ handle: h, type: 'MTEXT', layer: 'TXT', points: [{ x: x * k, y: y * k }], text: t })
    const line = (h: string, x1: number, y1: number, x2: number, y2: number, layer = 'A-WALL') => ({ handle: h, type: 'LINE', layer, points: [{ x: x1 * k, y: y1 * k }, { x: x2 * k, y: y2 * k }] })
    const doc = { insunits: 1, entities: [
      text('t1', 'KITCHEN', 10, 10), text('t2', 'BATH', 30, 12), text('t3', 'LIVING', 20, 30),
      line('w1', 0, 0, 40, 0), line('w2', 40, 0, 40, 40), line('w3', 0, 0, 0, 40),
      text('t4', 'BEDROOM', 500, 10), text('t5', 'HALL', 520, 20), line('w4', 490, 0, 540, 0), line('w5', 490, 0, 490, 30),
      text('t6', 'SCOPE OF WORK', 1000, 10), line('border', -100, -100, 2000, -100),
    ] }
    const models = findModels(doc as never)
    expect(models.length).toBe(2)
    expect(models[0].labels).toEqual(['Kitchen', 'Bath', 'Living'])
    expect(models[0].wallCount).toBe(3)
    expect(models[1].labels).toEqual(['Bedroom', 'Hall'])
    expect((doc.entities.find((e) => e.handle === 'border') as { model?: number }).model).toBeUndefined()
  })
})
