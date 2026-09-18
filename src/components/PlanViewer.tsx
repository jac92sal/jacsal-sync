import { useMemo, useState, type ReactElement } from 'react'
import type { CadEntity, Candidate } from '../lib/api'

type Pt = { x: number; y: number }
type Box = { minX: number; minY: number; maxX: number; maxY: number }

/**
 * Drawing view of one model page: the raw CAD geometry in light grey, the detected elements
 * (walls, rooms, openings) as clickable overlays. Coordinates are in feet.
 */
export function PlanViewer({ entities, k, candidates, activeId, onPick, bbox }: {
  entities: CadEntity[]
  /** drawing units → feet */
  k: number
  candidates: Candidate[]
  activeId?: string | null
  onPick?: (c: Candidate) => void
  /** model bbox in drawing units; falls back to the entity extent */
  bbox?: Box | null
}): ReactElement {
  const [zoom, setZoom] = useState<Box | null>(null)
  const extent = useMemo<Box>(() => {
    if (bbox) return { minX: bbox.minX * k, minY: bbox.minY * k, maxX: bbox.maxX * k, maxY: bbox.maxY * k }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const e of entities) for (const p of e.geometry.points ?? []) { const x = p.x * k, y = p.y * k; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
    if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 40, maxY: 30 }
    return { minX, minY, maxX, maxY }
  }, [entities, k, bbox])
  const view = zoom ?? extent
  const pad = Math.max(view.maxX - view.minX, view.maxY - view.minY) * 0.04
  const w = view.maxX - view.minX + pad * 2, h = view.maxY - view.minY + pad * 2
  const S = 1000 / Math.max(w, h)                       // world feet → svg units (~1000 wide)
  const X = (x: number) => (x - view.minX + pad) * S
  const Y = (y: number) => (view.maxY + pad - y) * S     // flip: CAD y up, SVG y down
  const sw = Math.max(0.6, S * 0.05)                     // hairline for raw geometry
  const P = (pts: Pt[]) => pts.map((p) => `${X(p.x * k).toFixed(1)},${Y(p.y * k).toFixed(1)}`).join(' ')

  const raw = useMemo(() => {
    const out: ReactElement[] = []
    let n = 0
    for (const e of entities) {
      if (n > 9000) break
      const g = e.geometry
      const key = `${e.handle}-${n++}`
      if (e.etype === 'LINE' && g.points.length === 2) out.push(<polyline key={key} points={P(g.points)} stroke="#8b94a3" strokeWidth={sw} fill="none" />)
      else if (e.etype === 'LWPOLYLINE' && g.points.length >= 2) out.push(g.closed ? <polygon key={key} points={P(g.points)} stroke="#8b94a3" strokeWidth={sw} fill="none" /> : <polyline key={key} points={P(g.points)} stroke="#8b94a3" strokeWidth={sw} fill="none" />)
      else if ((e.etype === 'CIRCLE' || e.etype === 'ARC') && g.points[0] && g.height) out.push(<circle key={key} cx={X(g.points[0].x * k)} cy={Y(g.points[0].y * k)} r={g.height * k * S} stroke="#8b94a3" strokeWidth={sw} fill="none" strokeDasharray={e.etype === 'ARC' ? `${sw * 4} ${sw * 3}` : undefined} />)
      else if ((e.etype === 'TEXT' || e.etype === 'MTEXT') && g.points[0] && e.attributes.text) { const t = e.attributes.text.trim(); if (t.length && t.length <= 24) out.push(<text key={key} x={X(g.points[0].x * k)} y={Y(g.points[0].y * k)} fontSize={Math.max(6, (g.height ?? 0.5) * k * S)} fill="#6b7280" style={{ pointerEvents: 'none' }}>{t}</text>) }
      else if (e.etype === 'INSERT' && g.points[0]) out.push(<rect key={key} x={X(g.points[0].x * k) - S * 0.4} y={Y(g.points[0].y * k) - S * 0.4} width={S * 0.8} height={S * 0.8} fill="none" stroke="#b0b7c3" strokeWidth={sw} />)
    }
    return out
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entities, k, view])

  const rooms = candidates.filter((c) => c.kind === 'ROOM'), walls = candidates.filter((c) => c.kind === 'WALL' || c.kind === 'BEAM'), pts = candidates.filter((c) => c.kind === 'WINDOW' || c.kind === 'DOOR')
  const tone = (c: Candidate, base: string) => (c.id === activeId ? '#2f6fed' : c.action === 'CONFIRM' || c.action === 'EDIT' ? '#2e9e5b' : c.action === 'IGNORE' ? '#c9d1db' : base)

  return (
    <div className="relative w-full h-full">
      <svg viewBox={`0 0 ${w * S} ${h * S}`} className="w-full h-full bg-[#f7f8fa]" style={{ minHeight: 420 }} onDoubleClick={() => setZoom(null)}>
        {raw}
        {rooms.map((c) => { const v = c.detected_value as { points?: Pt[] }; if (!v?.points) return null; return <polygon key={c.id} points={v.points.map((p) => `${X(p.x)},${Y(p.y)}`).join(' ')} fill={c.id === activeId ? 'rgba(47,111,237,.18)' : 'rgba(46,158,91,.08)'} stroke={tone(c, '#7a8699')} strokeWidth={sw * 2} onClick={() => onPick?.(c)} style={{ cursor: 'pointer' }} /> })}
        {walls.map((c) => { const v = c.detected_value as { x1?: number; y1?: number; x2?: number; y2?: number }; if (v?.x1 === undefined) return null; const active = c.id === activeId; return <line key={c.id} x1={X(v.x1)} y1={Y(v.y1!)} x2={X(v.x2!)} y2={Y(v.y2!)} stroke={tone(c, '#d97706')} strokeWidth={active ? S * 0.5 : S * 0.3} strokeLinecap="round" opacity={c.action === 'IGNORE' ? 0.4 : 0.85} onClick={() => onPick?.(c)} style={{ cursor: 'pointer' }} /> })}
        {pts.map((c) => { const v = c.detected_value as { x?: number; y?: number }; if (v?.x === undefined) return null; return <circle key={c.id} cx={X(v.x)} cy={Y(v.y!)} r={S * 0.6} fill={tone(c, c.kind === 'DOOR' ? '#9333ea' : '#0891b2')} stroke="white" strokeWidth={sw * 2} onClick={() => onPick?.(c)} style={{ cursor: 'pointer' }} /> })}
      </svg>
      <div className="absolute top-2 right-2 flex gap-1 text-xs">
        <button className="btn btn-ghost py-1 px-2" onClick={() => setZoom(null)}>Fit</button>
        <button className="btn btn-ghost py-1 px-2" onClick={() => { const cx = (view.minX + view.maxX) / 2, cy = (view.minY + view.maxY) / 2, hw = (view.maxX - view.minX) / 3, hh = (view.maxY - view.minY) / 3; setZoom({ minX: cx - hw, maxX: cx + hw, minY: cy - hh, maxY: cy + hh }) }}>Zoom in</button>
        <button className="btn btn-ghost py-1 px-2" onClick={() => { const cx = (view.minX + view.maxX) / 2, cy = (view.minY + view.maxY) / 2, hw = (view.maxX - view.minX) * 0.75, hh = (view.maxY - view.minY) * 0.75; setZoom({ minX: cx - hw, maxX: cx + hw, minY: cy - hh, maxY: cy + hh }) }}>Zoom out</button>
      </div>
    </div>
  )
}

/** Zoom window around a candidate, in feet, for the walk-through. */
export function focusBox(c: Candidate, margin = 12): Box | null {
  const v = c.detected_value as { x1?: number; y1?: number; x2?: number; y2?: number; x?: number; y?: number; points?: Pt[] }
  const xs: number[] = [], ys: number[] = []
  if (v?.points) v.points.forEach((p) => { xs.push(p.x); ys.push(p.y) })
  if (v?.x1 !== undefined) { xs.push(v.x1, v.x2!); ys.push(v.y1!, v.y2!) }
  if (v?.x !== undefined) { xs.push(v.x); ys.push(v.y!) }
  if (!xs.length) return null
  return { minX: Math.min(...xs) - margin, maxX: Math.max(...xs) + margin, minY: Math.min(...ys) - margin, maxY: Math.max(...ys) + margin }
}
