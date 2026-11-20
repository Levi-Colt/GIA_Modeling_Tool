import { zipSync } from 'fflate'

// What the results screen offers for download, built from the unzipped
// /api/process bundle. The contour and the tilted DEM are offered on their own
// (GeoPackage vector layer and float32 GeoTIFF: both open in ArcGIS Pro and
// QGIS), plus every file together as one zip. preview_tilted.tif is only the
// map's decimated preview, so it is left out of the user's zip.
const MAP_ONLY = new Set(['preview_tilted.tif'])

export const CONTOUR_FILE = 'strandlines.gpkg'
export const DEM_FILE = 'tilted_dem.tif'
export const ALL_FILE = 'gia_results.zip'

function blobOf(bytes, type) {
  return new Blob([bytes], { type })
}

export function zipForDownload(files) {
  const entries = {}
  for (const [name, bytes] of Object.entries(files)) {
    // level 0 (stored): elevation rasters and geometry barely compress, and
    // storing keeps a large DEM's zip quick to build in the browser.
    if (!MAP_ONLY.has(name)) entries[name] = [bytes, { level: 0 }]
  }
  return blobOf(zipSync(entries), 'application/zip')
}

export function buildDownloads(files) {
  const downloads = []
  if (files[CONTOUR_FILE]) {
    downloads.push({
      key: 'contour',
      label: 'Strandline contour',
      description: 'GeoPackage line layer',
      filename: CONTOUR_FILE,
      getBlob: () => blobOf(files[CONTOUR_FILE], 'application/geopackage+sqlite3')
    })
  }
  if (files[DEM_FILE]) {
    downloads.push({
      key: 'dem',
      label: 'Tilted DEM',
      description: 'GeoTIFF, float32, NoData -9999',
      filename: DEM_FILE,
      getBlob: () => blobOf(files[DEM_FILE], 'image/tiff')
    })
  }
  const included = Object.keys(files).filter((name) => !MAP_ONLY.has(name)).sort()
  downloads.push({
    key: 'all',
    label: 'All files',
    description: included.join(', '),
    filename: ALL_FILE,
    getBlob: () => zipForDownload(files)
  })
  return downloads
}
