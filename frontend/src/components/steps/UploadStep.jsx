import parseGeoraster from 'georaster'
import { useProcessing } from '../../context/ProcessingContext.jsx'
import { runPreflight, rasterPreview } from '../../api/client.js'

// States: idle | checking | valid | invalid — identical for drag-drop and
// typed path, since both resolve through the same preflight call. See spec:
// a typed path can't be validated client-side (it points at a server-side
// filesystem the browser can't read), so both entry methods share one
// round-trip to the backend's raster_io_check-backed preflight endpoint.
export default function UploadStep() {
  const { formState, updateForm } = useProcessing()
  const { preflightStatus, preflightMessage } = formState

  async function checkFile(file, path) {
    updateForm({ preflightStatus: 'checking', preflightMessage: '' })
    try {
      const result = await runPreflight(file, path)
      updateForm({
        demFile: file || formState.demFile,
        demPath: path ?? formState.demPath,
        preflightStatus: 'valid',
        preflightMessage: result.crs ? `readable, ${result.crs}` : 'readable',
        boundsWgs84: result.bounds_wgs84 ?? null,
        demCrs: result.crs ?? null
      })
      loadRasterPreview(file, path)
    } catch (err) {
      updateForm({ preflightStatus: 'invalid', preflightMessage: err.message })
    }
  }

  // Fires once, right after preflight succeeds (not on every keystroke) --
  // see documentation/VISUALIZATION_PIPELINE_SPEC.md Stage 2. Failure here is silent
  // (falls back to no raster layer on the map) since preflight having
  // already succeeded means the DEM itself is fine; a preview failure
  // shouldn't block or scare the user off an otherwise-valid upload.
  async function loadRasterPreview(file, path) {
    try {
      const arrayBuffer = await rasterPreview(file, path)
      const georaster = await parseGeoraster(arrayBuffer)
      updateForm({ rasterPreviewGeoraster: georaster })
    } catch {
      updateForm({ rasterPreviewGeoraster: null })
    }
  }

  function handleDrop(e) {
    e.preventDefault()
    const file = e.dataTransfer.files?.[0]
    if (file) checkFile(file, null)
  }

  function handlePathBlur(e) {
    const path = e.target.value.trim()
    if (path) checkFile(null, path)
  }

  return (
    <section id="step-upload">
      <p className="mb-2 text-xs text-gray-400">1 · Upload DEM</p>

      {preflightStatus === 'valid' ? (
        <div className="flex items-center justify-between rounded-md border border-green-300 px-3 py-3 text-sm">
          <span>
            {formState.demFile?.name || formState.demPath} · {preflightMessage}
          </span>
          <button
            className="text-xs"
            onClick={() =>
              updateForm({
                preflightStatus: 'idle',
                demFile: null,
                demPath: '',
                boundsWgs84: null,
                demCrs: null,
                rasterPreviewGeoraster: null
              })
            }
          >
            Replace
          </button>
        </div>
      ) : (
        <div
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          className="rounded-md border border-dashed border-gray-300 p-6 text-center"
        >
          <p className="mb-2 text-sm text-gray-500">Drag a GeoTIFF here, or</p>
          <input
            type="text"
            placeholder="/path/to/dem.tif"
            className="w-56"
            onBlur={handlePathBlur}
            onKeyDown={(e) => e.key === 'Enter' && handlePathBlur(e)}
          />
          {preflightStatus === 'checking' && (
            <p className="mt-2 text-xs text-gray-500">Checking file...</p>
          )}
          {preflightStatus === 'invalid' && (
            <p className="mt-2 text-xs text-red-600">{preflightMessage}</p>
          )}
        </div>
      )}
    </section>
  )
}
