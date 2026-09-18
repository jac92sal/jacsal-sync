# jacsal-sync

Function-first engineering design synchronization. Humans work with named building
objects (Primary Bedroom East Wall, Beam B4, Footing F3); the engine works with
geometry. A change never silently edits the drawing set: it resolves dependencies,
recalculates, proposes exact revisions, waits for approval, writes back, re-scans,
and blocks issue on any mismatch.

**Function first. Verification second. Design is the synchronized by-product.**

| | |
|---|---|
| **Subdomain** | `sync.jacsalservices.com` |
| **Worker** | `jacsal-sync` (custom domain route) + service Workers below |
| **Frontend** | React + Vite SPA, Tailwind v4, served as static assets |
| **Repo** | `VVVweb/jacsal-sync` (`main`) — monorepo: app at root, `services/*` |
| **Spec** | `docs/Engineering_CA_Wood_v11.xlsx` (workbook is the calculation spec + app contract, not a database) |

## Workers (all in this repo)

| Worker | Entrypoint | Purpose |
|---|---|---|
| `jacsal-sync` | default | Router + API in `worker/index.ts`; owns the subdomain and the data layer |
| `jacsal-sync-calc` | `CalcService` | Calculation engine. **One file per calculation** in `services/calc/src/modules/`, registered in `registry.ts`. Editing one never touches another. |
| `jacsal-sync-cad` | `CadService` | DXF parse + detection in-Worker; DWG convert / write-back / rescan via Autodesk Design Automation (AutoCAD engine); DXF text patcher fallback |
| `jacsal-sync-gis` | `GisService` | ArcGIS elevation, static maps, DC soil / zoning / parcel queries |
| `jacsal-auth` (shared) | `AuthService` | Passwordless email-code login + sessions |

## Resources

| Binding | Kind | Name / ID |
|---|---|---|
| `DB` | D1 | `jacsal-sync-db` — `97ed047b-673f-49dd-bae3-0dcf9086cba4`, migrations in `migrations/` |
| `FILES` | R2 | `jacsal-sync-files` (private; DWG/DXF uploads and every written-back revision) |
| `AUTH`, `CALC`, `CAD`, `GIS` | Service bindings | see table above |
| `SYNC_CALLBACK_SECRET` | Secrets Store | store `393ef1d6ad114ec598b1b2abf1e9a2b6` — signs Design Automation onComplete callbacks |
| `APS_CLIENT_ID`, `APS_CLIENT_SECRET` | Secrets Store (cad) | Autodesk Platform Services app credentials |
| `ARCGIS_CLIENT_ID`, `ARCGIS_CLIENT_SECRET` | Secrets Store (gis) | ArcGIS OAuth app credentials (the app item needs Elevation + Basemaps privileges enabled) |

Autodesk Design Automation: nickname = client id (none set), engine `Autodesk.AutoCAD+25_1`,
activity `RunScript+prod` (created on first use), bucket `jacsal-aps-<clientid>`.
The activity opens `input.dwg` in accoreconsole and runs `script.scr`; the script is
generated per job (`DXFOUT` for conversion, inline AutoLISP `entmod` for write-back,
then `SAVEAS` + `DXFOUT` for reconciliation).

## Data model (D1)

`projects` → `project_inputs` (01_INPUTS key/value with provenance) · `cad_files` → `cad_entities`
(every entity handle) → `candidates` (00_CAD_CONFIRM queue) → `objects` (00_OBJECT_MODEL: UUID,
human name, semantic tag, parent/host, anchor rule, geometry in feet, verification/approval
state) + `object_relations` + `representations` (object ↔ drawing entity) · `change_requests`
→ `change_impacts` (00_CHANGE_IMPACT) · `calc_runs` · `cad_jobs` · `sources` · `audit_log`.

Geometry is stored in **feet**; drawings are read/written in their own units (`$INSUNITS`,
inches assumed when unitless).

## The vertical slice (what works end to end)

1. Create project → 2. upload DWG/DXF → 3. detect rooms / walls / openings / dims / fields →
4. confirm queue → 5. persist semantic graph with representations → 6. propose a wall length
change → 7. impact set: hosted openings by anchor rule, shared corners, room polygon, structural
dependents + calc reruns, every drawing representation with its exact write op → 8. approve
(engineer + drafter) → 9. apply: model update, calcs rerun, write-back (Design Automation for
DWG, in-place patch for DXF) → 10. rescan + reconcile → issue gate.

## Commands

```bash
npm install
npm run cf-typegen      # regenerate worker-configuration.d.ts in root + each service (gitignored)
npm run dev             # Vite + all four Workers in workerd on http://localhost:5184
npm run check           # typecheck app + services
npm test                # vitest in services (calc benchmarks, DXF parser/detector/patcher)
npm run db:migrate      # apply D1 migrations (remote)
npm run deploy          # deploy services first (bindings must exist), then the app
```

Rules: bindings over REST; no floating promises; `crypto.randomUUID()`; secrets only in the
Secrets Store; never hand-edit `worker-configuration.d.ts`.
