"""
Unit tests for main.raster_io_check.

raster_io_check takes `available_ram_mb` as an explicit argument, so these
tests fully control the RAM budget and don't depend on the machine they run
on. Contrast with test_check_available_ram_mb.py, which does depend on the
real environment and is marked `cryocloud`.
"""
import numpy as np
import pytest

from main import raster_io_check


def test_bad_file_path_raises_file_not_found():
    with pytest.raises(FileNotFoundError):
        raster_io_check("/path/does/not/exist.tif", available_ram_mb=1000)


def test_malformed_file_raises_io_error(malformed_file_path):
    with pytest.raises(IOError):
        raster_io_check(malformed_file_path, available_ram_mb=1000)


def test_identifies_need_for_casting_when_dtype_not_float32(int16_dem_path):
    result = raster_io_check(int16_dem_path, available_ram_mb=1000)
    assert result["needs_casting"] is True


def test_identifies_no_casting_needed_when_already_float32(flat_dem_path):
    result = raster_io_check(flat_dem_path, available_ram_mb=1000)
    assert result["needs_casting"] is False


def test_correctly_identifies_size(int16_dem_path):
    # 10x10 int16 raster: 2 bytes/pixel raw, needs casting to float32 (4 bytes/pixel)
    width = height = 10
    raw_size_mb = (width * height * 2) / (1024 ** 2)
    float32_size_mb = (width * height * 4) / (1024 ** 2)
    expected_peak_mb = raw_size_mb + float32_size_mb

    result = raster_io_check(int16_dem_path, available_ram_mb=1000)
    assert result["peak_ram_mb"] == pytest.approx(expected_peak_mb)


def test_identifies_windowed_io_when_ram_is_scarce(flat_dem_path):
    # An absurdly small RAM budget should force the windowed strategy.
    result = raster_io_check(flat_dem_path, available_ram_mb=0.0001)
    assert result["use_windowed_io"] is True


def test_identifies_standard_io_when_ram_is_plentiful(flat_dem_path):
    # An absurdly large RAM budget should never require windowing for a tiny file.
    result = raster_io_check(flat_dem_path, available_ram_mb=1_000_000)
    assert result["use_windowed_io"] is False


def test_returns_correct_band_count(multiband_dem_path):
    result = raster_io_check(multiband_dem_path, available_ram_mb=1000)
    assert result["band_count"] == 3
