"""
Bit-identity regression guard for the uplift-model refactor
(documentation/UPLIFT_MODEL_SPEC.md D2 / D7).

`_legacy_tilt_block` and `_legacy_calculate_tilt` below are frozen, verbatim
copies of backend/main.py's `_tilt_block` and `calculate_tilt` chunking logic
as they stood BEFORE the refactor. Basic mode (no `uplift_model`) must
reproduce them with `np.array_equal` -- not `allclose`. Do not loosen these
assertions to make a change pass; if they fail, the refactor changed the
arithmetic.

Only the helpers the legacy code depends on (`_lonlat_grid`,
`_local_scale_factors`, `_raster_diagonal_km`, `RECALIBRATION_THRESHOLD_KM`)
are imported from backend.main; those are untouched by the refactor.
"""
import numpy as np
import pytest
from pyproj import Geod
from rasterio.transform import Affine, from_origin

from backend.main import (
    RECALIBRATION_THRESHOLD_KM,
    _local_scale_factors,
    _lonlat_grid,
    _raster_diagonal_km,
    calculate_tilt,
)


# --- Frozen copy of the pre-refactor implementation (do not edit) -----------

def _legacy_tilt_block(block, transform, row_offset, origin_coords, tilt_azimuth, tilt_factor,
                       diagonal_km, geod):
    """
    Computes the tilted elevation for one row-strip (or the whole array, if
    it isn't being chunked) -- the calibrated flat-plane replacement for the
    old per-pixel Geod.inv() call (Fix 1b/1c). See calculate_tilt's own
    docstring for the public contract.
    """
    lon0, lat0 = origin_coords
    lons, lats = _lonlat_grid(transform, row_offset, block.shape)
    m_per_deg_lon0, m_per_deg_lat0 = _local_scale_factors(geod, lon0, lat0)

    if diagonal_km < RECALIBRATION_THRESHOLD_KM:
        m_per_deg_lon = m_per_deg_lon0
    else:
        m_per_deg_lon = m_per_deg_lon0 * np.cos(np.radians(lats)) / np.cos(np.radians(lat0))

    east_km = (lons - lon0) * m_per_deg_lon / 1000.0
    north_km = (lats - lat0) * m_per_deg_lat0 / 1000.0

    tilt_rad = np.radians(tilt_azimuth)
    projected_distance_km = east_km * np.sin(tilt_rad) + north_km * np.cos(tilt_rad)

    # This prevents the "south" cells from experiencing any elevation change.
    projected_distance_km = np.where(projected_distance_km < 0, 0, projected_distance_km)

    # Compute elevation adjustments (tilt_factor is in meters per kilometer)
    elevation_delta = projected_distance_km * tilt_factor

    # Return the newly modified landscape block
    return block - elevation_delta


def _legacy_calculate_tilt(DEM_array, transform, origin_coords, tilt_azimuth, tilt_factor,
                           diagonal_km=None, chunk_rows=None):
    geod = Geod(ellps='WGS84')
    if diagonal_km is None:
        diagonal_km = _raster_diagonal_km(transform, DEM_array.shape, geod=geod)

    height = DEM_array.shape[0]
    if not chunk_rows or chunk_rows >= height:
        return _legacy_tilt_block(DEM_array, transform, 0, origin_coords, tilt_azimuth, tilt_factor,
                                  diagonal_km, geod)

    out = np.empty_like(DEM_array, dtype='float32')
    for row_start in range(0, height, chunk_rows):
        row_end = min(row_start + chunk_rows, height)
        out[row_start:row_end] = _legacy_tilt_block(
            DEM_array[row_start:row_end], transform, row_start, origin_coords, tilt_azimuth,
            tilt_factor, diagonal_km, geod,
        )
    return out


# --- Fixtures ---------------------------------------------------------------

def _dome(shape):
    """Non-trivial float32 surface (so a wrong sign/order can't hide in a flat DEM)."""
    y, x = np.indices(shape)
    return (500.0 + 3.0 * x - 2.0 * y + 40.0 * np.sin(x / 7.0)).astype("float32")


SMALL = dict(  # 40x40 at 0.005 deg: ~ 28 km diagonal -> single-calibration path
    transform=from_origin(-105.0, 45.0, 0.005, 0.005), shape=(40, 40), origin=(-104.9, 44.9),
)
LARGE = dict(  # 300x300 at 0.01 deg: ~ 423 km diagonal -> per-row cos(lat) path
    transform=from_origin(-110.0, 40.0, 0.01, 0.01), shape=(300, 300), origin=(-108.5, 38.5),
)
NON_SQUARE = dict(
    transform=from_origin(-105.0, 45.0, 0.02, 0.005), shape=(30, 30), origin=(-104.7, 44.9),
)
ROTATED = dict(  # exercises _lonlat_grid's per-pixel affine fallback
    transform=Affine(0.005, 0.0004, -105.0, 0.0003, -0.005, 45.0), shape=(40, 40),
    origin=(-104.9, 44.9),
)
GRIDS = {"small": SMALL, "large": LARGE, "non_square": NON_SQUARE, "rotated": ROTATED}

AZIMUTH_FACTORS = [(0.0, 0.5), (28.0, 0.35), (90.0, 5.0), (225.0, 3.0), (-90.0, -2.0), (450.0, 1.0)]


@pytest.mark.parametrize("grid_name", sorted(GRIDS))
@pytest.mark.parametrize("azimuth,factor", AZIMUTH_FACTORS)
@pytest.mark.parametrize("chunk_rows", [None, 1, 7, 100])
def test_basic_path_is_bit_identical_to_legacy(grid_name, azimuth, factor, chunk_rows):
    grid = GRIDS[grid_name]
    dem = _dome(grid["shape"])
    kwargs = dict(chunk_rows=chunk_rows)

    expected = _legacy_calculate_tilt(
        dem, grid["transform"], grid["origin"], azimuth, factor, **kwargs)
    actual = calculate_tilt(
        dem, grid["transform"], grid["origin"], azimuth, factor, warn_if_disconnected=False, **kwargs)

    assert actual.dtype == expected.dtype
    assert actual.shape == expected.shape
    assert np.array_equal(actual, expected, equal_nan=True)


@pytest.mark.parametrize("diagonal_km", [10.0, RECALIBRATION_THRESHOLD_KM - 1e-6,
                                         RECALIBRATION_THRESHOLD_KM, 500.0])
@pytest.mark.parametrize("chunk_rows", [None, 9])
def test_explicit_diagonal_km_is_bit_identical_to_legacy(diagonal_km, chunk_rows):
    # diagonal_km is a routing decision (single calibration vs per-row cos(lat));
    # exercise both sides of the threshold on the same small grid.
    grid = SMALL
    dem = _dome(grid["shape"])
    expected = _legacy_calculate_tilt(
        dem, grid["transform"], grid["origin"], 28.0, 0.35,
        diagonal_km=diagonal_km, chunk_rows=chunk_rows)
    actual = calculate_tilt(
        dem, grid["transform"], grid["origin"], 28.0, 0.35, warn_if_disconnected=False,
        diagonal_km=diagonal_km, chunk_rows=chunk_rows)
    assert np.array_equal(actual, expected, equal_nan=True)


def test_nan_cells_are_bit_identical_to_legacy():
    grid = SMALL
    dem = _dome(grid["shape"])
    dem[5:9, 12:20] = np.nan
    expected = _legacy_calculate_tilt(dem, grid["transform"], grid["origin"], 45.0, 1.5, chunk_rows=11)
    actual = calculate_tilt(dem, grid["transform"], grid["origin"], 45.0, 1.5,
                            warn_if_disconnected=False, chunk_rows=11)
    assert np.array_equal(actual, expected, equal_nan=True)
