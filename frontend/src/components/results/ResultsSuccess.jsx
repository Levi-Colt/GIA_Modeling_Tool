import Banner from '../shared/Banner.jsx'

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export default function ResultsSuccess({ result, formState, onRunAgain, onAdjustInputs }) {
  const { blob, filename, reprojectedFrom, warnings, elevationNote } = result

  return (
    <div className="space-y-4 py-2">
      <div className="flex items-center gap-2 text-lg font-medium text-gray-900">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-green-600 text-white">✓</span>
        Model run complete.
      </div>

      {/* Two separate banners, not one combined box -- a real severity
          difference between a neutral fact (reprojection) and something
          worth attention (backend warnings). */}
      {reprojectedFrom && (
        <Banner variant="info">
          Input was reprojected from {reprojectedFrom} to EPSG:4326 before processing.
        </Banner>
      )}
      {elevationNote && <Banner variant="info">{elevationNote}</Banner>}
      {warnings && <Banner variant="warning">{warnings}</Banner>}

      <div className="rounded-md border border-gray-200 p-4">
        <p className="text-sm font-medium text-gray-900">{filename}</p>
        <p className="text-xs text-gray-500">
          Strandline contour GeoPackage
          {formState.includeDem ? ' (includes the tilted DEM as a raster layer)' : ''}
        </p>
        <button
          onClick={() => triggerDownload(blob, filename)}
          className="mt-3 rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white"
        >
          Download
        </button>
      </div>

      <p className="text-xs text-gray-500">
        Azimuth {formState.tiltAzimuth}&deg; &middot; Tilt {formState.tiltFactor} m/km &middot; Target
        elevation {formState.targetElevation} m
      </p>

      <div className="flex gap-2">
        <button onClick={onRunAgain} className="rounded-md border border-gray-300 px-4 py-2 text-sm">
          Run again with same inputs
        </button>
        <button onClick={onAdjustInputs} className="rounded-md border border-gray-300 px-4 py-2 text-sm">
          Adjust inputs
        </button>
      </div>
    </div>
  )
}
