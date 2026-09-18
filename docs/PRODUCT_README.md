# Engineering Design Synchronization Platform — Project README

**Workbook handoff:** `Engineering_CA_Wood_v11.xlsx`  
**State at end of session:** Workbook specification complete enough to start the application architecture.

## 1. Core product idea

The product is not “AI does engineering” and it is not “an Excel calculator with AutoCAD export.”

It is a **function-first engineering/design synchronization system** that removes communication and revision failures between engineers, drafters, reviewers, GCs, and the drawing set.

The governing philosophy is:

> **Function first. Verification second. Design is the synchronized by-product.**

The system should automate repetitive work and dependency tracking while preserving human authority.

Another core rule:

> **Humans work with building objects. The engine works with geometry.**

Coordinates remain essential for math, geometry, intersections, spans, offsets and CAD write-back, but people should work with names such as **Primary Bedroom East Wall**, **Window 01**, **Beam B4**, **Shear Wall SW3**, and **Footing F3** rather than raw coordinate pairs.

## 2. What problem this solves

Traditional workflow failure:

1. Engineer changes a beam, wall, connection, opening, or member.
2. Someone updates a plan.
3. Someone must remember the schedule.
4. Someone must remember the detail.
5. Someone must remember every section/reference.
6. Someone must remember every calculation downstream.
7. One item is eventually missed.

The product should replace “remember every place this appears” with:

1. Change a known project object.
2. Resolve every dependency.
3. Recalculate affected functions.
4. Identify every affected drawing representation.
5. Prepare exact proposed revisions.
6. Show engineer/drafter the impact set.
7. Apply only approved revisions.
8. Re-scan and reconcile the set.
9. Block issue when a mismatch remains.

**Nobody should have to remember everywhere a change needs to be made. People should decide whether the proposed change is correct.**

## 3. Function → Verification → Design

### Function
The model knows what an item must do and everything required for that function.

A shear wall is not a hatch. It is an assembly including, as applicable:
- framing;
- boundary members;
- sheathing;
- fastener pattern;
- blocking;
- holdowns;
- holdown fasteners;
- anchor/rod system;
- sill anchorage;
- load path;
- capacity;
- deformation behavior;
- sources;
- CAD representations.

A connection is not “a bolt.” It is the complete connection:
- connected members;
- fastener group;
- bolts/screws/nails;
- nuts;
- washers;
- plates/straps;
- holes/geometry;
- spacing/end/edge conditions;
- force demand;
- capacity checks;
- source records;
- details/schedule representations.

A footing is not a rectangle. It is:
- geometry;
- supported object;
- service/strength reactions;
- soil/geotechnical basis;
- concrete;
- reinforcement;
- dowels/anchors;
- bearing/stability/concrete verification;
- detail/schedule representations;
- revision history.

### Verification
Each object has a meaningful engineering/readiness state, for example:

`INCOMPLETE → CALCULATED → VERIFIED → APPROVED → ISSUED`

Verification includes:
- completeness;
- source validity;
- demand/capacity;
- geometry rules;
- load-path continuity;
- product/source match;
- calculation-to-drawing reconciliation;
- revision reconciliation.

### Design output
Plans, schedules, notes, details and dimensions are views of the verified object model.

The drawing is important, but it is **not the only database containing the project’s meaning**.

## 4. Semantic object model

Every important object should have at least three identity layers:

### Permanent system identity
Immutable UUID/object key. Never changes.

Example:
`6fd2...91a`

### Human identity
Readable project name.

Example:
`Primary Bedroom East Wall`

### Semantic tag
Structured readable alias.

Example:
`ROOM.PRIMARY_BEDROOM.WALL.EAST`

### Geometry
Precise coordinates / curves / dimensions used by the engine.

Example:
- X1/Y1
- X2/Y2
- length
- elevation
- angle
- intersections

Names may change. Geometry may change. The permanent ID preserves all relationships.

## 5. Object relationships

The model is hierarchical and relational.

Example:

```text
PROJECT
└── LEVEL.01
    └── ROOM.PRIMARY_BEDROOM
        ├── WALL.NORTH
        ├── WALL.SOUTH
        ├── WALL.EAST
        │   ├── WINDOW.01
        │   ├── SHEAR_WALL.SW3
        │   └── related HEADER / HOLDOWN objects
        └── WALL.WEST
```

Objects can reference other objects semantically.

Example:

```text
Beam B4
  Start Support = PRIMARY_BEDROOM.WEST_WALL
  End Support   = PRIMARY_BEDROOM.EAST_WALL
```

The engine resolves those semantic objects to actual geometry and calculates the span.

## 6. Anchor / behavior rules

Hosted items should know **how they are intended to behave** when the host changes.

Examples:
- `KEEP_OFFSET_FROM_SOUTH_END`
- `KEEP_OFFSET_FROM_NORTH_END`
- `CENTER_ON_HOST`
- `BETWEEN_OBJECT_A_AND_OBJECT_B`
- `FOLLOW_SUPPORTED_OBJECT`
- `STRETCH_WITH_HOST`
- `FIXED_WORLD_POSITION`
- `ENGINEER_REVIEW_ON_HOST_CHANGE`

Example:

```text
Window W01
Host = Primary Bedroom East Wall
Anchor = SOUTH_END
Offset = 2'-6"
```

If the north end of the wall moves, W01 can remain 2'-6" from the south end.

## 7. CAD ingestion and confirmation

Target workflow:

`Upload DWG/DXF → Detect → Propose → Confirm/Edit/Ignore → Persist`

The system may detect:
- rooms;
- wall segments;
- openings;
- member marks;
- spans;
- wall lengths;
- heights;
- beam/post sizes;
- shear-wall extents;
- diaphragm boundaries;
- footing geometry;
- grids;
- title-block data;
- schedules/tables;
- blocks and attributes;
- xrefs/source entities.

Nothing automatically becomes authoritative solely because it was detected.

For every confirmed value/object retain:
- source drawing;
- entity/object ID;
- extraction method;
- detected value;
- confidence;
- confirmed value;
- confirming user;
- timestamp;
- revision.

## 8. CAD synchronization

The relationship must work both directions.

### DWG → App
Read:
- geometry;
- objects;
- dimensions;
- blocks;
- attributes;
- schedules;
- tags;
- xrefs;
- source sheets.

### App → DWG
Update:
- object geometry;
- dynamic block properties;
- dimensions;
- structural tags;
- member sizes;
- schedules;
- design criteria;
- notes;
- details;
- callouts;
- revision impacts.

A change must be previewed and approved before write-back.

After writing changes, the app re-scans and checks:

`Verified Project Model == Issued Drawing Set`

Any mismatch blocks the issue gate.

## 9. Change impact model

Example: Primary Bedroom East Wall changes from 14'-0" to 15'-6".

The app should determine:
- which endpoint moved;
- which hosted openings move and which stay fixed;
- whether headers change;
- whether beam spans change;
- whether tributary geometry changes;
- whether shear-wall length/aspect ratio changes;
- whether holdown forces change;
- whether collectors/diaphragms change;
- whether posts/reactions change;
- whether footings change;
- which dimensions, schedules, plans, sections and details change.

Then show the user a proposed impact set before modifying the files.

## 10. Complete working components, not graphic blocks

A reusable component represents **everything needed for the item to work**, not everything needed for it to merely look correct.

A component definition may include:
- functional role;
- allowed hosts;
- geometry parameters;
- child items;
- material requirements;
- fastener/hardware rules;
- calculation hooks;
- source requirements;
- schedule fields;
- CAD graphics;
- annotation rules;
- QA checks;
- cost/takeoff rules;
- revision behavior.

The drafter is increasingly assembling documented working items rather than redrawing anonymous geometry.

## 11. Cost / quantity architecture

Future costing should reuse the same object graph.

Every physical assembly can own a BOM.

### Countable parts
Examples:
- bolts;
- screws;
- nails;
- nuts;
- washers;
- plates;
- straps;
- holdowns;
- anchors.

Typical unit: `EA`.

### Measurable materials
Examples:
- lumber;
- sheathing;
- concrete;
- reinforcing steel;
- blocking.

Possible units:
- LF;
- SF;
- BF;
- CY;
- LB;
- EA.

### Cost-ready item fields
Recommended:
- object/item ID;
- parent object ID;
- canonical item type;
- human description;
- material/product specification;
- quantity basis;
- base quantity;
- unit;
- waste factor;
- cost quantity;
- price source;
- unit material cost;
- material cost;
- labor task/code;
- labor hours/unit;
- labor hours;
- labor rate;
- labor cost;
- equipment/subcontract cost;
- extended cost;
- price date;
- region;
- confidence/status.

Do not invent prices. Price records should have source/date/region.

### Design change → cost change
The dependency graph can later compare:

`Old BOM vs New BOM`

to calculate:
- added quantities;
- removed quantities;
- labor delta;
- material delta;
- potential change-order impact.

## 12. Workbook role

The Excel workbook is now primarily:

1. a transparent calculation specification;
2. a reference implementation of equations/QA;
3. a source/provenance pattern;
4. an app data-model specification;
5. a report/longhand prototype;
6. a CAD integration contract.

The app/project database should become the future canonical source of truth.

Do **not** continue turning Excel into a 500-field user interface.

`01_INPUTS` is an internal backend engineering schema.

The human-facing concept is represented by:
- `00_COVER`
- `00_CAD_CONFIRM`
- `00_OBJECT_MODEL`
- `00_CHANGE_IMPACT`
- `00_ISSUE_GATE`
- `00_README`
- `00_ITEM_KEY`
- `00_BUILDOUT_EXAMPLE`

## 13. Engineering modules currently represented

The workbook includes first-pass engines/interfaces for:
- project setup;
- design criteria;
- gravity effects;
- load combinations;
- wind;
- seismic;
- wood beams/headers;
- wood columns/posts;
- shear walls;
- diaphragms;
- connections;
- holdowns;
- sill/anchor lines;
- collectors/chords;
- foundation soil/stability interface;
- longhand calculation pages;
- QA benchmarks;
- CAD output mapping;
- source/document registers;
- issue gating.

Deeper engineering cases should primarily be implemented in the app engine and mirrored into report output rather than continuing to grow the Excel input interface.

## 14. Tomorrow — where to start

Start with the object model, not the calculator UI.

### First vertical slice
1. Create Project.
2. Upload a DWG/DXF.
3. Parse entities while retaining source IDs.
4. Detect candidate rooms/walls/openings.
5. Show confirmation UI.
6. Persist:
   - UUID;
   - human name;
   - semantic tag;
   - parent/host;
   - coordinates;
   - behavior rule;
   - CAD representations.
7. Allow user to change one wall length.
8. Build dependency/impact graph.
9. Show every affected object/drawing representation.
10. Approve proposed changes.
11. Write approved changes back.
12. Re-scan and reconcile.

### Proof-of-concept success case
Use a room such as:

`ROOM.PRIMARY_BEDROOM`

with:

`ROOM.PRIMARY_BEDROOM.WALL.EAST`

and a hosted window:

`ROOM.PRIMARY_BEDROOM.WALL.EAST.WINDOW.01`

The window should have an anchor rule such as:

`KEEP_OFFSET_FROM_SOUTH_END`

Change the east wall length and prove:
- the engine resolves exact coordinates;
- the semantic object relationships remain intact;
- the window behaves according to its rule;
- connected structural objects are flagged;
- affected drawings are identified;
- no update occurs without approval;
- final reconciliation detects any missed representation.

## 15. Product statement

> **We manage what a building must do, verify that it works, and let the design documents become the synchronized expression of that verified state.**

And the operational rule:

> **Nobody should have to remember everywhere a change needs to be made. They should only have to decide whether the proposed change is correct.**
