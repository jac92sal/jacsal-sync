/** Apply write operations directly to DXF text (fallback when a file was uploaded as DXF and no DWG exists). */
import type { WriteOp } from './aps'

export function patchDxf(text: string, ops: WriteOp[]): { text: string; applied: number; missing: string[] } {
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const missing: string[] = []
  let applied = 0
  for (const op of ops) {
    const range = findEntity(lines, op.handle)
    if (!range) { missing.push(op.handle); continue }
    const set = (code: string, value: string, nth = 0) => {
      let seen = -1
      for (let i = range.start; i < range.end; i += 2) if (lines[i].trim() === code && ++seen === nth) { lines[i + 1] = value; return true }
      return false
    }
    const f = (v: number) => (Math.round(v * 1e8) / 1e8).toString()
    let ok = true
    switch (op.op) {
      case 'set-line': ok = set('10', f(op.x1)) && set('20', f(op.y1)) && set('11', f(op.x2)) && set('21', f(op.y2)); break
      case 'move-line-end': ok = op.end === 'start' ? set('10', f(op.x)) && set('20', f(op.y)) : set('11', f(op.x)) && set('21', f(op.y)); break
      case 'move-insert': ok = set('10', f(op.x)) && set('20', f(op.y)); break
      case 'set-text': ok = set('1', op.text); break
      case 'set-poly-vertex': ok = set('10', f(op.x), op.index) && set('20', f(op.y), op.index); break
      case 'set-dim-points': ok = set('13', f(op.x13)) && set('23', f(op.y13)) && set('14', f(op.x14)) && set('24', f(op.y14)); set('1', ''); break
    }
    if (ok) applied++; else missing.push(op.handle)
  }
  return { text: lines.join(nl), applied, missing }
}

/** Locate the [start,end) line range of the entity with the given handle (group 5) inside ENTITIES. */
function findEntity(lines: string[], handle: string): { start: number; end: number } | null {
  let inEntities = false
  let entStart = -1
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim(), value = lines[i + 1].trim()
    if (code === '0' && value === 'SECTION' && lines[i + 3]?.trim() === 'ENTITIES') { inEntities = true; i += 2; continue }
    if (!inEntities) continue
    if (code === '0') {
      if (entStart >= 0 && lines[entStart + 1].trim() !== 'SECTION') {
        const r = { start: entStart, end: i }
        if (handleOf(lines, r) === handle) return r
      }
      if (value === 'ENDSEC') return null
      entStart = i
    }
  }
  return null
}
function handleOf(lines: string[], r: { start: number; end: number }): string | null {
  for (let i = r.start; i < r.end; i += 2) if (lines[i].trim() === '5') return lines[i + 1].trim()
  return null
}
