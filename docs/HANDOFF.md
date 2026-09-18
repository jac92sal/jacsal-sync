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
- **GitHub repo:** `jac92sal/jacsal-sync` (`main`). All work is pushed there.
- **Rotate the three credentials that were uploaded in plain text** (Anthropic key, Autodesk client secret, ArcGIS client secret).
  Autodesk + ArcGIS values are now in the Secrets Store (`APS_*`, `ARCGIS_*`); the Anthropic key was **not** stored anywhere.
- **ArcGIS: key expired.** The API key credential is referrer-restricted, so the GIS Worker sends
  `Referer: https://sync.jacsalservices.com/` (var `ARCGIS_REFERER`; that host is on the key's Referrers). The stored
  `ARCGIS_API_KEY` was a **temporary token** and has expired (elevation returns `498 Token Invalid`; DC soil/zoning/parcel
  still work because those layers are public). Generate a long-lived API key (expiration up to 1 year, privileges
  Basemaps + Elevation) from the same credential item and update `ARCGIS_API_KEY` in the Secrets Store; no redeploy needed.
- **Cloudflare returned a 403 "Attention Required" page for the SPA document to the build sandbox's IP** (assets and /api/* were fine).
  That is a zone WAF/bot rule, not the Worker. If your browser sees it too, check Security → WAF / Bot Fight Mode for jacsalservices.com.
- **Outbound HTTP quirk (root cause found).** From this account, Worker `fetch()` to several ordinary origins
  (developer.api.autodesk.com, elevation-api.arcgis.com, static-maps-api.arcgis.com, maps2.dcgis.dc.gov, even api.github.com)
  is answered by the edge with a synthetic `error code: 525`, while CDN-fronted hosts work. A direct TLS socket to the same
  hosts works, so both service Workers use `shared/socket-http.ts`, a small HTTP/1.1 client over `cloudflare:sockets`, for
  those hosts. Browser Rendering remains available as a fallback (`APS_VIA_BROWSER=true`). Worth a Cloudflare support ticket:
  the zone's SSL settings are ordinary (full, no origin pulls, no origin rules). Verified live: token, nickname, engines, bucket upload,
  activity `RunScript+prod` creation, work item submission, report retrieval. A test file renamed `.dwg` reached AutoCAD Core
  Console and failed with ErrorStatus 434 (invalid DWG) as expected. **Upload a real DWG in the morning** to confirm DXFOUT and
  write-back end to end; each job stores its Autodesk report URL and the last log lines in `error`.
- `GET /api/debug/aps` (signed in) shows outbound connectivity and the Autodesk diagnostic; remove it once write-back is proven.
- A Vercel relay (`relay/`) was drafted as an alternative path and deployed as project `jacsal-sync-aps-relay`, but Vercel's
  firewall denies every request to it (`x-vercel-mitigated: deny`) and its API cannot see the deployment. It is unused; delete
  the Vercel project or keep the code as a fallback (`APS_RELAY_URL` + `APS_RELAY_KEY`).
- The E2E project "E2E Test Residence" in the database is the walkthrough above run by Claude; delete or reuse it.
- Calc modules beyond wood-beam are first-pass engines with explicit REVIEW gates; deepen them one file at a time in `services/calc/src/modules/`.
