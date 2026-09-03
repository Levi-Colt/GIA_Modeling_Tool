"""
Unit tests for main.largest_safe_tile_size (see
documentation/PERFORMANCE_OPTIMIZATION_SPEC.md Fix 2).
"""
from backend.main import largest_safe_tile_size


def test_degenerates_to_single_pass_when_budget_covers_whole_raster():
    # A generous RAM budget should let the whole raster fit as "one tile" --
    # capped at min(width, height), not an oversized value.
    result = largest_safe_tile_size(width=100, height=200, available_ram_mb=100_000,
                                     per_pixel_cost_bytes=32)
    assert result == 100


def test_shrinks_tile_size_as_budget_shrinks():
    generous = largest_safe_tile_size(width=1000, height=1000, available_ram_mb=1000,
                                       per_pixel_cost_bytes=32)
    scarce = largest_safe_tile_size(width=1000, height=1000, available_ram_mb=10,
                                     per_pixel_cost_bytes=32)
    assert scarce < generous


def test_never_returns_less_than_one():
    # An absurdly tiny budget should still produce a usable (if inefficient)
    # tile size, never zero -- zero would make range(0, height, 0) crash the
    # windowed pipeline's tiling loops.
    result = largest_safe_tile_size(width=10_000, height=10_000, available_ram_mb=0.0001,
                                     per_pixel_cost_bytes=32)
    assert result >= 1


def test_capped_at_smaller_raster_dimension():
    result = largest_safe_tile_size(width=50, height=5000, available_ram_mb=1_000_000,
                                     per_pixel_cost_bytes=32)
    assert result == 50


def test_higher_per_pixel_cost_produces_smaller_tile():
    # available_ram_mb kept small enough that neither result hits the
    # min(width, height) cap -- otherwise both would just saturate at 1000
    # regardless of cost, and the comparison would be meaningless.
    cheap = largest_safe_tile_size(width=1000, height=1000, available_ram_mb=0.5,
                                    per_pixel_cost_bytes=8)
    expensive = largest_safe_tile_size(width=1000, height=1000, available_ram_mb=0.5,
                                        per_pixel_cost_bytes=32)
    assert expensive < cheap
