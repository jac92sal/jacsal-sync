# Morning handoff — jacsal-sync

**Live:** https://sync.jacsalservices.com — sign in with your work email (code arrives from login@jacsalservices.com).

## What to try (10 minutes)
1. **Projects → New project.** Name it, add the address and (optionally) lat/lng.
2. **Dashboard → Upload DWG / DXF.** A DXF parses instantly. A DWG is sent to Autodesk Design Automation
   (AutoCAD engine) which exports a DXF; press **Check** on the file row or wait for the 2-minute poller.
3. **00_CAD_CONFIRM.** Rooms (closed polylines with a text label inside), their four walls, windows/doors
   (block names containing WIN/WINDOW/DOOR), dimensions attached to wall ends, beam marks (B1, HDR-2…),
   and building extents are proposed. Confirm / edit / ignore, or **Confirm all ≥ 60%**.
4. **00_OBJECT_MODEL.** Click the east wall → inspector → *Propose a length change* (e.g. 15.5, "end moves") → **Analyze impact**.
5. **00_CHANGE_IMPACT.** Structural (critical) / Design (attention) / Documentation (exact write ops) are listed.
   Tick the ones you accept → **Approve selected changes** → **Apply approved revisions**.
   - DXF source: the DXF is patched in place, re-scanned and reconciled immediately.
   - DWG source: an AutoCAD script (inline AutoLISP `entmod` on the exact entity handles, then `SAVEAS` + `DXFOUT`)
     runs on Design Automation; press **Reconcile drawings** or wait for the poller. **Preview AutoCAD script** shows exactly what will run.
   - Download the revised DWG/DXF from the Dashboard file row.
6. **CALCULATIONS.** Pick 20_WOOD_BEAM and Beam B4; type Fb/Fv/E etc. once and **Save typed values to project** so they persist in 01_INPUTS.
7. **00_ISSUE_GATE.** Watch domains move from PENDING → REVIEW as calcs run and changes reconcile.

## Where the real drawing needs to look
- Room boundaries: closed **LWPOLYLINE**; room name as **TEXT/MTEXT inside** the polygon.
- Wall lines on a layer containing **WALL**; openings as **INSERT** blocks named with WIN / WINDOW / DOOR.
- Linear **DIMENSION** entities whose definition points sit on wall ends get linked as "length-dim" representations.
- Units from `$INSUNITS` (inches assumed when unitless). Model geometry is stored in feet.

## Known gaps / decisions for you
- **GitHub repo not created** (the session's GitHub grant cannot create repos). Create `jac92sal/jacsal-sync` (empty, private) and
  push from the archive, or tell Claude to push once it exists.
- **Rotate the three credentials that were uploaded in plain text** (Anthropic key, Autodesk client secret, ArcGIS client secret).
  Autodesk + ArcGIS values are now in the Secrets Store (`APS_*`, `ARCGIS_*`); the Anthropic key was **not** stored anywhere.
- **ArcGIS credentials have no privileges**: tokens are issued but every location service rejects them. In ArcGIS Location Platform,
  open the *aduprojectjacsal* item → Privileges → enable Elevation and Basemaps (static maps), or create an API-key credential.
- **Cloudflare returned a 403 "Attention Required" page for the SPA document to the build sandbox's IP** (assets and /api/* were fine).
  That is a zone WAF/bot rule, not the Worker. If your browser sees it too, check Security → WAF / Bot Fight Mode for jacsalservices.com.
- Design Automation write-back has been exercised for plumbing only; verify on a real DWG in the morning (the report URL is stored on the job for diagnostics).
- Calc modules beyond wood-beam are first-pass engines with explicit REVIEW gates; deepen them one file at a time in `services/calc/src/modules/`.
