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

import app


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
