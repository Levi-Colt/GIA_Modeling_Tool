# GIA_Modeling_Tool
This tool uses modern DEM data to simulate glacial isostatic adjustment (GIA) for the purpose of identifying potential paleo strandlines.

## How it works
The tool answers one question: *where would an old shoreline (strandline) sit today if the land has since been warped by glacial isostatic adjustment?* You anchor the model at a **spillway**, the outlet that held the lake at a known level. The land there is treated as unmoved, and the rest of the DEM is "un-uplifted" relative to it. The strandline is the contour at the spillway's elevation on the corrected surface.

1. **Load a DEM.** Drop in a GeoTIFF or type its path on the server. The tool checks the file (CRS, size, memory needs) and shows it on the map. Non-WGS84 DEMs are reprojected to WGS84 automatically.
2. **Place the spillway.** Type its latitude/longitude in decimal degrees, or pick it on the map. The strandline is contoured at the DEM's elevation at that point; if the spillway lies off the DEM or on nodata, you enter the elevation yourself.
3. **Describe the uplift.** Uplift is zero at the spillway and grows with distance in the uplift direction. Choose how to describe it:
   * **Basic:** one uplift direction (azimuth) and the gradient at the spillway (meters of uplift per km). This is the simplest mode.
   * **Advanced, single direction:** the same, plus a profile shape (linear, quadratic or polynomial) and what happens behind the spillway. A live chart previews the profile.
   * **Advanced, multiple directions:** draw several direction vectors on the map, each with an azimuth and an optional range of influence, and the tool blends them into a smoothly varying field.
   * **Advanced, shore points:** if you have shoreline elevation measurements, import or enter them and the tool fits an uplift surface to them directly. The fit statistics and residuals are shown so you can judge it.
4. **Set output options.** Optionally keep only contours within a chosen distance of the spillway, and choose whether to include the corrected DEM in the output.
5. **Run and review.** The map shows the strandline contour and, for the advanced modes, uplift contours (isobases). Any warnings from the run are listed with the results.
6. **Download.** You get a zip containing the GeoPackage, a GeoJSON of the contour, and a record of the parameters used (see [Usage](#usage)).

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

### Using the web app
1. Start the app by following [Running the app from a JupyterLab session](#running-the-app-from-a-jupyterlab-session) (or [CryoCloud](#running-in-cryocloud)) and open it in your browser.
2. Work down the four sections: **DEM**, **Origin** (the spillway), **Tilt** and **Output**. Each field shows its state: gray is optional, blue is required and empty, green is valid, red is invalid. The **Run** button enables once every required field is valid.
3. Use the **Basic / Advanced** switch above Run to move between a single-page form and collapsible sections with the extra uplift options. Switching never clears what you entered.
4. Press **Run**. A large DEM can take a while; the progress indicator is indeterminate while it works.
5. On the results screen, inspect the contour on the map and read the warnings, then download the zip.

Very large DEMs are handled automatically: the tool checks available memory and processes the raster in tiles when it won't fit.

### What you get back
The download is a zip bundle:

| File | Contents |
|---|---|
| `strandlines.gpkg` | The strandline contour layer, plus the corrected DEM as a raster layer if you included it. |
| `contour.geojson` | The same contour as GeoJSON (EPSG:4326). |
| `preview_tilted.tif` | A small decimated preview of the corrected DEM (only when the DEM was included). |
| `run_parameters.json` | Everything the run used, plus fit diagnostics, so the run can be reproduced. |
| `shore_points.csv` | The shore points used (only for shore-point runs); it can be re-imported. |

The full request/response contract is in [api-README.md](documentation/api-README.md).

## Known limitations
A few behaviors are intentional trade-offs or documented gaps rather than bugs, and are worth knowing about:

- **`write_dem_to_gpkg` overwrites an existing file at the same path by default** (`overwrite=True`); pass `overwrite=False` to restore the strict raise-if-exists behavior (e.g. to add a raster layer to an existing multi-layer `.gpkg` without touching its other layers). `write_dem_to_gpkg_windowed` shares the same `overwrite` parameter and default.
- **No `nodata` value is declared on GeoPackage raster output** — NaN values round-trip correctly as bit patterns, but downstream tools that rely on an explicit nodata tag (rather than recognizing NaN by convention) will treat those cells as literal data.
- **Multi-tile DEM mosaicking is not yet supported.** Input DEMs are expected as a single GeoTIFF; if a study area spans multiple source tiles (e.g., multiple 1°x1° USGS tiles), the user is currently responsible for mosaicking them beforehand.
- **DEM inputs are automatically reprojected to WGS84.** Regardless of the CRS of the input DEM, once uploaded, the input DEM is reprojected to WGS84. This is done to enforce CRS uniformity and simplify the map visualization, tilt calculation, and contouring workflows. This also means any products the user downloads will also be in WGS84.

## Documentation

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
