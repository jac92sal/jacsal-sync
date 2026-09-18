import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { CadEntity, Candidate } from '../lib/api'

type Pt = { x: number; y: number }
type Box = { minX: number; minY: number; maxX: number; maxY: number }

/**
 * Drawing view of one model page: the raw CAD geometry in light grey, the detected elements
 * (walls, rooms, openings) as clickable overlays. Coordinates are in feet.
 */
export function PlanViewer({ entities, k, candidates, activeId, onPick, bbox, focus }: {
  entities: CadEntity[]
  /** drawing units → feet */
  k: number
  candidates: Candidate[]
  activeId?: string | null
  onPick?: (c: Candidate) => void
  /** model bbox in drawing units; falls back to the entity extent */
  bbox?: Box | null
  /** a window in feet to jump to (the element being reviewed); pan and zoom stay free afterwards */
  focus?: Box | null
}): ReactElement {
  const [zoom, setZoom] = useState<Box | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<{ x: number; y: number; view: Box } | null>(null)
  const extent = useMemo<Box>(() => {
    if (bbox) return { minX: bbox.minX * k, minY: bbox.minY * k, maxX: bbox.maxX * k, maxY: bbox.maxY * k }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const e of entities) for (const p of e.geometry.points ?? []) { const x = p.x * k, y = p.y * k; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
    if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 40, maxY: 30 }
    return { minX, minY, maxX, maxY }
  }, [entities, k, bbox])
  // Jump to the focused element when it changes; reset when the page changes.
  useEffect(() => { setZoom(focus ?? null) }, [focus?.minX, focus?.minY, focus?.maxX, focus?.maxY]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setZoom(null) }, [extent.minX, extent.minY, extent.maxX, extent.maxY])
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
      if (n > 20000) break
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

  // World (feet) coordinates of a pointer event, for zoom-at-cursor and panning.
  const toWorld = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current?.getBoundingClientRect(); if (!r) return { x: 0, y: 0 }
    const scale = Math.max((w * S) / r.width, (h * S) / r.height)   // svg units per px (preserveAspectRatio meet)
    const ox = (r.width - (w * S) / scale) / 2, oy = (r.height - (h * S) / scale) / 2
    const sx = (e.clientX - r.left - ox) * scale, sy = (e.clientY - r.top - oy) * scale
    return { x: sx / S + view.minX - pad, y: view.maxY + pad - sy / S }
  }
  const zoomAt = (factor: number, at?: { x: number; y: number }) => {
    const c = at ?? { x: (view.minX + view.maxX) / 2, y: (view.minY + view.maxY) / 2 }
    const nw = (view.maxX - view.minX) * factor, nh = (view.maxY - view.minY) * factor
    const fx = (c.x - view.minX) / (view.maxX - view.minX), fy = (c.y - view.minY) / (view.maxY - view.minY)
    setZoom({ minX: c.x - nw * fx, maxX: c.x + nw * (1 - fx), minY: c.y - nh * fy, maxY: c.y + nh * (1 - fy) })
  }
  // Native non-passive wheel listener: React's onWheel is passive, so preventDefault would not stop page scroll.
  const wheelRef = useRef<(e: WheelEvent) => void>(() => undefined)
  wheelRef.current = (e: WheelEvent) => { e.preventDefault(); zoomAt(e.deltaY > 0 ? 1.2 : 1 / 1.2, toWorld(e)) }
  useEffect(() => { const el = svgRef.current; if (!el) return; const h = (e: WheelEvent) => wheelRef.current(e); el.addEventListener('wheel', h, { passive: false }); return () => el.removeEventListener('wheel', h) }, [])
  const onDown = (e: React.PointerEvent) => { if (e.button !== 0) return; drag.current = { x: e.clientX, y: e.clientY, view }; (e.target as Element).setPointerCapture?.(e.pointerId) }
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return
    const r = svgRef.current?.getBoundingClientRect(); if (!r) return
    const scale = Math.max((w * S) / r.width, (h * S) / r.height) / S       // feet per px
    const dx = (e.clientX - drag.current.x) * scale, dy = (e.clientY - drag.current.y) * scale
    const v = drag.current.view
    setZoom({ minX: v.minX - dx, maxX: v.maxX - dx, minY: v.minY + dy, maxY: v.maxY + dy })
  }
  const onUp = () => { drag.current = null }

  const rooms = candidates.filter((c) => c.kind === 'ROOM'), walls = candidates.filter((c) => c.kind === 'WALL' || c.kind === 'BEAM'), pts = candidates.filter((c) => c.kind === 'WINDOW' || c.kind === 'DOOR')
  const tone = (c: Candidate, base: string) => (c.id === activeId ? '#2f6fed' : c.action === 'CONFIRM' || c.action === 'EDIT' ? '#2e9e5b' : c.action === 'IGNORE' ? '#c9d1db' : base)

  return (
    <div className="relative w-full h-full">
      <svg ref={svgRef} viewBox={`0 0 ${w * S} ${h * S}`} className="w-full h-full bg-[#f7f8fa] select-none touch-none" style={{ minHeight: 420, cursor: drag.current ? 'grabbing' : 'grab' }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp} onDoubleClick={() => setZoom(null)}>
        {raw}
        {rooms.map((c) => { const v = c.detected_value as { points?: Pt[] }; if (!v?.points) return null; return <polygon key={c.id} points={v.points.map((p) => `${X(p.x)},${Y(p.y)}`).join(' ')} fill={c.id === activeId ? 'rgba(47,111,237,.18)' : 'rgba(46,158,91,.08)'} stroke={tone(c, '#7a8699')} strokeWidth={sw * 2} onClick={() => onPick?.(c)} style={{ cursor: 'pointer' }} /> })}
        {walls.map((c) => { const v = c.detected_value as { x1?: number; y1?: number; x2?: number; y2?: number }; if (v?.x1 === undefined) return null; const active = c.id === activeId; return <line key={c.id} x1={X(v.x1)} y1={Y(v.y1!)} x2={X(v.x2!)} y2={Y(v.y2!)} stroke={tone(c, '#d97706')} strokeWidth={active ? S * 0.5 : S * 0.3} strokeLinecap="round" opacity={c.action === 'IGNORE' ? 0.4 : 0.85} onClick={() => onPick?.(c)} style={{ cursor: 'pointer' }} /> })}
        {pts.map((c) => { const v = c.detected_value as { x?: number; y?: number }; if (v?.x === undefined) return null; return <circle key={c.id} cx={X(v.x)} cy={Y(v.y!)} r={S * 0.6} fill={tone(c, c.kind === 'DOOR' ? '#9333ea' : '#0891b2')} stroke="white" strokeWidth={sw * 2} onClick={() => onPick?.(c)} style={{ cursor: 'pointer' }} /> })}
      </svg>
      <div className="absolute top-2 right-2 flex gap-1 text-xs">
        <button className="btn btn-ghost py-1 px-2" onClick={() => setZoom(null)}>Fit plan</button>
        <button className="btn btn-ghost py-1 px-2" onClick={() => zoomAt(1 / 1.5)}>+</button>
        <button className="btn btn-ghost py-1 px-2" onClick={() => zoomAt(1.5)}>−</button>
      </div>
      <div className="absolute bottom-2 left-2 text-[11px] text-muted bg-white/80 px-2 py-0.5 rounded">drag to pan · scroll to zoom · double-click to fit</div>
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
