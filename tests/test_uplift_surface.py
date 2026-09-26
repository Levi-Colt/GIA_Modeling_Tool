"""
Shore-point uplift surfaces (documentation/SHORE_POINT_SURFACE_SPEC.md, spec 6;
backend/uplift_surface.py).

The surfaces and coordinates below are synthetic, realistic-looking example
values; nothing here is a default of anything or tied to a particular basin.
"""
import warnings

import geopandas as gpd
import numpy as np
import pytest
import rasterio
import shapely
from pyproj import Geod
from rasterio.transform import from_origin
from shapely.geometry import Point

from backend.app import process_dem
from backend.main import (
    _local_en_km, _local_en_to_lonlat, _lonlat_grid, _raster_diagonal_km, calculate_tilt,
    tilt_DEM_windowed,
)
from backend.uplift import PlanarUpliftModel, PolynomialProfile
from backend.uplift_surface import (
    ShorePoint, SurfaceUpliftModel, build_surface_model_from_spec, build_surface_uplift_model,
    fit_all_orders, fit_trend_surface, min_points, surface_isobases_geojson, unscaled_coeffs,
)

ORIGIN = (-105.0, 45.0)
GEOD = Geod(ellps="WGS84")


def make_raster(pixel=0.006, n=100):
    """An n x n WGS84 raster centered on ORIGIN (0.006 deg -> ~82 km diagonal)."""
    half = n * pixel / 2
    return from_origin(ORIGIN[0] - half, ORIGIN[1] + half, pixel, pixel), (n, n)


@pytest.fixture
def raster():
    return make_raster()


def diagonal(raster):
    return _raster_diagonal_km(raster[0], raster[1], geod=GEOD)


def points_from_frame(raster, e, n, z):
    """ShorePoints at frame positions (km) with elevations z (m)."""
    lons, lats = _local_en_to_lonlat(np.asarray(e, float), np.asarray(n, float), ORIGIN,
                                     diagonal(raster), GEOD)
    return [ShorePoint(float(a), float(b), float(c)) for a, b, c in zip(lons, lats, z)]


def quad_surface(e, n):
    """A known quadratic in frame km (m a.s.l.)."""
    return 300.0 + 0.30 * e + 0.15 * n + 0.002 * e * e - 0.001 * e * n + 0.0015 * n * n


def scattered(count=40, half=30.0, seed=1):
    rng = np.random.default_rng(seed)
    return rng.uniform(-half, half, count), rng.uniform(-half, half, count)


def build(points, raster, order=2, **kw):
    return build_surface_uplift_model(points, order, ORIGIN, raster[0], raster[1], **kw)


def quiet_build(*args, **kw):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return build(*args, **kw)


# --- the fit ----------------------------------------------------------------------

def test_exact_quadratic_is_recovered_to_1e_8_and_order_1_is_not_exact(raster):
    e, n = scattered()
    pts = points_from_frame(raster, e, n, quad_surface(e, n))
    fit = fit_trend_surface(pts, ORIGIN, diagonal(raster), GEOD, 2)
    got = unscaled_coeffs(fit)
    want = {(0, 0): 300.0, (1, 0): 0.30, (0, 1): 0.15, (2, 0): 0.002, (1, 1): -0.001, (0, 2): 0.0015}
    for ab, c in want.items():
        assert got[ab] == pytest.approx(c, abs=1e-8)
    assert fit["r2"] == pytest.approx(1.0, abs=1e-12)
    assert fit["rmse_m"] < 1e-8 and fit["outlier_indices"] == []
    assert fit_trend_surface(pts, ORIGIN, diagonal(raster), GEOD, 1)["r2"] < 1.0


def test_noisy_fit_has_rmse_near_sigma_and_flags_only_the_planted_outlier(raster):
    e, n = scattered(count=60, seed=2)
    z = quad_surface(e, n) + np.random.default_rng(7).normal(0.0, 2.0, e.size)
    diag_km = diagonal(raster)
    clean = fit_trend_surface(points_from_frame(raster, e, n, z), ORIGIN, diag_km, GEOD, 2)
    assert clean["rmse_m"] == pytest.approx(2.0, rel=0.25)
    assert clean["outlier_indices"] == []

    z[7] += 30.0
    planted = fit_trend_surface(points_from_frame(raster, e, n, z), ORIGIN, diag_km, GEOD, 2)
    assert planted["outlier_indices"] == [7]
    assert planted["residuals_m"][7] > 20.0


def test_fit_statistics_are_consistent(raster):
    e, n = scattered(count=30, seed=3)
    z = quad_surface(e, n) + np.random.default_rng(1).normal(0.0, 1.0, e.size)
    fit = fit_trend_surface(points_from_frame(raster, e, n, z), ORIGIN, diagonal(raster), GEOD, 2)
    r = np.array(fit["residuals_m"])
    assert fit["n"] == 30 and fit["terms"] == 6
    assert fit["rmse_m"] == pytest.approx(np.sqrt((r ** 2).mean()))
    assert fit["adj_r2"] < fit["r2"] <= 1.0
    assert np.array(fit["std_residuals"]).std() == pytest.approx(np.sqrt(24 / 30), rel=1e-6)


@pytest.mark.parametrize("order", [1, 2, 3])
def test_minimum_points_per_order(raster, order):
    need = min_points(order)
    assert need == {1: 6, 2: 9, 3: 13}[order]
    e, n = scattered(count=need)
    z = quad_surface(e, n)
    pts = points_from_frame(raster, e, n, z)
    fit_trend_surface(pts, ORIGIN, diagonal(raster), GEOD, order)          # exactly enough: fine
    with pytest.raises(ValueError, match=f"at least {need} shore points"):
        fit_trend_surface(pts[:-1], ORIGIN, diagonal(raster), GEOD, order)


def test_fit_all_orders_returns_only_the_feasible_orders(raster):
    def orders(count):
        e, n = scattered(count=count)
        pts = points_from_frame(raster, e, n, quad_surface(e, n))
        return [f["order"] for f in fit_all_orders(pts, ORIGIN, diagonal(raster), GEOD)]
    assert orders(5) == []
    assert orders(6) == [1]
    assert orders(9) == [1, 2]
    assert orders(13) == [1, 2, 3]


def test_collinear_points_warn(raster):
    t = np.linspace(-25, 25, 12)
    pts = points_from_frame(raster, t, 0.4 * t, 300 + 0.3 * t)
    with pytest.warns(UserWarning, match="collinear"):
        build(pts, raster, order=1)


def test_unbuildable_requests_raise(raster):
    e, n = scattered()
    pts = points_from_frame(raster, e, n, quad_surface(e, n))
    with pytest.raises(ValueError, match="hinge"):
        build(pts, raster, hinge_mode="natural")
    with pytest.raises(ValueError, match="extrapolation"):
        build(pts, raster, extrapolation="clip")
    same = [ShorePoint(-104.9, 45.05, 300.0 + i) for i in range(12)]
    with pytest.raises(ValueError):
        quiet_build(same, raster, order=1)


# --- the model ----------------------------------------------------------------------

@pytest.mark.parametrize("order", [1, 2, 3])
@pytest.mark.parametrize("hinge", ["none", "origin"])
def test_uplift_is_exactly_zero_at_the_origin(raster, order, hinge):
    e, n = scattered(count=40, seed=order)
    z = quad_surface(e, n) + np.random.default_rng(order).normal(0, 1.5, e.size)
    model, _ = quiet_build(points_from_frame(raster, e, n, z), raster, order=order, hinge_mode=hinge)
    assert model.evaluate(np.array([[0.0]]), np.array([[0.0]]))[0, 0] == 0.0


def planar_points(raster, azimuth=28.0, gradient=0.35, z0=300.0, count=5):
    g = np.linspace(-30, 30, count)
    e, n = (a.ravel() for a in np.meshgrid(g, g))
    d = e * np.sin(np.radians(azimuth)) + n * np.cos(np.radians(azimuth))
    return points_from_frame(raster, e, n, z0 + gradient * d)


def pixel_frame(raster):
    lons, lats = _lonlat_grid(raster[0], 0, raster[1])
    return _local_en_km(lons, lats, ORIGIN, diagonal(raster), GEOD)


@pytest.mark.parametrize("hinge, planar_hinge_d", [("none", None), ("origin", 0.0)])
def test_order_1_surface_matches_the_planar_model(raster, hinge, planar_hinge_d):
    model, _ = quiet_build(planar_points(raster), raster, order=1, hinge_mode=hinge)
    planar = PlanarUpliftModel(28.0, PolynomialProfile((0.35,)), planar_hinge_d)
    east, north = pixel_frame(raster)
    np.testing.assert_allclose(model.evaluate(east, north), planar.evaluate(east, north), atol=1e-6)


def test_evaluate_broadcasts_separable_inputs_to_the_block_shape(raster):
    model, _ = quiet_build(planar_points(raster), raster, order=2)
    east, north = pixel_frame(raster)
    assert east.shape[0] == 1 and north.shape[1] == 1        # the separable (1, W) x (H, 1) case
    assert model.evaluate(east, north).shape == raster[1]
    full_e, full_n = np.broadcast_arrays(east, north)
    np.testing.assert_allclose(model.evaluate(east, north), model.evaluate(full_e, full_n), atol=1e-9)


def test_model_matches_the_fitted_surface_at_the_points(raster):
    e, n = scattered(count=25, seed=5)
    z = quad_surface(e, n)
    model, diag = quiet_build(points_from_frame(raster, e, n, z), raster, order=2)
    np.testing.assert_allclose(model.evaluate(e, n), z - quad_surface(0.0, 0.0), atol=1e-6)
    assert diag["fit"]["order"] == 2 and [f["order"] for f in diag["orders"]] == [1, 2, 3]


def test_build_from_spec_matches_a_direct_build(raster):
    e, n = scattered()
    pts = points_from_frame(raster, e, n, quad_surface(e, n))
    spec = {"direction": {"type": "points", "order": 2, "hinge": "origin", "extrapolation": "warn",
                          "points": [{"lat": p.lat, "lon": p.lon, "elevation_m": p.elevation_m,
                                      "label": None} for p in pts]}}
    a, _ = build_surface_model_from_spec(spec, ORIGIN, *raster)
    b, _ = quiet_build(pts, raster, order=2, hinge_mode="origin")
    east, north = pixel_frame(raster)
    assert np.array_equal(a.evaluate(east, north), b.evaluate(east, north))


# --- hull, mask, warnings -----------------------------------------------------------------

def west_half_points(raster, count=40):
    rng = np.random.default_rng(4)
    e = np.concatenate([rng.uniform(-41, -9, count - 4), [-41, -41, -9, -9]])
    n = np.concatenate([rng.uniform(-41, 41, count - 4), [-41, 41, -41, 41]])
    return points_from_frame(raster, e, n, quad_surface(e, n))


def test_outside_fraction_is_about_half_when_the_points_cover_half_the_dem(raster):
    _, diag = quiet_build(west_half_points(raster), raster)
    assert diag["dem_fraction_outside_hull"] == pytest.approx(0.5, abs=0.08)


def test_warn_mode_warns_only_above_twenty_percent_outside(raster):
    with pytest.warns(UserWarning, match="lies outside the shore points' buffered hull"):
        build(west_half_points(raster), raster)
    e, n = scattered(count=40, half=45.0, seed=8)                 # spans the whole DEM
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        _, diag = build(points_from_frame(raster, e, n, quad_surface(e, n)), raster)
    assert diag["dem_fraction_outside_hull"] < 0.2


def test_origin_outside_the_hull_warns(raster):
    rng = np.random.default_rng(6)
    e, n = rng.uniform(15, 40, 20), rng.uniform(15, 40, 20)      # the origin (0, 0) is not near
    with pytest.warns(UserWarning, match="origin lies outside"):
        _, diag = build(points_from_frame(raster, e, n, quad_surface(e, n)), raster)
    assert diag["origin_inside_hull"] is False


def test_mask_mode_is_nan_exactly_outside_the_hull_and_reports_the_share(raster):
    with pytest.warns(UserWarning, match="masked"):
        model, diag = build(west_half_points(raster), raster, extrapolation="mask")
    assert model.masks_outside
    east, north = pixel_frame(raster)
    u = model.evaluate(east, north)
    assert np.isnan(u).mean() == pytest.approx(diag["dem_fraction_outside_hull"], abs=0.01)
    inside = shapely.contains_xy(diag["hull"], *np.broadcast_arrays(east, north))
    # Agreement with the polygon to within the mask grid's cell size.
    assert (np.isnan(u) != ~inside).mean() < 0.005
    east_only, north_only = 0.0, 0.0
    assert np.isfinite(model.evaluate(np.array([[east_only]]), np.array([[north_only]]))[0, 0]) == diag["origin_inside_hull"]


def test_mask_that_removes_the_whole_dem_is_rejected(raster):
    e, n = np.linspace(200, 260, 15), np.linspace(200, 250, 15)   # far outside the ~82 km DEM
    pts = points_from_frame(raster, e, n + 3 * np.sin(e), quad_surface(e, n))
    with pytest.raises(ValueError, match="entirely outside"):
        quiet_build(pts, raster, order=1, extrapolation="mask")


def test_mask_mode_extra_memory_is_larger(raster):
    warn, _ = quiet_build(west_half_points(raster), raster)
    mask, _ = quiet_build(west_half_points(raster), raster, extrapolation="mask")
    assert warn.extra_bytes_per_pixel == 24 and mask.extra_bytes_per_pixel > 24


# --- pipelines ---------------------------------------------------------------------------------

def write_dem(path, transform, n, dem):
    with rasterio.open(path, "w", driver="GTiff", height=n, width=n, count=1, dtype="float32",
                       crs="EPSG:4326", transform=transform, nodata=-9999.0) as dst:
        dst.write(dem, 1)
    return path


@pytest.mark.parametrize("extrapolation", ["warn", "mask"])
def test_windowed_and_in_memory_pipelines_agree_with_a_surface_model(tmp_path, extrapolation):
    n, pixel = 60, 0.01
    transform = from_origin(-105.3, 45.3, pixel, pixel)
    r = (transform, (n, n))
    dem = np.random.default_rng(3).uniform(400, 600, (n, n)).astype("float32")
    path = write_dem(str(tmp_path / "dem.tif"), transform, n, dem)
    e, ny = scattered(count=30, half=22.0, seed=9)
    pts = points_from_frame(r, e, ny, quad_surface(e, ny))
    model, _ = quiet_build(pts, r, order=2, hinge_mode="origin", extrapolation=extrapolation)

    in_memory = calculate_tilt(dem, transform, ORIGIN, 0.0, 0.0, uplift_model=model)
    out = str(tmp_path / "tilted.tif")
    tilt_DEM_windowed(path, out, ORIGIN, 0.0, 0.0, tile_size=17, uplift_model=model)
    with rasterio.open(out) as src:
        windowed = src.read(1)
    assert not np.allclose(in_memory, dem, equal_nan=True)
    if extrapolation == "mask":
        assert np.isnan(in_memory).any() and np.isfinite(in_memory).any()
        assert np.array_equal(np.isnan(windowed), np.isnan(in_memory))
    np.testing.assert_allclose(windowed, in_memory, atol=1e-3)


@pytest.mark.parametrize("windowed", [False, True])
def test_process_dem_mask_mode_contours_stay_inside_the_hull(tmp_path, monkeypatch, windowed):
    n, pixel = 100, 0.006
    transform, shape = make_raster(pixel, n)
    east, north = pixel_frame((transform, shape))
    dem = (450.0 + 2.0 * east + 0 * north).astype("float32")           # rises to the east
    path = write_dem(str(tmp_path / "dem.tif"), transform, n, dem)
    with pytest.warns(UserWarning):
        model, diag = build(west_half_points((transform, shape)), (transform, shape),
                            order=1, extrapolation="mask")
    if windowed:
        import backend.app as app
        monkeypatch.setattr(app, "raster_io_check", lambda *a, **k: {
            **_io_check(path), "use_windowed_io": True})
    out = str(tmp_path / "out.gpkg")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        process_dem(path, ORIGIN, 0.0, 0.0, 410.0, out, include_dem=True,
                    uplift_model=model)
    lines = gpd.read_file(out, layer="strandline_contour")
    assert len(lines) >= 1
    hull = diag["hull"].buffer(2.0)                    # ~2 pixels of slack, in km
    for geom in lines.geometry:
        e, nn = _local_en_km(np.array([c[0] for c in geom.coords]), np.array([c[1] for c in geom.coords]),
                             ORIGIN, diagonal((transform, shape)), GEOD)
        assert all(hull.contains(Point(a, b)) for a, b in zip(e, nn))
        # The strandline is ~20 km inside the hull's eastern edge (e ~ -0.4 km). Untrimmed, the
        # contour tracing that valid/NaN edge comes out too -- a vertical line at the edge.
        assert e.max() < -10.0


def _io_check(path):
    from backend.main import raster_io_check
    return raster_io_check(path, 1e9)


# --- isobases -----------------------------------------------------------------------------------

def test_isobases_of_a_plane_are_straight_lines_at_absolute_elevations(raster):
    pts = planar_points(raster, azimuth=90.0, gradient=0.5, z0=300.0)         # rises to the east
    model, diag = quiet_build(pts, raster, order=1)
    isobases, interval, hull = surface_isobases_geojson(model, diag)
    feats = isobases["inside"]["features"]
    levels = sorted({f["properties"]["elevation_m"] for f in feats})
    assert 1 <= len(levels) <= 13
    mantissa = interval / 10 ** np.floor(np.log10(interval))
    assert round(mantissa, 6) in (1.0, 2.0, 5.0)
    for f in feats:
        lons, lats = np.array(f["geometry"]["coordinates"]).T
        e, _ = _local_en_km(lons, lats, ORIGIN, diagonal(raster), GEOD)
        level = f["properties"]["elevation_m"]                 # S = 300 + 0.5 e, an absolute elevation
        np.testing.assert_allclose(e, (level - 300.0) / 0.5, atol=0.5)
    assert hull["type"] == "Polygon" and hull["coordinates"][0][0] == hull["coordinates"][0][-1]


def test_warn_mode_splits_isobases_inside_and_outside_the_hull(raster):
    pts = west_half_points(raster)
    model, diag = quiet_build(pts, raster, order=1)
    isobases, _, _ = surface_isobases_geojson(model, diag)
    hull = diag["hull"]
    d = diagonal(raster)

    def frame_points(fc):
        for f in fc["features"]:
            lons, lats = np.array(f["geometry"]["coordinates"]).T
            e, n = _local_en_km(lons, lats, ORIGIN, d, GEOD)
            yield from zip(e, n)

    assert isobases["inside"]["features"] and isobases["outside"]["features"]
    assert all(hull.buffer(0.05).contains(Point(a, b)) for a, b in frame_points(isobases["inside"]))
    assert not any(hull.buffer(-0.05).contains(Point(a, b)) for a, b in frame_points(isobases["outside"]))


def test_mask_mode_draws_no_isobases_outside_the_hull(raster):
    model, diag = quiet_build(west_half_points(raster), raster, order=1, extrapolation="mask")
    isobases, _, _ = surface_isobases_geojson(model, diag)
    assert isobases["inside"]["features"] and isobases["outside"]["features"] == []
