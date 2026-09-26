"""
A DEM with a nodata border must not get a contour drawn along the border's edge
(backend.main.extract_strandline_contours's trim_nan_edges, on for every run).

Basic path (no uplift model): a DEM that rises to the east, with the eastern
columns nodata. Without trimming, the valid/NaN boundary yields a second, spurious
contour along the last valid column, next to the real strandline.
"""
import geopandas as gpd
import numpy as np
import pytest
from rasterio.transform import from_origin

import backend.app as app
from backend.app import process_dem
from backend.main import raster_io_check

from tests.conftest import write_raster

N, PIXEL, BORDER_COL = 60, 0.01, 45          # columns >= 45 are nodata
ORIGIN = (-105.0 + 0.30, 45.0 - 0.30)


def make_dem(tmp_path):
    ramp = np.tile(np.arange(N, dtype="float32") * 10.0, (N, 1))     # 0..590 m, rising east
    ramp[:, BORDER_COL:] = -9999.0
    return write_raster(tmp_path / "bordered.tif", ramp, from_origin(-105.0, 45.0, PIXEL, PIXEL), nodata=-9999.0)


@pytest.mark.parametrize("windowed", [False, True], ids=["in-memory", "windowed"])
def test_no_contour_runs_along_the_nodata_border(tmp_path, monkeypatch, windowed):
    path = make_dem(tmp_path)
    if windowed:
        monkeypatch.setattr(app, "raster_io_check", lambda p, ram: {**raster_io_check(p, 1e9), "use_windowed_io": True})
    out = str(tmp_path / "out.gpkg")
    # tilt_factor 0: the tilted DEM is the DEM, so the contour at 200 m is the real strandline
    # (column ~20); the region east of it is above 200 m, so the valid/NaN edge would trace too.
    process_dem(path, ORIGIN, 0.0, 0.0, 200.0, out, include_dem=False)

    lines = gpd.read_file(out, layer="strandline_contour")
    assert len(lines) >= 1
    border_lon = -105.0 + BORDER_COL * PIXEL
    for geom in lines.geometry:
        lons = np.array([c[0] for c in geom.coords])
        assert lons.max() < border_lon - 0.5 * PIXEL        # nothing along the last valid column
    strandline_lon = -105.0 + 20.5 * PIXEL
    assert min(abs(np.array([c[0] for g in lines.geometry for c in g.coords]) - strandline_lon)) < PIXEL
