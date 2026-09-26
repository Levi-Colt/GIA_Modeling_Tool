"""
Vector direction fields: a spatially varying uplift model built from user
vectors (documentation/VECTOR_FIELD_SPEC.md, spec 5).

Each vector is a location plus an azimuth (the direction of maximum uplift
there) and an optional *range of influence* (how far its direction is trusted;
not a magnitude). The model blends the vectors' unit directions into a smooth
field v(x) on a small regular grid, solves in least squares for a curved
distance coordinate phi with grad(phi) ~ v (its contours are the isobases), and
turns phi into uplift U either through the global profile (Case A, every vector
uses it) or by integrating a blended gradient field (Case B, some vector has a
custom tilt).

Everything is done in `backend.main`'s local frame (`_local_en_km`, east/north
km from the origin) -- never a second projection -- and the result is a
`GridUpliftModel`: `evaluate(east_km, north_km)` bilinearly samples a grid,
so per-block work is elementwise and the windowed and in-memory pipelines agree.

Case A deviates from the spec's "U precomputed on the grid" deliberately: the
grid holds phi and the (cheap, exact) profile is applied per pixel after
sampling. Sampling U instead smears the hinge kink and the profile's curvature
by O(h) / O(h^2) relative to the grid, which no tolerance worth asserting could
hide; sampling phi is exact whenever phi is (a uniform field gives a linear phi).

Pure numpy/scipy/skimage/pyproj: no FastAPI or Pydantic (validation lives in
api/tilt_model.py, which hands this module plain dicts).
"""
import math
import warnings
from dataclasses import dataclass

import numpy as np
import rasterio.transform
import scipy.sparse as sp
import scipy.sparse.linalg as spla
from pyproj import Geod
from scipy.ndimage import map_coordinates
from skimage.measure import find_contours

from backend.main import _local_en_km, _local_en_to_lonlat, _raster_diagonal_km
from backend.uplift import HINGE_MODES, DEFAULT_HINGE_MODE, PolynomialProfile, _profile_from_spec

GRID_CELLS = 255            # cells on the long side => at most 256 nodes
GRID_PADDING = 0.05         # each side, fraction of the DEM's frame extent
TAPER_FLOOR = 1e-6          # keeps the field defined far from every vector
DEGENERATE_RATIO = 0.05     # |V| / sum(w) below this => near-opposite vectors
DEGENERATE_WARN_FRACTION = 0.01
MISFIT_WARN_DEG = 15.0
COVERAGE_MARGIN = 0.5       # of the DEM's frame diagonal
MAX_ISOBASE_LEVELS = 12


@dataclass(frozen=True)
class Vector:
    lon: float
    lat: float
    azimuth_deg: float
    range_km: float | None = None
    # None = uses the global profile, else
    # {"family": "linear" | "quadratic", "local_gradient": g, "rate_of_increase": k | None}
    custom: dict | None = None


@dataclass(frozen=True, eq=False)
class GridUpliftModel:
    """
    Uplift sampled from a regular frame grid (row index increases northward).

    `profile is None`: `values` is U itself (Case B) and `evaluate` returns the
    bilinear sample. `profile` given: `values` is phi (Case A) and `evaluate`
    returns `profile.U(max(phi, hinge_d))`.
    """
    e0: float               # frame km of the south-west node
    n0: float
    h: float                # node spacing, km
    values: np.ndarray      # (rows, cols)
    profile: PolynomialProfile | None = None
    hinge_d: float | None = None
    hinge_source: str | None = None

    @property
    def extra_bytes_per_pixel(self):
        # Two float64 coordinate arrays + the sampled output = 24 B; Case A adds
        # the hinge clamp copy (8) and the profile's temporaries (0 linear, 16
        # otherwise). Estimated, not profiled -- see backend/app.py's notes.
        if self.profile is None:
            return 24
        return 24 + 8 + (0 if len(self.profile.coeffs) == 1 else 16)

    def evaluate(self, east_km, north_km):
        east, north = np.broadcast_arrays(east_km, north_km)
        sampled = _sample(self.values, self.e0, self.n0, self.h, east, north)
        if self.profile is None:
            return sampled
        if self.hinge_d is not None:
            sampled = np.maximum(sampled, self.hinge_d)
        return self.profile.U(sampled)


def _sample(grid, e0, n0, h, east, north):
    """Bilinear sample of a frame grid; positions outside it clamp to the edge."""
    coords = np.stack([(north - n0) / h, (east - e0) / h])
    return map_coordinates(grid, coords, order=1, mode="nearest")


def _resolve_hinge(profile, hinge):
    """(d_h, source) for the global hinge, with the zero-gradient guard when a
    global profile exists; from the mode alone when every vector is custom."""
    hinge = hinge or {}
    mode = hinge.get("mode") or DEFAULT_HINGE_MODE
    distance_km = hinge.get("distance_km")
    if profile is not None:
        return profile.resolve_hinge(mode, distance_km)
    if mode == "origin":
        return 0.0, "mode"
    if mode == "distance":
        if distance_km is None or not np.isfinite(distance_km) or distance_km <= 0:
            raise ValueError("A 'distance' hinge requires distance_km > 0 and finite.")
        return -float(distance_km), "mode"
    if mode == "none":
        return None, None
    raise ValueError(f"Unknown hinge mode '{mode}'. Expected one of {HINGE_MODES}.")


def _make_solver(ny, nx, h, pin_row, pin_col):
    """
    Least-squares integrator on the node grid: given a vector field (fx, fy) at
    the nodes, returns the grid F minimizing the misfit of the forward
    differences (F[r, c+1] - F[r, c]) / h to the edge-midpoint average of fx
    (and likewise vertical, fy), with F at the pin node fixed to 0. The normal
    matrix depends only on the grid, so it is factorised once and reused for
    both passes.
    """
    def diff(n):
        return sp.diags([-np.ones(n - 1), np.ones(n - 1)], [0, 1], shape=(n - 1, n), format="csr")

    dx = sp.kron(sp.identity(ny), diff(nx), format="csr")
    dy = sp.kron(diff(ny), sp.identity(nx), format="csr")
    normal = (dx.T @ dx + dy.T @ dy).tocsr()

    pin = pin_row * nx + pin_col
    keep = np.ones(ny * nx)
    keep[pin] = 0.0
    mask = sp.diags(keep)
    normal = (mask @ normal @ mask + sp.diags(1.0 - keep)).tocsc()
    lu = spla.splu(normal)

    def integrate(fx, fy):
        bx = h * 0.5 * (fx[:, :-1] + fx[:, 1:])   # horizontal edge midpoints (ny, nx-1)
        by = h * 0.5 * (fy[:-1, :] + fy[1:, :])   # vertical edge midpoints (ny-1, nx)
        rhs = dx.T @ bx.ravel() + dy.T @ by.ravel()
        rhs[pin] = 0.0
        return lu.solve(rhs).reshape(ny, nx)

    return integrate


def _resolve_ranges(vectors_en, given, frame_diag_km):
    """R_i: the given range, else the median nearest-neighbour distance between
    vectors (0.5 x the DEM's frame diagonal for one vector, or when vectors
    coincide so that median is 0)."""
    fallback = 0.5 * frame_diag_km
    default = fallback
    n = len(vectors_en)
    if n > 1:
        d = np.hypot(vectors_en[:, 0, None] - vectors_en[None, :, 0],
                     vectors_en[:, 1, None] - vectors_en[None, :, 1])
        np.fill_diagonal(d, np.inf)
        median = float(np.median(d.min(axis=1)))
        if median > 0:
            default = median
    return np.array([default if r is None else float(r) for r in given])


def build_vector_uplift_model(vectors, origin_coords, raster_transform, raster_shape,
                              global_profile, hinge=None, grid_cells=GRID_CELLS):
    """
    Builds (GridUpliftModel, diagnostics) from `Vector`s, in the local frame of
    the raster described by (raster_transform, raster_shape).

    global_profile: PolynomialProfile or None (None only when every vector has a
    custom tilt). hinge: {"mode", "distance_km"} or None ('origin'); resolved
    exactly as PlanarUpliftModel does when a global profile exists.

    diagnostics: misfit_deg (per vector, None when the vector lies outside the
    grid), misfit_rms_deg / misfit_max_deg / worst_vector (0-based; None when no
    vector could be measured), degenerate_fraction, ranges_km, case ('A' | 'B'),
    hinge_km / hinge_source, phi_grid, and grid {e0, n0, h, nx, ny,
    diagonal_km, origin} (what the isobase generator needs).

    UserWarnings: near-opposite directions over >1% of the area, a worst misfit
    above 15 degrees, and a vector far outside the DEM.
    """
    vectors = list(vectors)
    if not vectors:
        raise ValueError("At least one vector is required.")
    if any(v.custom is None for v in vectors) and global_profile is None:
        raise ValueError("A global profile is required because a vector uses it.")
    for v in vectors:
        if not all(np.isfinite(x) for x in (v.lon, v.lat, v.azimuth_deg)):
            raise ValueError("Vector lon, lat and azimuth must be finite numbers.")
        if v.range_km is not None and not (np.isfinite(v.range_km) and v.range_km > 0):
            raise ValueError("A vector's range_km must be finite and > 0.")

    geod = Geod(ellps="WGS84")
    height, width = raster_shape
    left, bottom, right, top = rasterio.transform.array_bounds(height, width, raster_transform)
    diagonal_km = _raster_diagonal_km(raster_transform, raster_shape, geod=geod)

    def to_frame(lons, lats):
        return _local_en_km(np.asarray(lons, dtype="float64"), np.asarray(lats, dtype="float64"),
                            origin_coords, diagonal_km, geod)

    # --- The DEM's frame bounding box and the working grid ---
    ce, cn = to_frame([left, right, left, right], [bottom, bottom, top, top])
    e_min, e_max, n_min, n_max = float(ce.min()), float(ce.max()), float(cn.min()), float(cn.max())
    dem_w, dem_h = e_max - e_min, n_max - n_min
    frame_diag = math.hypot(dem_w, dem_h)
    pad_e, pad_n = GRID_PADDING * dem_w, GRID_PADDING * dem_h
    g_e_min, g_n_min = e_min - pad_e, n_min - pad_n
    g_w, g_h = dem_w + 2 * pad_e, dem_h + 2 * pad_n
    h = max(g_w, g_h) / grid_cells
    nx, ny = int(math.ceil(g_w / h)) + 1, int(math.ceil(g_h / h)) + 1
    e0, n0 = g_e_min, g_n_min
    node_e = e0 + h * np.arange(nx)
    node_n = n0 + h * np.arange(ny)
    grid_e, grid_n = np.meshgrid(node_e, node_n)      # (ny, nx); row index = northward

    # --- Step 1: vectors into the frame (position, unit direction, range) ---
    lons = np.array([v.lon for v in vectors], dtype="float64")
    lats = np.array([v.lat for v in vectors], dtype="float64")
    azs = np.array([v.azimuth_deg for v in vectors], dtype="float64")
    ve, vn = to_frame(lons, lats)
    # Mapping the point 1 km along the azimuth (not the raw bearing) folds the
    # frame's own scale distortion away from the origin into the direction.
    lon2, lat2, _ = geod.fwd(lons, lats, azs, np.full(len(vectors), 1000.0))
    te, tn = to_frame(lon2, lat2)
    dir_e, dir_n = te - ve, tn - vn
    norm = np.hypot(dir_e, dir_n)
    dir_e, dir_n = dir_e / norm, dir_n / norm
    positions = np.column_stack([ve, vn])
    ranges = _resolve_ranges(positions, [v.range_km for v in vectors], frame_diag)

    # Coverage: a vector far outside the DEM is probably a typo (it still counts).
    margin = COVERAGE_MARGIN * frame_diag
    for i in range(len(vectors)):
        if not (e_min - margin <= ve[i] <= e_max + margin and n_min - margin <= vn[i] <= n_max + margin):
            warnings.warn(
                f"Vector {i + 1} lies far outside the DEM (more than half the DEM's diagonal "
                "beyond its bounds); check its latitude and longitude.",
                UserWarning,
            )

    # --- Step 3: direction field at the nodes ---
    def weights(i):
        r2 = (grid_e - ve[i]) ** 2 + (grid_n - vn[i]) ** 2
        taper = np.maximum(np.exp(-r2 / ranges[i] ** 2), TAPER_FLOOR)
        return taper / (r2 + h * h), r2

    sum_w = np.zeros((ny, nx))
    sum_e = np.zeros((ny, nx))
    sum_n = np.zeros((ny, nx))
    best_r2 = np.full((ny, nx), np.inf)
    nearest = np.zeros((ny, nx), dtype=int)
    for i in range(len(vectors)):
        w, r2 = weights(i)
        sum_w += w
        sum_e += w * dir_e[i]
        sum_n += w * dir_n[i]
        closer = r2 < best_r2
        best_r2 = np.where(closer, r2, best_r2)
        nearest = np.where(closer, i, nearest)
    mag = np.hypot(sum_e, sum_n)
    degenerate = mag / sum_w < DEGENERATE_RATIO
    safe_mag = np.where(degenerate, 1.0, mag)
    field_e = np.where(degenerate, dir_e[nearest], sum_e / safe_mag)
    field_n = np.where(degenerate, dir_n[nearest], sum_n / safe_mag)
    degenerate_fraction = float(degenerate.mean())
    if degenerate_fraction > DEGENERATE_WARN_FRACTION:
        warnings.warn(
            f"Vectors disagree strongly (near-opposite directions) over "
            f"{100 * degenerate_fraction:.0f}% of the area; isobases there are unreliable.",
            UserWarning,
        )

    # --- Step 4: phi, then anchor phi(origin) = 0 exactly ---
    pin_col = int(np.clip(round(-e0 / h), 0, nx - 1))
    pin_row = int(np.clip(round(-n0 / h), 0, ny - 1))
    integrate = _make_solver(ny, nx, h, pin_row, pin_col)

    def origin_value(grid):
        return float(_sample(grid, e0, n0, h, np.zeros(1), np.zeros(1))[0])

    phi = integrate(field_e, field_n)
    phi = phi - origin_value(phi)

    # --- Step 6 (diagnostics): direction misfit at each vector ---
    inside = ((ve >= e0) & (ve <= e0 + (nx - 1) * h) & (vn >= n0) & (vn <= n0 + (ny - 1) * h))
    d_phi_e = (_sample(phi, e0, n0, h, ve + h, vn) - _sample(phi, e0, n0, h, ve - h, vn)) / (2 * h)
    d_phi_n = (_sample(phi, e0, n0, h, ve, vn + h) - _sample(phi, e0, n0, h, ve, vn - h)) / (2 * h)
    grad_norm = np.hypot(d_phi_e, d_phi_n)
    with np.errstate(invalid="ignore", divide="ignore"):
        cos = np.clip((d_phi_e * dir_e + d_phi_n * dir_n) / grad_norm, -1.0, 1.0)
    misfit = np.where(grad_norm > 0, np.degrees(np.arccos(cos)), 180.0)
    measured = [i for i in range(len(vectors)) if inside[i]]
    misfit_list = [float(misfit[i]) if inside[i] else None for i in range(len(vectors))]
    if measured:
        m = misfit[measured]
        rms, worst_val = float(np.sqrt(np.mean(m ** 2))), float(m.max())
        worst = int(measured[int(np.argmax(m))])
    else:
        rms = worst_val = worst = None
    if worst_val is not None and worst_val > MISFIT_WARN_DEG:
        warnings.warn(
            f"Vector {worst + 1}'s direction is off by {worst_val:.0f} degrees in the fitted surface "
            "(the vectors cannot all be honored by a smooth surface); check its azimuth against "
            "its neighbours.",
            UserWarning,
        )

    # --- Step 5: uplift ---
    hinge_d, hinge_source = _resolve_hinge(global_profile, hinge)
    all_global = all(v.custom is None for v in vectors)
    if all_global:
        case = "A"
        model = GridUpliftModel(e0=e0, n0=n0, h=h, values=phi, profile=global_profile,
                                hinge_d=hinge_d, hinge_source=hinge_source)
        hinge_km = hinge_d
    else:
        case = "B"
        phi_at_vector = _sample(phi, e0, n0, h, ve, vn)
        g_sum = np.zeros((ny, nx))
        for i, v in enumerate(vectors):
            w, _ = weights(i)
            c = v.custom
            if c is None:
                g_i = global_profile.g(phi)
            elif c["family"] == "linear":
                g_i = c["local_gradient"] + 0.0 * phi
            else:  # quadratic: equals local_gradient at the vector's own phi
                g_i = c["local_gradient"] + c["rate_of_increase"] * (phi - phi_at_vector[i])
            g_sum += w * g_i
        gradient = g_sum / sum_w
        if hinge_d is not None:
            gradient = np.where(phi < hinge_d, 0.0, gradient)
        # Guard (every mode): uplift never re-increases behind the spillway.
        guard = (phi < 0.0) & (gradient < 0.0)
        gradient = np.where(guard, 0.0, gradient)
        hinge_km, hinge_source_b = hinge_d, ("mode" if hinge_d is not None else None)
        if guard.any():
            # Where the guard, not the mode, sets the clamp, report the extent it
            # reached (approximate: the field has no single zero-gradient point).
            hinge_km, hinge_source_b = float(phi[guard].max()), "guard"
        hinge_source = hinge_source_b
        u = integrate(gradient * field_e, gradient * field_n)
        u = u - origin_value(u)
        model = GridUpliftModel(e0=e0, n0=n0, h=h, values=u, profile=None,
                                hinge_d=hinge_km, hinge_source=hinge_source)

    diagnostics = {
        "misfit_deg": misfit_list,
        "misfit_rms_deg": rms,
        "misfit_max_deg": worst_val,
        "worst_vector": worst,
        "degenerate_fraction": degenerate_fraction,
        "ranges_km": [float(r) for r in ranges],
        "case": case,
        "hinge_km": hinge_km,
        "hinge_source": hinge_source,
        "phi_grid": phi,
        "grid": {"e0": e0, "n0": n0, "h": h, "nx": nx, "ny": ny,
                 "diagonal_km": diagonal_km, "origin": tuple(origin_coords)},
    }
    return model, diagnostics


def build_vector_model_from_spec(spec, tilt_factor, origin_coords, raster_transform, raster_shape,
                                 grid_cells=GRID_CELLS):
    """
    Builds the model from the API layer's validated `tilt_model` dict with
    `direction.type == 'vectors'` (see api/tilt_model.py). `tilt_factor` (c1 of
    the global profile) may be None only when every vector is custom, in which
    case the spec's `profile` is unused.
    """
    vectors = [
        Vector(lon=float(v["lon"]), lat=float(v["lat"]), azimuth_deg=float(v["azimuth_deg"]),
               range_km=v.get("range_km"), custom=v.get("custom"))
        for v in spec["direction"]["vectors"]
    ]
    profile = None
    if spec.get("profile") is not None and tilt_factor is not None:
        profile = _profile_from_spec(spec["profile"], tilt_factor)
    return build_vector_uplift_model(
        vectors, origin_coords, raster_transform, raster_shape, profile, spec.get("hinge"),
        grid_cells=grid_cells,
    )


def _nice_interval(u_min, u_max):
    """Smallest 1/2/5 x 10^n (m) giving at most MAX_ISOBASE_LEVELS nonzero levels."""
    if not (np.isfinite(u_min) and np.isfinite(u_max)) or u_max - u_min <= 0:
        return None
    for exponent in range(-6, 9):
        for mantissa in (1, 2, 5):
            interval = mantissa * 10.0 ** exponent
            first, last = math.ceil(u_min / interval), math.floor(u_max / interval)
            if last - first + 1 <= MAX_ISOBASE_LEVELS:
                return interval
    return None


def isobases_geojson(model, diagnostics):
    """
    Isobases as (GeoJSON FeatureCollection of LineStrings with `uplift_m`,
    interval_m). Contours of U on the model's grid at 'nice' levels, mapped back
    through `_local_en_to_lonlat`. The spillway's own isobase (0) is contoured
    from phi, not U: behind the spillway U is a flat plateau at 0, where a
    contour at exactly 0 finds nothing.
    """
    g = diagnostics["grid"]
    geod = Geod(ellps="WGS84")
    node_e = g["e0"] + g["h"] * np.arange(g["nx"])
    node_n = g["n0"] + g["h"] * np.arange(g["ny"])
    grid_e, grid_n = np.meshgrid(node_e, node_n)
    u = model.evaluate(grid_e, grid_n)
    phi = diagnostics["phi_grid"]

    def lines(field, level):
        out = []
        for contour in find_contours(field, level):
            rows, cols = contour[:, 0], contour[:, 1]
            lons, lats = _local_en_to_lonlat(
                g["e0"] + cols * g["h"], g["n0"] + rows * g["h"], g["origin"], g["diagonal_km"], geod)
            out.append([[float(x), float(y)] for x, y in zip(lons, lats)])
        return out

    features = []
    interval = _nice_interval(float(u.min()), float(u.max()))
    if interval is not None:
        for k in range(math.ceil(float(u.min()) / interval), math.floor(float(u.max()) / interval) + 1):
            if k == 0:
                continue
            level = k * interval
            for coords in lines(u, level):
                features.append({"type": "Feature", "properties": {"uplift_m": round(level, 9)},
                                 "geometry": {"type": "LineString", "coordinates": coords}})
    if float(phi.min()) < 0.0 < float(phi.max()):
        for coords in lines(phi, 0.0):
            features.append({"type": "Feature", "properties": {"uplift_m": 0.0},
                             "geometry": {"type": "LineString", "coordinates": coords}})
    return {"type": "FeatureCollection", "features": features}, interval
