"""
Vector direction fields (documentation/VECTOR_FIELD_SPEC.md, spec 5;
backend/direction_field.py).

Azimuths and gradients below are realistic example values (the rotating-field
case borrows the sort of direction spread published for a single basin), not
defaults of anything.
"""
import warnings

import numpy as np
import pytest
import rasterio
from pyproj import Geod
from rasterio.transform import from_origin

from backend.direction_field import (
    GridUpliftModel, Vector, _sample, build_vector_model_from_spec, build_vector_uplift_model,
    isobases_geojson,
)
from backend.main import (
    _lonlat_grid, _local_en_km, _raster_diagonal_km, calculate_tilt, tilt_DEM_windowed,
)
from backend.uplift import PlanarUpliftModel, PolynomialProfile

ORIGIN = (-105.0, 45.0)
GEOD = Geod(ellps="WGS84")
ORIGIN_HINGE = {"mode": "origin"}


def make_raster(pixel, n=100):
    """An n x n WGS84 raster centered on ORIGIN (pixel in degrees)."""
    half = n * pixel / 2
    return from_origin(ORIGIN[0] - half, ORIGIN[1] + half, pixel, pixel), (n, n)


# 0.006 deg -> ~82 km diagonal (single calibration); 0.02 deg -> ~270 km (per-row correction).
@pytest.fixture(params=[0.006, 0.02], ids=["small", "large"])
def raster(request):
    return make_raster(request.param)


@pytest.fixture
def small():
    return make_raster(0.006)


def frame_of(transform, shape, lons, lats):
    diagonal = _raster_diagonal_km(transform, shape, geod=GEOD)
    return _local_en_km(np.asarray(lons, float), np.asarray(lats, float), ORIGIN, diagonal, GEOD)


def pixel_frame(transform, shape):
    lons, lats = _lonlat_grid(transform, 0, shape)
    return frame_of(transform, shape, lons, lats)


def implied_azimuth(transform, shape, lon, lat, azimuth):
    """The frame direction (degrees clockwise from north) a vector's mapped
    1 km step gives -- what the model actually treats as its azimuth."""
    lon2, lat2, _ = GEOD.fwd(lon, lat, azimuth, 1000.0)
    (e1,), (n1,) = frame_of(transform, shape, [lon], [lat])
    (e2,), (n2,) = frame_of(transform, shape, [lon2], [lat2])
    return float(np.degrees(np.arctan2(e2 - e1, n2 - n1)))


def build(vectors, raster, profile=PolynomialProfile((0.35,)), hinge=ORIGIN_HINGE, **kw):
    transform, shape = raster
    return build_vector_uplift_model(vectors, ORIGIN, transform, shape, profile, hinge, **kw)


def custom_linear(g):
    return {"family": "linear", "local_gradient": g, "rate_of_increase": None}


def custom_quadratic(g, k):
    return {"family": "quadratic", "local_gradient": g, "rate_of_increase": k}


# --- single-vector regression against the planar model -----------------------

@pytest.mark.parametrize("profile,hinge", [
    (PolynomialProfile((0.35,)), ORIGIN_HINGE),
    (PolynomialProfile((0.35, 0.003)), {"mode": "none"}),   # the guard sets the clamp
    (PolynomialProfile((0.35, 0.003)), ORIGIN_HINGE),
])
def test_single_vector_reproduces_the_planar_model(raster, profile, hinge):
    transform, shape = raster
    model, diag = build([Vector(*ORIGIN, 28.0)], raster, profile, hinge)
    east, north = pixel_frame(transform, shape)
    u = model.evaluate(east, north)

    az = implied_azimuth(transform, shape, *ORIGIN, 28.0)
    assert az == pytest.approx(28.0, abs=0.05)  # the mapping is a tiny correction, not a different azimuth
    d_h, source = profile.resolve_hinge(hinge["mode"], hinge.get("distance_km"))
    planar = PlanarUpliftModel(az, profile, d_h, source).evaluate(east, north)

    scale = np.abs(planar).max()
    assert np.abs(u - planar).max() <= 1e-6 * scale
    assert (model.hinge_d, model.hinge_source) == (d_h, source)
    assert diag["case"] == "A"
    # And against the nominal azimuth: bounded by that mapping correction only.
    nominal = PlanarUpliftModel(28.0, profile, d_h, source).evaluate(east, north)
    assert np.abs(u - nominal).max() <= 1e-3 * scale


def test_uniform_field_matches_the_single_vector_case(small):
    transform, shape = small
    profile = PolynomialProfile((0.35,))
    single, _ = build([Vector(*ORIGIN, 28.0)], small, profile)
    several, diag = build(
        [Vector(-105.1, 44.9, 28.0), Vector(-104.9, 45.1, 28.0), Vector(-105.05, 45.15, 28.0),
         Vector(-104.85, 44.85, 28.0)],
        small, profile)
    east, north = pixel_frame(transform, shape)
    u1, u2 = single.evaluate(east, north), several.evaluate(east, north)
    # Nominally equal azimuths differ in the frame by the (tiny) meridian-convergence correction.
    assert np.abs(u1 - u2).max() <= 2e-3 * np.abs(u1).max()
    assert diag["misfit_max_deg"] < 0.1
    assert diag["degenerate_fraction"] == 0.0


# --- a rotating field ---------------------------------------------------------

def test_rotating_field_bends_the_isobases_to_follow_the_vectors(small):
    transform, shape = small
    west, east = Vector(-105.2, 45.0, 2.5), Vector(-104.8, 45.0, 31.0)
    with warnings.catch_warnings():
        warnings.simplefilter("error")  # a consistent pair must not warn
        model, diag = build([west, east], small)
    assert diag["misfit_rms_deg"] < 5.0
    assert all(m < 5.0 for m in diag["misfit_deg"])

    # phi increases monotonically along the line joining the vectors (both
    # directions point somewhat east of north, so it climbs eastward).
    g = diag["grid"]
    (e_w, e_e), (n_w, n_e) = frame_of(transform, shape, [west.lon, east.lon], [west.lat, east.lat])
    t = np.linspace(0.0, 1.0, 200)
    phi_line = _sample(diag["phi_grid"], g["e0"], g["n0"], g["h"],
                       e_w + t * (e_e - e_w), n_w + t * (n_e - n_w))
    assert np.all(np.diff(phi_line) > 0)

    # Curved: the isobase normal (phi's gradient) differs between the two ends.
    grad_w = np.degrees(np.arctan2(*_grad(diag, e_w, n_w)))
    grad_e = np.degrees(np.arctan2(*_grad(diag, e_e, n_e)))
    assert grad_w == pytest.approx(2.5, abs=5.0)
    assert grad_e == pytest.approx(31.0, abs=5.0)
    assert grad_e - grad_w > 20.0


def _grad(diag, e, n):
    g = diag["grid"]
    h = g["h"]

    def phi(de, dn):
        return _sample(diag["phi_grid"], g["e0"], g["n0"], h, np.array([e + de]), np.array([n + dn]))[0]

    return phi(h, 0) - phi(-h, 0), phi(0, h) - phi(0, -h)   # (east, north) components


# --- degenerate / conflicting input -------------------------------------------

def test_opposing_vectors_warn_about_near_opposite_directions(small):
    with pytest.warns(UserWarning, match=r"near-opposite directions"):
        _, diag = build([Vector(-105.02, 45.0, 28.0), Vector(-104.98, 45.0, 208.0)], small)
    assert diag["degenerate_fraction"] > 0.01


def test_conflicting_vectors_warn_when_the_surface_cannot_honor_them(small):
    with pytest.warns(UserWarning, match=r"Vector \d+'s direction is off by"):
        _, diag = build([Vector(-105.02, 45.0, 0.0), Vector(-104.98, 45.0, 140.0)], small)
    assert diag["misfit_max_deg"] > 15.0
    assert diag["worst_vector"] in (0, 1)


def test_vector_far_outside_the_dem_warns_and_still_builds(small):
    with pytest.warns(UserWarning, match=r"Vector 2 lies far outside the DEM"):
        model, diag = build([Vector(*ORIGIN, 28.0), Vector(-95.0, 50.0, 28.0)], small)
    assert diag["misfit_deg"][1] is None       # not measurable outside the working grid
    assert diag["misfit_deg"][0] is not None
    assert isinstance(model, GridUpliftModel)


def test_coincident_vectors_do_not_break_the_default_range(small):
    _, diag = build([Vector(*ORIGIN, 28.0), Vector(*ORIGIN, 28.0)], small)
    assert all(r > 0 for r in diag["ranges_km"])


def test_given_range_is_used_and_default_range_is_the_median_neighbour_distance(small):
    _, diag = build([Vector(-105.1, 45.0, 28.0, range_km=12.5), Vector(-104.9, 45.0, 28.0)], small)
    (e1, e2), (n1, n2) = frame_of(*small, [-105.1, -104.9], [45.0, 45.0])
    assert diag["ranges_km"][0] == 12.5
    assert diag["ranges_km"][1] == pytest.approx(np.hypot(e2 - e1, n2 - n1))


def test_no_vectors_is_rejected(small):
    with pytest.raises(ValueError, match="At least one vector"):
        build([], small)


def test_every_vector_custom_needs_no_global_profile(small):
    model, diag = build([Vector(*ORIGIN, 28.0, custom=custom_linear(0.3))], small, profile=None)
    assert diag["case"] == "B"


def test_a_global_vector_needs_a_global_profile(small):
    with pytest.raises(ValueError, match="global profile is required"):
        build([Vector(*ORIGIN, 28.0)], small, profile=None)


# --- Case B: custom tilts ------------------------------------------------------

def test_custom_tilts_equal_to_the_global_profile_reproduce_case_a(small):
    """If each vector's custom tilt is what the global profile implies at its
    location, integrating the blended gradient (Case B) matches Case A."""
    transform, shape = small
    profile = PolynomialProfile((0.35, 0.004))       # gradient 0.35 + 0.008 * phi
    positions = [(-105.1, 45.0, 10.0), (-104.9, 45.0, 20.0), (-105.0, 45.15, 15.0)]
    plain = [Vector(lon, lat, az) for lon, lat, az in positions]
    _, diag = build(plain, small, profile)
    g = diag["grid"]
    (es, ns) = frame_of(transform, shape, [p[0] for p in positions], [p[1] for p in positions])
    phi_at = _sample(diag["phi_grid"], g["e0"], g["n0"], g["h"], es, ns)
    custom = [
        Vector(lon, lat, az, custom=custom_quadratic(profile.g(p), 0.008))
        for (lon, lat, az), p in zip(positions, phi_at)
    ]

    a_model, _ = build(plain, small, profile)
    b_model, b_diag = build(custom, small, profile)
    assert b_diag["case"] == "B"
    east, north = pixel_frame(transform, shape)
    ua, ub = a_model.evaluate(east, north), b_model.evaluate(east, north)
    # Case B integrates a field that is only approximately curl-free (least
    # squares, on the working grid), so the match is to a discretisation
    # tolerance, not exact.
    assert np.abs(ua - ub).max() <= 0.02 * np.abs(ua).max()


def test_custom_linear_equal_to_a_global_linear_profile_reproduces_case_a(small):
    transform, shape = small
    profile = PolynomialProfile((0.35,))
    plain = [Vector(-105.1, 45.0, 28.0), Vector(-104.9, 45.0, 28.0)]
    custom = [Vector(v.lon, v.lat, v.azimuth_deg, custom=custom_linear(0.35)) for v in plain]
    east, north = pixel_frame(transform, shape)
    ua = build(plain, small, profile)[0].evaluate(east, north)
    ub = build(custom, small, None)[0].evaluate(east, north)
    assert np.abs(ua - ub).max() <= 0.02 * np.abs(ua).max()


def test_steeper_custom_tilt_grows_uplift_faster_on_its_side(small):
    transform, shape = small
    gentle = Vector(-105.15, 45.0, 0.0, custom=custom_linear(0.3))
    steep = Vector(-104.85, 45.0, 0.0, custom=custom_linear(0.9))
    model, diag = build([gentle, steep], small, None)
    assert diag["case"] == "B"
    # Both vectors sit on the origin's parallel, so phi > 0 to their north.
    # Isobase spacing is dU/d(phi): compare the rise between 25 and 40 km north
    # of each vector. The steeper side rises faster (closer isobases), though the
    # inverse-distance blend pulls the two sides toward each other (~1.5x, not
    # 3x, at this vector spacing). Absolute U close to the spillway's parallel is
    # not compared: two different gradients at one azimuth are not curl-free, so
    # the least-squares surface trades some of the gradient for a slight tilt of
    # the U = 0 contour there (a few metres).
    es, ns = frame_of(transform, shape, [-105.15, -104.85], [45.0, 45.0])
    rise_gentle, rise_steep = model.evaluate(es, ns + 40.0) - model.evaluate(es, ns + 25.0)
    assert rise_steep > 1.3 * rise_gentle > 0


def test_origin_hinge_flattens_uplift_behind_the_spillway(small):
    """Gradient form of the origin hinge: G = 0 wherever phi < 0."""
    transform, shape = small
    model, diag = build([Vector(*ORIGIN, 0.0, custom=custom_linear(0.6))], small, None, ORIGIN_HINGE)
    g = diag["grid"]
    node_e = g["e0"] + g["h"] * np.arange(g["nx"])
    node_n = g["n0"] + g["h"] * np.arange(g["ny"])
    grid_e, grid_n = np.meshgrid(node_e, node_n)
    u = model.evaluate(grid_e, grid_n)
    behind = diag["phi_grid"] < -3 * g["h"]
    assert behind.any()
    assert np.abs(u[behind]).max() <= 0.01 * np.abs(u).max()
    assert u[diag["phi_grid"] > 3 * g["h"]].min() > 0


def test_hinge_none_only_the_guard_applies_behind_the_spillway(small):
    """`none` lets the field continue behind the spillway, but a gradient that
    would go negative there is held at zero (uplift never re-increases)."""
    transform, shape = small
    # gradient 0.2 at the vector, rising 0.01 per km up-tilt => negative 20+ km behind it.
    vec = Vector(*ORIGIN, 0.0, custom=custom_quadratic(0.2, 0.01))
    model, diag = build([vec], small, None, {"mode": "none"})
    assert diag["hinge_source"] == "guard"
    assert diag["hinge_km"] == pytest.approx(-20.0, abs=2 * diag["grid"]["h"])

    # Walk south (behind the spillway) along the origin's meridian.
    south = np.linspace(0.0, -35.0, 141)
    u = model.evaluate(np.zeros_like(south), south)
    steps = np.diff(u)
    assert steps.max() <= 1e-3 * np.abs(u).max()           # never rises again
    assert u[-1] < u[len(u) // 4]                          # but did fall before the clamp
    assert abs(u[-1] - u[-20]) <= 0.02 * abs(u[-1])       # flat past the guard point


def test_all_custom_vectors_resolve_a_distance_hinge_without_a_profile(small):
    _, diag = build([Vector(*ORIGIN, 0.0, custom=custom_linear(0.5))], small, None,
                    {"mode": "distance", "distance_km": 8.0})
    assert (diag["hinge_km"], diag["hinge_source"]) == (-8.0, "mode")
    with pytest.raises(ValueError, match="distance_km"):
        build([Vector(*ORIGIN, 0.0, custom=custom_linear(0.5))], small, None, {"mode": "distance"})


# --- windowed == in-memory -----------------------------------------------------

def test_windowed_and_in_memory_pipelines_agree_with_a_vectors_model(tmp_path):
    n, pixel = 60, 0.01
    transform = from_origin(-105.3, 45.3, pixel, pixel)
    dem = np.random.default_rng(3).uniform(400, 600, (n, n)).astype("float32")
    path = str(tmp_path / "dem.tif")
    with rasterio.open(path, "w", driver="GTiff", height=n, width=n, count=1, dtype="float32",
                       crs="EPSG:4326", transform=transform, nodata=-9999.0) as dst:
        dst.write(dem, 1)

    model, _ = build_vector_uplift_model(
        [Vector(-105.15, 45.0, 5.0), Vector(-104.85, 45.0, 30.0, custom=custom_linear(0.8))],
        ORIGIN, transform, (n, n), PolynomialProfile((0.4, 0.002)), ORIGIN_HINGE)
    in_memory = calculate_tilt(dem, transform, ORIGIN, 0.0, 0.0, uplift_model=model)
    out = str(tmp_path / "tilted.tif")
    tilt_DEM_windowed(path, out, ORIGIN, 0.0, 0.0, tile_size=17, uplift_model=model)
    with rasterio.open(out) as src:
        windowed = src.read(1)
    assert not np.allclose(in_memory, dem)          # the model really did something
    np.testing.assert_allclose(windowed, in_memory, atol=1e-3)


# --- isobases ------------------------------------------------------------------

def test_single_vector_isobases_are_straight_lines_perpendicular_to_the_arrow(small):
    transform, shape = small
    model, diag = build([Vector(*ORIGIN, 90.0)], small)     # arrow points east
    fc, interval = isobases_geojson(model, diag)
    levels = sorted({f["properties"]["uplift_m"] for f in fc["features"]})
    assert 0.0 in levels and 1 <= len(levels) <= 13
    for f in fc["features"]:
        lons, lats = np.array(f["geometry"]["coordinates"]).T
        e, n = frame_of(transform, shape, lons, lats)
        assert np.ptp(e) < 0.02 * max(np.ptp(n), 1e-9) + 0.3      # constant east => north-south line
    zero = next(f for f in fc["features"] if f["properties"]["uplift_m"] == 0.0)
    lons, lats = np.array(zero["geometry"]["coordinates"]).T
    assert np.allclose(lons, ORIGIN[0], atol=1e-3)                # the spillway isobase


def test_isobase_levels_are_nice_and_few(small):
    model, diag = build([Vector(*ORIGIN, 28.0)], small, PolynomialProfile((3.0,)))
    fc, interval = isobases_geojson(model, diag)
    mantissa = interval / 10 ** np.floor(np.log10(interval))
    assert round(mantissa, 6) in (1.0, 2.0, 5.0)
    assert len({f["properties"]["uplift_m"] for f in fc["features"]}) <= 13


# --- the spec-dict entry point ---------------------------------------------------

def test_build_from_spec_matches_direct_build_and_ignores_an_unused_profile(small):
    transform, shape = small
    spec = {
        "direction": {"type": "vectors", "vectors": [
            {"lat": 45.0, "lon": -105.0, "azimuth_deg": 28.0, "range_km": None,
             "custom": custom_linear(0.6)},
        ]},
        "profile": {"family": "linear", "rate_of_increase": None, "second_gradient": None,
                    "coefficients": None},
        "hinge": {"mode": "origin", "distance_km": None},
    }
    a, _ = build_vector_model_from_spec(spec, None, ORIGIN, transform, shape)   # no tilt_factor needed
    b, _ = build([Vector(*ORIGIN, 28.0, custom=custom_linear(0.6))], small, None)
    assert np.array_equal(a.values, b.values)
