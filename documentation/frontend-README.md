# Frontend scaffold

Drop this `frontend/` directory alongside `api/` in `GIA_Modeling_Tool`.

## Structure

```
frontend/
  vite.config.js        relative base path — required for jupyter-server-proxy
  src/
    api/client.js        relative-path fetch calls (no leading slash — see comments)
    hooks/
      useProfilePreview.js  debounced (400ms) POST /api/profile-preview; keeps the
                             transient formState.profilePreview current. Mounted
                             once in ProcessingPage (not in the tilt section), so
                             it works while that section is collapsed. Azimuth
                             source only
      useUpliftPreview.js   the vectors source's counterpart: debounced (500ms)
                             POST /api/uplift-preview -> transient
                             formState.upliftPreview (isobases + per-vector fit);
                             needs a ready tilt section, the resolved origin and
                             the DEM bounds; cleared when not in vectors mode
    context/             ProcessingContext: shared form state + `mode` + the
                          `advanced` namespace (`updateForm`, `updateAdvanced`),
                          carry-forward to localStorage (not presets — separate concern).
                          Also the vector-list actions (`setVectors`, `undoVectors`,
                          `selectVector`, `setMapEditMode`, `requestVectorFocus`)
                          and the undo stack (last 20 list states, in a ref)
    utils/
      basemap.js          BASEMAPS (absolute external tile URLs, by design),
                           pickBasemapKey(extent) — pure US/non-US test using
                           assets/us_boundary.json + @turf/boolean-point-in-polygon
      readiness.js        getReadiness() -> { ready, missing: [{section, text}],
                           missingText }; isReadyToRun() wraps it
      payload.js          buildProcessPayload(formState) for POST /api/process
                           (lives here, not App.jsx, so it's unit-testable)
      steps.js            STEPS (four sections + their Advanced keys), scrollToStep,
                           classifyErrorStep (backend error text -> section id)
      tiltModel.js        Advanced uplift-model helpers: parseFiniteNumber (text
                           inputs, accepts 64.94e-4), hinge-default resolution,
                           buildTiltModel (the `tilt_model` payload object),
                           tiltModelIssues (readiness reasons), describeTiltModel
                           (results-screen line), DEFAULT_PROFILE / DEFAULT_HINGE
      ticks.js            niceTicks(min, max, count) for the profile chart axes
      geometry.js         client-side geometry, no backend call: the azimuth line
                           (turf + a hand-rolled haversine/bbox-clip), and the
                           vector helpers bearingDeg / distanceKm / pointAlong /
                           arrowGeometry / arrowLengthKm / isClick (a drag under
                           8 px is a click)
      numbers.js          the strict numeric parsers (parseFiniteNumber, ...),
                           shared by tiltModel.js and vectors.js (re-exported
                           from tiltModel.js)
      vectors.js          the vectors row model and everything pure about it:
                           readiness (vectorIssues), the payload
                           (buildVectorsDirection), CSV import (papaparse),
                           the map adapter (vectorsToMapData), map-edit
                           formatting (fieldsFromGeometry), the undo stack
    components/
      shared/
        AppLayout.jsx      page layout for form + results views: header, form
                            column (mode switch / scrolling body / pinned footer),
                            full-height map; stacks below 1024px
        ModeSwitch.jsx     Basic/Advanced segmented control (changes only `mode`)
        CollapsibleSection.jsx  Advanced section: header button + status line
      forms/
        BasicForm.jsx      four numbered sections on one scrolling page
        AdvancedForm.jsx   the same four as collapsible sections; TiltModelBody
                            is the extension point for the later modeling specs
      steps/               body components the two forms share (no section
                            wrapper/heading of their own): UploadStep,
                            CoordinateModeStep, CoordinatesStep,
                            TargetElevationField, TiltInputs, ProductsStep
      advanced/
        TiltModelBody.jsx  the Advanced Tilt-model section body (the extension
                            point): direction-source switch (Single azimuth |
                            Vectors), shared azimuth + gradient inputs, profile
                            family, family parameters, hinge rule, chart
        ProfileChart.jsx   hand-rolled SVG uplift-vs-distance preview + warnings
        VectorTable.jsx    the vectors table (#, Lat, Lon, Azim, Range, Tilt, Fit,
                            remove), custom-tilt rows, + Add row / Add on map /
                            Undo / Import CSV
        CsvImport.jsx      the CSV import panel (Replace / Append buttons)
        VectorFitSummary.jsx  vectors mode's replacement for the profile chart:
                            fit summary line, guard note, preview warnings
        fields.jsx         NumberField / Help / Segmented, shared by the above
      map/
        MapPanel.jsx       pipeline-agnostic — see "map component contract" in
                           GIA_Tool_Penpot_Spec.md / VISUALIZATION_PIPELINE_SPEC.md.
                           Vanilla Leaflet (no react-leaflet) wired via
                           useRef/useEffect; renders whatever subset of
                           extent/rasterPreview/origin/azimuthLine/contour/
                           tiltedRasterPreview/selectionRadius/vectors/isobases
                           it's handed, and reports vector edits through an
                           optional `editing` prop's callbacks. One effect and
                           one pane per layer group, so editing vectors never
                           rebuilds the raster.
        VectorLayer.js     the vector arrows + editing gestures (add on map, base
                           and tip handles), imperative Leaflet owned by
                           MapPanel; no model logic
        CompassRose.jsx    fixed chrome overlay, rotates with tiltAzimuth
```

## What's real vs. stubbed here

- Vite config, relative routing pattern, the preflight state machine
  (`UploadStep.jsx`), and the map panel (`MapPanel.jsx` + `CompassRose.jsx`)
  are all implemented and wired end-to-end against the real API, including
  the raster/origin/azimuth-line input preview and the post-run
  contour/tilted-raster result preview. See `VISUALIZATION_PIPELINE_SPEC.md`
  for the full contract and staged build order.
- Map quality-of-life (`MAP_QOL_SPEC.md`) is implemented: USGS Topo / NRCan
  Canada Base Map basemaps (auto-picked from the DEM extent, manual choice via
  the layer control wins for the session), a metric scale bar, attribution,
  and a Run button that's disabled until the form is ready, with a "Still
  needed: ..." list.
- Layout and modes (`LAYOUT_AND_MODES_SPEC.md`) are implemented: the map takes
  two thirds of the width and the full height; `StepRail` is retired; a
  Basic/Advanced switch tops the form column. Advanced is a shell — the same
  inputs as Basic in collapsible sections ("Single azimuth" / "Gradient at
  origin" are the shared `tiltAzimuth` / `tiltFactor`), with a `TiltModelBody`
  extension point for the uplift-model, vector-field and shore-point specs.
  Both modes' values are kept in state and persisted; switching never clears
  anything. Target elevation moved into the Origin section.
- Selection radius (`SELECTION_RADIUS_SPEC.md`) is implemented: optional km
  input in the Output section, a dashed circle on the map, an `X-Selection-Summary`
  banner in the results, and `selection_radius_km` in the process payload.
- The uplift model / profile families (`UPLIFT_MODEL_SPEC.md`, amended by
  `UPLIFT_MODEL_CORRECTIONS_SPEC.md`) are implemented in Advanced mode:
  `TiltModelBody` offers Linear / Quadratic / Polynomial (degree 2-5) profiles
  and three hinge modes (At spillway (default) / Distance behind spillway /
  None: continue behind spillway). Gradient at the spillway is the shared
  `tiltFactor`; a quadratic's curvature is entered either as a second gradient
  (a gradient at a distance up the uplift direction, the default) or as a rate
  of increase, via a "Curvature from" control. All text is generic (no
  basin- or paper-specific content; see `tests/test_no_basin_specific_text.py`).
  State lives in `advanced.profile` / `advanced.hinge` (persisted; the hinge
  mode has no `'default'` value, and legacy `'default'` / `'natural'` load as
  `'origin'`); the `/api/profile-preview` response lives in the transient
  top-level `profilePreview` key. Advanced runs send a `tilt_model` JSON form field (see
  `utils/payload.js`); Basic never does. Shore points (spec 6) mount in
  `TiltModelBody` too.
- Vector direction fields (`VECTOR_FIELD_SPEC.md`, spec 5) are implemented in
  Advanced mode. `TiltModelBody` starts with a **Direction source** switch,
  Single azimuth | Vectors. In vectors mode it shows the vectors table above a
  "Global profile (whole DEM)" block (the same gradient / family / hinge controls;
  a muted note says the profile is unused when every vector is custom), and the
  profile chart is replaced by the fit summary (the isobases are on the map).
  Each row has lat, lon, azimuth, an optional **range** (its range of influence,
  not a magnitude) and a Global/Custom tilt; a custom row expands below with a
  family (Linear/Quadratic), a **local gradient** (at that vector's own
  location) and, for a quadratic, the same "Curvature from" control as the
  global profile. The Fit column comes from `/api/uplift-preview` and is amber
  above 15 degrees. Rows can be added with **+ Add row**, by **Add on map**
  (drag = direction and range, a short drag is a click and focuses the new
  row's azimuth input; Escape or Done stops; add mode disables map panning),
  by **Import CSV** (header aliases matched case-insensitively; bad rows are
  skipped whole and reported; Replace / Append buttons), and edited by dragging
  each arrow's base handle (moves) or tip handle (rotates and resizes; sets the
  azimuth and range). Map edits commit on drag end only; Undo keeps the last 20
  list states (structural edits, not typing).
  State: `advanced.directionSource` (`'azimuth' | 'vectors'`) and
  `advanced.vectors` (persisted; every field a string, stable `id`s); the
  selection (`selectedVectorId`), add-on-map mode (`mapEditMode`), a pending
  focus request (`vectorFocusRequest`) and the preview (`upliftPreview`) are
  transient top-level keys in `TRANSIENT_KEYS`. In vectors mode the payload omits
  `tilt_azimuth`, and omits `tilt_factor` (and the unused global profile) only
  when every vector is custom; the single-azimuth line and compass needle are
  not drawn.
- Presets and the reprojection modal aren't scaffolded yet.
- Vitest + `@testing-library/react` are configured (`npm test`, config lives
  in `vite.config.js`'s `test` key, setup file at `src/test/setup.js`). Still
  thin — most of the frontend is still verified via `npm run build` plus
  manual/browser-driven checks against the running app, not full coverage —
  but component tests are a real, supported option now, not something to
  bootstrap from scratch each time. See
  `src/components/steps/CoordinateSteps.test.jsx` for the current pattern
  (render via `ProcessingProvider`, mock `api/client.js`, drive the DOM with
  `@testing-library/user-event`). Pure logic that doesn't need a DOM (e.g.
  `utils/readiness.js`) is deliberately split out of component files so it's
  testable without pulling in heavy UI dependencies (`MapPanel.jsx` ->
  `georaster-layer-for-leaflet` in particular doesn't resolve cleanly under
  Vitest's module resolution) — keep that pattern for similar extractions.

## Production build

```
npm install
npm run build     # outputs frontend/dist
```

FastAPI should serve `frontend/dist` via `StaticFiles` alongside the
existing `/api/*` routes — one process, one port, one thing to proxy
through `jupyter-server-proxy`.

## Local dev

```
npm run dev
```

Runs the Vite dev server with hot reload; `/api` calls are proxied to a
local FastAPI instance on port 8000 (see `vite.config.js`). This proxy is
dev-only — production doesn't need it since FastAPI serves everything from
one origin.
