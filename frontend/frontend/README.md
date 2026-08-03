# Frontend scaffold

Drop this `frontend/` directory alongside `api/` in `GIA_Modeling_Tool`.

## Structure

```
frontend/
  vite.config.js        relative base path — required for jupyter-server-proxy
  src/
    api/client.js        relative-path fetch calls (no leading slash — see comments)
    context/             shared form state, carry-forward (not presets — separate concern)
    components/
      shared/StepRail.jsx  anchor nav, never gates a step
      steps/               one component per form step (1-5)
      map/MapPanel.jsx     pipeline-agnostic — see "map component contract" in the spec doc
```

## What's real vs. stubbed here

- Vite config, relative routing pattern, and the preflight state machine
  (`UploadStep.jsx`) are implemented as designed.
- `MapPanel.jsx` is still a placeholder — Leaflet + `georaster-layer-for-leaflet`
  wiring is the next real implementation step, not done here.
- The `/api/preflight` endpoint this calls doesn't exist in `api/README.md`
  yet — new backend scope, flagged in the spec doc.
- Loading state, results screens (success/error), presets, and the
  reprojection modal aren't scaffolded yet — the form/map/step-rail
  skeleton was the priority for this pass.

## Production build

```
npm install
npm run build     # outputs frontend/dist
```

FastAPI should serve `frontend/dist` via `StaticFiles` alongside the
existing `/process` route — one process, one port, one thing to proxy
through `jupyter-server-proxy`.

## Local dev

```
npm run dev
```

Runs the Vite dev server with hot reload; `/api` calls are proxied to a
local FastAPI instance on port 8000 (see `vite.config.js`). This proxy is
dev-only — production doesn't need it since FastAPI serves everything from
one origin.
