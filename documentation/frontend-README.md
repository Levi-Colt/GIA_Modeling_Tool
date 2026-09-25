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
                             it works while that section is collapsed
    context/             ProcessingContext: shared form state + `mode` + the
                          `advanced` namespace (`updateForm`, `updateAdvanced`),
                          carry-forward to localStorage (not presets — separate concern)
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
      geometry.js         client-side azimuth-line math (turf + a hand-rolled
                           haversine/bbox-clip) — no backend call
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
                            point): shared azimuth + gradient inputs, profile
                            family, family parameters, hinge rule, chart
        ProfileChart.jsx   hand-rolled SVG uplift-vs-distance preview + warnings
      map/
        MapPanel.jsx       pipeline-agnostic — see "map component contract" in
                           GIA_Tool_Penpot_Spec.md / VISUALIZATION_PIPELINE_SPEC.md.
                           Vanilla Leaflet (no react-leaflet) wired via
                           useRef/useEffect; renders whatever subset of
                           extent/rasterPreview/origin/azimuthLine/contour/
                           tiltedRasterPreview/selectionRadius it's handed.
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
  `utils/payload.js`); Basic never does. The direction-source switch, vectors
  and shore points (specs 5/6) mount in `TiltModelBody` too.
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
