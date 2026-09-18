import type { CalcModule } from './types'
import { gravity } from './modules/gravity'
import { loadCombos } from './modules/load-combos'
import { wind } from './modules/wind'
import { seismic } from './modules/seismic'
import { woodBeam } from './modules/wood-beam'
import { woodColumn } from './modules/wood-column'
import { shearWall } from './modules/shear-wall'
import { diaphragm } from './modules/diaphragm'
import { connections } from './modules/connections'
import { holdown } from './modules/holdown'
import { sillAnchor } from './modules/sill-anchor'
import { collectorChord } from './modules/collector-chord'
import { foundation } from './modules/foundation'

/** Add a calculation: create src/modules/<id>.ts and register it here. Nothing else changes. */
export const MODULES: CalcModule[] = [gravity, loadCombos, wind, seismic, woodBeam, woodColumn, shearWall, diaphragm, connections, holdown, sillAnchor, collectorChord, foundation]
export const byId = new Map(MODULES.map((m) => [m.id, m]))

/** Which calc modules an object type depends on — the change-impact engine uses this. */
export const MODULES_FOR_TYPE: Record<string, string[]> = {
  BEAM: ['wood-beam'], HEADER: ['wood-beam'], POST: ['wood-column'], COLUMN: ['wood-column'],
  SHEAR_WALL: ['shear-wall', 'holdown', 'sill-anchor'], DIAPHRAGM: ['diaphragm', 'collector-chord'],
  HOLDOWN: ['holdown'], FOOTING: ['foundation'], CONNECTION: ['connections'], COLLECTOR: ['collector-chord'],
}
