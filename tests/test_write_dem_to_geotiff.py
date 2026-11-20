"""
The tilted DEM delivered to users: a standalone float32 GeoTIFF with NaN
written as DEM_NODATA and declared as nodata, so ArcGIS and QGIS both read
missing cells as NoData.
"""
import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

import backend.app as app
from backend.app import process_dem
from backend.main import (
    DEM_NODATA,
    write_dem_to_geotiff,
    write_dem_to_geotiff_windowed,
)

TRANSFORM = from_origin(-105.0, 45.0, 0.01, 0.01)


def _array(h=300, w=170, dtype="float64"):
    y, x = np.indices((h, w))
    a = (900.0 + 0.37 * x - 0.11 * y).astype(dtype)
    a[3:9, 4:12] = np.nan
    return a


def _read(path):
    with rasterio.open(path) as src:
        return src.read(1), src.profile


@pytest.mark.parametrize("strip_bytes", [64 * 1024 ** 2, 1])  # one strip / many 256-row strips
def test_values_nodata_and_profile(tmp_path, strip_bytes):
    a = _array()
    path = str(tmp_path / "dem.tif")
    write_dem_to_geotiff(a, TRANSFORM, "EPSG:4326", path, strip_bytes=strip_bytes)
    data, profile = _read(path)
    assert profile["driver"] == "GTiff" and profile["dtype"] == "float32"
    assert profile["nodata"] == DEM_NODATA
    assert profile["crs"] == rasterio.crs.CRS.from_epsg(4326)
    assert profile["transform"] == TRANSFORM
    expected = np.where(np.isnan(a), DEM_NODATA, a.astype("float32")).astype("float32")
    assert np.array_equal(data, expected)


def test_threads_do_not_change_the_file_contents(tmp_path):
    a = _array()
    write_dem_to_geotiff(a, TRANSFORM, "EPSG:4326", str(tmp_path / "1.tif"), workers=1)
    write_dem_to_geotiff(a, TRANSFORM, "EPSG:4326", str(tmp_path / "8.tif"), workers=8)
    assert np.array_equal(_read(tmp_path / "1.tif")[0], _read(tmp_path / "8.tif")[0])


@pytest.mark.parametrize("src_nodata", [None, -32768.0, float("nan")])
def test_windowed_copy_matches_in_memory(tmp_path, src_nodata):
    a = _array(60, 40, dtype="float32")
    src_path = str(tmp_path / "src.tif")
    stored = a if src_nodata is None or np.isnan(src_nodata) else np.where(np.isnan(a), src_nodata, a)
    with rasterio.open(src_path, "w", driver="GTiff", height=a.shape[0], width=a.shape[1], count=1,
                       dtype="float32", crs="EPSG:4326", transform=TRANSFORM, nodata=src_nodata) as dst:
        dst.write(stored.astype("float32"), 1)
    write_dem_to_geotiff_windowed(src_path, str(tmp_path / "w.tif"), tile_size=64)
    write_dem_to_geotiff(a, TRANSFORM, "EPSG:4326", str(tmp_path / "m.tif"))
    windowed, profile = _read(tmp_path / "w.tif")
    assert profile["nodata"] == DEM_NODATA
    assert np.array_equal(windowed, _read(tmp_path / "m.tif")[0])


@pytest.mark.parametrize("windowed", [False, True])
@pytest.mark.parametrize("workers", [1, 4])
def test_process_dem_writes_the_dem_as_geotiff(tmp_path, monkeypatch, windowed, workers):
    import geopandas as gpd

    if windowed:
        monkeypatch.setattr(app, "check_available_ram_mb", lambda: 0.0001)
    a = _array(60, 40, dtype="float32")
    dem_path = str(tmp_path / "in.tif")
    with rasterio.open(dem_path, "w", driver="GTiff", height=a.shape[0], width=a.shape[1], count=1,
                       dtype="float32", crs="EPSG:4326", transform=TRANSFORM, nodata=-9999.0) as dst:
        dst.write(np.nan_to_num(a, nan=-9999.0), 1)
    gpkg, tif = str(tmp_path / "out.gpkg"), str(tmp_path / "out.tif")

    process_dem(dem_path, (-104.8, 44.7), 210, 0.5, 905.0, gpkg, workers=workers, dem_tif_path=tif)

    assert list(gpd.list_layers(gpkg)["name"]) == ["strandline_contour"]
    data, profile = _read(tif)
    assert profile["nodata"] == DEM_NODATA and data.shape == a.shape
    assert (data == DEM_NODATA).sum() == np.isnan(a).sum()


def test_process_dem_without_dem_writes_no_geotiff(tmp_path):
    a = _array(60, 40, dtype="float32")
    dem_path = str(tmp_path / "in.tif")
    with rasterio.open(dem_path, "w", driver="GTiff", height=a.shape[0], width=a.shape[1], count=1,
                       dtype="float32", crs="EPSG:4326", transform=TRANSFORM, nodata=-9999.0) as dst:
        dst.write(np.nan_to_num(a, nan=-9999.0), 1)
    tif = tmp_path / "out.tif"
    tif.write_bytes(b"stale")  # a leftover from an earlier run is removed, not shipped
    process_dem(dem_path, (-104.8, 44.7), 210, 0.5, 905.0, str(tmp_path / "o.gpkg"),
                include_dem=False, dem_tif_path=str(tif))
    assert not tif.exists()
