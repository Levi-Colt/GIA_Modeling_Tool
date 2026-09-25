"""
process_dem's `uplift_model` keyword (documentation/UPLIFT_MODEL_SPEC.md D2/D3):
basic-path identity, model precedence, memory sizing, and extent-dependent warnings.
"""
import warnings

import geopandas as gpd
import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

import backend.app as app
from backend.uplift import build_uplift_model, linear_planar_model

ORIGIN = (-104.95, 44.95)
GRID = 20
PIXEL = 0.01


@pytest.fixture
def dem_path(tmp_path):
    transform = from_origin(-105.0, 45.0, PIXEL, PIXEL)
    row = np.arange(GRID, dtype="float32") * 50.0
    array = np.tile(row, (GRID, 1))
    path = str(tmp_path / "dem.tif")
    profile = {
        "driver": "GTiff", "height": GRID, "width": GRID, "count": 1, "dtype": "float32",
        "crs": "EPSG:4326", "transform": transform, "nodata": -9999.0,
    }
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(array, 1)
    return path


def _spec(family, mode, rate=None, coefficients=None, distance_km=None):
    return {
        "version": 1, "direction": {"type": "azimuth"},
        "profile": {"family": family, "rate_of_increase": rate, "coefficients": coefficients},
        "hinge": {"mode": mode, "distance_km": distance_km},
    }


def _contour(tmp_path, dem_path, name, **kwargs):
    out = str(tmp_path / f"{name}.gpkg")
    app.process_dem(dem_path, ORIGIN, 90.0, 20.0, 300.0, out, include_dem=False, **kwargs)
    return gpd.read_file(out, layer="strandline_contour")


def test_explicit_linear_model_matches_basic_run(tmp_path, dem_path):
    basic = _contour(tmp_path, dem_path, "basic")
    modeled = _contour(tmp_path, dem_path, "modeled", uplift_model=linear_planar_model(90.0, 20.0))
    assert len(basic) > 0
    assert basic.geometry.equals(modeled.geometry)


def test_uplift_model_takes_precedence_over_azimuth_and_factor(tmp_path, dem_path):
    basic = _contour(tmp_path, dem_path, "basic")
    # Bogus tilt_azimuth/tilt_factor positional args (see _contour: 90, 20) are
    # overridden by the model's own.
    other = _contour(tmp_path, dem_path, "other", uplift_model=linear_planar_model(180.0, 0.0))
    assert not basic.geometry.equals(other.geometry)


def test_quadratic_model_changes_the_contour(tmp_path, dem_path):
    linear = _contour(tmp_path, dem_path, "linear", uplift_model=build_uplift_model(
        _spec("linear", "origin"), 90.0, 20.0))
    quad = _contour(tmp_path, dem_path, "quad", uplift_model=build_uplift_model(
        _spec("quadratic", "origin", rate=4.0), 90.0, 20.0))
    assert len(quad) > 0
    assert not linear.geometry.equals(quad.geometry)


def _record_tilt_cost(monkeypatch):
    costs = []
    real = app.largest_safe_tile_size

    def spy(width, height, free_ram, per_pixel_cost, *a, **k):
        costs.append(per_pixel_cost)
        return real(width, height, free_ram, per_pixel_cost, *a, **k)

    monkeypatch.setattr(app, "largest_safe_tile_size", spy)
    return costs


@pytest.mark.parametrize("windowed", [False, True])
def test_tilt_sizing_adds_the_models_extra_bytes(tmp_path, dem_path, monkeypatch, windowed):
    if windowed:
        monkeypatch.setattr(app, "check_available_ram_mb", lambda: 0.0001)
    costs = _record_tilt_cost(monkeypatch)

    _contour(tmp_path, dem_path, "basic")
    assert costs[0] == app.TILT_BYTES_PER_PIXEL

    costs.clear()
    model = build_uplift_model(_spec("quadratic", "origin", rate=4.0), 90.0, 20.0)
    _contour(tmp_path, dem_path, "quad", uplift_model=model)
    assert costs[0] == app.TILT_BYTES_PER_PIXEL + 16

    costs.clear()
    _contour(tmp_path, dem_path, "lin", uplift_model=linear_planar_model(90.0, 20.0))
    assert costs[0] == app.TILT_BYTES_PER_PIXEL


def test_quadratic_agrees_between_in_memory_and_windowed(tmp_path, dem_path, monkeypatch):
    model = build_uplift_model(_spec("quadratic", "none", rate=4.0), 90.0, 20.0)
    in_memory = _contour(tmp_path, dem_path, "mem", uplift_model=model)
    monkeypatch.setattr(app, "check_available_ram_mb", lambda: 0.0001)
    windowed = _contour(tmp_path, dem_path, "win", uplift_model=model)
    # Fragment counts can differ (the windowed merge may leave a contour in
    # pieces); compare the physical strandline instead.
    assert len(in_memory) > 0 and len(windowed) > 0
    assert in_memory.total_bounds == pytest.approx(windowed.total_bounds, abs=2 * PIXEL)
    assert in_memory.geometry.length.sum() == pytest.approx(windowed.geometry.length.sum(), rel=0.02)


def test_forward_sign_change_warning_surfaces_from_process_dem(tmp_path, dem_path):
    # g(d) = 20 - 40 d flips sign ~0.5 km up-tilt, well inside the ~2 km DEM.
    model = build_uplift_model(_spec("quadratic", "origin", rate=-40.0), 90.0, 20.0)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        app.process_dem(dem_path, ORIGIN, 90.0, 20.0, 300.0, str(tmp_path / "o.gpkg"),
                        include_dem=False, uplift_model=model)
    assert any("changes sign" in str(w.message) for w in caught)


def test_basic_run_emits_no_uplift_warnings(tmp_path, dem_path):
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        app.process_dem(dem_path, ORIGIN, 90.0, 20.0, 300.0, str(tmp_path / "o.gpkg"), include_dem=False)
    assert not any("changes sign" in str(w.message) or "gradient" in str(w.message) for w in caught)
