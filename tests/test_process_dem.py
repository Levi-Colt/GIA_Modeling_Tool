"""
Integration tests for app.process_dem -- the orchestration layer.

Unlike the other test files, these exercise the full pipeline end-to-end
through process_dem itself, not individual main.py functions in isolation.
The windowed branch is forced by monkeypatching check_available_ram_mb,
since process_dem doesn't expose a way to inject the RAM budget directly.
"""
import glob
import os
import warnings

import numpy as np
import pytest
import rasterio
import geopandas as gpd
from rasterio.transform import from_origin

import backend.app as app


ORIGIN = (-104.95, 44.95)


def _write_dem(path, array, transform, nodata=-9999.0):
    profile = {
        "driver": "GTiff", "height": array.shape[0], "width": array.shape[1], "count": 1,
        "dtype": "float32", "crs": "EPSG:4326", "transform": transform, "nodata": nodata,
    }
    with rasterio.open(str(path), "w", **profile) as dst:
        dst.write(array, 1)
    return str(path)


def _sloped_dem(tmp_path, grid=10, pixel=0.01):
    transform = from_origin(-105.0, 45.0, pixel, pixel)
    row = np.arange(grid, dtype="float32") * 100.0
    array = np.tile(row, (grid, 1))
    path = _write_dem(tmp_path / "dem.tif", array, transform)
    return path, transform


def _force_windowed(monkeypatch):
    """Forces process_dem into the windowed branch regardless of file size."""
    monkeypatch.setattr(app, "check_available_ram_mb", lambda: 0.0001)


# --- standard (in-memory) branch ---

def test_standard_branch_produces_output_file(tmp_path):
    dem_path, _ = _sloped_dem(tmp_path)
    output_path = str(tmp_path / "output.gpkg")

    result = app.process_dem(dem_path, ORIGIN, 90, 0.0, 450, output_path, include_dem=True)

    assert result == output_path
    assert os.path.exists(output_path)


def test_standard_branch_writes_both_layers_when_include_dem_true(tmp_path):
    dem_path, _ = _sloped_dem(tmp_path)
    output_path = str(tmp_path / "output.gpkg")

    app.process_dem(dem_path, ORIGIN, 90, 0.0, 450, output_path, include_dem=True)

    assert "strandline_contour" in gpd.list_layers(output_path)["name"].values
    with rasterio.open(f"GPKG:{output_path}:modified_dem") as src:
        assert src.read(1).shape == (10, 10)


def test_standard_branch_omits_dem_layer_when_include_dem_false(tmp_path):
    dem_path, _ = _sloped_dem(tmp_path)
    output_path = str(tmp_path / "output.gpkg")

    app.process_dem(dem_path, ORIGIN, 90, 0.0, 450, output_path, include_dem=False)

    assert "strandline_contour" in gpd.list_layers(output_path)["name"].values
    with pytest.raises(rasterio.errors.RasterioIOError):
        rasterio.open(f"GPKG:{output_path}:modified_dem").close()


def test_standard_branch_contour_geometry_is_correct(tmp_path):
    dem_path, _ = _sloped_dem(tmp_path)
    output_path = str(tmp_path / "output.gpkg")

    app.process_dem(dem_path, ORIGIN, 90, 0.0, 450, output_path, include_dem=False)

    gdf = gpd.read_file(output_path, layer="strandline_contour")
    assert len(gdf) >= 1
    assert all(geom.geom_type == "LineString" for geom in gdf.geometry)


# --- windowed branch ---

def test_windowed_branch_produces_output_file(tmp_path, monkeypatch):
    _force_windowed(monkeypatch)
    dem_path, _ = _sloped_dem(tmp_path)
    output_path = str(tmp_path / "output.gpkg")

    result = app.process_dem(dem_path, ORIGIN, 90, 0.0, 450, output_path, include_dem=True)

    assert result == output_path
    assert os.path.exists(output_path)


def test_windowed_branch_handles_single_merged_linestring(tmp_path, monkeypatch):
    # Regression test: a simple linear gradient DEM produces one continuous
    # strandline, which linemerge returns as a plain LineString (not
    # MultiLineString). This used to crash with AttributeError.
    _force_windowed(monkeypatch)
    dem_path, _ = _sloped_dem(tmp_path)
    output_path = str(tmp_path / "output.gpkg")

    app.process_dem(dem_path, ORIGIN, 90, 0.0, 450, output_path, include_dem=False)

    gdf = gpd.read_file(output_path, layer="strandline_contour")
    assert len(gdf) >= 1


def test_windowed_branch_writes_both_layers_when_include_dem_true(tmp_path, monkeypatch):
    # Regression test: this used to emit a UserWarning about include_dem=True
    # negating the windowed pipeline's memory savings (write_dem_to_gpkg only
    # accepted a full in-memory array). write_dem_to_gpkg_windowed removed
    # that limitation, so no warning should fire anymore -- see
    # TARGET_ELEVATION_AND_GPKG_TASKS.md Task 7.
    _force_windowed(monkeypatch)
    dem_path, _ = _sloped_dem(tmp_path)
    output_path = str(tmp_path / "output.gpkg")

    with warnings.catch_warnings():
        warnings.simplefilter("error")
        app.process_dem(dem_path, ORIGIN, 90, 0.0, 450, output_path, include_dem=True)

    assert "strandline_contour" in gpd.list_layers(output_path)["name"].values
    with rasterio.open(f"GPKG:{output_path}:modified_dem") as src:
        assert src.read(1).shape == (10, 10)


def test_windowed_branch_cleans_up_temp_file_on_success(tmp_path, monkeypatch):
    _force_windowed(monkeypatch)
    dem_path, _ = _sloped_dem(tmp_path)
    output_path = str(tmp_path / "output.gpkg")

    before = set(glob.glob(os.path.join(tempfile_dir(), "tmp*.tif")))
    app.process_dem(dem_path, ORIGIN, 90, 0.0, 450, output_path, include_dem=True)
    after = set(glob.glob(os.path.join(tempfile_dir(), "tmp*.tif")))

    assert after - before == set()


def test_windowed_branch_cleans_up_temp_file_on_failure(tmp_path, monkeypatch):
    _force_windowed(monkeypatch)
    dem_path, _ = _sloped_dem(tmp_path)
    output_path = str(tmp_path / "output.gpkg")

    def boom(*args, **kwargs):
        raise RuntimeError("forced failure for cleanup test")
    monkeypatch.setattr(app, "extract_strandline_contours_windowed", boom)

    before = set(glob.glob(os.path.join(tempfile_dir(), "tmp*.tif")))
    with pytest.raises(RuntimeError, match="forced failure"):
        app.process_dem(dem_path, ORIGIN, 90, 0.0, 450, output_path, include_dem=True)
    after = set(glob.glob(os.path.join(tempfile_dir(), "tmp*.tif")))

    assert after - before == set()


def tempfile_dir():
    import tempfile
    return tempfile.gettempdir()


# --- Fix 3 contour cleanup (documentation/PERFORMANCE_OPTIMIZATION_SPEC.md) ---

def test_contours_below_min_vertex_count_are_dropped(tmp_path, monkeypatch):
    # The sloped-dem contour at this grid size has only a handful of
    # vertices; raising the threshold above that count should make the
    # cleanup step drop it entirely, confirming the filter is actually wired
    # into process_dem (not just defined and unused).
    monkeypatch.setattr(app, "MIN_CONTOUR_VERTICES", 1000)
    dem_path, _ = _sloped_dem(tmp_path)
    output_path = str(tmp_path / "output.gpkg")

    app.process_dem(dem_path, ORIGIN, 90, 0.0, 450, output_path, include_dem=False)

    gdf = gpd.read_file(output_path, layer="strandline_contour")
    assert len(gdf) == 0


def test_default_min_vertex_count_does_not_drop_a_normal_contour(tmp_path):
    dem_path, _ = _sloped_dem(tmp_path)
    output_path = str(tmp_path / "output.gpkg")

    app.process_dem(dem_path, ORIGIN, 90, 0.0, 450, output_path, include_dem=False)

    gdf = gpd.read_file(output_path, layer="strandline_contour")
    assert len(gdf) >= 1


def test_contour_geometry_is_simplified(tmp_path, monkeypatch):
    # Disable simplification and compare against the default: the default
    # run's geometry should have no more vertices than the unsimplified one
    # (simplify never adds points), confirming it's actually applied.
    dem_path, _ = _sloped_dem(tmp_path, grid=30, pixel=0.001)

    unsimplified_path = str(tmp_path / "unsimplified.gpkg")
    monkeypatch.setattr(app, "CONTOUR_SIMPLIFY_TOLERANCE_DEG", 0.0)
    app.process_dem(dem_path, ORIGIN, 90, 0.0, 450, unsimplified_path, include_dem=False)
    unsimplified_gdf = gpd.read_file(unsimplified_path, layer="strandline_contour")

    monkeypatch.undo()
    simplified_path = str(tmp_path / "simplified.gpkg")
    app.process_dem(dem_path, ORIGIN, 90, 0.0, 450, simplified_path, include_dem=False)
    simplified_gdf = gpd.read_file(simplified_path, layer="strandline_contour")

    assert len(simplified_gdf.geometry.iloc[0].coords) <= len(unsimplified_gdf.geometry.iloc[0].coords)


# --- orchestration-level fixes ---

def test_creates_missing_output_directory(tmp_path):
    dem_path, _ = _sloped_dem(tmp_path)
    output_path = str(tmp_path / "nested" / "dirs" / "output.gpkg")

    result = app.process_dem(dem_path, ORIGIN, 90, 0.0, 450, output_path, include_dem=False)

    assert os.path.exists(result)


def test_rerunning_against_same_output_path_does_not_crash(tmp_path):
    # Regression test: write_dem_to_gpkg raises if a raster table of the
    # same name already exists at the path. process_dem needs to clear any
    # pre-existing output before writing so re-running the pipeline against
    # the same path (a very normal thing to do) doesn't crash.
    dem_path, _ = _sloped_dem(tmp_path)
    output_path = str(tmp_path / "output.gpkg")

    app.process_dem(dem_path, ORIGIN, 90, 0.0, 450, output_path, include_dem=True)
    result = app.process_dem(dem_path, ORIGIN, 90, 0.0, 450, output_path, include_dem=True)

    assert result == output_path
    with rasterio.open(f"GPKG:{output_path}:modified_dem") as src:
        assert src.read(1).shape == (10, 10)


def test_rerunning_with_different_parameters_reflects_the_new_run(tmp_path):
    # Not just "doesn't crash" -- the second run's output should fully
    # replace the first, not merge with or append to it.
    dem_path, transform = _sloped_dem(tmp_path)
    output_path = str(tmp_path / "output.gpkg")

    app.process_dem(dem_path, ORIGIN, 90, 0.0, 450, output_path, include_dem=False)
    first_gdf = gpd.read_file(output_path, layer="strandline_contour")

    app.process_dem(dem_path, ORIGIN, 90, 0.0, 250, output_path, include_dem=False)
    second_gdf = gpd.read_file(output_path, layer="strandline_contour")

    # Different target elevations on this gradient DEM should produce
    # contours at different locations, not accumulate together.
    assert not first_gdf.geometry.iloc[0].equals(second_gdf.geometry.iloc[0])


# --- selection radius (documentation/SELECTION_RADIUS_SPEC.md B1) ---

DOME_ORIGIN = (-104.9, 44.9)   # the dome's center
DOME_TARGET = 700.0            # a ring ~7.5px (~6-8 km) out from the center


def _dome_dem(tmp_path, grid=20, pixel=0.01):
    """Radial dome, so DOME_TARGET contours as a closed ring around DOME_ORIGIN."""
    transform = from_origin(-105.0, 45.0, pixel, pixel)
    y, x = np.indices((grid, grid))
    radius = np.sqrt((x - grid / 2) ** 2 + (y - grid / 2) ** 2)
    array = (1000.0 - radius * 40.0).astype("float32")
    return _write_dem(tmp_path / "dome.tif", array, transform)


def _run_dome(tmp_path, name="out.gpkg", **kwargs):
    output_path = str(tmp_path / name)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        app.process_dem(_dome_dem(tmp_path), DOME_ORIGIN, 90, 0.0, DOME_TARGET,
                        output_path, include_dem=False, **kwargs)
    return gpd.read_file(output_path, layer="strandline_contour"), [str(w.message) for w in caught]


def test_selection_radius_none_matches_omitting_the_argument(tmp_path):
    omitted, _ = _run_dome(tmp_path, "omitted.gpkg")
    explicit_none, _ = _run_dome(tmp_path, "none.gpkg", selection_radius_km=None)

    assert len(omitted) >= 1
    assert [g.wkb for g in omitted.geometry] == [g.wkb for g in explicit_none.geometry]


def test_selection_radius_that_reaches_the_ring_keeps_it_whole(tmp_path):
    unfiltered, _ = _run_dome(tmp_path, "unfiltered.gpkg")
    filtered, caught = _run_dome(tmp_path, "filtered.gpkg", selection_radius_km=20.0)

    assert [g.wkb for g in filtered.geometry] == [g.wkb for g in unfiltered.geometry]
    assert not any("selection radius" in m for m in caught)


def test_selection_radius_too_small_yields_empty_valid_gpkg_and_warning(tmp_path):
    filtered, caught = _run_dome(tmp_path, selection_radius_km=1.0)

    assert len(filtered) == 0
    assert any("Try a larger selection radius" in m for m in caught)


def test_selection_radius_empty_result_keeps_dem_layer_when_include_dem_true(tmp_path):
    output_path = str(tmp_path / "out.gpkg")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        app.process_dem(_dome_dem(tmp_path), DOME_ORIGIN, 90, 0.0, DOME_TARGET,
                        output_path, include_dem=True, selection_radius_km=1.0)

    assert len(gpd.read_file(output_path, layer="strandline_contour")) == 0
    with rasterio.open(f"GPKG:{output_path}:modified_dem") as src:
        assert src.read(1).shape == (20, 20)


def test_selection_radius_agrees_between_in_memory_and_windowed_branches(tmp_path, monkeypatch):
    for radius in (20.0, 1.0):
        in_memory, _ = _run_dome(tmp_path, f"mem_{radius}.gpkg", selection_radius_km=radius)
        with monkeypatch.context() as m:
            _force_windowed(m)
            # The forced-tiny RAM budget would otherwise pick a degenerate
            # 1px tile; use tiles small enough that the ring spans several.
            m.setattr(app, "largest_safe_tile_size", lambda *a, **k: 8)
            windowed, _ = _run_dome(tmp_path, f"win_{radius}.gpkg", selection_radius_km=radius)

        assert len(in_memory) == len(windowed)
        assert sum(g.length for g in in_memory.geometry) == pytest.approx(
            sum(g.length for g in windowed.geometry), rel=1e-3
        )
        if radius == 20.0:
            # Must actually have kept something, or the comparison above
            # would trivially pass on two empty results.
            assert len(in_memory) >= 1
        else:
            assert len(in_memory) == 0
