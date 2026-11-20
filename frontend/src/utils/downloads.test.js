import { describe, it, expect } from 'vitest'
import { unzipSync } from 'fflate'

import { ALL_FILE, buildDownloads, zipForDownload } from './downloads.js'

const bytes = (s) => new TextEncoder().encode(s)

const bundle = (withDem) => ({
  'strandlines.gpkg': bytes('gpkg'),
  'contour.geojson': bytes('{}'),
  'run_parameters.json': bytes('{"x":1}'),
  ...(withDem ? { 'tilted_dem.tif': bytes('tif'), 'preview_tilted.tif': bytes('preview') } : {})
})

async function unzipBlob(blob) {
  return unzipSync(new Uint8Array(await blob.arrayBuffer()))
}

describe('buildDownloads', () => {
  it('offers the contour, the tilted DEM and everything together', () => {
    expect(buildDownloads(bundle(true)).map((d) => [d.key, d.filename])).toEqual([
      ['contour', 'strandlines.gpkg'],
      ['dem', 'tilted_dem.tif'],
      ['all', ALL_FILE]
    ])
  })

  it('has no DEM download when the DEM was not included', () => {
    expect(buildDownloads(bundle(false)).map((d) => d.key)).toEqual(['contour', 'all'])
  })

  it('hands back each file exactly as received', async () => {
    const [contour, dem] = buildDownloads(bundle(true))
    expect(new TextDecoder().decode(await contour.getBlob().arrayBuffer())).toBe('gpkg')
    expect(new TextDecoder().decode(await dem.getBlob().arrayBuffer())).toBe('tif')
  })

  it("lists the zip's contents, leaving out the map-only preview", () => {
    const all = buildDownloads(bundle(true)).find((d) => d.key === 'all')
    expect(all.description).toBe('contour.geojson, run_parameters.json, strandlines.gpkg, tilted_dem.tif')
  })
})

describe('zipForDownload', () => {
  it('zips every file but the map preview, byte for byte', async () => {
    const files = await unzipBlob(zipForDownload(bundle(true)))
    expect(Object.keys(files).sort()).toEqual([
      'contour.geojson', 'run_parameters.json', 'strandlines.gpkg', 'tilted_dem.tif'
    ])
    expect(new TextDecoder().decode(files['run_parameters.json'])).toBe('{"x":1}')
  })
})
