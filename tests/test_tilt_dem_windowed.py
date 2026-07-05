"""
Unit tests for main.tilt_DEM_windowed, in isolation from the standard
calculate_tilt pipeline (see test_pipeline_equivalence.py for tests that
compare the two directly).

Since tilt_DEM_windowed streams through a file's native block windows and
writes straight to disk, these tests read the output back from disk rather
than getting an in-memory array directly.

Grid geometry reminder (see conftest.standard_transform):
  - 10x10 grid, 0.01 degree pixels
  - top-left corner at (lon=-105.0, lat=45.0)
  - bounding box: lon in [-105.0, -104.9], lat in [44.9, 45.0]
"""
import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from main import tilt_DEM_windowed

CENTER = (-104.95, 44.95)
OUTSIDE = (-200.0, 45.0)
TOP_LEFT_CORNER = (-105.0, 45.0)


def _run(dem_path, output_path, origin, azimuth, factor):
    """Small helper: run tilt_DEM_windowed and read the result back."""
    out_path, out_transform, out_crs = tilt_DEM_windowed(dem_path, output_path, origin, azimuth, factor)
    with rasterio.open(out_path) as src:
        array = src.read(1)
    return array, out_transform, out_crs


def test_modifies_cells_in_front_reduces_elevation(flat_dem_path, flat_dem_array, tmp_path):
    output_path = str(tmp_path / "out.tif")
    tilted, _, _ = _run(flat_dem_path, output_path, CENTER, 90, 5.0)
    assert tilted[:, -1].mean() < flat_dem_array[:, -1].mean()


def test_does_not_modify_cells_behind_origin(flat_dem_path, flat_dem_array, tmp_path):
    output_path = str(tmp_path / "out.tif")
    tilted, _, _ = _run(flat_dem_path, output_path, CENTER, 90, 5.0)
    np.testing.assert_allclose(tilted[:, 0], flat_dem_array[:, 0])


def test_zero_tilt_factor_leaves_array_unchanged(flat_dem_path, flat_dem_array, tmp_path):
    output_path = str(tmp_path / "out.tif")
    tilted, _, _ = _run(flat_dem_path, output_path, CENTER, 90, 0.0)
    np.testing.assert_allclose(tilted, flat_dem_array)


def test_negative_tilt_factor_raises_elevation_instead_of_lowering(flat_dem_path, flat_dem_array, tmp_path):
    output_path = str(tmp_path / "out.tif")
    tilted, _, _ = _run(flat_dem_path, output_path, CENTER, 90, -5.0)
    assert tilted[:, -1].mean() > flat_dem_array[:, -1].mean()


def test_returns_path_transform_and_crs(flat_dem_path, tmp_path):
    output_path = str(tmp_path / "out.tif")
    result = tilt_DEM_windowed(flat_dem_path, output_path, CENTER, 90, 5.0)
    assert len(result) == 3
    out_path, out_transform, out_crs = result
    assert out_path == output_path
    assert isinstance(out_transform, rasterio.Affine)
    assert out_crs is not None


def test_output_dtype_is_float32(flat_dem_path, tmp_path):
    output_path = str(tmp_path / "out.tif")
    out_path, _, _ = tilt_DEM_windowed(flat_dem_path, output_path, CENTER, 90, 5.0)
    with rasterio.open(out_path) as src:
        assert src.dtypes[0] == "float32"


def test_nodata_pixels_become_nan_in_output(tmp_path, standard_transform, raster_writer):
    array = np.full((10, 10), 1000.0, dtype="float32")
    array[0, 0] = -9999.0
    dem_path = raster_writer(tmp_path / "with_nodata.tif", array, standard_transform, nodata=-9999.0)

    output_path = str(tmp_path / "out.tif")
    tilted, _, _ = _run(dem_path, output_path, CENTER, 90, 5.0)
    assert np.isnan(tilted[0, 0])


def test_origin_outside_raster_warns_disconnected(flat_dem_path, tmp_path):
    output_path = str(tmp_path / "out.tif")
    with pytest.warns(UserWarning, match="outside the raster's extent"):
        tilt_DEM_windowed(flat_dem_path, output_path, OUTSIDE, 90, 5.0)


def test_origin_on_edge_does_not_warn(flat_dem_path, tmp_path):
    output_path = str(tmp_path / "out.tif")
    import warnings
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        tilt_DEM_windowed(flat_dem_path, output_path, TOP_LEFT_CORNER, 90, 5.0)
    disconnected = [w for w in caught if "outside the raster's extent" in str(w.message)]
    assert not disconnected


# --- windowed-specific edge cases ---

def test_block_size_parameter_is_currently_ignored(flat_dem_path, flat_dem_array, tmp_path):
    # KNOWN GAP: block_size is accepted as a parameter but never actually
    # used -- the function streams through the file's NATIVE block windows
    # (src.block_windows(1)) regardless of what's passed here. This test
    # documents that the parameter is currently a no-op so it doesn't get
    # mistaken for a working knob, and so a real implementation change here
    # would be caught by this test needing an update.
    out_a = str(tmp_path / "out_a.tif")
    out_b = str(tmp_path / "out_b.tif")
    tilted_a, _, _ = _run(flat_dem_path, out_a, CENTER, 90, 5.0)
    result_b = tilt_DEM_windowed(flat_dem_path, out_b, CENTER, 90, 5.0, block_size=1)
    with rasterio.open(result_b[0]) as src:
        tilted_b = src.read(1)
    np.testing.assert_allclose(tilted_a, tilted_b)


def test_disconnected_origin_warns_only_once_across_multiple_blocks(tmp_path):
    # Regression guard for the fix that moved the disconnected-origin check
    # out of the per-block calculate_tilt calls and into a single upfront
    # check: a raster with many native blocks should still only warn ONCE,
    # not once per block.
    transform = from_origin(-105.0, 45.0, 0.001, 0.001)
    grid = 100
    array = np.full((grid, grid), 1000.0, dtype="float32")
    dem_path = str(tmp_path / "big_dem.tif")
    profile = {
        "driver": "GTiff", "height": grid, "width": grid, "count": 1,
        "dtype": "float32", "crs": "EPSG:4326", "transform": transform,
        "nodata": -9999.0,
        "tiled": True, "blockxsize": 16, "blockysize": 16,  # forces many native blocks
    }
    with rasterio.open(dem_path, "w", **profile) as dst:
        dst.write(array, 1)

    output_path = str(tmp_path / "out.tif")
    import warnings
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        tilt_DEM_windowed(dem_path, output_path, OUTSIDE, 90, 5.0)
    disconnected = [w for w in caught if "outside the raster's extent" in str(w.message)]
    assert len(disconnected) == 1


def test_every_pixel_written_exactly_once_across_blocks(tmp_path):
    # Native block windows must tile the raster with no gaps and no overlaps.
    # A DEM where every pixel is uniquely identifiable by value makes any
    # gap (leftover from the initial file, e.g. 0 or nodata) or overlap
    # (double-processed pixel with an unexpected value) detectable.
    transform = from_origin(-105.0, 45.0, 0.001, 0.001)
    grid = 37  # deliberately not a clean multiple of typical block sizes
    yy, xx = np.indices((grid, grid))
    array = (yy * grid + xx).astype("float32")  # every cell has a unique value
    dem_path = str(tmp_path / "unique_dem.tif")
    profile = {
        "driver": "GTiff", "height": grid, "width": grid, "count": 1,
        "dtype": "float32", "crs": "EPSG:4326", "transform": transform,
        "tiled": True, "blockxsize": 16, "blockysize": 16,
    }
    with rasterio.open(dem_path, "w", **profile) as dst:
        dst.write(array, 1)

    output_path = str(tmp_path / "out.tif")
    # tilt_factor=0 isolates this test to the block-iteration/writing logic,
    # not the tilt math -- output should exactly equal input.
    tilted, _, _ = _run(dem_path, output_path, CENTER, 90, 0.0)
    np.testing.assert_array_equal(tilted, array)


def test_output_matches_regardless_of_source_block_layout(flat_dem_array, standard_transform, tmp_path):
    # Whether the source file is internally tiled or plain-striped shouldn't
    # change the tilt result -- src.block_windows(1) reflects whatever the
    # source's native layout is, and the function should be correct either way.
    striped_path = str(tmp_path / "striped.tif")
    tiled_path = str(tmp_path / "tiled.tif")
    striped_profile = {
        "driver": "GTiff", "height": 10, "width": 10, "count": 1,
        "dtype": "float32", "crs": "EPSG:4326", "transform": standard_transform,
        "nodata": -9999.0,
    }
    tiled_profile = dict(striped_profile, tiled=True, blockxsize=16, blockysize=16)

    with rasterio.open(striped_path, "w", **striped_profile) as dst:
        dst.write(flat_dem_array, 1)
    with rasterio.open(tiled_path, "w", **tiled_profile) as dst:
        dst.write(flat_dem_array, 1)

    striped_out = str(tmp_path / "striped_out.tif")
    tiled_out = str(tmp_path / "tiled_out.tif")
    striped_tilted, _, _ = _run(striped_path, striped_out, CENTER, 90, 5.0)
    tiled_tilted, _, _ = _run(tiled_path, tiled_out, CENTER, 90, 5.0)

    np.testing.assert_allclose(striped_tilted, tiled_tilted)
