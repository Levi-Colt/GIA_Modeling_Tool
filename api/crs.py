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

  1. normalize_origin_to_wgs84 -- takes whatever (x, y, crs) the client sent
     for the tilt origin and reprojects it to (lon, lat) in EPSG:4326.
  2. ensure_wgs84_raster -- inspects the uploaded GeoTIFF's CRS and, if it
     isn't already EPSG:4326, reprojects the whole raster to a new file in
     EPSG:4326 before it's ever handed to app.process_dem.

Both steps land on EPSG:4326 specifically (rather than "whatever CRS the
raster happens to be in") so the two are guaranteed to agree with each
other regardless of what the client uploaded or typed in.
"""
from dataclasses import dataclass

import rasterio
from rasterio.warp import calculate_default_transform, reproject, Resampling
from pyproj import CRS, Transformer
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
