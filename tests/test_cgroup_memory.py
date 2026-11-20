"""
check_available_ram_mb must respect a container's memory limit.

In a Kubernetes pod (CryoCloud/2i2c) psutil reports the node's memory, not the
pod's limit, so these tests build fake cgroup v1/v2 file trees and a fake
psutil reading to check the limit wins whenever it's the smaller of the two.
"""
from types import SimpleNamespace

import pytest

import backend.main as main

MB = 1024 ** 2
GB = 1024 ** 3


@pytest.fixture
def node_has(monkeypatch):
    """Pretend psutil sees `available` bytes free on the whole node."""
    def _set(available):
        monkeypatch.setattr(main.psutil, "virtual_memory", lambda: SimpleNamespace(available=available))
    return _set


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def test_v2_limit_caps_node_memory(tmp_path, node_has):
    node_has(50 * GB)
    write(tmp_path / "memory.max", f"{8 * GB}\n")
    write(tmp_path / "memory.current", f"{3 * GB}\n")
    write(tmp_path / "memory.stat", f"anon {2 * GB}\ninactive_file {1 * GB}\nactive_file 0\n")
    # working set = 3 GB - 1 GB inactive cache = 2 GB, so 6 GB left of 8
    assert main.check_available_ram_mb(tmp_path) == pytest.approx(6 * GB / MB)


def test_v2_unlimited_falls_back_to_psutil(tmp_path, node_has):
    node_has(5 * GB)
    write(tmp_path / "memory.max", "max\n")
    write(tmp_path / "memory.current", f"{1 * GB}\n")
    assert main.check_available_ram_mb(tmp_path) == pytest.approx(5 * GB / MB)


def test_psutil_wins_when_smaller_than_the_limit(tmp_path, node_has):
    node_has(1 * GB)
    write(tmp_path / "memory.max", f"{8 * GB}\n")
    write(tmp_path / "memory.current", "0\n")
    assert main.check_available_ram_mb(tmp_path) == pytest.approx(1 * GB / MB)


def test_v1_limit_caps_node_memory(tmp_path, node_has):
    node_has(50 * GB)
    write(tmp_path / "memory" / "memory.limit_in_bytes", f"{4 * GB}\n")
    write(tmp_path / "memory" / "memory.usage_in_bytes", f"{2 * GB}\n")
    write(tmp_path / "memory" / "memory.stat", f"cache {1 * GB}\ntotal_inactive_file {512 * MB}\n")
    assert main.check_available_ram_mb(tmp_path) == pytest.approx((4 * GB - 1.5 * GB) / MB)


def test_v1_unlimited_sentinel_falls_back_to_psutil(tmp_path, node_has):
    node_has(5 * GB)
    write(tmp_path / "memory" / "memory.limit_in_bytes", "9223372036854771712\n")
    write(tmp_path / "memory" / "memory.usage_in_bytes", f"{1 * GB}\n")
    assert main.check_available_ram_mb(tmp_path) == pytest.approx(5 * GB / MB)


def test_no_cgroup_files_falls_back_to_psutil(tmp_path, node_has):
    node_has(5 * GB)
    assert main.cgroup_available_bytes(tmp_path) is None
    assert main.check_available_ram_mb(tmp_path / "missing") == pytest.approx(5 * GB / MB)


def test_usage_above_limit_reports_zero_not_negative(tmp_path, node_has):
    node_has(50 * GB)
    write(tmp_path / "memory.max", f"{1 * GB}\n")
    write(tmp_path / "memory.current", f"{2 * GB}\n")
    assert main.check_available_ram_mb(tmp_path) == 0.0


def test_garbage_files_are_ignored(tmp_path, node_has):
    node_has(5 * GB)
    write(tmp_path / "memory.max", "not-a-number\n")
    assert main.check_available_ram_mb(tmp_path) == pytest.approx(5 * GB / MB)


def test_dem_that_fits_the_node_but_not_the_pod_goes_windowed(tmp_path, node_has):
    """Through raster_io_check's decision: a 1000x1000 float32 DEM (~3.8 MB)
    fits a 50 GB node easily but not a pod with 4 MB left."""
    import numpy as np
    import rasterio
    from rasterio.transform import from_origin

    dem = tmp_path / "dem.tif"
    with rasterio.open(dem, "w", driver="GTiff", width=1000, height=1000, count=1,
                       dtype="float32", crs="EPSG:4326",
                       transform=from_origin(-100, 45, 0.001, 0.001)) as dst:
        dst.write(np.zeros((1000, 1000), dtype="float32"), 1)

    node_has(50 * GB)
    cg = tmp_path / "cgroup"
    write(cg / "memory.max", f"{4 * MB}\n")
    write(cg / "memory.current", "0\n")

    assert not main.raster_io_check(str(dem), main.check_available_ram_mb(cg / "missing"))["use_windowed_io"]
    assert main.raster_io_check(str(dem), main.check_available_ram_mb(cg))["use_windowed_io"]
