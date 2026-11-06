# GIA_Modeling_Tool
This tool uses modern DEM data to simulate glacial isostatic adjustment (GIA) for the purpose of identifying potential paleo strandlines.

## How it works
Given a DEM GeoTIFF, an origin point, a tilt direction and magnitude, and a target elevation, the tool:

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

## Running the app from a JupyterLab session

The full stack (backend + API + built frontend) is served by a single FastAPI
process on one port. You start it from a terminal inside JupyterLab and open
it in your browser, either directly or through `jupyter-server-proxy`. The
steps below cover a JupyterLab on your own computer (Windows or macOS); the
[CryoCloud](#running-in-cryocloud) section covers the hosted JupyterHub.

### 1. Install conda (once)

Skip this if `conda --version` already works in your terminal.

**macOS**
```bash
brew install --cask miniforge        # or download the installer from
                                     # https://github.com/conda-forge/miniforge/releases/latest
conda init zsh                       # use `conda init bash` if your shell is bash
```
Close and reopen the terminal; the prompt should start with `(base)`.

**Windows** (PowerShell)
```powershell
winget install CondaForge.Miniforge3 --override "/S /D=C:\Users\Public\miniforge3"
C:\Users\Public\miniforge3\Scripts\conda.exe init powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```
Close and reopen PowerShell; the prompt should start with `(base)`.

* The install path must **not contain a space**. The default
  (`C:\Users\<First Last>\miniforge3`) fails when your user name has one, and
  `C:\miniforge3` fails without admin rights, which is why the command above
  installs under `C:\Users\Public`.
* `Set-ExecutionPolicy` is needed so PowerShell may load the profile script
  `conda init` writes; without it `conda` stays "not recognized".

### 2. Get the code and create the environment (once)

Run from any terminal where `conda` works (the repo can live anywhere; a path
with spaces is fine here).

**macOS**
```bash
git clone <repo URL> GIA_Modeling_Tool
cd GIA_Modeling_Tool
conda env create -f setup/environment.yml
```

**Windows** (PowerShell)
```powershell
git clone <repo URL> GIA_Modeling_Tool
cd GIA_Modeling_Tool
conda env create -f setup/environment.yml
```

This creates the `gia-modeling-tool` environment with Python 3.11, Node 20+
and the geoprocessing/API dependencies. It can take several minutes.

### 3. Add JupyterLab and the proxy (once)

If you already have JupyterLab, you only need `jupyter-server-proxy` in the
environment that runs it. The simplest route is to run JupyterLab from this
environment:

```bash
conda activate gia-modeling-tool
conda install -c conda-forge jupyterlab jupyter-server-proxy
```
(The command is the same on macOS and Windows.)

### 4. Build the frontend (once, and after any frontend change)

**macOS**
```bash
conda activate gia-modeling-tool
cd frontend && npm install && npm run build && cd ..
```

**Windows** (PowerShell 5.1 has no `&&`; use semicolons)
```powershell
conda activate gia-modeling-tool
cd frontend; npm install; npm run build; cd ..
```

`npm install` prints deprecation and vulnerability warnings; they are expected
and harmless here. The build creates `frontend/dist`, which FastAPI serves
automatically. **If you start the server before building, `/` returns 404.**

### 5. Launch JupyterLab and start the app

```bash
conda activate gia-modeling-tool     # same command on macOS and Windows
jupyter lab                          # run from the repo root
```

In JupyterLab open **File → New → Terminal** (the **+** launcher, then
**Terminal**). The terminal starts in the folder JupyterLab was launched from,
so confirm you are at the repo root (`pwd` on macOS, `pwd` or `ls` in
PowerShell), then:

**macOS**
```bash
conda activate gia-modeling-tool
uvicorn api.main:app --host 127.0.0.1 --port 8765
```

**Windows** (PowerShell)
```powershell
conda activate gia-modeling-tool
uvicorn api.main:app --host 127.0.0.1 --port 8765
```

Pick any free port. `Errno 10048` (Windows) or `address already in use`
(macOS) means the port is taken; choose another. Leave the terminal open while
you use the app and stop the server with `Ctrl+C`.

### 6. Open the app

* Through the proxy: `http://localhost:8888/proxy/8765/` (use your own Jupyter
  port and keep the trailing slash).
* Or directly: `http://127.0.0.1:8765/`. On your own computer the proxy is
  optional.

To check the server itself, open `http://127.0.0.1:8765/api/health`.

### Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `conda` is not recognized (Windows) | Execution policy blocks the profile: run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, then open a new PowerShell. If it persists, rerun the `conda init` line from step 1. |
| Miniforge installer: "contains 1 space" | Install to a path without spaces (step 1). |
| Miniforge installer: "not writable" | Don't install to `C:\`; use `C:\Users\Public\miniforge3` or an administrator shell. |
| `conda: command not found` (macOS) | Run `conda init zsh` (or `bash`) and reopen the terminal. |
| `/` returns `{"detail":"Not Found"}` | The frontend isn't built; do step 4, then restart uvicorn. |
| Blank page | Missing trailing slash on the proxy URL, or a stale build; rebuild. |
| 404 at `/proxy/<port>/` | Server isn't running, wrong port, or `jupyter-server-proxy` isn't installed in the environment running JupyterLab. |
| `ModuleNotFoundError: backend` | Start uvicorn from the repo root. |

## Running in CryoCloud

On CryoCloud (NASA/2i2c JupyterHub) the same stack runs inside your own pod,
exposed via `jupyter-server-proxy`, which is already installed there. Use the
terminal in your JupyterLab session:

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

### Job storage

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
- **DEM inputs are automatically reprojected to WGS84.** Regardless of the CRS of the input DEM, once uploaded, the input DEM is reprojected to WGS84. This is done to enforce CRS uniformity and simplify the map visualization, tilt calculation, and contouring workflows. This also means any products the user downloads will also be in WGS84.

## Documentation

### Project documents (`documentation/`)
* [api-README.md](documentation/api-README.md) - The API contract: every route, request fields, response shape and headers, and the contents of the `/api/process` zip bundle.
* [frontend-README.md](documentation/frontend-README.md) - Frontend structure and what is implemented vs. stubbed.
* [UPLIFT_MODEL_SPEC.md](documentation/UPLIFT_MODEL_SPEC.md) and [UPLIFT_MODEL_CORRECTIONS_SPEC.md](documentation/UPLIFT_MODEL_CORRECTIONS_SPEC.md) - Pluggable uplift models (linear, quadratic, polynomial profiles; hinge modes). Where they conflict, the corrections spec wins.
* [VECTOR_FIELD_SPEC.md](documentation/VECTOR_FIELD_SPEC.md) - Multi-direction (vector) uplift fields.
* [SHORE_POINT_SURFACE_SPEC.md](documentation/SHORE_POINT_SURFACE_SPEC.md) - Fitting an uplift surface directly from shoreline elevation points.
* [SELECTION_RADIUS_SPEC.md](documentation/SELECTION_RADIUS_SPEC.md) - Optional filter that keeps only contours near the origin.
* [PERFORMANCE_OPTIMIZATION_SPEC.md](documentation/PERFORMANCE_OPTIMIZATION_SPEC.md) - Diagnosis and measurements behind the tilt calculation and tiling choices (background, not a live spec).
* [VISUALIZATION_PIPELINE_SPEC.md](documentation/VISUALIZATION_PIPELINE_SPEC.md) - How input previews and result previews reach the map.
* [LAYOUT_AND_MODES_SPEC.md](documentation/LAYOUT_AND_MODES_SPEC.md) - The page layout and the Basic/Advanced input modes.
* [MAP_QOL_SPEC.md](documentation/MAP_QOL_SPEC.md) - Map quality-of-life features (basemaps and related).
* [GIA_Tool_Penpot_Spec.md](documentation/GIA_Tool_Penpot_Spec.md) - Wireframe rationale and component contracts.
* [FRONTEND_REVIEW.md](documentation/FRONTEND_REVIEW.md) - Notes from a UI walkthrough.
* [CLAUDE.md](CLAUDE.md) - Architecture, design decisions and open items (the most current overview).

### Backend / geoprocessing
* [rasterio](https://rasterio.readthedocs.io/en/stable/) - Reading/writing GeoTIFF and GeoPackage raster data, and windowed/tiled I/O for large files.
* [scikit-image (skimage.measure)](https://scikit-image.org/docs/stable/auto_examples/edges/plot_contours.html) - Finds constant-value (contour) paths in the tilted DEM array.
* [pyproj](https://pyproj4.github.io/pyproj/stable/) - Geodetic distance/azimuth calculations (`Geod`) used to project the tilt across the DEM using true curved-earth geometry.
* [NumPy](https://numpy.org/doc/stable/) - Manipulates the DEM as a 2-D array and vectorizes the tilt calculation.
* [Shapely](https://shapely.readthedocs.io/) - Creation, manipulation, clipping, and merging of the resulting vector geometries (including stitching contour fragments across tile boundaries) before they're serialized into a GeoPackage.
* [GeoPandas](https://geopandas.org/en/stable/docs.html) - Configuring and exporting the strandline contour vector layer to GeoPackage.
* [psutil](https://psutil.readthedocs.io/en/latest/) - Queries live system memory availability to decide between the standard and windowed pipelines.
* [SciPy](https://docs.scipy.org/doc/scipy/) - Sparse least-squares solves and bilinear sampling for the vector direction fields, plus convex hulls for the shore-point surface.
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
* [Turf.js](https://turfjs.org/) (`@turf/destination`, `@turf/bbox`, `@turf/bearing`, `@turf/distance`, `@turf/boolean-point-in-polygon`) - Geodesic point projection for the client-side azimuth line, bearing/distance math for drawn uplift vectors, point-in-polygon checks, and bounding-box math for fitting the map view to the result contour.
* [fflate](https://github.com/101arrowz/fflate) - Client-side unzip of `/api/process`'s bundled response (strandline `.gpkg` + contour GeoJSON + optional tilted-DEM preview + `run_parameters.json`).
* [PapaParse](https://www.papaparse.com/) - CSV parsing for the shore-point import.
* [Vitest](https://vitest.dev/) and [Testing Library](https://testing-library.com/docs/react-testing-library/intro/) - Frontend test runner and component-testing utilities (`npm test` in `frontend/`).
