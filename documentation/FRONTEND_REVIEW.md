# GIA Modeling Tool — Frontend Review Notes

Working notes from a frontend walkthrough. Started as a purely visual/UI
review (hence the original filename, `UI_REVIEW.md`) but some items reach
past styling into behavior and even the API contract (e.g. item 6, dropping
two origin-input modes) — renamed to reflect that. This is a scratch list,
not a spec: items get added as they come up in conversation, then get
triaged and eventually promoted into a proper spec document (in the style of
the other `documentation/*_SPEC.md` files) once there's a coherent set to
implement.

Status values: `open` (raised, not yet discussed to a conclusion) `decided`
(agreed on what to do, not yet spec'd/implemented) `spec'd` (folded into a
spec doc — note which one) `dropped` (considered, not doing it).

---

## Items

### 1. DEM raster should be opaque by default

- **Status:** decided
- **Where:** `frontend/src/components/map/MapPanel.jsx` (`RASTER_OPACITY` constant, line ~14)
- **Issue:** A single `RASTER_OPACITY = 0.6` applies to both the input-preview
  raster and the tilted-result raster. Users can't clearly see the DEM change
  after running a tilt simulation because it's blended with the basemap.
- **Decision:** Default to fully opaque (1.0). The basemap still provides
  context in the area *surrounding* the DEM extent. Layer opacity/contour-color
  toggles are a reasonable future feature but out of scope for now — don't
  build a layers-control UI just for this.

### 2. Per-field validated/invalid visual indicators, consistently applied

- **Status:** open
- **Where:** `UploadStep.jsx` (has one), `CoordinateSteps.jsx`,
  `TiltAndProductsSteps.jsx`, `advanced/fields.jsx::NumberField`
- **Issue:** The green border on a successfully-preflighted DEM
  (`UploadStep.jsx`, `border-green-300`) is a one-off — no other field has an
  equivalent "this is valid" treatment. `NumberField` already computes an
  `invalid` flag but only renders an error state, never a positive one.
  Origin already tracks `resolveOriginStatus` / `elevationCheckStatus`
  (resolved/checking/error) but doesn't surface it visually beyond text.
- **Discussion:** Needs a defined idle → checking → valid → invalid state
  set that every field type can express, not just upload. Async fields
  (origin) and pure client-side fields (tilt, selection radius, numeric
  fields in general) will need different triggers for "valid" but should
  look the same once they get there.

### 3. No shared input/label/help typography — build one field primitive

- **Status:** open
- **Where:** Every step/section file rolls its own markup: `CoordinateSteps.jsx`,
  `TiltAndProductsSteps.jsx`, `advanced/fields.jsx::NumberField`,
  `UploadStep.jsx`'s typed-path input
- **Issue:** No shared input component exists, so styling drifted per-file:
  - Origin (`CoordinatesStep`) and target elevation (`TargetElevationField`):
    bare `<input className="w-full">`, no text classes → browser-default size
    and color (reads larger/darker than everything else).
  - Tilt (`TiltInputs`): input nested inside
    `<label className="block text-xs text-gray-500">` with no override, so it
    inherits the label's small gray styling — identical to the help text
    below it.
  - Selection radius (`ProductsStep`): same label-wraps-input pattern but
    `text-sm text-gray-600` — different from Tilt for no functional reason.
  - Advanced's `NumberField` (tilt-model body, vector table): same pattern as
    Tilt (`text-xs text-gray-500`).
- **Discussion:** Font-size/color patching file-by-file would just move the
  inconsistency around. Recommendation: one shared field primitive (label
  style, input style — visible border/padding/focus ring, readable
  near-black text — and help style, all distinct from each other) used
  everywhere, replacing the ad hoc per-file markup. Pairs naturally with
  item 2's valid/invalid states. Also a chance to cut redundant help text
  now that fields will visually read as fields.
- **Also covers:** the DEM-derived target-elevation field (`TargetElevationField`,
  `elevationCheckStatus === 'dem'` case) renders a disabled input showing a
  bare number with no persistent label — just a small sentence below it
  ("245 m — from DEM at origin") that's easy to miss. Same root cause: no
  shared field primitive that always shows a label, including in
  disabled/derived states.

### 4. No feedback while origin is resolving

- **Status:** open
- **Where:** `CoordinateSteps.jsx` (`handleBlur` → `checkElevation()` +
  `checkResolvedOrigin()`)
- **Issue:** Two async calls fire on blur after entering a coordinate.
  `checkElevation`'s "checking" message renders in `TargetElevationField`, a
  different section than the field the user just typed in.
  `checkResolvedOrigin` (drives the map's origin marker/azimuth line) has no
  visual feedback at all — it silently updates state until the marker
  appears on the map. Net effect: typing a coordinate and tabbing away looks
  like nothing happened.
- **Discussion:** Attach a status indicator (spinner/text) directly to the
  coordinate input itself rather than relying on a message in an unrelated
  section below. Ties into item 2 (valid/invalid/checking states) — this is
  the "checking" state for the origin field specifically.

### 5. Click-to-place origin on the map, then edit values

- **Status:** open
- **Where:** `MapPanel.jsx`'s `editing` prop (currently vectors-only),
  `App.jsx` (wires `editing` in), `VectorTable.jsx` ("Add on map" button)
- **Issue/request:** Origin currently has no map-click input path — only
  typed coordinates. Vectors mode already has the exact pattern wanted:
  `editing.mode`, `onAddVector`/`onUpdateVector`/`onSelectVector`/
  `onExitAddMode`, toggled by an "Add on map" button, callbacks wired in
  `App.jsx`. Origin would reuse the same shape (`mode: 'addOrigin'`,
  `onSetOrigin({lon, lat})`), simpler than vectors since it's one point, not
  a table.
- **Decision:** map-click always resolves to decimal-degrees lon/lat and
  writes straight into the (now sole) coordinate field — no CRS conversion
  needed. Resolved by item 6 below.

### 6. Drop `match_raster` / `epsg` origin modes — decimal degrees only

- **Status:** decided
- **Where:** Frontend: `CoordinateSteps.jsx` (`MODE_CONFIG`, `CoordinateModeStep`
  mode `<select>`), `ProcessingContext.jsx`/`utils/readiness.js` (`originMode`,
  `originEpsg`). API/backend: `api/crs.py` (`normalize_origin_to_wgs84`,
  `parse_xy_pair`, `parse_decimal_degrees_hemisphere`), `api/main.py`'s
  origin-mode handling, `documentation/api-README.md`. Also a documented
  **Key design decision** in `CLAUDE.md` ("Origin coordinate input supports
  three explicit modes... rather than one ambiguous format") that this
  supersedes.
- **Decision:** since every non-geographic input raster is already
  reprojected to EPSG:4326 server-side (`ensure_wgs84_raster`), there's no
  real case left for entering the origin in the raster's native CRS
  (`match_raster`) or an arbitrary EPSG (`epsg`) — decimal degrees always
  works and is one less ambiguous format for users to reason about. Going
  forward: **all coordinate input is decimal degrees**, full stop. This
  simplifies item 5's map-click feature too (no client-side CRS reprojection
  needed — a click always gives usable lon/lat).
- **Scope note:** this is bigger than a frontend tweak — it removes an
  API-level input mode and a documented design decision, not just a UI
  affordance. When this gets spec'd, it should cover: removing
  `origin_mode`/`origin_epsg` from the request contract (or leaving them
  server-side-accepted-but-undocumented vs. hard removal — worth deciding
  explicitly), updating/removing the affected tests, and updating `CLAUDE.md`
  and `api-README.md` to match. The 500m geodesic CRS-mismatch guard stays
  either way — it's independent of which origin modes are offered.

### 7. Global Profile section: visual clutter + misleading empty-state box

- **Status:** open
- **Where:** `advanced/TiltModelBody.jsx` (Global Profile fields), `advanced/ProfileChart.jsx`
- **Issue:** Mostly a concentrated instance of item 3 (no shared field
  primitive) plus a specific bad pattern:
  - Every label in the section (`Profile family`, `Hinge behind spillway`,
    plus every `NumberField`) uses the same `text-xs text-gray-500`, and five
    separate `<Help>` blocks (gradient/rate/second-gradient/hinge/polynomial
    help text) sit inline at the same muted styling — labels, inputs, and
    explanations all blend together.
  - The "Uplift preview" chart's empty/loading/error state
    (`ProfileChart.jsx:188`) is styled as `border-dashed border-gray-300` —
    visually indistinguishable from `UploadStep.jsx`'s actual drag-and-drop
    file zone, but it's just a status placeholder ("Fill in the tilt
    parameters to preview the profile" / "Updating preview..." / an error
    string). The same dashed-box-as-placeholder pattern is reused verbatim in
    `VectorFitSummary.jsx`, `VectorTable.jsx`, and `ShorePointsPanel.jsx` —
    so it's a systemic pattern, not a one-off.
- **Discussion:** Resolving item 3 (shared field primitive) fixes the
  label/input/help blending here directly. The dashed-box placeholder needs
  its own fix regardless — give status/empty states their own non-dropzone
  treatment (e.g. plain muted text block, no dashed border) so nothing in the
  form ever visually implies "drop a file here" except the one place that
  actually is one.

### 8. Replace text-based "what's missing" with per-field color states; reduce footer text

- **Status:** decided
- **Where:** `App.jsx` (footer "Still needed: {missingText.join(', ')}",
  line ~261), `utils/readiness.js`, plus every field this would touch
- **Issue/request:** The current "what do I still need to fill in" signal is
  a plain-text comma list in the footer below the Run button, echoed by the
  dashed-box placeholders (item 7) saying things like "Fill in the tilt
  parameters to preview the profile." Both are text-only and pile up
  underneath the button, reading as clutter rather than guidance.
- **Direction:** extend item 2's per-field valid/invalid states with a third,
  distinct "still needed" state — a colored outline (like the existing green
  `border-green-300` for a completed DEM upload) on fields/sections that are
  required but still empty. Once every required field carries this signal
  directly, the footer's comma-separated `missingText` list becomes
  redundant for anything already visible on screen — it can shrink
  significantly or go away, rather than duplicating what the fields
  themselves now show.
- **Color choice: blue.** Agreed not to reuse red for "still needed" —
  `NumberField` already uses red (`border-red-400`) for a genuinely
  invalid/unparseable value, and an untouched-but-required field turning red
  would read as an error before the user's done anything wrong. Four-state
  palette: gray/default (untouched, optional) → **blue** (required, still
  empty) → green (valid) → red (invalid value).

<!--
Entry template:

### N. Short title

- **Status:** open
- **Where:** component/page
- **Issue:** what's wrong or missing
- **Discussion:** notes from back-and-forth, tradeoffs considered
- **Decision:** what we're doing about it (once decided)
-->
