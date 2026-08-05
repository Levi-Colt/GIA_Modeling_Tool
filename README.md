# GIA_Modeling_Tool
This tool uses modern DEM data to simulate glacial isostatic adjustment (GIA) for the purpose of identifying potential paleo strandlines.

## How it works
Given a DEM (Digital Elevation Model) GeoTIFF, an origin point, a tilt direction and magnitude, and a target elevation, the tool:

1. **Inspects the input file** (`raster_io_check`) against the system's available RAM to decide whether it's safe to load the whole DEM into memory, or whether it needs to be streamed through in tiles instead.
2. **Applies a directional planar tilt** (`calculate_tilt`) across the DEM, modeling the effect of glacial isostatic rebound/depression away from an origin point.
3. **Extracts a strandline contour** (`extract_strandline_contours`) at a target paleo-elevation from the tilted surface.
4. **Writes the result to a GeoPackage** (`write_dem_to_gpkg` + GeoPandas), optionally embedding the modified DEM as a raster layer alongside the strandline contour vector layer, so both ship as a single `.gpkg` file.

### Standard vs. windowed pipeline
`backend/app.py`'s `process_dem` is the orchestration entry point. It runs the pre-flight RAM check and routes to one of two pipelines:

- **Standard (in-memory) pipeline** — `load_DEM` → `calculate_tilt` → `extract_strandline_contours`. Used when the DEM comfortably fits within a safe fraction of available RAM.
- **Windowed (streamed) pipeline** — `tilt_DEM_windowed` → `extract_strandline_contours_windowed`. Used for DEMs too large to load in one pass; both functions process the raster in fixed-size tiles (`tile_size`), writing/reading incrementally rather than holding the whole array in memory at once.

Both pipelines converge on the same output step, and are verified against each other for equivalent results (see Testing below).

## Installation
```bash
pip install -r setup/requirements.txt
```
For running the test suite, install the dev dependencies instead (this also installs everything in `setup/requirements.txt`):
```bash
pip install -r setup/requirements-dev.txt
```

## Running in CryoCloud

The full stack (backend + API + built frontend, all served by one FastAPI
process) is meant to run inside your own CryoCloud (NASA/2i2c JupyterHub)
pod, exposed via `jupyter-server-proxy`. This is lab-only, clone-and-build
for now -- no shared/org-wide CryoCloud image, no admin registration needed.

```bash
conda env create -f setup/environment.yml
conda activate gia-modeling-tool
cd frontend && npm install && npm run build && cd ..
uvicorn api.main:app --host 0.0.0.0 --port <PORT>
```

Then reach it at the pod's `jupyter-server-proxy` URL:
`/user/<your-username>/proxy/<PORT>/`. This is a manually-launched proxy
target, not a registered server-proxy extension, so no 2i2c/CryoCloud admin
coordination is required.

By default, job workspaces (uploaded/intermediate/output files) live under
the OS temp directory and are cleaned up after each request. If you'd
rather they persist on the pod's persistent storage instead (not needed for
normal operation), point `GIA_STORAGE_DIR` at a directory there before
starting uvicorn.

## Usage
Run from the repository root (so `backend/` resolves as an importable package):
```python
from backend.app import process_dem

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
The test suite covers every function in `backend/main.py` individually, the standard/windowed pipelines' equivalence, and `backend/app.py`'s orchestration layer end-to-end, using synthetic in-memory-generated GeoTIFFs rather than real DEM data.

`pytest.ini` lives in `setup/`, not the repo root, so it needs to be pointed
to explicitly -- plain `pytest` won't pick it up:
```bash
pytest -c setup/pytest.ini --rootdir=.              # run the full suite
pytest -c setup/pytest.ini --rootdir=. -m cryocloud  # also run tests that only meaningfully validate real system RAM behavior inside a CryoCloud container
```

## Known limitations
A few behaviors are intentional trade-offs or documented gaps rather than bugs, and are worth knowing about:

- **`write_dem_to_gpkg` overwrites an existing file at the same path by default** (`overwrite=True`); pass `overwrite=False` to restore the strict raise-if-exists behavior (e.g. to add a raster layer to an existing multi-layer `.gpkg` without touching its other layers). `write_dem_to_gpkg_windowed` shares the same `overwrite` parameter and default.
- **No `nodata` value is declared on GeoPackage raster output** — NaN values round-trip correctly as bit patterns, but downstream tools that rely on an explicit nodata tag (rather than recognizing NaN by convention) will treat those cells as literal data.
- **Multi-tile DEM mosaicking is not yet supported.** Input DEMs are expected as a single GeoTIFF; if a study area spans multiple source tiles (e.g., multiple 1°x1° USGS tiles), the user is currently responsible for mosaicking them beforehand.

## Documentation

### Backend / geoprocessing
* [rasterio](https://rasterio.readthedocs.io/en/stable/) - Reading/writing GeoTIFF and GeoPackage raster data, and windowed/tiled I/O for large files.
* [scikit-image (skimage.measure)](https://scikit-image.org/docs/stable/auto_examples/edges/plot_contours.html) - Finds constant-value (contour) paths in the tilted DEM array.
* [pyproj](https://pyproj4.github.io/pyproj/stable/) - Geodetic distance/azimuth calculations (`Geod`) used to project the tilt across the DEM using true curved-earth geometry.
* [NumPy](https://numpy.org/doc/stable/) - Manipulates the DEM as a 2-D array and vectorizes the tilt calculation.
* [Shapely](https://shapely.readthedocs.io/) - Creation, manipulation, clipping, and merging of the resulting vector geometries (including stitching contour fragments across tile boundaries) before they're serialized into a GeoPackage.
* [GeoPandas](https://geopandas.org/en/stable/docs.html) - Configuring and exporting the strandline contour vector layer to GeoPackage.
* [psutil](https://psutil.readthedocs.io/en/latest/) - Queries live system memory availability to decide between the standard and windowed pipelines.
* [pytest](https://docs.pytest.org/en/stable/) - Test suite framework, including fixtures for synthetic raster generation and markers for environment-dependent tests.

### API layer
* [FastAPI](https://fastapi.tiangolo.com/) - HTTP layer wrapping `app.process_dem`; request validation, multipart form/file handling, and the interactive `/docs` schema.
* [uvicorn](https://www.uvicorn.org/) - ASGI server that runs the FastAPI app, both for local development and inside a CryoCloud pod behind `jupyter-server-proxy`.
* [python-multipart](https://github.com/Kludex/python-multipart) - Parses the multipart form data FastAPI uses for file uploads and form fields.

### Frontend
* [React](https://react.dev/) - Component-based UI for the multi-step form, results, and preview panels.
* [Vite](https://vite.dev/) - Dev server (with API proxying) and production build tooling for the frontend.
* [Tailwind CSS](https://tailwindcss.com/) - Utility-first styling used throughout the frontend components.
* [Leaflet](https://leafletjs.com/) - Interactive map rendering for the input/result preview panel.
* [georaster](https://github.com/GeoTIFF/georaster) - Parses GeoTIFF bytes returned by `/api/raster-preview` and `/api/process` into an in-browser raster object.
* [georaster-layer-for-leaflet](https://github.com/GeoTIFF/georaster-layer-for-leaflet) - Renders those parsed rasters (the input DEM preview and the tilted DEM result) directly as a Leaflet layer in-browser.
* [Turf.js](https://turfjs.org/) (`@turf/destination`, `@turf/bbox`) - Geodesic point projection for the client-side tilt-azimuth line, and bounding-box math for fitting the map view to the result contour.
* [fflate](https://github.com/101arrowz/fflate) - Client-side unzip of `/api/process`'s bundled response (strandline `.gpkg` + contour GeoJSON + optional tilted-DEM preview).
