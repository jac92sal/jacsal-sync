-- jacsal-sync: semantic object model, CAD confirmation, change impact, calcs, issue gate.
-- Humans work with building objects; the engine works with geometry. IDs are permanent UUIDs.

CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  address       TEXT,
  city          TEXT,
  county        TEXT,
  jurisdiction  TEXT,
  apn           TEXT,
  prepared_for  TEXT,
  prepared_by   TEXT,
  project_no    TEXT,
  code_path     TEXT,            -- CBC | CRC
  risk_category TEXT,            -- I..IV
  design_method TEXT,            -- ASD | LRFD
  occupancy     TEXT,
  stories       INTEGER,
  lat           REAL,
  lng           REAL,
  status        TEXT NOT NULL DEFAULT 'SETUP',   -- SETUP | ACTIVE | ISSUED
  created_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 01_INPUTS: the backend engineering schema as key/value with provenance. Not a user form.
CREATE TABLE project_inputs (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,        -- e.g. BUILDING.LENGTH, WOOD.FB, WIND.VULT
  value       TEXT,                 -- JSON scalar
  unit        TEXT,
  source      TEXT,                 -- source record code, CAD candidate id, or 'USER'
  status      TEXT NOT NULL DEFAULT 'READY',      -- READY | MISSING | REVIEW
  updated_by  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (project_id, key)
);

CREATE TABLE cad_files (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  kind          TEXT NOT NULL,        -- DWG | DXF
  r2_key        TEXT NOT NULL,        -- original upload
  dxf_r2_key    TEXT,                 -- DXF produced by Design Automation when kind = DWG
  size          INTEGER,
  sha256        TEXT,
  status        TEXT NOT NULL DEFAULT 'UPLOADED',  -- UPLOADED | CONVERTING | PARSED | ERROR
  entity_count  INTEGER,
  error         TEXT,
  revision      INTEGER NOT NULL DEFAULT 1,
  uploaded_by   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Every source entity retained with its handle so write-back can target it exactly.
CREATE TABLE cad_entities (
  id          TEXT PRIMARY KEY,
  file_id     TEXT NOT NULL REFERENCES cad_files(id) ON DELETE CASCADE,
  project_id  TEXT NOT NULL,
  handle      TEXT NOT NULL,          -- DXF group 5
  layer       TEXT,
  etype       TEXT NOT NULL,          -- LINE | LWPOLYLINE | INSERT | TEXT | MTEXT | DIMENSION | ...
  geometry    TEXT NOT NULL,          -- JSON: points, closed flag, text, insertion, etc.
  attributes  TEXT                    -- JSON: block name, attribs, dim text, style
);
CREATE INDEX idx_cad_entities_file_handle ON cad_entities(file_id, handle);
CREATE INDEX idx_cad_entities_project ON cad_entities(project_id, etype);

-- 00_CAD_CONFIRM: detection is a proposal until a human confirms it.
CREATE TABLE candidates (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_id         TEXT REFERENCES cad_files(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL,      -- FIELD | ROOM | WALL | WINDOW | DOOR | BEAM | SHEAR_WALL | FOOTING | TEXT
  human_name      TEXT NOT NULL,
  semantic_tag    TEXT,
  detected_value  TEXT,               -- JSON: scalar for FIELD, geometry for objects
  unit            TEXT,
  confidence      REAL,
  source_handles  TEXT,               -- JSON array of entity handles
  method          TEXT,               -- e.g. 'closed-polyline', 'parallel-lines', 'title-block'
  ckey            TEXT,               -- detector key, stable within a file (ROOM:<handle>, WALL:<handle>:<i>)
  host_key        TEXT,               -- detector key of the host candidate
  anchor_rule     TEXT,
  anchor_params   TEXT,               -- JSON
  representations TEXT,               -- JSON [{handle, repType, role}]
  action          TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | CONFIRM | EDIT | IGNORE
  edited_value    TEXT,
  confirmed_value TEXT,
  backend_target  TEXT,               -- project_inputs key or object type
  object_id       TEXT,               -- object created on confirm
  confirmed_by    TEXT,
  confirmed_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_candidates_project ON candidates(project_id, action);

-- 00_OBJECT_MODEL: permanent ID + human name + semantic tag + geometry + relationships + states.
CREATE TABLE objects (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type                TEXT NOT NULL,   -- PROJECT | LEVEL | ROOM | WALL | WINDOW | DOOR | BEAM | POST | SHEAR_WALL | HOLDOWN | FOOTING | DIAPHRAGM | ...
  human_name          TEXT NOT NULL,
  semantic_tag        TEXT NOT NULL,   -- ROOM.PRIMARY_BEDROOM.WALL.EAST
  parent_id           TEXT REFERENCES objects(id) ON DELETE SET NULL,
  host_id             TEXT REFERENCES objects(id) ON DELETE SET NULL,
  function            TEXT,
  anchor_rule         TEXT,            -- KEEP_OFFSET_FROM_SOUTH_END | CENTER_ON_HOST | ... | ENGINEER_REVIEW_ON_HOST_CHANGE
  anchor_params       TEXT,            -- JSON e.g. {"offset_ft":2.5,"from":"SOUTH_END"}
  geometry            TEXT,            -- JSON {"x1","y1","x2","y2"} or {"points":[...]} or {"x","y"}
  geometry_source     TEXT,            -- CAD candidate id | USER | ENGINE
  derived             TEXT,            -- JSON {"length_ft":14,"area_sf":...}
  properties          TEXT,            -- JSON type-specific (size, species, sheathing, ...)
  verification_state  TEXT NOT NULL DEFAULT 'INCOMPLETE',  -- INCOMPLETE | CALCULATED | VERIFIED | APPROVED | ISSUED
  approval_state      TEXT NOT NULL DEFAULT 'PENDING',     -- PENDING | APPROVED | REJECTED
  revision            INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, semantic_tag)
);
CREATE INDEX idx_objects_project_type ON objects(project_id, type);
CREATE INDEX idx_objects_host ON objects(host_id);
CREATE INDEX idx_objects_parent ON objects(parent_id);

-- Semantic relationships beyond parent/host: Beam B4 SUPPORTED_BY PB.WEST_WALL, etc.
CREATE TABLE object_relations (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  from_id     TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  to_id       TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,          -- SUPPORTED_BY | SUPPORTS | LOADS | HOSTS | ANCHORS_TO | COLLECTS
  params      TEXT                    -- JSON e.g. {"end":"WEST"}
);
CREATE INDEX idx_relations_from ON object_relations(from_id);
CREATE INDEX idx_relations_to ON object_relations(to_id);

-- One object may appear on many sheets. Each row is one CAD representation we can write back to.
CREATE TABLE representations (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  object_id   TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  file_id     TEXT NOT NULL REFERENCES cad_files(id) ON DELETE CASCADE,
  handle      TEXT NOT NULL,          -- entity handle in that file
  rep_type    TEXT NOT NULL,          -- GEOMETRY | DIMENSION | TEXT | SCHEDULE | NOTE | DETAIL | TAG
  role        TEXT,                   -- e.g. 'wall-centerline', 'length-dim', 'mark-text'
  last_value  TEXT,                   -- JSON of what the drawing currently shows
  synced      INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_reps_object ON representations(object_id);
CREATE INDEX idx_reps_file_handle ON representations(file_id, handle);

-- 00_CHANGE_IMPACT: a change never silently edits the set.
CREATE TABLE change_requests (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  object_id          TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  property           TEXT NOT NULL,   -- e.g. length_ft | geometry | properties.depth_in
  current_value      TEXT,            -- JSON
  proposed_value     TEXT,            -- JSON
  reason             TEXT,
  requested_by       TEXT,
  status             TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | APPROVED | REJECTED | APPLIED | RECONCILED | MISMATCH
  engineer_approval  TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | APPROVE | REJECT
  drafter_approval   TEXT NOT NULL DEFAULT 'PENDING',
  applied_at         TEXT,
  reconciliation     TEXT,            -- MATCH | MISMATCH | PENDING
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_changes_project ON change_requests(project_id, status);

CREATE TABLE change_impacts (
  id           TEXT PRIMARY KEY,
  change_id    TEXT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  project_id   TEXT NOT NULL,
  target_kind  TEXT NOT NULL,         -- OBJECT | CALC | REPRESENTATION
  target_id    TEXT,                  -- object id | calc module | representation id
  domain       TEXT NOT NULL,         -- STRUCTURAL | DESIGN | DOCUMENTATION
  severity     TEXT NOT NULL,         -- CRITICAL | ATTENTION | INFO
  summary      TEXT NOT NULL,         -- 'HEADER 01: SPAN INCREASED (Requires Recalculation)'
  detail       TEXT,                  -- JSON: rule applied, before/after
  proposed     TEXT,                  -- JSON: exact proposed revision (new geometry, new text, new dim value)
  module       TEXT,                  -- calc module to rerun, when target_kind = CALC
  status       TEXT NOT NULL DEFAULT 'PROPOSED',  -- PROPOSED | APPROVED | REJECTED | APPLIED | VERIFIED | FAILED
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_impacts_change ON change_impacts(change_id);

-- Every calculation run: inputs, outputs, longhand trace, QA, status. Append-only.
CREATE TABLE calc_runs (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  object_id    TEXT REFERENCES objects(id) ON DELETE SET NULL,
  module       TEXT NOT NULL,         -- wood-beam | wood-column | shear-wall | ...
  inputs       TEXT NOT NULL,         -- JSON
  outputs      TEXT,                  -- JSON
  trace        TEXT,                  -- JSON longhand steps
  status       TEXT NOT NULL,         -- PASS | FAIL | REVIEW | PENDING | ERROR
  utilization  REAL,
  triggered_by TEXT,                  -- change id | USER | CONFIRM
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_calc_runs_project ON calc_runs(project_id, module, created_at);

-- Design Automation jobs (DWG->DXF conversion, approved write-back, rescan).
CREATE TABLE cad_jobs (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_id      TEXT REFERENCES cad_files(id) ON DELETE SET NULL,
  change_id    TEXT REFERENCES change_requests(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL,         -- CONVERT | WRITEBACK | RESCAN
  workitem_id  TEXT,
  status       TEXT NOT NULL DEFAULT 'QUEUED',  -- QUEUED | PENDING | INPROGRESS | SUCCESS | FAILED | CANCELLED
  report_url   TEXT,
  input_key    TEXT,
  output_key   TEXT,
  script_key   TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_cad_jobs_project ON cad_jobs(project_id, status);

-- 07_SOURCES / A2_DOCUMENT_REGISTER: every controlled value stays traceable.
CREATE TABLE sources (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,          -- SRC-01
  title       TEXT NOT NULL,
  kind        TEXT,                   -- CODE | ESR | MANUFACTURER | GEOTECH | API | CALC
  reference   TEXT,
  url         TEXT,
  valid_from  TEXT,
  valid_to    TEXT,
  notes       TEXT
);

CREATE TABLE audit_log (
  id           TEXT PRIMARY KEY,
  project_id   TEXT,
  actor        TEXT,
  action       TEXT NOT NULL,
  target_kind  TEXT,
  target_id    TEXT,
  detail       TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_audit_project ON audit_log(project_id, created_at);
