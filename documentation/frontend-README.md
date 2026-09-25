# Frontend scaffold

Drop this `frontend/` directory alongside `api/` in `GIA_Modeling_Tool`.

## Structure

```
frontend/
  vite.config.js        relative base path — required for jupyter-server-proxy
  src/
    api/client.js        relative-path fetch calls (no leading slash — see comments)
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
