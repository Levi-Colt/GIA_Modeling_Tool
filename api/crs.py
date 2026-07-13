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

  1. normalize_origin_to_wgs84 -- takes an (x, y, crs) origin and reprojects
     it to (lon, lat) in EPSG:4326.
  2. parse_xy_pair / parse_decimal_degrees_hemisphere -- parse the client's
     origin_value string per origin_mode (see api/main.py) into either a raw
     (x, y) pair or directly into (lon, lat), before any CRS work happens.
  3. get_raster_crs / get_raster_bounds_wgs84 -- inspect the uploaded
     GeoTIFF's own CRS and its extent reprojected to EPSG:4326.
  4. check_origin_within_threshold -- a geodesic plausibility check, applied
     the same way regardless of origin_mode, that rejects an origin
     implausibly far from the raster's extent.
  5. ensure_wgs84_raster -- inspects the uploaded GeoTIFF's CRS and, if it
     isn't already EPSG:4326, reprojects the whole raster to a new file in
     EPSG:4326 before it's ever handed to app.process_dem.

Both the origin and the raster land on EPSG:4326 specifically (rather than
"whatever CRS each happens to be in") so the two are guaranteed to agree
with each other regardless of what the client uploaded or typed in.
"""
import re
from dataclasses import dataclass

import rasterio
from rasterio.transform import array_bounds
from rasterio.warp import calculate_default_transform, reproject, Resampling
from pyproj import CRS, Geod, Transformer
from pyproj.exceptions import CRSError

WGS84 = "EPSG:4326"


class InvalidCRSError(ValueError):
    """Raised when a client-supplied CRS identifier can't be parsed."""


class InvalidOriginError(ValueError):
    """Raised when a client-supplied origin coordinate is out of range."""


def _parse_crs(crs_input: str) -> CRS:
    try:
        return CRS.from_user_input(crs_input)
    except CRSError as e:
        raise InvalidCRSError(
            f"'{crs_input}' is not a recognized CRS identifier. "
            "Use an EPSG code (e.g. 'EPSG:32612') or a recognized CRS name."
        ) from e


def normalize_origin_to_wgs84(x: float, y: float, source_crs: str) -> tuple[float, float]:
    """
    Reprojects a client-supplied origin point into (lon, lat) in EPSG:4326.

    x, y are in the order native to source_crs (e.g. easting, northing for a
    projected CRS; lon, lat for a geographic one) -- NOT assumed to already
    be lon/lat. Raises InvalidCRSError for an unrecognized CRS identifier,
    or InvalidOriginError if the resulting point is outside valid WGS84
    bounds (a strong signal the client sent x/y in the wrong order, or under
    the wrong CRS).
    """
    crs = _parse_crs(source_crs)
    transformer = Transformer.from_crs(crs, WGS84, always_xy=True)
    lon, lat = transformer.transform(x, y)

    if not (-180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0):
        raise InvalidOriginError(
            f"Origin ({x}, {y}) in {source_crs} reprojects to ({lon}, {lat}), "
            "which is outside valid WGS84 bounds. Check the coordinate order "
            "and CRS -- for a projected CRS this is usually (easting, northing)."
        )
    return lon, lat


def parse_xy_pair(value: str) -> tuple[float, float]:
    """
    Parses a plain "x,y" pair of floats -- no CRS or hemisphere info implied.

    Shared by the 'match_raster' and 'epsg' origin modes, where the caller
    already knows (from the raster's own CRS, or from origin_epsg) what x
    and y mean; this function just handles the comma-separated-floats
    syntax common to both.
    """
    tokens = [t.strip() for t in value.split(",")]
    if len(tokens) != 2:
        raise InvalidOriginError(f"Expected two comma-separated numbers, got: '{value}'")
    try:
        x, y = float(tokens[0]), float(tokens[1])
    except ValueError as e:
        raise InvalidOriginError(f"'{value}' isn't a valid 'x,y' numeric pair.") from e
    return x, y


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

    Used by the 'match_raster' origin mode, where the client's origin_value
    is expressed in whatever CRS the raster is already in -- so the client
    needs no CRS knowledge, but we still need to know what that CRS is
    before the coordinate can be reprojected to WGS84.
    """
    with rasterio.open(path) as src:
        if src.crs is None:
            raise InvalidCRSError(
                "The uploaded GeoTIFF has no CRS defined, so 'match_raster' can't "
                "determine what CRS the origin coordinates are in."
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
