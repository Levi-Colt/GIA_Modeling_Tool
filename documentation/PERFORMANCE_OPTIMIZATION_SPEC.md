# GIA Modeling Tool — Performance Optimization Spec

Companion to `GIA_Tool_Penpot_Spec.md` and `VISUALIZATION_PIPELINE_SPEC.md`.
Triggered by a real 13-minute run on a 10,812×10,812 (1°×1°, 10m) USGS DEM
that should have taken well under a minute. Diagnosed against the actual
input/output files, not guessed — see "How this was diagnosed" at the
bottom for the numbers behind every claim here.

## The core problem: `calculate_tilt`'s real memory cost is invisible

`raster_io_check` estimates peak RAM from the raw array + its float32 cast
only (`peak_ram_mb` in `/api/preflight`'s response). It has no visibility
into what `calculate_tilt` itself allocates. For the diagnosed file, that
estimate said 445.94 MB; `calculate_tilt`'s actual peak, measured directly,
is several GB — because it builds 7-8 full-size float64 arrays (`rows`,
`cols`, `lons`, `lats`, `forward_azimuth`, `distance_meters`,
`angle_diff`/`projected_distance_km`/`elevation_delta`) for the entire
raster at once, before `pyproj`'s `Geod.inv()` even runs its own
per-pixel ellipsoidal solve on top of that.

This is why the file routed to the "safe for in-memory" branch and still
took 13 minutes: the routing decision itself was made from an incomplete
cost model. Reproducing `calculate_tilt` on the same file in a
same-available-RAM environment gets it OOM-killed outright; on a real
machine with a pagefile, the likely outcome is severe disk-swapping
instead of a crash — which is consistent with a 10-100x slowdown over
what the computation should cost.

## Fix 1 — Rewrite `calculate_tilt`'s coordinate/distance math

Three changes, bundled (they compound, don't ship independently):

**a. Stop building full 2D coordinate grids.** For any non-rotated
(north-up) transform — `transform.b == transform.d == 0`, true for
virtually every real-world GeoTIFF including the diagnosed one — longitude
depends only on column and latitude depends only on row. Replace
`np.indices` + `rasterio.transform.xy` on the full grid with two 1D arrays
(`lons_1d` of length `width`, `lats_1d` of length `height`), built directly
from the affine transform. Only broadcast into 2D where the math actually
requires it (the final distance/projection step), not before.

**b. Replace the per-pixel ellipsoidal geodesic call with a locally-
calibrated flat-plane approximation.** Call `Geod.inv()` a small, fixed
number of times (not once per pixel) to get accurate meters-per-degree
scale factors on the real WGS84 ellipsoid at specific calibration points,
then use plain vectorized trig (`east_km`, `north_km`, dot product against
the tilt azimuth's unit vector) for every pixel. Measured on the real file:
**16.4s → 0.11s** on a 4000×4000 crop, max deviation from the true
per-pixel geodesic answer **9mm** across 16 million pixels (mean 1.6mm) —
two orders of magnitude below this DEM's own vertical RMSE, and negligible
against the model's own linear-planar simplification of GIA.

**c. Adaptive recalibration for large extents (per your proposal).**
Single-point calibration is only valid near that point; error grows
roughly with the square of distance from it. Rather than hardcode "large
enough to matter," compute it:

- **At preflight** (`/api/preflight`, cheap — one more `Geod.inv()` call,
  same pattern already used for `bounds_wgs84`): compute the raster's
  corner-to-corner diagonal distance in km. Return it alongside the
  existing preflight fields (`diagonal_km`).
- **Pass `diagonal_km` through to `calculate_tilt`** (via `process_dem` /
  `backend/app.py`, which already threads origin/azimuth/tilt_factor
  through the same way).
- **Inside `calculate_tilt`:** if `diagonal_km` is below
  `RECALIBRATION_THRESHOLD_KM` (start at **100km** — derived from the
  measured 9mm-at-44km data point, solved for where error crosses ~5cm;
  re-validate against a real large-extent DEM during implementation rather
  than trusting the extrapolation blind), use the single-calibration-point
  approach from (b) unchanged — this covers the diagnosed file (and
  presumably most single-DEM-tile inputs) with room to spare, at zero
  added cost.
- **Above the threshold:** bucket pixels into concentric distance-bands
  from the origin (band width = the same threshold constant), using the
  already-computed flat-plane distance for bucketing — it doesn't need to
  be exact for this, since adjacent bands' calibration factors are nearly
  identical near a boundary, so a mis-bucketed edge pixel is not a visible
  error. For each band, call `Geod.inv()` once more (at a representative
  point — e.g. along the tilt-azimuth ray at the band's midpoint distance)
  to get that band's local scale factors, and apply them via
  `np.digitize` + indexed assignment or `np.select`. Still O(bands), not
  O(pixels) — cheap regardless of how large the extent gets.
- Note for the record: `pyproj`'s azimuthal-equidistant projection
  (`+proj=aeqd`, centered on the origin) was tested as a globally-exact
  alternative — it matches the true per-pixel geodesic answer to
  floating-point noise at any distance, confirming (b)'s calibration
  target is correct. But applied per-pixel it's no faster than the
  ellipsoidal `Geod.inv()` call this spec is replacing (12.37s on the same
  4000×4000 crop) — it's the right tool for occasional calibration points,
  not for the pixel grid itself. Don't reach for it as a full-grid
  drop-in.

**Chunk internally regardless of extent size.** Process `calculate_tilt`
in row-strips (a `chunk_rows` parameter, not a new public API — internal
to the function) so peak memory is a small, predictable multiple of
`chunk_rows × width`, never the full raster, independent of whichever
calibration path above is taken. Measured on the full 10,812×10,812 file
with `chunk_rows=1024`: **1.4 seconds**, **~1.3GB peak RSS for the whole
load+tilt sequence** (previously: OOM in an equivalent-RAM environment).

## Fix 2 — Adaptive tile sizing for the windowed pipeline (per your request)

`tilt_DEM_windowed`, `extract_strandline_contours_windowed`, and
`write_dem_to_gpkg_windowed` all currently default `tile_size` to a fixed
constant (512, 512, 1024 respectively) — the exact ArcGIS-style pattern
you were trying to avoid, just with a bigger fixed number. Once Fix 1
lands, this matters less than it used to (see "Why this fix matters less
now" below) but is still real for genuinely huge files.

Replace the fixed defaults with a sizing function, computed once in (or
alongside) `raster_io_check`:

```
largest_safe_tile_size(width, height, band_count, dtype,
                        available_ram_mb, safe_fraction=0.60)
```

- Uses a per-pixel memory-cost constant for whichever operation it's
  sizing for (tilt, contour, gpkg-write) — each has a different number of
  live intermediate arrays per pixel now that Fix 1's chunking exists as
  the reference implementation. **Measure these empirically during
  implementation** (the same way this spec's own numbers were measured —
  run each windowed function against a real large file at a few tile
  sizes and fit the constant) rather than guessing from first principles;
  document whatever constant gets used, with the measurement that
  produced it, right next to where it's defined.
- Solves for the largest `tile_size` such that
  `tile_size × width × per_pixel_cost ≤ available_ram_mb × safe_fraction`,
  capped at `min(width, height)` — i.e. if the whole raster fits in one
  "tile" under that budget, it degenerates to a single pass, no windowing
  subdivision at all. This is the "largest possible tile, fewest tiles
  necessary" behavior you asked for, expressed as one continuous sizing
  function rather than a binary in-memory/windowed switch.
- Threaded through to all three windowed functions' `tile_size` parameter
  (replacing their individual hardcoded defaults), and to `calculate_tilt`'s
  internal `chunk_rows` from Fix 1 — one sizing decision, reused
  everywhere a tile/chunk dimension is needed, rather than three
  independently-guessed constants.

**Why this fix matters less now than it looked like it would:** most of
what made the windowed pipeline feel ArcGIS-like was `calculate_tilt`'s
hidden memory blowup forcing bigger files toward the windowed path (or
making the in-memory path slow even when correctly routed there) — not
the windowed path's own tile size choice. With Fix 1 landed,
`raster_io_check`'s existing estimate (raw array + cast, ignoring
`calculate_tilt`) becomes *accurate* again, since the biggest previously-
hidden cost is gone. Expect most realistic files — even ones noticeably
bigger than the diagnosed 460MB one — to route to the in-memory branch
correctly and quickly, with the windowed path now reserved for genuinely
huge files where the raw array itself doesn't fit in memory. Fix 2 is
still worth doing (that case is real and deserves better than a fixed
512px default), just not the load-bearing fix it looked like before Fix 1
was diagnosed.

## Fix 3 — Small, independent wins found during diagnosis

Not related to `calculate_tilt`, worth doing in the same pass since
they're cheap and already measured:

- **`/api/process`'s zip bundling** (`VISUALIZATION_PIPELINE_SPEC.md`
  Stage 3) uses `zipfile.ZIP_DEFLATED`. Measured on the diagnosed file's
  actual 440MB output: **19.25s** to compress, for a **5% size reduction**
  (440MB → 416MB) — elevation rasters and WKB geometry don't compress well.
  Switch to `zipfile.ZIP_STORED` (no compression); recovers nearly all of
  that 19s for negligible size cost.
- **NAD83 vs. WGS84 reprojection.** `ensure_wgs84_raster` requires the
  input CRS to be *exactly* `EPSG:4326`; the diagnosed file was
  `EPSG:4269` (NAD83), which triggered a full bilinear reprojection of the
  entire raster (measured: **15.2s**) that happens silently before
  `backend/app.py`'s own logging starts, invisible in the terminal output
  a user actually sees. NAD83 and WGS84 agree to roughly a meter — well
  under this DEM's own vertical precision. Worth relaxing the check to
  treat any unprojected geographic CRS as close enough, skipping the
  reprojection (and its resample-induced smoothing) entirely for this
  common case. Flagging as a decision worth your sign-off rather than a
  silent change, same reasoning as the flat-plane trade-off above — it's
  a real (if small) precision choice, not just a performance one.
- **Contour fragment/vertex cleanup.** The diagnosed output has 2,424
  separate contour features totaling ~619,000 vertices, with lengths
  ranging from ~0.2m up to ~750km — the bottom end matches what you
  described as the abandoned nodata-boundary-artifact fix (the commented-
  out `if len(contour) < 10: skip` line in `extract_strandline_contours`).
  Two independent things worth doing here, not mutually exclusive:
  - A **minimum-length or minimum-vertex-count filter** to drop nodata-
    boundary artifacts, revisiting the abandoned approach now that its
    likely cause is understood (nodata cells get filled with an extreme
    sentinel value before contouring, which traces a false boundary
    wherever that cliff crosses the target elevation).
  - **Simplification** (e.g. `shapely.simplify(tolerance)`) on the
    legitimate remaining contours, both for smaller `.gpkg` output and
    because Stage 3 of the visualization pipeline serializes this same
    geometry to GeoJSON and renders it in Leaflet — vertex count there
    isn't just a backend cost, it's a browser one too.
  - Not performance-blocking on its own (contour extraction itself was
    measured cheap — ~3s at full scale, this is a data-quality issue, not
    a speed one) but grouped here since it surfaced during the same
    diagnosis and touches the same code path.

## Explicitly out of scope for this pass

- The two new modeling features (non-linear tilt-factor functions,
  multi-directional tilt with per-region azimuth/extent) — separate design
  pass, per your own sequencing. Worth noting `calculate_tilt`'s rewrite
  here (separable 1D coordinates, calibrated flat-plane math, internal
  chunking) is a reasonable foundation for multi-directional tilt to build
  on, once that gets scoped — it's already structured around per-pixel
  distance/bearing-from-an-origin, which is the same primitive a
  multi-region version would need per region.
- Re-tuning `PREVIEW_MAX_DIM` against a real CryoCloud pod — already an
  open item from the visualization pipeline spec, unrelated to this one.

## How this was diagnosed

Against the real files you uploaded (`USGS_13_n42w074_20241010.tif`,
10,812×10,812, `EPSG:4269`, and the `.gpkg` it produced): confirmed via
your terminal log that the run used the in-memory (not windowed) branch;
timed each pipeline stage in isolation (`load_DEM` ~10.5s,
`ensure_wgs84_raster` reprojection ~15.2s, `calculate_tilt` extrapolated
~100s+ under memory pressure, `extract_strandline_contours` ~3s,
`write_dem_to_gpkg`+`gdf.to_file` ~10s, zip compression ~19s — summing to
roughly 2.5-3 minutes under clean conditions, well short of the observed
13, with `calculate_tilt`'s real memory footprint under a
similarly-constrained-RAM environment (reproduced OOM-kill) the best-
evidenced explanation for the gap); read the contour layer directly
(2,424 features, ~619,000 vertices) to check the nodata-artifact
hypothesis; and built + benchmarked the Fix 1 prototype against the same
real file to confirm both the speed claim (1.4s at full scale) and the
accuracy claim (9mm max deviation from the true geodesic answer) before
writing any of this down.
