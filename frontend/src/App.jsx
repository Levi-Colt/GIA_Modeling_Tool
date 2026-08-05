import { useState } from 'react'
import parseGeoraster from 'georaster'
import { ProcessingProvider, useProcessing } from './context/ProcessingContext.jsx'
import StepRail from './components/shared/StepRail.jsx'
import MapPanel from './components/map/MapPanel.jsx'
import UploadStep from './components/steps/UploadStep.jsx'
import { CoordinateModeStep, CoordinatesStep } from './components/steps/CoordinateSteps.jsx'
import { TiltStep, ProductsStep } from './components/steps/TiltAndProductsSteps.jsx'
import LoadingState from './components/results/LoadingState.jsx'
import ResultsSuccess from './components/results/ResultsSuccess.jsx'
import ResultsError from './components/results/ResultsError.jsx'
import { runProcess } from './api/client.js'
import { scrollToStep } from './utils/steps.js'
import { azimuthLine as computeAzimuthLine } from './utils/geometry.js'

// Derives the map's input-preview shape from form state alone — the
// extent/origin/demCrs fields come from /api/preflight and
// /api/resolve-point respectively (cached client-side in formState by
// UploadStep.jsx / CoordinateSteps.jsx), but the azimuth line geometry
// itself is pure client-side math, no backend call. This is the "input
// preview" half of the map contract; the "result preview" half (contour /
// tiltedRasterPreview) gets populated separately once /process returns —
// see the adapter in handleRunModel below.
function deriveMapDataFromForm(formState) {
  const extent = formState.boundsWgs84 || null
  const origin = formState.resolvedOrigin || null
  const azimuthDeg = formState.tiltAzimuth !== '' ? Number(formState.tiltAzimuth) : null

  let azimuthLine = null
  if (extent && origin && azimuthDeg !== null && !Number.isNaN(azimuthDeg)) {
    azimuthLine = computeAzimuthLine(origin, azimuthDeg, extent)
  }

  return {
    extent,
    rasterPreview: formState.rasterPreviewGeoraster
      ? { georaster: formState.rasterPreviewGeoraster }
      : null,
    origin,
    azimuthLine
  }
}

// Adapter step for the "result preview" half of the map contract --
// separate from deriveMapDataFromForm's "input preview" half, per the
// Penpot spec's contract: a future change to /process's output format only
// touches this adapter, never MapPanel itself. Parses preview_tilted.tif's
// raw bytes (when include_dem was on) with georaster, same library Stage 2
// uses for the uploaded-raster preview.
async function deriveMapDataFromResult({ contour, tiltedRasterBytes }) {
  const tiltedRasterPreview = tiltedRasterBytes
    ? { georaster: await parseGeoraster(tiltedRasterBytes) }
    : null
  return { contour: contour || null, tiltedRasterPreview }
}

const IDLE_RUN_STATE = { status: 'idle', startedAt: null, result: null, resultMapData: null, error: null }

// Best-effort keyword heuristic over the backend's free-text `detail`
// strings (there are no typed error codes) — a routing hint for which step
// to send the user back to, not a correctness-critical classification.
function classifyErrorStep(message) {
  const text = (message || '').toLowerCase()
  if (/extent|origin|500|geodesic/.test(text)) return 'coordinates'
  if (/elevation range/.test(text)) return 'tilt'
  if (/file type|corrupted|geotiff|extension/.test(text)) return 'upload'
  return null
}

// UX nicety only — not a substitute for the backend's own 422 validation.
function isReadyToRun(formState) {
  if (formState.preflightStatus !== 'valid') return false
  if (!formState.originValue) return false
  if (formState.originMode === 'epsg' && !formState.originEpsg) return false
  if (!formState.tiltAzimuth || !formState.tiltFactor || !formState.targetElevation) return false
  return true
}

function buildProcessPayload(formState) {
  return {
    ...(formState.demFile ? { dem_file: formState.demFile } : { file_path: formState.demPath }),
    origin_mode: formState.originMode,
    origin_value: formState.originValue,
    ...(formState.originMode === 'epsg' ? { origin_epsg: formState.originEpsg } : {}),
    tilt_azimuth: formState.tiltAzimuth,
    tilt_factor: formState.tiltFactor,
    target_elevation: formState.targetElevation,
    include_dem: formState.includeDem
  }
}

function ProcessingPage() {
  const { formState } = useProcessing()
  // Transient — deliberately not persisted to localStorage like formState,
  // so kept as local state here rather than in ProcessingContext.
  const [runState, setRunState] = useState(IDLE_RUN_STATE)
  const completedIds = []
  if (formState.preflightStatus === 'valid') completedIds.push('upload')
  if (formState.originMode) completedIds.push('mode')

  async function handleRunModel() {
    if (!isReadyToRun(formState)) return
    setRunState({ status: 'running', startedAt: Date.now(), result: null, error: null })
    try {
      const { blob, contour, tiltedRasterBytes, reprojectedFrom, warnings, elevationSource, elevationNote } =
        await runProcess(buildProcessPayload(formState))
      const resultMapData = await deriveMapDataFromResult({ contour, tiltedRasterBytes })
      setRunState({
        status: 'success',
        startedAt: null,
        result: { blob, filename: 'strandlines.gpkg', reprojectedFrom, warnings, elevationSource, elevationNote },
        resultMapData,
        error: null
      })
    } catch (err) {
      setRunState({
        status: 'error',
        startedAt: null,
        result: null,
        error: { message: err.message, stepId: classifyErrorStep(err.message) }
      })
    }
  }

  // Resets to idle and, if a step was implicated, scrolls to it once the
  // form panel is back in the DOM. The scroll target only exists after this
  // state update re-renders the idle branch below, so it's deferred a tick
  // rather than run synchronously against the still-mounted results screen.
  function resetRun(stepId) {
    setRunState(IDLE_RUN_STATE)
    if (stepId) {
      setTimeout(() => scrollToStep(stepId), 0)
    }
  }

  if (runState.status !== 'idle') {
    // Same two-column sticky-map layout as the idle form view, so the map
    // stays visible while a run is loading or its results are shown -- the
    // result-preview half of the map contract (contour / tiltedRasterPreview)
    // is inherently tied to this screen, not achievable earlier (see
    // documentation/VISUALIZATION_PIPELINE_SPEC.md Stage 3 / documentation/GIA_Tool_Penpot_Spec.md).
    // Carries the input-preview fields (extent/origin/azimuthLine) forward
    // for context alongside whatever the result adapter produced.
    const mapData = { ...deriveMapDataFromForm(formState), ...(runState.resultMapData || {}) }

    return (
      <div className="mx-auto grid max-w-5xl grid-cols-[1.3fr_1fr] gap-4 p-6">
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          {runState.status === 'running' && <LoadingState startedAt={runState.startedAt} />}
          {runState.status === 'success' && (
            <ResultsSuccess
              result={runState.result}
              formState={formState}
              onRunAgain={handleRunModel}
              onAdjustInputs={() => resetRun(null)}
            />
          )}
          {runState.status === 'error' && (
            <ResultsError error={runState.error} onBack={() => resetRun(runState.error.stepId)} />
          )}
        </div>

        <MapPanel mapData={mapData} azimuthDeg={formState.tiltAzimuth} />
      </div>
    )
  }

  return (
    <div className="mx-auto grid max-w-5xl grid-cols-[1.3fr_1fr] gap-4 p-6">
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <StepRail completedIds={completedIds} currentId="coordinates" />
        <div className="space-y-3">
          <UploadStep />
          <CoordinateModeStep />
          <CoordinatesStep />
          <TiltStep />
          <ProductsStep />
        </div>
        <button
          onClick={handleRunModel}
          className="mt-4 w-full rounded-md bg-gray-900 py-2 font-medium text-white"
        >
          Run model
        </button>
      </div>

      <MapPanel mapData={deriveMapDataFromForm(formState)} azimuthDeg={formState.tiltAzimuth} />
    </div>
  )
}

export default function App() {
  return (
    <ProcessingProvider>
      <ProcessingPage />
    </ProcessingProvider>
  )
}
