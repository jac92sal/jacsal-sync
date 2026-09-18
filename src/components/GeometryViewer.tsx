import { useMemo } from 'react'
import type { Geometry, Obj } from '../lib/api'
import { ftIn } from '../lib/api'

/** SVG plan view of the object model. Walls, openings, rooms, with proposed geometry overlaid in red. */
export function GeometryViewer({ objects, selectedId, onSelect, proposed = {} }: { objects: Obj[]; selectedId?: string | null; onSelect?: (id: string) => void; proposed?: Record<string, Geometry> }) {
  const geom = objects.filter((o) => o.geometry && (o.geometry.points || o.geometry.x1 !== undefined || o.geometry.x !== undefined))
  const bounds = useMemo(() => {
    const xs: number[] = [], ys: number[] = []
    const push = (g: Geometry) => { if (g.points) g.points.forEach((p) => { xs.push(p.x); ys.push(p.y) }); if (g.x1 !== undefined) { xs.push(g.x1, g.x2!); ys.push(g.y1!, g.y2!) } if (g.x !== undefined) { xs.push(g.x); ys.push(g.y!) } }
    geom.forEach((o) => push(o.geometry)); Object.values(proposed).forEach(push)
    if (!xs.length) return { minX: 0, minY: 0, w: 20, h: 20 }
    const minX = Math.min(...xs) - 2, maxX = Math.max(...xs) + 2, minY = Math.min(...ys) - 2, maxY = Math.max(...ys) + 2
    return { minX, minY, w: Math.max(maxX - minX, 1), h: Math.max(maxY - minY, 1) }
  }, [geom, proposed])
  const s = 40 / Math.max(bounds.w, bounds.h) * 20 // scale to ~800px
  const X = (x: number) => (x - bounds.minX) * s, Y = (y: number) => (bounds.h - (y - bounds.minY)) * s
  const rooms = geom.filter((o) => o.type === 'ROOM'), walls = geom.filter((o) => o.type === 'WALL' || o.type === 'SHEAR_WALL' || o.type === 'BEAM'), pts = geom.filter((o) => o.geometry.x !== undefined)
  if (!geom.length) return <div className="p-6 text-sm text-muted text-center">No geometry yet. Upload a drawing and confirm the detected objects.</div>
  return (
    <svg viewBox={`0 0 ${bounds.w * s} ${bounds.h * s}`} className="w-full h-full bg-[#f3f5f8]" style={{ minHeight: 320 }}>
      {rooms.map((o) => <polygon key={o.id} points={o.geometry.points!.map((p) => `${X(p.x)},${Y(p.y)}`).join(' ')} fill={o.id === selectedId ? '#dbe7ff' : '#f9fafb'} stroke="#c9d1db" strokeWidth={1} onClick={() => onSelect?.(o.id)} />)}
      {rooms.map((o) => { const c = centroid(o.geometry.points!); return <text key={`${o.id}-l`} x={X(c.x)} y={Y(c.y)} fontSize={s * 0.9} textAnchor="middle" fill="#334" fontWeight={700}>{o.semanticTag}</text> })}
      {walls.map((o) => { const g = o.geometry; const sel = o.id === selectedId; return <g key={o.id} onClick={() => onSelect?.(o.id)} style={{ cursor: 'pointer' }}>
        <line x1={X(g.x1!)} y1={Y(g.y1!)} x2={X(g.x2!)} y2={Y(g.y2!)} stroke={sel ? '#2f6fed' : o.type === 'BEAM' ? '#8a5a00' : '#3a3f47'} strokeWidth={sel ? s * 0.45 : s * 0.3} strokeLinecap="square" strokeDasharray={o.type === 'BEAM' ? `${s * 0.6} ${s * 0.3}` : undefined} />
        <text x={X((g.x1! + g.x2!) / 2)} y={Y((g.y1! + g.y2!) / 2) - s * 0.5} fontSize={s * 0.7} textAnchor="middle" fill="#556">{o.type === 'WALL' ? ftIn(o.derived.length_ft as number) : o.humanName}</text></g> })}
      {Object.entries(proposed).map(([id, g]) => g.x1 !== undefined ? <line key={`p-${id}`} x1={X(g.x1)} y1={Y(g.y1!)} x2={X(g.x2!)} y2={Y(g.y2!)} stroke="#d6423b" strokeWidth={s * 0.3} strokeDasharray={`${s * 0.4} ${s * 0.3}`} /> : g.points ? <polygon key={`p-${id}`} points={g.points.map((p) => `${X(p.x)},${Y(p.y)}`).join(' ')} fill="none" stroke="#d6423b" strokeWidth={1.5} strokeDasharray="6 4" /> : g.x !== undefined ? <circle key={`p-${id}`} cx={X(g.x)} cy={Y(g.y!)} r={s * 0.5} fill="none" stroke="#d6423b" strokeWidth={2} /> : null)}
      {pts.map((o) => <g key={o.id} onClick={() => onSelect?.(o.id)} style={{ cursor: 'pointer' }}><rect x={X(o.geometry.x!) - s * 0.9} y={Y(o.geometry.y!) - s * 0.3} width={s * 1.8} height={s * 0.6} fill={o.id === selectedId ? '#2f6fed' : o.type === 'WINDOW' ? '#7fb3ff' : '#c8a165'} stroke="#1c2430" strokeWidth={1} /><text x={X(o.geometry.x!)} y={Y(o.geometry.y!) + s * 1.2} fontSize={s * 0.65} textAnchor="middle" fill="#334">{o.semanticTag.split('.').slice(-2).join('.')}</text>{o.anchorRule && <text x={X(o.geometry.x!)} y={Y(o.geometry.y!) + s * 1.9} fontSize={s * 0.55} textAnchor="middle" fill="#2e9e5b">{o.anchorRule}{o.anchorParams.offset_ft !== undefined ? ` (${ftIn(Number(o.anchorParams.offset_ft))})` : ''}</text>}</g>)}
    </svg>
  )
}
function centroid(p: { x: number; y: number }[]) { return { x: p.reduce((s, q) => s + q.x, 0) / p.length, y: p.reduce((s, q) => s + q.y, 0) / p.length } }
