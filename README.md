# GIA_Modeling_Tool
This tool uses modern DEM data to simulate glacial isostatic adjustment (GIA) for the purpose of identifying potential paleo strandlines.

## How it works
Given a DEM (Digital Elevation Model) GeoTIFF, an origin point, a tilt direction and magnitude, and a target elevation, the tool:

1. **Inspects the input file** (`raster_io_check`) against the system's available RAM to decide whether it's safe to load the whole DEM into memory, or whether it needs to be streamed through in tiles instead.
2. **Applies a directional planar tilt** (`calculate_tilt`) across the DEM, modeling the effect of glacial isostatic rebound/depression away from an origin point.
3. **Extracts a strandline contour** (`extract_strandline_contours`) at a target paleo-elevation from the tilted surface.
4. **Writes the result to a GeoPackage** (`write_dem_to_gpkg` + GeoPandas), optionally embedding the modified DEM as a raster layer alongside the strandline contour vector layer, so both ship as a single `.gpkg` file.

### Standard vs. windowed pipeline
`app.py`'s `process_dem` is the orchestration entry point. It runs the pre-flight RAM check and routes to one of two pipelines:

- **Standard (in-memory) pipeline** — `load_DEM` → `calculate_tilt` → `extract_strandline_contours`. Used when the DEM comfortably fits within a safe fraction of available RAM.
- **Windowed (streamed) pipeline** — `tilt_DEM_windowed` → `extract_strandline_contours_windowed`. Used for DEMs too large to load in one pass; both functions process the raster in fixed-size tiles (`tile_size`), writing/reading incrementally rather than holding the whole array in memory at once.

Both pipelines converge on the same output step, and are verified against each other for equivalent results (see Testing below).

## Installation
```bash
pip install -r requirements.txt
```
For running the test suite, install the dev dependencies instead (this also installs everything in `requirements.txt`):
```bash
pip install -r requirements-dev.txt
```

## Usage
```python
from app import process_dem

process_dem(
    file_path="test_data/my_dem.tif",
    origin_coords=(-110.5, 45.2),   # (lon, lat) tilt origin
    tilt_azimuth=210,               # degrees, direction of tilt
    tilt_factor=0.1,                # meters of elevation change per km, per unit distance
    target_elevation=1200,          # paleo-elevation to contour, in meters
    output_gpkg_path="output/strandlines.gpkg",
    include_dem=True,               # also embed the tilted DEM as a raster layer
)
```

## Testing
The test suite covers every function in `main.py` individually, the standard/windowed pipelines' equivalence, and `app.py`'s orchestration layer end-to-end, using synthetic in-memory-generated GeoTIFFs rather than real DEM data.

```bash
pytest              # run the full suite
pytest -m cryocloud  # also run tests that only meaningfully validate real system RAM behavior inside a CryoCloud container
```

## Known limitations
A few behaviors are intentional trade-offs or documented gaps rather than bugs, and are worth knowing about:

- **`include_dem=True` with the windowed pipeline** still reads the entire tilted raster back into memory to embed it in the GeoPackage (`write_dem_to_gpkg` has no tiled/streaming raster writer yet), which negates the memory savings windowing is otherwise meant to provide for very large files. `process_dem` raises a `UserWarning` when this happens.
- **Re-running `write_dem_to_gpkg` with the same `table_name` at the same path raises** rather than overwriting; `process_dem` works around this by clearing any pre-existing output file at the start of each run.
- **No `nodata` value is declared on GeoPackage raster output** — NaN values round-trip correctly as bit patterns, but downstream tools that rely on an explicit nodata tag (rather than recognizing NaN by convention) will treat those cells as literal data.
- **Multi-tile DEM mosaicking is not yet supported.** Input DEMs are expected as a single GeoTIFF; if a study area spans multiple source tiles (e.g., multiple 1°x1° USGS tiles), the user is currently responsible for mosaicking them beforehand.

## Documentation
This application utilizes the following core libraries for spatial data processing:
* [rasterio](https://rasterio.readthedocs.io/en/stable/) - Reading/writing GeoTIFF and GeoPackage raster data, and windowed/tiled I/O for large files.
* [scikit-image (skimage.measure)](https://scikit-image.org/docs/stable/auto_examples/edges/plot_contours.html) - Finds constant-value (contour) paths in the tilted DEM array.
* [pyproj](https://pyproj4.github.io/pyproj/stable/) - Geodetic distance/azimuth calculations (`Geod`) used to project the tilt across the DEM using true curved-earth geometry.
* [NumPy](https://numpy.org/doc/stable/) - Manipulates the DEM as a 2-D array and vectorizes the tilt calculation.
* [Shapely](https://shapely.readthedocs.io/) - Creation, manipulation, clipping, and merging of the resulting vector geometries (including stitching contour fragments across tile boundaries) before they're serialized into a GeoPackage.
* [GeoPandas](https://geopandas.org/en/stable/docs.html) - Configuring and exporting the strandline contour vector layer to GeoPackage.
* [psutil](https://psutil.readthedocs.io/en/latest/) - Queries live system memory availability to decide between the standard and windowed pipelines.
* [pytest](https://docs.pytest.org/en/stable/) - Test suite framework, including fixtures for synthetic raster generation and markers for environment-dependent tests.
