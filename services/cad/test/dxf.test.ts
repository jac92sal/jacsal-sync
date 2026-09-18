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
