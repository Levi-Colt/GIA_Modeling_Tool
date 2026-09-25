# GIA Modeling Tool — Layout & Basic/Advanced Mode Spec

Spec 3 of the Sep 2026 feature set. Frontend only. Implement **after**
`MAP_QOL_SPEC.md` and `SELECTION_RADIUS_SPEC.md`: this spec moves their fields
and reuses `getReadiness`.

Design reference: the "GIA Tool — Input Layout Options" canvas. Artboard **A**
is Basic mode and artboard **B** is Advanced mode. Artboard C (wizard) was
considered and rejected. Match the structure of A and B, not their pixel
values: this app keeps its existing Tailwind styling.

## Goal

1. The map takes two thirds of the screen and the full viewport height.
2. A Basic/Advanced switch sits at the top of the form column. Basic is a
   single scrolling page; Advanced is a set of collapsible sections.
3. Switching modes never loses anything. Every value in either mode is kept
   in state and carried across reloads.
4. Build the Advanced **shell** only. The later structural specs fill the
   tilt-model section (profile families, vectors, shore points). Until then,
   Advanced mode offers exactly the same inputs as Basic, arranged in
   sections, and produces an identical run.

## Out of scope

- Any new modeling parameter, API field, or backend change.
- Map editing (click-and-drag vector entry). That belongs to the vectors spec,
  which will extend `MapPanel`'s contract.
- Presets.

---

## C1. Page layout

Replace both `mx-auto grid max-w-5xl grid-cols-[1.3fr_1fr] gap-4 p-6`
wrappers in `App.jsx` (form view and results view) with one shared layout
component, `components/shared/AppLayout.jsx`:

```
┌──────────────────────── header (h-12) ────────────────────────┐
├── form column ──┬────────────────── map ──────────────────────┤
│ mode switch     │                                             │
│ ─────────────── │                                             │
│ scrolling body  │            MapPanel (fills)                 │
│                 │                                             │
│ ─────────────── │                                             │
│ pinned footer   │                                             │
└─────────────────┴─────────────────────────────────────────────┘
```

- **Root:** `h-screen flex flex-col`. Below the header,
  `grid flex-1 min-h-0 lg:grid-cols-[minmax(380px,1fr)_2fr]`.
- **Form column:** `flex flex-col min-h-0 border-r bg-white`, holding a
  mode-switch row, a body (`flex-1 overflow-y-auto`), and a footer with the
  Run button and the "Still needed" line from spec 1. Only the body scrolls;
  the switch and the Run button stay put.
- **Header:** a thin bar with the app name. Nothing interactive in it for now.
- **Narrow screens (below `lg`, 1024px):** stack vertically, with the map
  first at `h-[55vh]` and the form below at natural height. It's rarely used,
  but it must not break.
- **Results view:** uses the same layout. The results panel (`LoadingState`,
  `ResultsSuccess`, `ResultsError`) replaces the form column; the mode switch
  is hidden while a run is loading or showing results.

### `MapPanel.jsx` sizing

- Drop `sticky top-4`, `min-h-[340px]`, and the fixed `h-[340px]`. The
  container becomes `relative h-full w-full`, and so does the inner Leaflet
  div.
- Add a `ResizeObserver` on the container that calls `map.invalidateSize()`,
  debounced with `requestAnimationFrame`. Without it, Leaflet renders gray
  tiles after window resizes and after the stack/side-by-side breakpoint
  switch. Disconnect it in the init effect's cleanup.
- The empty-state overlay text stays, centered in the larger panel.

## C2. Mode state and persistence

All of this lives in `context/ProcessingContext.jsx`.

### Shape

Advanced-only fields live in their own namespace. Fields both modes use stay
at the top level, under their current names.

```js
const defaultState = {
  mode: 'basic',              // 'basic' | 'advanced'   (persisted)
  // ...every existing field, unchanged...
  selectionRadiusKm: '',      // from spec 2
  advanced: {                 // advanced-only; filled in by later specs
    sectionsOpen: { dem: true, origin: true, tilt: true, output: false }
  }
}
```

### Shared vs. advanced-only fields

- **Shared (top level):** DEM file/path and preflight, origin mode and value,
  EPSG, target elevation, `includeDem`, `selectionRadiusKm`, `tiltAzimuth`,
  `tiltFactor`.
- **Mapping for later specs:** `tiltAzimuth` becomes Advanced's "single
  azimuth" direction, and `tiltFactor` becomes Advanced's **gradient at
  origin**. A value typed in one mode therefore appears in the other. Later
  specs must reuse these two keys and must not add duplicates.
- **Advanced-only (`formState.advanced`):** everything else those specs add
  (profile family, higher-order coefficients, hinge, direction source,
  vectors, shore points).

### Rules

1. **Switching modes changes only `mode`.** It never clears, resets, or
   rewrites any other field in either direction.
2. **`mode` and `advanced` are persisted.** They go through the existing
   carry-forward mechanism. Transient status fields stay excluded, exactly as
   today. Later specs that add transient advanced state (e.g. a fitted
   surface, a validation response) must add those keys to the exclusion list.
3. **Old saved state loads cleanly.** Saved state from before this spec lacks
   `mode` and `advanced`. `loadCarriedForwardState` must deep-merge the
   `advanced` object (defaults ← saved) instead of relying on the top-level
   spread, so new advanced keys added by later specs also get defaults when
   older saves load.
4. **Persistence must not crash the app.** Wrap `localStorage.setItem` in
   `try/catch`; shore-point tables can get large. On failure (quota), log one
   `console.warn` and continue. The in-memory state is unaffected.
5. **Add a helper for the namespace.** `updateAdvanced(patch)` merges into
   `formState.advanced` and is exposed from the context alongside
   `updateForm`.

## C3. Mode switch

`components/shared/ModeSwitch.jsx` is a two-button segmented control.

- **Markup:** real `<button>`s with `aria-pressed`, inside a `role="group"`
  labelled "Input mode". Styling follows artboard A/B: a grey track with the
  active button raised in white.
- **To the right of the switch,** a short muted caption: "Planar, linear tilt"
  in Basic, "All settings kept when switching" in Advanced.
- **Clicking a mode** calls `updateForm({ mode })`, then resets the form body's
  scroll to the top.

## C4. Basic mode (artboard A)

`components/forms/BasicForm.jsx` renders the existing step components as one
page, in four numbered sections:

1. **DEM:** `UploadStep`.
2. **Origin (spillway):** `CoordinateModeStep` and `CoordinatesStep`, plus
   `TargetElevationField`, moved here from the tilt step. The target
   elevation is determined by the origin (it's DEM-authoritative there), so
   it belongs next to the coordinates.
3. **Tilt:** azimuth and tilt factor, two per row.
4. **Output:** selection radius and include-DEM.

**Retire `StepRail`.** With a full-height column, the four sections fit with
little scrolling, and artboard A has no rail. Delete `StepRail.jsx` and remove
`STEPS` from `utils/steps.js` if nothing else uses them.

**Keep the section `id`s** (`step-upload`, `step-coordinates`, `step-tilt`,
`step-products`) so error routing keeps working:

- The Origin section wraps both coordinate components in one element with
  `id="step-coordinates"`, and drops `step-mode`.
- Update `classifyErrorStep` in `App.jsx` so the elevation-range error routes
  to `coordinates`, since that's where target elevation now lives.

The existing step components keep their logic. They may need their outer
`<section>` and heading markup lifted into the new form components so both
modes can reuse them without nested headings. Keep that refactor mechanical.

## C5. Advanced mode (artboard B), shell only

`components/forms/AdvancedForm.jsx` has four collapsible sections with the
same content as Basic, grouped the same way (DEM, Origin, Tilt model, Output),
built on one shared `components/shared/CollapsibleSection.jsx`.

- **Header:** a `<button aria-expanded aria-controls>` with the section title
  on the left and a **status line** on the right.
- **Status line:**
  - Complete: a check mark plus a short summary, e.g. the DEM file name, the
    resolved `lat, lon` in monospace, or `028° · 0.65 m/km`.
  - Incomplete: `Needs: <items>` in muted text. Take the items from
    `getReadiness`, grouped by section. Give each `missing` entry a section
    key alongside its text, e.g. `{ section: 'tilt', text: 'tilt azimuth' }`,
    and keep a string-only accessor so spec 1's footer line is unchanged.
- **Body:** mounted only when open, except the upload section, which must stay
  mounted so an in-flight preflight isn't lost. Test this: collapsing the DEM
  section mid-preflight must not cancel it.
- **Open state** lives in `formState.advanced.sectionsOpen`, so it's persisted.
  More than one section can be open at once.
- **Tilt model section:** for now it renders the same azimuth and tilt-factor
  inputs as Basic, labelled **"Single azimuth"** and **"Gradient at origin
  (m/km)"**. Add a clearly commented insertion point (a single `TiltModelBody`
  component) where the later specs add the direction-source switch, profile
  families, vectors, and shore points. Do **not** render disabled or
  "coming soon" controls.

### Error routing in Advanced

The current `resetRun(stepId)` calls `scrollToStep` after a tick, but in
Advanced the target section may be collapsed.

1. Lift a `focusRequest` value (a step id plus a counter) into
   `ProcessingPage`.
2. `BasicForm` handles it by scrolling, exactly as today.
3. `AdvancedForm` first opens the section containing that id (via
   `updateAdvanced`), then scrolls to it after the next paint.
4. Both forms keep the same `step-*` element ids, so `classifyErrorStep` is
   mode-agnostic.

## C6. Readiness and payload per mode

- **`getReadiness(formState)`** gains the section keys above. Mode doesn't
  matter yet, because both modes share the same required fields. Add the
  branch point now: `if (formState.mode === 'advanced') { /* later specs append advanced checks */ }`.
  **Advanced-only fields must never affect a Basic run's readiness.**
- **`buildProcessPayload`** (move it to `utils/payload.js` if spec 2 hasn't
  already) branches on `mode` the same way. Basic output must be identical to
  today's payload regardless of anything stored in `formState.advanced`.
  Advanced currently produces the same payload; later specs add the
  `tilt_model` field there.

---

## Files touched

- **New:** `components/shared/AppLayout.jsx`, `components/shared/ModeSwitch.jsx`,
  `components/shared/CollapsibleSection.jsx`, `components/forms/BasicForm.jsx`,
  `components/forms/AdvancedForm.jsx`.
- **Changed:**
  - `App.jsx`: layout, mode routing, `focusRequest`, `classifyErrorStep`.
  - `MapPanel.jsx`: sizing and `ResizeObserver`.
  - `ProcessingContext.jsx`: `mode`, `advanced`, `updateAdvanced`, deep-merge
    on load, safe persistence.
  - `utils/readiness.js`: section-keyed reasons, mode branch point.
  - `utils/payload.js`.
  - The step components (heading and section markup lifted out,
    `TargetElevationField` moved).
- **Removed:** `StepRail.jsx`, and `STEPS` if unused.
- **Docs:**
  - `CLAUDE.md`: a new design-decision entry covering the two modes, the
    shared-vs-`advanced` state rule and the mapping `tiltAzimuth` → single
    azimuth, `tiltFactor` → gradient at origin, "switching never clears,"
    and the `TiltModelBody` extension point. Also update the map-panel entry
    for full-height sizing.
  - `documentation/frontend-README.md`: the new structure, StepRail retired.
  - `documentation/GIA_Tool_Penpot_Spec.md`: a short note that its five-step
    rail and two-column proportions are superseded by this spec.

## Tests (Vitest)

**`ProcessingContext`**
- Switching `basic → advanced → basic` leaves every other field, including
  `advanced.*`, deep-equal to before.
- Saved state is restored with `mode` and `advanced` after a remount (a
  simulated reload).
- A legacy saved blob without `mode`/`advanced` loads with defaults, and the
  existing saved fields survive.
- A partial saved `advanced` object gets its missing keys from defaults.
- A throwing `localStorage.setItem` doesn't throw out of `updateForm`, and
  state still updates.

**`utils/payload.js`**
- Basic payload with a populated `advanced` object equals the payload without
  it.
- Advanced payload currently equals Basic's.

**`utils/readiness.js`**
- Reasons carry section keys, and the string list for the footer is unchanged
  in content.

**`CollapsibleSection`**
- `aria-expanded` toggles, the body mounts and unmounts, and the status line
  renders both states.

**`AdvancedForm`**
- A `focusRequest` for `tilt` opens a collapsed tilt section.
- The upload section stays mounted while collapsed.

**Unchanged**
- `CoordinateSteps.test.jsx` passes. Update only imports or wrappers if the
  markup lift requires it, not assertions.

`npm run build` is clean. The Python suite is untouched and stays green.

### Manual check

1. At 1920, 1440, and 1280px wide: the map fills two thirds and the full
   height, the form body scrolls while the switch and Run button stay pinned,
   and the scale bar and basemap from spec 1 still render correctly.
2. Resize the window across 1024px: the layout stacks and un-stacks, and the
   map never shows gray tiles.
3. Fill Basic completely, switch to Advanced, and check that every value is
   present in its section and the status lines show check marks. Collapse
   some sections, reload the page, and check that the mode, values, and open
   sections are all restored.
4. Trigger an elevation-range error from Advanced with the Origin section
   collapsed, then click Back: the section opens and scrolls into view.
5. Run once in each mode with the same inputs and check the outputs are
   identical.
