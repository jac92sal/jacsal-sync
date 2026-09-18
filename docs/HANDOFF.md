# Morning handoff — jacsal-sync

**Live:** https://sync.jacsalservices.com — sign in with your work email (code arrives from login@jacsalservices.com).

## What to try (10 minutes)
1. Sign in at https://sync.jacsalservices.com (email code). Create a project: name, street address, and city/state or ZIP.
   The address is verified (US Census geocoder) and jurisdiction, county, coordinates, and code path fill in.
2. Dashboard → Upload DWG. The file goes to Autodesk Design Automation (AutoCAD Core Console) for DXF conversion;
   the page polls progress. A 10 MB architectural set takes about a minute to convert and 15 s to parse.
   At the same time the DWG is translated by Autodesk Model Derivative for the viewer (first time 1–3 minutes).
3. **01_MODEL_REVIEW** (step one). Every floor plan found in the sheet set is listed as a unit. Name the three real
   ones, mark the others "Not a plan", then *Open and break down*. The drawing shown is AutoCAD's own rendering
   (Autodesk Viewer). Click an entity or use *Next*; say what it is, type the label, *Confirm and next*. Labels
   become the object names and tags. Elevations, sections, and schedules are not read; they are generated later.
4. 00_OBJECT_MODEL shows what you built (plan units → walls / rooms / openings). 00_CHANGE_IMPACT → propose a
   wall length change → approve → apply → write-back (DWG via Design Automation, DXF patched locally).
5. Settings (top right of Projects): ArcGIS key status and creation form; test elevation call.

## Where the real drawing needs to look
- Rooms are only proposed when closed outlines exist. On PDF-derived sets (like the National City file) the walls are
  outlines on wall layers; the detector merges the two faces into a centerline with thickness and chains collinear
  pieces. Expect ~30–40 walls per plan. Rooms will need to be drawn or derived from confirmed walls (next step).
- Viewer selection ↔ walk-through is bridged by AutoCAD entity handle (the viewer's externalId). If clicking an entity
  does not pick a candidate, the handle mapping differs for that translation; check `getExternalIdMapping` output.

## Known gaps / decisions for you
- **GitHub repo:** `jac92sal/jacsal-sync` (`main`). All work is pushed there.
- **Rotate the three credentials that were uploaded in plain text** (Anthropic key, Autodesk client secret, ArcGIS client secret).
  Autodesk + ArcGIS values are now in the Secrets Store (`APS_*`, `ARCGIS_*`); the Anthropic key was **not** stored anywhere.
- **ArcGIS key: create it from the app.** Open **Settings** (top-right on the Projects page) → *Create a long-lived API key*.
  Enter your ArcGIS username + password, keep the default privileges (Basemaps, Elevation, Static maps), 1 year, and click
  Create. The Worker signs in once, creates an API key credential item in your ArcGIS content with referrers
  `https://sync.jacsalservices.com` (+ adufeasibility), seals the key under `APP_KEK` into `app_settings`, discards the
  password, and runs a test elevation call. The old `ARCGIS_API_KEY` Secrets Store entry is now only a fallback (the last
  temporary token in it has expired). If ArcGIS rejects a privilege, the error names it: untick it and retry.
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
