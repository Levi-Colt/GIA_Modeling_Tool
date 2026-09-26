"""
Shore-point uplift surfaces (documentation/SHORE_POINT_SURFACE_SPEC.md, spec 6).

When shore-feature elevations exist, the deformed water plane can be fitted
directly instead of described with directions and profiles. Each point is a
location and the present elevation of the shoreline there; a polynomial trend
surface S(e, n) of order 1, 2 or 3 is fitted to them by least squares (a smooth
trend, not an exact interpolating spline -- real shoreline elevations scatter,
and an exact fit would chase that noise). The uplift model is then

    U(e, n) = S(e, n) - S(origin)          (origin = (0, 0) in the local frame)

so U(origin) == 0 and the tilted DEM is DEM - U like every other model.
Magnitude comes entirely from the data: no profile family, no tilt_factor.

Everything is done in `backend.main`'s local frame (`_local_en_km`, east/north km
from the origin), with the same `diagonal_km` a run's `_tilt_block` uses (taken
from the full raster), so the fit's frame and the run's are identical. S is
evaluated analytically per pixel (a polynomial of at most 10 terms is exact and
cheap); the working grid is used only for the hull mask and the preview
isobases. The isobases the user sees are contours of S (absolute meters a.s.l.);
the model itself uses U.

Extrapolation guard: polynomial surfaces diverge quickly outside their data, so
the convex hull of the points (buffered by HULL_BUFFER_FRACTION of its diameter)
is rasterized onto the DEM. `warn` computes everywhere and reports how much of
the DEM lies outside; `mask` sets the tilted DEM to NaN there (process_dem then
trims the contour step at those edges -- see `masks_outside`).

Pure numpy/scipy/shapely/pyproj: no FastAPI or Pydantic (validation lives in
api/tilt_model.py, which hands this module plain dicts).
"""
import math
import warnings
from dataclasses import dataclass

import numpy as np
import shapely
from pyproj import Geod
from scipy.ndimage import map_coordinates
from shapely.geometry import LineString, MultiPoint, Point

from backend.direction_field import (
    GRID_CELLS, _nice_interval, contour_lines_frame, working_grid,
)
from backend.main import (
    _flatten_to_lines, _local_en_km, _local_en_to_lonlat, _raster_diagonal_km,
)

ORDERS = (1, 2, 3)
HINGE_MODES = ("none", "origin")
DEFAULT_HINGE_MODE = "none"
EXTRAPOLATION_MODES = ("warn", "mask")
DEFAULT_EXTRAPOLATION = "warn"

# First-pass values, not tuned against real shoreline data (same status as the
# other tunables in backend/app.py and backend/main.py).
HULL_BUFFER_FRACTION = 0.10     # of the hull's diameter, added around the convex hull
HULL_WARN_FRACTION = 0.20       # warn mode: warn when more of the DEM than this is outside
HULL_MASK_CELLS = 1024          # cells on the long side of the hull-mask grid (fine, so the
                                # masked edge is not visibly stair-stepped on a large DEM)
CONDITION_WARN = 1e8            # cond(design matrix) above this => near-degenerate geometry
OUTLIER_SIGMA = 3.0
EXTRA_BYTES_PER_PIXEL = 24      # e-hat, n-hat and the accumulator (estimated, not profiled)
MASK_EXTRA_BYTES_PER_PIXEL = 32  # mask mode: the sampling coordinates and the sample


@dataclass(frozen=True)
class ShorePoint:
    lon: float
    lat: float
    elevation_m: float


def terms_for(order):
    """Number of polynomial terms of a bivariate surface of this order: 3, 6, 10."""
    return (order + 1) * (order + 2) // 2


def min_points(order):
    """Fewest points a fit of this order needs (terms + 3, leaving 3 degrees of freedom)."""
    return terms_for(order) + 3


def _monomials(order):
    """(a, b) exponents of e-hat^a * n-hat^b, a + b <= order, by total degree
    ((0, 0) first)."""
    return [(d - b, b) for d in range(order + 1) for b in range(d + 1)]


def _design(e_hat, n_hat, order):
    return np.column_stack([e_hat ** a * n_hat ** b for a, b in _monomials(order)])


def _points_to_frame(points, origin_coords, diagonal_km, geod):
    lons = np.array([p.lon for p in points], dtype="float64")
    lats = np.array([p.lat for p in points], dtype="float64")
    z = np.array([p.elevation_m for p in points], dtype="float64")
    if not (np.isfinite(lons).all() and np.isfinite(lats).all() and np.isfinite(z).all()):
        raise ValueError("Shore point lon, lat and elevation must be finite numbers.")
    e, n = _local_en_km(lons, lats, origin_coords, diagonal_km, geod)
    return np.asarray(e, dtype="float64"), np.asarray(n, dtype="float64"), z


def fit_trend_surface(points, origin_coords, diagonal_km, geod, order):
    """
    Least-squares polynomial trend surface of `order` (1, 2 or 3) through the
    points, in the local frame. Pure; no raster I/O.

    S(e, n) = sum_{a+b<=p} beta_ab * (e/L)^a * (n/L)^b, with L the largest
    absolute frame coordinate among the points (keeps the design matrix well
    conditioned). The constant term is included: S is an absolute elevation.

    Returns {"order", "monomials", "coeffs" (beta, scaled basis; use
    `unscaled_coeffs` for per-km coefficients), "L", "n", "terms", "r2",
    "adj_r2", "rmse_m", "residuals_m" (z_j - S_j), "std_residuals"
    (residual / sqrt(SSE / dof)), "outlier_indices" (|std| > 3; shown, never
    removed), "cond"}. Raises ValueError below the minimum point count.
    """
    if order not in ORDERS:
        raise ValueError(f"order must be one of {list(ORDERS)}.")
    points = list(points)
    n_pts, terms = len(points), terms_for(order)
    if n_pts < min_points(order):
        raise ValueError(
            f"An order-{order} surface needs at least {min_points(order)} shore points "
            f"(got {n_pts})."
        )
    e, n, z = _points_to_frame(points, origin_coords, diagonal_km, geod)
    scale = float(max(np.abs(e).max(), np.abs(n).max()))
    if not scale > 0:
        raise ValueError("Every shore point is at the origin; the surface cannot be fitted.")

    design = _design(e / scale, n / scale, order)
    beta, *_ = np.linalg.lstsq(design, z, rcond=None)
    residuals = z - design @ beta
    sse = float(residuals @ residuals)
    sst = float(((z - z.mean()) ** 2).sum())
    dof = n_pts - terms
    if sst > 0:
        r2 = 1.0 - sse / sst
        adj_r2 = 1.0 - (1.0 - r2) * (n_pts - 1) / dof
    else:
        r2 = adj_r2 = 1.0 if sse == 0 else 0.0
    sigma = math.sqrt(sse / dof)
    std = residuals / sigma if sigma > 0 else np.zeros_like(residuals)
    return {
        "order": order,
        "monomials": _monomials(order),
        "coeffs": beta.tolist(),
        "L": scale,
        "n": n_pts,
        "terms": terms,
        "r2": float(r2),
        "adj_r2": float(adj_r2),
        "rmse_m": math.sqrt(sse / n_pts),
        "residuals_m": residuals.tolist(),
        "std_residuals": std.tolist(),
        "outlier_indices": [int(i) for i in np.nonzero(np.abs(std) > OUTLIER_SIGMA)[0]],
        "cond": float(np.linalg.cond(design)),
    }


def unscaled_coeffs(fit):
    """{(a, b): c} such that S = sum c_ab * e_km^a * n_km^b (frame km)."""
    return {ab: c / fit["L"] ** (ab[0] + ab[1]) for ab, c in zip(fit["monomials"], fit["coeffs"])}


def fit_all_orders(points, origin_coords, diagonal_km, geod):
    """`fit_trend_surface` for every order the point count allows (possibly none)."""
    points = list(points)
    return [fit_trend_surface(points, origin_coords, diagonal_km, geod, o)
            for o in ORDERS if len(points) >= min_points(o)]


@dataclass(frozen=True, eq=False)
class SurfaceUpliftModel:
    """
    Uplift from a fitted trend surface: implements the UpliftModel interface
    (`evaluate`, `extra_bytes_per_pixel`). S is evaluated analytically per pixel.

    `hinge_d` / `hinge_source` exist (always None) so callers that read them off
    any model (run_parameters.json) work; this model's hinge is `hinge_mode`
    ('none': U as fitted, 'origin': U = max(U, 0)).
    """
    coeffs: np.ndarray                 # beta, scaled basis, aligned with `monomials`
    monomials: tuple                   # ((a, b), ...)
    L: float
    hinge_mode: str = DEFAULT_HINGE_MODE
    extrapolation: str = DEFAULT_EXTRAPOLATION
    mask: np.ndarray | None = None     # bool (ny, nx), True = inside the hull; mask mode only
    mask_e0: float = 0.0               # frame km of the mask grid's south-west node
    mask_n0: float = 0.0
    mask_h: float = 1.0
    hinge_d: float | None = None
    hinge_source: str | None = None

    @property
    def masks_outside(self):
        return self.mask is not None

    @property
    def extra_bytes_per_pixel(self):
        return EXTRA_BYTES_PER_PIXEL + (MASK_EXTRA_BYTES_PER_PIXEL if self.masks_outside else 0)

    def surface(self, east_km, north_km):
        """S (absolute meters) at frame positions: broadcastable arrays in, the
        broadcast shape out. Grouped by n-power, so with a separable (1, W) x
        (H, 1) input the inner sums stay one-dimensional."""
        e = np.asarray(east_km, dtype="float64") / self.L
        n = np.asarray(north_km, dtype="float64") / self.L
        order = max(a + b for a, b in self.monomials)
        e_pow = [np.ones_like(e)]
        for _ in range(order):
            e_pow.append(e_pow[-1] * e)
        n_pow = [np.ones_like(n)]
        for _ in range(order):
            n_pow.append(n_pow[-1] * n)
        total = 0.0
        for b in range(order + 1):
            inner = 0.0
            for (ma, mb), c in zip(self.monomials, self.coeffs):
                if mb == b:
                    inner = inner + c * e_pow[ma]
            total = total + inner * n_pow[b]
        return total + np.zeros(np.broadcast(e, n).shape)

    @property
    def origin_surface_m(self):
        """S at the origin, (0, 0): the constant term."""
        return float(self.coeffs[self.monomials.index((0, 0))])

    def inside_hull(self, east_km, north_km):
        """Nearest-sample of the hull mask onto frame positions (False off the grid)."""
        east, north = np.broadcast_arrays(east_km, north_km)
        coords = np.stack([(north - self.mask_n0) / self.mask_h, (east - self.mask_e0) / self.mask_h])
        sampled = map_coordinates(self.mask.astype("uint8"), coords, order=0, mode="constant", cval=0)
        return sampled > 0

    def evaluate(self, east_km, north_km):
        east, north = np.broadcast_arrays(east_km, north_km)
        u = self.surface(east, north) - self.origin_surface_m
        if self.hinge_mode == "origin":
            u = np.maximum(u, 0.0)
        if self.masks_outside:
            u = np.where(self.inside_hull(east, north), u, np.nan)
        return u


def _hull_polygon(e, n):
    """Convex hull of the points (frame km), buffered by HULL_BUFFER_FRACTION of
    its diameter. Returns (polygon, diameter_km)."""
    hull = MultiPoint(list(zip(e.tolist(), n.tolist()))).convex_hull
    xy = shapely.get_coordinates(hull)
    diameter = float(np.hypot(xy[:, None, 0] - xy[None, :, 0], xy[:, None, 1] - xy[None, :, 1]).max())
    if not diameter > 0:
        raise ValueError("The shore points must not all be at the same location.")
    return hull.buffer(HULL_BUFFER_FRACTION * diameter, quad_segs=16), diameter


def build_surface_uplift_model(points, order, origin_coords, raster_transform, raster_shape,
                               hinge_mode=DEFAULT_HINGE_MODE, extrapolation=DEFAULT_EXTRAPOLATION):
    """
    Builds (SurfaceUpliftModel, diagnostics) from `ShorePoint`s, in the local
    frame of the raster described by (raster_transform, raster_shape).

    diagnostics: "fit" (the selected order's `fit_trend_surface` dict), "orders"
    (every feasible order's), "dem_fraction_outside_hull", "origin_inside_hull",
    plus what `surface_isobases_geojson` needs ("hull", the buffered hull polygon
    in frame km, and "geometry": transform, shape, origin, diagonal_km).

    UserWarnings: a near-degenerate design (cond > 1e8), the origin outside the
    hull, and (warn mode) more than 20% of the DEM outside the hull or (mask
    mode) the share masked. Raises ValueError for an unbuildable request,
    including a `mask` that would remove the whole DEM.
    """
    points = list(points)
    if hinge_mode not in HINGE_MODES:
        raise ValueError(f"hinge must be one of {list(HINGE_MODES)}.")
    if extrapolation not in EXTRAPOLATION_MODES:
        raise ValueError(f"extrapolation must be one of {list(EXTRAPOLATION_MODES)}.")

    geod = Geod(ellps="WGS84")
    diagonal_km = _raster_diagonal_km(raster_transform, raster_shape, geod=geod)
    fits = fit_all_orders(points, origin_coords, diagonal_km, geod)
    fit = next((f for f in fits if f["order"] == order), None)
    if fit is None:  # raises the specific minimum-points / order message
        fit = fit_trend_surface(points, origin_coords, diagonal_km, geod, order)

    if fit["cond"] > CONDITION_WARN:
        warnings.warn(
            "The shore points are nearly collinear or clustered for an order-"
            f"{order} surface (condition number {fit['cond']:.3g}); the fit is unreliable. "
            "Try a lower order or points that cover more of the area.",
            UserWarning,
        )

    e, n, _ = _points_to_frame(points, origin_coords, diagonal_km, geod)
    hull, _ = _hull_polygon(e, n)
    origin_inside = bool(hull.contains(Point(0.0, 0.0)))

    # The hull on a fine grid over the DEM: the share of the DEM outside it, and
    # (mask mode) the boolean grid the model samples per pixel.
    fine = working_grid(raster_transform, raster_shape, origin_coords, geod, HULL_MASK_CELLS)
    inside = shapely.contains_xy(hull, fine["grid_e"], fine["grid_n"])
    e_min, e_max, n_min, n_max = fine["frame_bbox"]
    on_dem = ((fine["grid_e"] >= e_min) & (fine["grid_e"] <= e_max)
              & (fine["grid_n"] >= n_min) & (fine["grid_n"] <= n_max))
    outside_fraction = float(1.0 - inside[on_dem].mean()) if on_dem.any() else 0.0

    if not origin_inside:
        warnings.warn(
            "The origin lies outside the shore points' buffered hull, so the surface is "
            "extrapolated to it" + ("; in mask mode the contour cannot pass through it." if
                                    extrapolation == "mask" else "."),
            UserWarning,
        )
    if extrapolation == "mask":
        if outside_fraction >= 1.0:
            raise ValueError(
                "The DEM lies entirely outside the shore points' buffered hull; masking would "
                "remove every cell. Use 'warn', or add points that cover the DEM."
            )
        if outside_fraction > 0:
            warnings.warn(
                f"{outside_fraction * 100:.0f}% of the DEM lies outside the shore points' buffered "
                "hull and is masked (no contours there).",
                UserWarning,
            )
    elif outside_fraction > HULL_WARN_FRACTION:
        warnings.warn(
            f"{outside_fraction * 100:.0f}% of the DEM lies outside the shore points' buffered "
            "hull; the fitted surface is extrapolated there and may be unreliable.",
            UserWarning,
        )

    model = SurfaceUpliftModel(
        coeffs=np.asarray(fit["coeffs"], dtype="float64"),
        monomials=tuple(tuple(m) for m in fit["monomials"]),
        L=fit["L"],
        hinge_mode=hinge_mode,
        extrapolation=extrapolation,
        mask=inside if extrapolation == "mask" else None,
        mask_e0=fine["e0"], mask_n0=fine["n0"], mask_h=fine["h"],
    )
    diagnostics = {
        "fit": fit,
        "orders": fits,
        "dem_fraction_outside_hull": outside_fraction,
        "origin_inside_hull": origin_inside,
        "hull": hull,
        "geometry": {"transform": raster_transform, "shape": tuple(raster_shape),
                     "origin": tuple(origin_coords), "diagonal_km": diagonal_km},
    }
    return model, diagnostics


def build_surface_model_from_spec(spec, origin_coords, raster_transform, raster_shape):
    """
    Builds the model from the API layer's validated `tilt_model` dict with
    `direction.type == 'points'` (see api/tilt_model.py).
    """
    d = spec["direction"]
    points = [ShorePoint(lon=float(p["lon"]), lat=float(p["lat"]), elevation_m=float(p["elevation_m"]))
              for p in d["points"]]
    return build_surface_uplift_model(
        points, d["order"], origin_coords, raster_transform, raster_shape,
        hinge_mode=d.get("hinge") or DEFAULT_HINGE_MODE,
        extrapolation=d.get("extrapolation") or DEFAULT_EXTRAPOLATION,
    )


def _lines_to_lonlat(geometry, origin, diagonal_km, geod):
    out = []
    for line in _flatten_to_lines(geometry):
        east, north = np.asarray(line.xy[0]), np.asarray(line.xy[1])
        lons, lats = _local_en_to_lonlat(east, north, origin, diagonal_km, geod)
        out.append([[float(x), float(y)] for x, y in zip(lons, lats)])
    return out


def surface_isobases_geojson(model, diagnostics):
    """
    (isobases, interval_m, hull_geojson) for the preview map. `isobases` is
    {"inside": FeatureCollection, "outside": FeatureCollection} of LineStrings
    with `elevation_m`: contours of S (absolute meters a.s.l., not U) at 1/2/5 x
    10^n levels, at most 12 over the range S takes inside the hull, split by the
    buffered hull. In `mask` mode nothing is drawn outside it. The hull polygon
    is mapped back through `_local_en_to_lonlat`.
    """
    g = diagnostics["geometry"]
    geod = Geod(ellps="WGS84")
    grid = working_grid(g["transform"], g["shape"], g["origin"], geod, GRID_CELLS)
    hull = diagnostics["hull"]
    s = model.surface(grid["grid_e"], grid["grid_n"])
    in_hull = shapely.contains_xy(hull, grid["grid_e"], grid["grid_n"])

    empty = {"type": "FeatureCollection", "features": []}
    inside_fc = {"type": "FeatureCollection", "features": []}
    outside_fc = {"type": "FeatureCollection", "features": []}
    interval = None
    if in_hull.any():
        lo, hi = float(s[in_hull].min()), float(s[in_hull].max())
        interval = _nice_interval(lo, hi)
    if interval is not None:
        for k in range(math.ceil(lo / interval), math.floor(hi / interval) + 1):
            level = k * interval
            for east, north in contour_lines_frame(s, level, grid):
                line = LineString(np.column_stack([east, north]))
                for geometry, fc in ((line.intersection(hull), inside_fc),
                                     (line.difference(hull), outside_fc)):
                    if fc is outside_fc and model.extrapolation == "mask":
                        continue
                    for coords in _lines_to_lonlat(geometry, g["origin"], g["diagonal_km"], geod):
                        fc["features"].append({
                            "type": "Feature", "properties": {"elevation_m": round(level, 9)},
                            "geometry": {"type": "LineString", "coordinates": coords}})

    ring = np.asarray(hull.exterior.coords)
    lons, lats = _local_en_to_lonlat(ring[:, 0], ring[:, 1], g["origin"], g["diagonal_km"], geod)
    hull_geojson = {"type": "Polygon",
                    "coordinates": [[[float(x), float(y)] for x, y in zip(lons, lats)]]}
    return {"inside": inside_fc, "outside": outside_fc if outside_fc["features"] else empty}, interval, hull_geojson
