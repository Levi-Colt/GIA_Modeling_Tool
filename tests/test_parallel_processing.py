"""
Multi-core processing: CPU detection, threaded tilt arithmetic and threaded
GDAL reprojection. Threads are purely a speed-up, so every result must be
bit-identical (np.array_equal, never allclose) to the single-threaded one.
"""
import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

import backend.main as main
from backend.app import process_dem
from backend.uplift import build_uplift_model, linear_planar_model

ORIGIN = (-104.25, 44.25)


# --- available_cpu_count -------------------------------------------------------

def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


@pytest.fixture
def host_has(monkeypatch):
    """Pretend the process may run on `n` cores (affinity / os.cpu_count)."""
    def _set(n):
        monkeypatch.setattr(main.os, "sched_getaffinity", lambda pid: set(range(n)), raising=False)
        monkeypatch.setattr(main.os, "cpu_count", lambda: n)
    return _set


def test_v2_cpu_quota_caps_node_cores(tmp_path, host_has):
    host_has(64)
    write(tmp_path / "cpu.max", "400000 100000\n")  # 4 CPUs
    assert main.available_cpu_count(tmp_path, env={}) == 4


def test_v2_fractional_quota_rounds_down_but_never_below_one(tmp_path, host_has):
    host_has(64)
    write(tmp_path / "cpu.max", "250000 100000\n")
    assert main.available_cpu_count(tmp_path, env={}) == 2
    write(tmp_path / "cpu.max", "50000 100000\n")
    assert main.available_cpu_count(tmp_path, env={}) == 1


def test_v2_unlimited_uses_affinity(tmp_path, host_has):
    host_has(6)
    write(tmp_path / "cpu.max", "max 100000\n")
    assert main.available_cpu_count(tmp_path, env={}) == 6


@pytest.mark.parametrize("sub", ["cpu", "cpu,cpuacct"])
def test_v1_quota_caps_node_cores(tmp_path, host_has, sub):
    host_has(64)
    write(tmp_path / sub / "cpu.cfs_quota_us", "300000\n")
    write(tmp_path / sub / "cpu.cfs_period_us", "100000\n")
    assert main.available_cpu_count(tmp_path, env={}) == 3


def test_v1_unlimited_uses_affinity(tmp_path, host_has):
    host_has(6)
    write(tmp_path / "cpu" / "cpu.cfs_quota_us", "-1\n")
    write(tmp_path / "cpu" / "cpu.cfs_period_us", "100000\n")
    assert main.available_cpu_count(tmp_path, env={}) == 6


def test_quota_above_affinity_uses_affinity(tmp_path, host_has):
    host_has(2)
    write(tmp_path / "cpu.max", "800000 100000\n")
    assert main.available_cpu_count(tmp_path, env={}) == 2


def test_no_cgroup_files_uses_affinity(tmp_path, host_has):
    host_has(5)
    assert main.available_cpu_count(tmp_path / "missing", env={}) == 5


def test_gia_workers_overrides_detection(tmp_path, host_has):
    host_has(64)
    write(tmp_path / "cpu.max", "400000 100000\n")
    assert main.available_cpu_count(tmp_path, env={"GIA_WORKERS": "1"}) == 1
    assert main.available_cpu_count(tmp_path, env={"GIA_WORKERS": "12"}) == 12


@pytest.mark.parametrize("bad", ["0", "-2", "lots", " "])
def test_invalid_gia_workers_is_ignored(tmp_path, host_has, bad):
    host_has(3)
    assert main.available_cpu_count(tmp_path / "missing", env={"GIA_WORKERS": bad}) == 3


# --- threaded tilt ---------------------------------------------------------------

def _dem(grid):
    y, x = np.indices((grid, grid))
    dem = (1000.0 - 0.5 * x - 0.25 * y + np.sin(x / 7.0) * 3).astype("float32")
    dem[5:9, 10:14] = np.nan
    return dem


def _quadratic():
    spec = {
        "version": 1, "direction": {"type": "azimuth"},
        "profile": {"family": "quadratic", "rate_of_increase": 0.3, "coefficients": None},
        "hinge": {"mode": "none", "distance_km": None},
    }
    return build_uplift_model(spec, 28.0, 3.0)


@pytest.mark.parametrize("pixel", [0.005, 0.01])  # single calibration / per-row cos(lat)
@pytest.mark.parametrize("model_name", ["linear", "quadratic"])
@pytest.mark.parametrize("workers", [2, 3, 8])
@pytest.mark.parametrize("chunk_rows", [None, 7, 1000])
def test_threaded_tilt_is_bit_identical(pixel, model_name, workers, chunk_rows):
    grid = 150
    transform = from_origin(-105.0, 45.0, pixel, pixel)
    dem = _dem(grid)
    model = linear_planar_model(210, 0.5) if model_name == "linear" else _quadratic()
    single = main.calculate_tilt(dem, transform, ORIGIN, 210, 0.5, chunk_rows=chunk_rows,
                                 uplift_model=model)
    threaded = main.calculate_tilt(dem, transform, ORIGIN, 210, 0.5, chunk_rows=chunk_rows,
                                   uplift_model=model, workers=workers)
    assert threaded.dtype == single.dtype
    assert np.array_equal(threaded, single, equal_nan=True)


def test_threaded_tilt_on_a_tiny_array_falls_back_to_one_thread():
    dem = _dem(150)[:3]
    transform = from_origin(-105.0, 45.0, 0.01, 0.01)
    single = main.calculate_tilt(dem, transform, ORIGIN, 210, 0.5)
    assert np.array_equal(main.calculate_tilt(dem, transform, ORIGIN, 210, 0.5, workers=8),
                          single, equal_nan=True)


def test_threaded_tilt_propagates_errors():
    class Broken:
        extra_bytes_per_pixel = 0

        def evaluate(self, east_km, north_km):
            raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        main.calculate_tilt(_dem(150), from_origin(-105.0, 45.0, 0.01, 0.01), ORIGIN, 0, 0,
                            uplift_model=Broken(), workers=4)


def _write(path, array, transform, crs="EPSG:4326"):
    with rasterio.open(str(path), "w", driver="GTiff", height=array.shape[0], width=array.shape[1],
                       count=1, dtype=array.dtype, crs=crs, transform=transform,
                       nodata=-9999.0) as dst:
        dst.write(np.nan_to_num(array, nan=-9999.0), 1)
    return str(path)


def test_threaded_windowed_tilt_is_bit_identical(tmp_path):
    transform = from_origin(-105.0, 45.0, 0.01, 0.01)
    dem_path = _write(tmp_path / "dem.tif", _dem(150), transform)
    outs = []
    for workers in (1, 4):
        out, _, _ = main.tilt_DEM_windowed(dem_path, str(tmp_path / f"t{workers}.tif"), ORIGIN, 210, 0.5,
                                           tile_size=64, workers=workers)
        with rasterio.open(out) as src:
            outs.append(src.read(1))
    assert np.array_equal(outs[0], outs[1], equal_nan=True)


@pytest.mark.parametrize("windowed", [False, True])
def test_process_dem_with_workers_gives_the_same_bundle(tmp_path, monkeypatch, windowed):
    import geopandas as gpd

    import backend.app as app
    if windowed:
        monkeypatch.setattr(app, "check_available_ram_mb", lambda: 0.0001)
    transform = from_origin(-105.0, 45.0, 0.01, 0.01)
    dem_path = _write(tmp_path / "dem.tif", _dem(150), transform)
    results = []
    for workers in (1, 4):
        out = str(tmp_path / f"out{workers}.gpkg")
        process_dem(dem_path, ORIGIN, 210, 0.5, 950.0, out, include_dem=True, workers=workers)
        with rasterio.open(f"GPKG:{out}:modified_dem") as src:
            raster = src.read(1)
        lines = gpd.read_file(out, layer="strandline_contour").geometry
        results.append((raster, [g.wkb for g in lines]))
    assert np.array_equal(results[0][0], results[1][0], equal_nan=True)
    assert results[0][1] == results[1][1]


def _spy_dem_write(monkeypatch):
    """Record which thread write_dem_to_gpkg runs on."""
    import threading

    import backend.app as app
    threads = []
    real = app.write_dem_to_gpkg

    def spy(*args, **kwargs):
        threads.append(threading.current_thread() is threading.main_thread())
        return real(*args, **kwargs)
    monkeypatch.setattr(app, "write_dem_to_gpkg", spy)
    return threads


def test_dem_write_overlaps_contours_only_with_workers_and_room(tmp_path, monkeypatch):
    import backend.app as app
    on_main = _spy_dem_write(monkeypatch)
    dem_path = _write(tmp_path / "dem.tif", _dem(150), from_origin(-105.0, 45.0, 0.01, 0.01))

    process_dem(dem_path, ORIGIN, 210, 0.5, 950.0, str(tmp_path / "a.gpkg"), workers=1)
    process_dem(dem_path, ORIGIN, 210, 0.5, 950.0, str(tmp_path / "b.gpkg"), workers=4)
    monkeypatch.setattr(app, "_overlap_fits", lambda w, h: False)
    process_dem(dem_path, ORIGIN, 210, 0.5, 950.0, str(tmp_path / "c.gpkg"), workers=4)
    assert on_main == [True, False, True]


def test_overlap_budget_counts_both_operations(monkeypatch):
    import backend.app as app
    per_px = app.CONTOUR_BYTES_PER_PIXEL + app.GPKG_WRITE_BYTES_PER_PIXEL
    needed_mb = 1000 * 4000 * per_px / 1024 ** 2
    monkeypatch.setattr(app, "check_available_ram_mb", lambda: needed_mb / 0.6 * 1.01)
    assert app._overlap_fits(1000, 4000) and app._overlap_fits(4000, 1000)
    monkeypatch.setattr(app, "check_available_ram_mb", lambda: needed_mb / 0.6 * 0.99)
    assert not app._overlap_fits(1000, 4000) and not app._overlap_fits(4000, 1000)


def test_contour_error_during_overlap_waits_for_the_write_and_raises(tmp_path, monkeypatch):
    on_main = _spy_dem_write(monkeypatch)
    dem_path = _write(tmp_path / "dem.tif", _dem(150), from_origin(-105.0, 45.0, 0.01, 0.01))
    out = str(tmp_path / "out.gpkg")
    with pytest.raises(ValueError):
        process_dem(dem_path, ORIGIN, 210, 0.5, 99_999.0, out, workers=4)  # far above the DEM
    assert on_main == [False]
    with rasterio.open(f"GPKG:{out}:modified_dem") as src:  # the write completed
        assert src.read(1).shape == (150, 150)


# --- threaded reprojection ---------------------------------------------------------

def test_threaded_reprojection_is_bit_identical(tmp_path):
    from api.crs import ensure_wgs84_raster

    transform = from_origin(500_000, 5_000_000, 30, 30)  # UTM 12N metres
    y, x = np.indices((300, 300))
    dem = (1000.0 + 0.3 * x - 0.2 * y + np.cos(y / 9.0) * 5).astype("float32")
    src = _write(tmp_path / "utm.tif", dem, transform, crs="EPSG:32612")
    arrays = []
    for threads in (1, 4):
        prep = ensure_wgs84_raster(src, str(tmp_path / f"wgs84_{threads}.tif"), num_threads=threads)
        assert prep.was_reprojected
        with rasterio.open(prep.path) as s:
            arrays.append(s.read(1))
    assert np.array_equal(arrays[0], arrays[1], equal_nan=True)
