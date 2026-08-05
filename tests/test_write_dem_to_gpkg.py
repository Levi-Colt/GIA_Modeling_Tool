"""
Unit tests for main.write_dem_to_gpkg.

The GeoPackage raster driver has some real quirks around dtype coercion,
multi-table append behavior, and how it interacts with vector layers in the
same file -- several of these tests exist specifically to document behavior
that isn't obvious from reading the function itself.
"""
import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from backend.main import write_dem_to_gpkg


@pytest.fixture
def transform():
    return from_origin(-105.0, 45.0, 0.01, 0.01)


def test_round_trips_data_transform_and_crs(tmp_path, transform):
    array = np.arange(100, dtype="float32").reshape(10, 10)
    path = str(tmp_path / "dem.gpkg")

    write_dem_to_gpkg(array, transform, "EPSG:4326", path, table_name="my_dem")

    with rasterio.open(path) as src:
        np.testing.assert_array_equal(src.read(1), array)
        assert src.transform == transform
        assert src.crs.to_string() == "EPSG:4326"


def test_default_table_name_is_modified_dem(tmp_path, transform):
    array = np.full((10, 10), 500.0, dtype="float32")
    path = str(tmp_path / "dem.gpkg")

    write_dem_to_gpkg(array, transform, "EPSG:4326", path)  # no table_name given

    with rasterio.open(f"GPKG:{path}:modified_dem") as src:
        assert src.read(1).mean() == pytest.approx(500.0)


def test_custom_table_name_is_independently_readable(tmp_path, transform):
    array = np.full((10, 10), 42.0, dtype="float32")
    path = str(tmp_path / "dem.gpkg")

    write_dem_to_gpkg(array, transform, "EPSG:4326", path, table_name="custom_layer")

    with rasterio.open(f"GPKG:{path}:custom_layer") as src:
        assert src.read(1).mean() == pytest.approx(42.0)


def test_float64_input_is_safely_cast_to_float32(tmp_path, transform):
    # The profile always declares dtype='float32' regardless of the input
    # array's actual dtype. GDAL performs an implicit cast on write rather
    # than raising -- this documents that it doesn't crash and that
    # representable values survive the cast correctly.
    array = np.arange(100, dtype="float64").reshape(10, 10)
    path = str(tmp_path / "dem.gpkg")

    write_dem_to_gpkg(array, transform, "EPSG:4326", path)

    with rasterio.open(f"GPKG:{path}:modified_dem") as src:
        assert src.dtypes[0] == "float32"
        np.testing.assert_array_equal(src.read(1), array.astype("float32"))


def test_nan_values_round_trip_but_no_nodata_is_declared(tmp_path, transform):
    # KNOWN LIMITATION: NaN bit patterns survive the write/read round trip
    # fine, but write_dem_to_gpkg's profile never sets a `nodata` value on
    # the output dataset. Some downstream GIS tools recognize NaN in a
    # float raster as missing data by convention; others rely on an
    # explicit nodata tag and would treat these NaN cells as literal data.
    # This documents the current behavior rather than assuming it's safe
    # for every consumer of the output file.
    array = np.full((10, 10), 1000.0, dtype="float32")
    array[0, 0] = np.nan
    path = str(tmp_path / "dem.gpkg")

    write_dem_to_gpkg(array, transform, "EPSG:4326", path)

    with rasterio.open(f"GPKG:{path}:modified_dem") as src:
        assert np.isnan(src.read(1)[0, 0])
        assert src.nodata is None


def test_multiple_distinct_table_names_coexist(tmp_path, transform):
    # Accreting a second raster table onto the same file is exactly the
    # multi-layer case overwrite=True's whole-file delete isn't meant for --
    # opt out on the second (and later) calls to get the old append behavior.
    array_a = np.full((10, 10), 111.0, dtype="float32")
    array_b = np.full((10, 10), 222.0, dtype="float32")
    path = str(tmp_path / "dem.gpkg")

    write_dem_to_gpkg(array_a, transform, "EPSG:4326", path, table_name="dem_a")
    write_dem_to_gpkg(array_b, transform, "EPSG:4326", path, table_name="dem_b", overwrite=False)

    with rasterio.open(path) as src:
        assert set(src.subdatasets) == {f"GPKG:{path}:dem_a", f"GPKG:{path}:dem_b"}
    with rasterio.open(f"GPKG:{path}:dem_a") as src:
        assert src.read(1).mean() == pytest.approx(111.0)
    with rasterio.open(f"GPKG:{path}:dem_b") as src:
        assert src.read(1).mean() == pytest.approx(222.0)


def test_writing_same_path_twice_overwrites_by_default(tmp_path, transform):
    # Default overwrite=True: a second call at the same path succeeds and
    # the file reflects only the second call's data -- the first write's
    # table is gone entirely (the whole file is replaced), not merged.
    array_a = np.full((10, 10), 111.0, dtype="float32")
    array_b = np.full((10, 10), 999.0, dtype="float32")
    path = str(tmp_path / "dem.gpkg")

    write_dem_to_gpkg(array_a, transform, "EPSG:4326", path, table_name="dem")
    write_dem_to_gpkg(array_b, transform, "EPSG:4326", path, table_name="dem")

    with rasterio.open(f"GPKG:{path}:dem") as src:
        assert src.read(1).mean() == pytest.approx(999.0)


def test_overwrite_false_restores_strict_raise_behavior(tmp_path, transform):
    array_a = np.full((10, 10), 111.0, dtype="float32")
    array_b = np.full((10, 10), 999.0, dtype="float32")
    path = str(tmp_path / "dem.gpkg")

    write_dem_to_gpkg(array_a, transform, "EPSG:4326", path, table_name="dem", overwrite=False)
    with pytest.raises(rasterio.errors.RasterioIOError):
        write_dem_to_gpkg(array_b, transform, "EPSG:4326", path, table_name="dem", overwrite=False)

    # The original write should be untouched by the failed second attempt.
    with rasterio.open(f"GPKG:{path}:dem") as src:
        assert src.read(1).mean() == pytest.approx(111.0)


def test_coexists_with_a_vector_layer_written_after(tmp_path, transform):
    # Mirrors app.py's real usage: write_dem_to_gpkg first, then a contour
    # vector layer is added to the same .gpkg via geopandas afterward.
    import geopandas as gpd
    from shapely.geometry import LineString

    array = np.full((10, 10), 500.0, dtype="float32")
    path = str(tmp_path / "dem.gpkg")

    write_dem_to_gpkg(array, transform, "EPSG:4326", path, table_name="modified_dem")
    gdf = gpd.GeoDataFrame(geometry=[LineString([(-105, 45), (-104.9, 44.9)])], crs="EPSG:4326")
    gdf.to_file(path, layer="strandline_contour", driver="GPKG")

    # NOTE: once a vector layer exists in the file, opening the bare path
    # with rasterio no longer lists raster subdatasets (src.subdatasets
    # comes back empty) -- the raster table itself is still intact and must
    # be opened explicitly by name.
    with rasterio.open(path) as src:
        assert src.subdatasets == []
    with rasterio.open(f"GPKG:{path}:modified_dem") as src:
        assert src.read(1).mean() == pytest.approx(500.0)
    assert "strandline_contour" in gpd.list_layers(path)["name"].values


def test_coexists_with_a_vector_layer_written_before(tmp_path, transform):
    # The reverse order also works -- vector layer written first, raster
    # added to the same file afterward -- but only with overwrite=False,
    # since the default overwrite=True would delete the whole file (vector
    # layer included) before writing the raster.
    import geopandas as gpd
    from shapely.geometry import LineString

    array = np.full((10, 10), 777.0, dtype="float32")
    path = str(tmp_path / "dem.gpkg")

    gdf = gpd.GeoDataFrame(geometry=[LineString([(-105, 45), (-104.9, 44.9)])], crs="EPSG:4326")
    gdf.to_file(path, layer="strandline_contour", driver="GPKG")
    write_dem_to_gpkg(array, transform, "EPSG:4326", path, table_name="modified_dem", overwrite=False)

    with rasterio.open(f"GPKG:{path}:modified_dem") as src:
        assert src.read(1).mean() == pytest.approx(777.0)
    assert "strandline_contour" in gpd.list_layers(path)["name"].values


def test_none_crs_does_not_crash(tmp_path, transform):
    array = np.full((10, 10), 500.0, dtype="float32")
    path = str(tmp_path / "dem.gpkg")

    write_dem_to_gpkg(array, transform, None, path)  # should not raise

    with rasterio.open(f"GPKG:{path}:modified_dem") as src:
        assert src.read(1).mean() == pytest.approx(500.0)


def test_single_pixel_dem_round_trips(tmp_path, transform):
    array = np.array([[1000.0]], dtype="float32")
    path = str(tmp_path / "dem.gpkg")

    write_dem_to_gpkg(array, transform, "EPSG:4326", path)

    with rasterio.open(f"GPKG:{path}:modified_dem") as src:
        assert src.read(1).shape == (1, 1)
        assert src.read(1)[0, 0] == pytest.approx(1000.0)
