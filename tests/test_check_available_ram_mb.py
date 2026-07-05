"""
Unit test for main.check_available_ram_mb.

Unlike raster_io_check (which takes available RAM as an explicit parameter),
this function reads the *real* system's live memory via psutil. Its output
therefore depends on whatever machine/container it runs on, so this test is
marked `cryocloud` -- it's meaningful to run inside an actual CryoCloud
container to sanity-check psutil behaves as expected there, but a passing
result on an arbitrary dev machine or CI runner doesn't validate anything
CryoCloud-specific.

Run explicitly with: pytest -m cryocloud
(the default test run, `pytest`, does not need to skip this -- it's a cheap,
harmless sanity check anywhere -- but the marker documents its real purpose.)
"""
import pytest

from main import check_available_ram_mb


@pytest.mark.cryocloud
def test_returns_a_positive_number_of_megabytes():
    free_ram_mb = check_available_ram_mb()
    assert isinstance(free_ram_mb, float)
    assert free_ram_mb > 0
