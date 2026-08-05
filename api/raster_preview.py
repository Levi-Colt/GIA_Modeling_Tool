"""
Shared "decimate + reproject-to-WGS84" recipe for raster preview bytes, used
by both POST /api/raster-preview (Stage 2 -- the uploaded/pathed DEM as
first dropped) and POST /api/process's bundled preview_tilted.tif (Stage 3
-- the tilted DEM, read back from the .gpkg raster table it was already
written to). See documentation/VISUALIZATION_PIPELINE_SPEC.md.

Kept out of api/main.py to avoid duplicating this two-step recipe (decimate
first at native resolution -- cheap regardless of source size -- then
reproject only the small decimated array, not the full raster) across the
two call sites.
"""
import numpy as np
import rasterio
from rasterio.io import MemoryFile
from rasterio.warp import calculate_default_transform, reproject, Resampling
from pyproj import CRS

from api.crs import WGS84, InvalidCRSError

# Starting value suggested directly in documentation/VISUALIZATION_PIPELINE_SPEC.md --
# explicitly a "revisit against a real CryoCloud pod" number, not tuned
# against any real-world memory/latency measurement yet.
PREVIEW_MAX_DIM = 1024


def build_preview_geotiff_bytes(source, max_dim: int = PREVIEW_MAX_DIM) -> bytes:
    """
    Opens `source` (a file path, or a GDAL connection string like
    "GPKG:path:table_name" for reading a specific GeoPackage raster table),
    decimates band 1 so neither dimension exceeds max_dim, reprojects that
    small array to EPSG:4326 if it isn't already, and returns the result as
    an in-memory single-band GeoTIFF's bytes.
    """
    with rasterio.open(source) as src:
        if src.crs is None:
            raise InvalidCRSError(
                "The raster has no CRS defined, so a preview can't be georeferenced."
            )

        scale = min(1.0, max_dim / max(src.width, src.height))
        out_height = max(1, round(src.height * scale))
        out_width = max(1, round(src.width * scale))

        decimated = src.read(
            1,
            out_shape=(out_height, out_width),
            resampling=Resampling.bilinear,
        )
        decimated_transform = src.transform * src.transform.scale(
            src.width / out_width, src.height / out_height
        )
        src_crs = src.crs
        dtype = src.dtypes[0]
        nodata = src.nodata

    if CRS.from_user_input(src_crs) == CRS.from_user_input(WGS84):
        out_array = decimated
        out_transform = decimated_transform
    else:
        dst_transform, dst_width, dst_height = calculate_default_transform(
            src_crs, WGS84, out_width, out_height,
            *rasterio.transform.array_bounds(out_height, out_width, decimated_transform),
        )
        out_array = np.empty((dst_height, dst_width), dtype=decimated.dtype)
        reproject(
            source=decimated,
            destination=out_array,
            src_transform=decimated_transform,
            src_crs=src_crs,
            dst_transform=dst_transform,
            dst_crs=WGS84,
            src_nodata=nodata,
            dst_nodata=nodata,
            resampling=Resampling.bilinear,
        )
        out_transform = dst_transform

    profile = {
        "driver": "GTiff",
        "height": out_array.shape[0],
        "width": out_array.shape[1],
        "count": 1,
        "dtype": dtype,
        "crs": WGS84,
        "transform": out_transform,
    }
    if nodata is not None:
        profile["nodata"] = nodata

    with MemoryFile() as mem:
        with mem.open(**profile) as dst:
            dst.write(out_array.astype(dtype), 1)
        return mem.read()
