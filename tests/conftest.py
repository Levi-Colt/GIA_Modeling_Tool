"""
Shared fixtures for the GIA Modeling Tool test suite.

Rather than depending on real USGS DEM tiles, every test in this suite works
against small synthetic GeoTIFFs written to disk in a pytest tmp_path. This
keeps tests fast, deterministic, and independent of any specific machine's
filesystem or downloaded data.
"""
import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin


# A simple 10x10 grid, ~0.01 degree pixels, anchored near a real-ish location.
# Top-left corner at (-105.0, 45.0); pixel size 0.01 deg in both directions.
GRID_SIZE = 10
PIXEL_SIZE = 0.01
ORIGIN_LON = -105.0
ORIGIN_LAT = 45.0


def write_raster(path, array, transform, crs="EPSG:4326", dtype=None, nodata=None):
    """
    Writes a single-band (or multi-band, if array is 3D) GeoTIFF to `path`.
    Returns the path as a string for convenience.
    """
    array = np.asarray(array)
    if array.ndim == 2:
        height, width = array.shape
        count = 1
    else:
        count, height, width = array.shape

    profile = {
        "driver": "GTiff",
        "height": height,
        "width": width,
        "count": count,
        "dtype": dtype or str(array.dtype),
        "crs": crs,
        "transform": transform,
    }
    if nodata is not None:
        profile["nodata"] = nodata

    with rasterio.open(str(path), "w", **profile) as dst:
        if count == 1:
            dst.write(array, 1)
        else:
            for band_idx in range(count):
                dst.write(array[band_idx], band_idx + 1)

    return str(path)


@pytest.fixture
def standard_transform():
    """Affine transform for the standard 10x10 test grid."""
    return from_origin(ORIGIN_LON, ORIGIN_LAT, PIXEL_SIZE, PIXEL_SIZE)


@pytest.fixture
def flat_dem_array():
    """A perfectly flat 10x10 DEM at 1000.0 meters everywhere."""
    return np.full((GRID_SIZE, GRID_SIZE), 1000.0, dtype="float32")


@pytest.fixture
def sloped_dem_array():
    """
    A 10x10 DEM that increases in elevation from left (0) to right (900),
    100 meters per column. Useful for contour and tilt tests where a
    predictable gradient matters.
    """
    row = np.arange(GRID_SIZE, dtype="float32") * 100.0
    return np.tile(row, (GRID_SIZE, 1))


@pytest.fixture
def flat_dem_path(tmp_path, standard_transform, flat_dem_array):
    """A flat, well-formed float32 DEM with nodata defined."""
    path = tmp_path / "flat_dem.tif"
    return write_raster(path, flat_dem_array, standard_transform, nodata=-9999.0)


@pytest.fixture
def sloped_dem_path(tmp_path, standard_transform, sloped_dem_array):
    """A sloped, well-formed float32 DEM with nodata defined."""
    path = tmp_path / "sloped_dem.tif"
    return write_raster(path, sloped_dem_array, standard_transform, nodata=-9999.0)


@pytest.fixture
def int16_dem_path(tmp_path, standard_transform, sloped_dem_array):
    """A DEM stored as int16 (smaller than float32; casting is safe/no truncation)."""
    path = tmp_path / "int16_dem.tif"
    return write_raster(
        path, sloped_dem_array.astype("int16"), standard_transform,
        dtype="int16", nodata=-9999,
    )


@pytest.fixture
def float64_dem_path(tmp_path, standard_transform, sloped_dem_array):
    """A DEM stored as float64 (greater precision than float32; casting truncates)."""
    path = tmp_path / "float64_dem.tif"
    return write_raster(
        path, sloped_dem_array.astype("float64"), standard_transform,
        dtype="float64", nodata=-9999.0,
    )


@pytest.fixture
def no_nodata_dem_path(tmp_path, standard_transform, flat_dem_array):
    """A well-formed DEM that has no nodata value defined at all."""
    path = tmp_path / "no_nodata_dem.tif"
    return write_raster(path, flat_dem_array, standard_transform, nodata=None)


@pytest.fixture
def multiband_dem_path(tmp_path, standard_transform, flat_dem_array):
    """A DEM with 3 bands, where only band 1 should be used."""
    path = tmp_path / "multiband_dem.tif"
    stacked = np.stack([flat_dem_array, flat_dem_array + 1, flat_dem_array + 2])
    return write_raster(path, stacked, standard_transform, nodata=-9999.0)


@pytest.fixture
def raster_writer():
    """Returns the write_raster helper so tests can build custom rasters on the fly."""
    return write_raster


@pytest.fixture
def malformed_file_path(tmp_path):
    """A file that exists but is not a valid raster."""
    path = tmp_path / "not_a_raster.tif"
    path.write_text("this is definitely not a GeoTIFF")
    return str(path)
