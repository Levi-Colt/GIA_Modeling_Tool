# GIA Modeling Tool — Penpot wireframe spec

Reference doc for building out the Penpot boards. Ties every screen and
component back to `api/README.md`'s actual contract so the design doesn't
drift from what the backend can do.

## Working assumptions (confirm before/while building)

- **Deployment**: single-lab use for now. Each user clones the repo into
  their own CryoCloud JupyterHub pod, builds the environment themselves, and
  runs the FastAPI app via `jupyter-server-proxy` inside their own session.
  No shared/org-wide CryoCloud image involved at this stage.
- **Routing must be relative, not root-absolute.** Under
  `jupyter-server-proxy` the app is served at a per-user path prefix
  (`/user/<name>/proxy/<port>/...`), not at the domain root. Every API call
  and asset reference in the frontend needs to resolve relative to that
  prefix. Bake this in from the first commit — it's much easier than
  retrofitting later.
- **Processing is synchronous** (no job queue/polling yet). The loading
  state is deliberately indeterminate — no fake step-by-step progress.
- **Two input methods, both first-class**: drag-and-drop upload and a typed
  server-side file path. Path input is viable because the API runs inside
  the user's own pod and shares their filesystem — it isn't a fallback,
  it's likely the *preferred* method for large DEMs once this is real
  (avoids the 2GB upload ceiling entirely).
- **A lightweight preflight check is new scope**, not yet in
  `api/README.md`. It should wrap the existing `raster_io_check` (cheap —
  metadata-only, no full raster load) behind a fast endpoint hit on file
  drop or path entry/blur, so both entry methods get identical, immediate
  validation before the user reaches "Run model."
- **Carry-forward and presets are separate mechanisms.** Carry-forward is
  silent/automatic (last-run values pre-filled). Presets are explicit,
  named, and saved on purpose. Don't merge them into one control.

---

## Screen inventory

| # | Screen | Purpose |
|---|--------|---------|
| 1 | Landing | Explains the tool, 3-step "how it works," CTA into processing |
| 2 | Processing | Single scrollable page, step rail anchor nav, all 5 input groups |
| 3 | Upload preflight states | Idle / checking / valid / invalid — lives inside step 1 of screen 2 |
| 4 | Reprojection notice | One-time dismissible modal, triggered right after upload |
| 5 | Loading | Indeterminate state after "Run model" |
| 6 | Results — success | Download, info/warning banners, rerun controls |
| 7 | Results — error | 422/400/500 failures that only surface after a full run |
| 8 | Map panel (placeholder) | Reserved layout slot on screen 2; not built yet |

Suggested Penpot page/board naming: `01-landing`, `02-processing`,
`03-upload-states`, `04-modal-reprojection`, `05-loading`,
`06-results-success`, `07-results-error`. Keep one board per screen state
rather than nesting states as layers — makes it easier to link flows later
if you move into prototyping mode.

---

## Screen 1 — Landing

- Headline + one-line description of the tool's purpose.
- 3-column step summary (upload → set origin/tilt → get contour), icon +
  4–6 word title + one-line description each.
- Single primary CTA button → processing screen. This is the one place a
  bold/filled button is appropriate; keep every other button on the site
  secondary-weight by comparison.

---

## Screen 2 — Processing (hybrid single-page + step rail + map panel)

**Layout**: two columns. Left column is the form — one scrollable page
with a horizontal step rail above it acting as an anchor nav (clicking a
step scrolls to it). Right column is the map panel, `position: sticky` so
it stays visible while scrolling through the 5 form steps. Nothing in the
form is gated: all 5 sections are editable at all times regardless of
what's "complete." This matters given the unknown skill level of the
audience — nobody should get stuck unable to reach step 5 because step 3
looks unfinished.

**Map panel — placeholder for now.** This is a real, committed-to future
feature, not a nice-to-have, so the layout should reserve its space now
even though the panel itself renders as an explicit "coming soon" state
(dashed border, muted icon, one-line description) rather than a built
map. Deliberately make the placeholder look unfinished — don't let it
read as a polished empty map — so nobody mistakes reserved layout for a
shipped feature during handoff.

When the real visualization pipeline gets designed, keep two states of
this panel conceptually separate, since they have very different
technical requirements:
- **Input preview** — raster extent, origin point, tilt azimuth direction.
  All drawable client-side from form values alone, no backend call needed.
- **Result preview** — the actual tilted contour. Requires the real
  transform pipeline to have run, so this is inherently tied to the
  results screen, not something achievable while the user is still typing.

Don't design one panel that silently assumes it can show both from day
one — they're different features with different data dependencies.

**Map component contract**: the map is a dumb, pipeline-agnostic
component. It never calls into geoprocessing logic and doesn't know or
care what produced its data — it just renders whatever shape of
in-memory geometry/imagery it's handed. Something like:

```
{ extent, origin, azimuthLine, contour?, tiltedRasterUrl? }
```

Before processing, the form-state layer populates `extent`/`origin`/
`azimuthLine` from user input. After processing, a separate adapter step
populates `contour`/`tiltedRasterUrl` from the `/process` response. The
map component itself never branches on "am I in input mode or result
mode" internally in a coupled way — it just renders whatever fields are
present. This keeps it swappable/testable independent of the actual
pipeline, and means a future change to the backend's output format only
touches the adapter, never the map component.

**Persistent elements above the step rail:**
- Preset bar: `Load preset` dropdown + `Save as preset` button.
- (Presets are named/explicit — distinct from the silent carry-forward
  that pre-fills fields from the user's last run.)

**Step rail states** (component variants): `completed` (checkmark, filled),
`current` (numbered, accent-filled), `upcoming` (numbered, muted/outline).

### Step 1 — Upload DEM
See "Upload preflight states" below — this section has its own state
machine independent of the rest of the form.

### Step 2 — Coordinate mode
Single select: `match_raster` / `decimal_degrees` / `epsg`. This selection
drives the *shape* of step 3, not just its label.

### Step 3 — Coordinates
**This is a dynamic field, not a static one.** Build three variants in
Penpot, one per `origin_mode`:

| origin_mode | Field(s) shown | Format / placeholder |
|---|---|---|
| `match_raster` | `origin_value` only | `"x,y"`, floats, raster's native CRS |
| `decimal_degrees` | `origin_value` only | `"45.25N,110.55W"`, hemisphere-tagged, order-agnostic |
| `epsg` | `origin_value` + `origin_epsg` | `"x,y"` floats + `"EPSG:32612"` |

`origin_epsg` is only ever visible/enabled in the `epsg` variant — don't
show it grayed-out in the other two, just omit it.

### Step 4 — Tilt parameters
Three fields side by side: `tilt_azimuth` (degrees), `tilt_factor` (m per
km), `target_elevation` (m, paleo-elevation to contour). All three are
required — no defaults in the API.

### Step 5 — Return products
`include_dem` checkbox (default checked — matches the API's own default).

### Submit
`Run model` button, full-width, primary weight. Disabled state text:
"Running..." while step 5 (loading) is active — see below.

---

## Upload preflight states (lives inside Step 1)

Four variants, identical for both entry methods (drop vs. typed path) once
the preflight call resolves:

1. **Idle** — dashed dropzone + "Drag a GeoTIFF here, or" + path text input.
2. **Checking** — spinner + "Checking {filename}..." Applies the moment a
   file is dropped or the path field loses focus / Enter is pressed.
3. **Valid** — checkmark, filename, detected CRS, `Replace` button.
4. **Invalid** — the actual message from the backend's `raster_io_check` /
   `PreFlight` surfaced directly (e.g. "Couldn't read this file..."), not a
   generic "upload failed." `Try another file` button.

This is also where `413`/`400` (oversized or corrupted file) get caught —
before the user ever reaches step 5. The results-page error state (below)
is reserved for failures that genuinely can't be known until a full run.

---

## Modal — reprojection notice

Triggered once, automatically, right after a file passes preflight — **if
its embedded CRS isn't already EPSG:4326** (not related to which
`origin_mode` is selected — that's a separate check). Non-blocking,
dismissible, single "Got it" button. No decision for the user to make here
— it's automatic either way — so don't give this the visual weight of a
confirmation dialog.

Copy pattern: "{filename} is in {detected EPSG}. It'll be reprojected to
EPSG:4326 automatically before processing."

---

## Loading state

Indeterminate spinner + elapsed timer + "Large DEMs can take several
minutes. You can leave this page open." Submit button disabled during this
state. No fake phase list — the backend can't report real progress yet
(synchronous, no job queue), so don't imply it can.

---

## Results — success

- Success icon + "Model run complete."
- **Two separate banners, not one combined box** — this matches a real
  severity difference in the API's own response headers:
  - Info/blue banner ← `X-Source-CRS-Reprojected-From` (neutral fact)
  - Warning/amber banner ← `X-Processing-Warnings` (worth attention)
- Download card: filename, contents description, `Download` button.
- Recap line of the run's parameters (azimuth/tilt/target elevation).
- Two actions: `Run again with same inputs` and `Adjust inputs` — gives
  the carry-forward workflow an explicit landing spot right where someone
  decides whether to iterate.

## Results — error

For failures only knowable after a full run: `422` (origin >500m from
raster extent, `target_elevation` out of range), `400` (corrupted file that
somehow passed preflight), `500` (unexpected processing failure).

Pattern: danger banner with the specific message, then a button routed
back to the *named step* that caused it (e.g. "Back to step 4 · Tilt
parameters") rather than a generic "back to form." Apply this per error
cause — origin errors route to step 3, tilt/elevation errors route to
step 4, file errors route to step 1.

---

## Component checklist for Penpot

Build these as reusable components with the listed variants, rather than
one-off frames per screen:

- [ ] Step rail item — `completed` / `current` / `upcoming`
- [ ] Dropzone — `idle` / `checking` / `valid` / `invalid`
- [ ] Origin input group — `match_raster` / `decimal_degrees` / `epsg`
- [ ] Banner — `info` / `warning` / `danger`
- [ ] Button — `primary` (one per screen max) / `secondary` / `disabled`
- [ ] Preset bar
- [ ] Results action row — `success` / `error`
- [ ] Map panel — `placeholder` (only variant needed right now)

---

## Open items to resolve alongside/after Penpot work

- Preflight endpoint: new lightweight route wrapping `raster_io_check`, or
  a flag on `/process`? Needs a decision before frontend build starts.
- Whether `origin_value`/file-path fields should eventually accept `s3://`
  URIs (CryoCloud's scratch bucket) in addition to local filesystem paths
  — not urgent, but keep the input component flexible enough to add later.
- Relative-routing requirement (see assumptions above) — worth a small
  proof-of-concept `jupyter-server-proxy` deployment early, before too much
  frontend code assumes root-relative paths.
- **Visualization pipeline** (map panel, currently placeholder only): a
  real architecture task spanning frontend, backend, and API layers —
  needs its own diagramming pass before building. Open questions to
  resolve then, not now: how to render GeoTIFF/vector output in-browser
  (e.g. a raster tile library plus a vector overlay layer), whether
  input-preview geometry (extent/origin/azimuth) is computed client-side
  or via a cheap new endpoint, and how result-preview data gets from the
  `/process` response into the map component.
