"""
CRS normalization for the API layer.

main.py's calculate_tilt() takes the raster's own affine transform and feeds
the resulting coordinates directly into pyproj.Geod.inv(), which requires
geographic (lon/lat, degrees) input. The affine transform maps pixel space
into whatever CRS the raster is already in -- it does not itself reproject
anything. So if a raster arrives in a projected CRS (UTM, State Plane, etc.),
the backend will silently produce an all-NaN result rather than raising an
error (verified directly against main.calculate_tilt with a synthetic
UTM-CRS raster).

This module is the fix, applied entirely at the API boundary so main.py and
its existing test suite stay untouched:

  1. parse_decimal_degrees_hemisphere -- parses the client's origin_value
     (hemisphere-annotated decimal degrees, the only origin format) directly
     into (lon, lat).
  2. get_raster_crs / get_raster_bounds_wgs84 -- inspect the uploaded
     GeoTIFF's own CRS and its extent reprojected to EPSG:4326.
  3. check_origin_within_threshold -- a geodesic plausibility check that
     rejects an origin implausibly far from the raster's extent.
  4. ensure_wgs84_raster -- inspects the uploaded GeoTIFF's CRS and, if it
     isn't already EPSG:4326, reprojects the whole raster to a new file in
     EPSG:4326 before it's ever handed to app.process_dem.

Both the origin and the raster land on EPSG:4326 specifically (rather than
"whatever CRS each happens to be in") so the two are guaranteed to agree
with each other regardless of what the client uploaded or typed in.
"""
import re
from dataclasses import dataclass

import numpy as np
import rasterio
from rasterio.transform import array_bounds
from rasterio.warp import calculate_default_transform, reproject, Resampling
from pyproj import CRS, Geod

WGS84 = "EPSG:4326"


class InvalidCRSError(ValueError):
    """Raised when a client-supplied CRS identifier can't be parsed."""


class InvalidOriginError(ValueError):
    """Raised when a client-supplied origin coordinate is out of range."""


def parse_decimal_degrees_hemisphere(value: str) -> tuple[float, float]:
    """
    Parses a hemisphere-annotated decimal degrees string, order-agnostic.
    Accepts e.g. "45.25N, 110.55W" or "110.55W, 45.25N" -- the hemisphere
    letter alone determines which token is lat vs lon, so input order
    doesn't matter and there's no coordinate-order ambiguity.
    """
    tokens = [t.strip() for t in value.split(",")]
    if len(tokens) != 2:
        raise InvalidOriginError(f"Expected two comma-separated values, got: '{value}'")

    lat = lon = None
    pattern = re.compile(r"^(\d+(?:\.\d+)?)\s*([NSEW])$", re.IGNORECASE)
    for tok in tokens:
        m = pattern.match(tok)
        if not m:
            raise InvalidOriginError(
                f"'{tok}' isn't a valid decimal-degrees value. "
                "Expected a number followed by N, S, E, or W (e.g. '45.25N')."
            )
        magnitude, hemi = float(m.group(1)), m.group(2).upper()
        if hemi in ("N", "S"):
            if lat is not None:
                raise InvalidOriginError("Two latitude values given, no longitude.")
            if not (0 <= magnitude <= 90):
                raise InvalidOriginError(f"Latitude magnitude {magnitude} out of range for '{hemi}'.")
            lat = magnitude if hemi == "N" else -magnitude
        else:
            if lon is not None:
                raise InvalidOriginError("Two longitude values given, no latitude.")
            if not (0 <= magnitude <= 180):
                raise InvalidOriginError(f"Longitude magnitude {magnitude} out of range for '{hemi}'.")
            lon = magnitude if hemi == "E" else -magnitude

    if lat is None or lon is None:
        raise InvalidOriginError("Need exactly one N/S value and one E/W value.")
    return lon, lat


def get_raster_crs(path: str) -> str:
    """
    Returns the raster's own native CRS as a string (e.g. "EPSG:32612").

    Reported by /api/preflight so the client can show what the DEM is in
    (it is reprojected to EPSG:4326 before processing either way).
    """
    with rasterio.open(path) as src:
        if src.crs is None:
            raise InvalidCRSError(
                "The uploaded GeoTIFF has no CRS defined, so it can't be "
                "reprojected to EPSG:4326."
            )
        return str(src.crs)


def get_raster_bounds_wgs84(path: str) -> tuple[float, float, float, float]:
    """
    Returns the raster's bounding box reprojected into WGS84, as
    (west, south, east, north) in degrees.

    Reuses calculate_default_transform's own bounds-transform behavior --
    the same machinery ensure_wgs84_raster uses to reproject the raster
    itself -- rather than transforming just the four corner points by hand.
    """
    with rasterio.open(path) as src:
        crs = src.crs
        if crs is None:
            raise InvalidCRSError("The uploaded GeoTIFF has no CRS defined.")
        if CRS.from_user_input(crs) == CRS.from_user_input(WGS84):
            left, bottom, right, top = src.bounds
            return left, bottom, right, top

        transform, width, height = calculate_default_transform(
            crs, WGS84, src.width, src.height, *src.bounds
        )
        return array_bounds(height, width, transform)


def get_raster_diagonal_km(path: str) -> float:
    """
    Corner-to-corner geodesic distance across the raster's own extent, in
    km, reprojecting to WGS84 first via get_raster_bounds_wgs84 -- so this
    is correct regardless of the raster's own native CRS. Contrast with
    backend.main's internal diagonal helper, which assumes its input is
    already WGS84 (a safe assumption there, never here -- see that module's
    own docstring).

    Exposed via /api/preflight purely for frontend display
    (documentation/PERFORMANCE_OPTIMIZATION_SPEC.md Fix 1c); calculate_tilt's
    own calibration decision recomputes this independently once the raster
    is guaranteed WGS84, rather than trusting this pre-reprojection value.
    """
    west, south, east, north = get_raster_bounds_wgs84(path)
    geod = Geod(ellps="WGS84")
    _, _, dist_m = geod.inv(west, south, east, north)
    return dist_m / 1000.0


def check_origin_within_threshold(
    origin_lon: float,
    origin_lat: float,
    raster_bounds_wgs84: tuple[float, float, float, float],
    threshold_meters: float = 500.0,
) -> None:
    """
    Raises InvalidOriginError if the origin is implausibly far from the
    raster's extent -- a geodesic distance check applied the same way
    regardless of which origin_mode produced (origin_lon, origin_lat).

    The nearest point on the (axis-aligned, WGS84) bounding rectangle to the
    origin is found by clamping lon/lat independently into the box's range
    (zero distance, and a trivial pass, if the origin already falls inside
    the box), then the true curved-earth distance to that point is measured
    via pyproj.Geod rather than a flat-plane approximation.
    """
    west, south, east, north = raster_bounds_wgs84
    nearest_lon = min(max(origin_lon, west), east)
    nearest_lat = min(max(origin_lat, south), north)

    geod = Geod(ellps="WGS84")
    _, _, distance_m = geod.inv(origin_lon, origin_lat, nearest_lon, nearest_lat)

    if distance_m > threshold_meters:
        raise InvalidOriginError(
            f"Origin ({origin_lon}, {origin_lat}) is {distance_m:.0f} m from the raster's "
            f"extent, which exceeds the {threshold_meters:.0f} m plausibility threshold. "
            "Check that the origin and the DEM cover the same location."
        )


def sample_elevation_at_point(raster_path: str, lon: float, lat: float) -> float | None:
    """
    Samples the raster's band-1 value at (lon, lat), assuming raster_path
    is already in EPSG:4326.

    Returns None if the point falls outside the raster's pixel grid, or if
    the sampled cell is nodata / NaN. Returns the float value otherwise.
    """
    with rasterio.open(raster_path) as src:
        row, col = rasterio.transform.rowcol(src.transform, lon, lat)
        if not (0 <= row < src.height and 0 <= col < src.width):
            return None

        window = rasterio.windows.Window(col, row, 1, 1)
        value = src.read(1, window=window)[0, 0]

        if src.nodata is not None and value == src.nodata:
            return None
        if np.isnan(value):
            return None
        return float(value)


@dataclass
class RasterPrepResult:
    path: str
    was_reprojected: bool
    original_crs: str


def ensure_wgs84_raster(input_path: str, output_path: str) -> RasterPrepResult:
    """
    Guarantees the raster at the returned path is in EPSG:4326.

    If the input is already EPSG:4326, returns the original path unchanged
    (no unnecessary copy/resample of the client's data). Otherwise reprojects
    to output_path using bilinear resampling (appropriate for continuous
    elevation data, unlike nearest-neighbor which would introduce visible
    stair-stepping into the tilt/contour math) and returns that path.
    """
    with rasterio.open(input_path) as src:
        original_crs = src.crs
        if original_crs is None:
            raise InvalidCRSError(
                "The uploaded GeoTIFF has no CRS defined. A DEM must carry "
                "spatial reference metadata to be processed."
            )
        if CRS.from_user_input(original_crs) == CRS.from_user_input(WGS84):
            return RasterPrepResult(path=input_path, was_reprojected=False,
                                     original_crs=str(original_crs))

        transform, width, height = calculate_default_transform(
            original_crs, WGS84, src.width, src.height, *src.bounds
        )
        profile = src.profile.copy()
        profile.update(crs=WGS84, transform=transform, width=width, height=height)

        with rasterio.open(output_path, "w", **profile) as dst:
            for band_idx in range(1, src.count + 1):
                reproject(
                    source=rasterio.band(src, band_idx),
                    destination=rasterio.band(dst, band_idx),
                    src_transform=src.transform,
                    src_crs=original_crs,
                    dst_transform=transform,
                    dst_crs=WGS84,
                    resampling=Resampling.bilinear,
                )
        return RasterPrepResult(path=output_path, was_reprojected=True,
                                 original_crs=str(original_crs))
