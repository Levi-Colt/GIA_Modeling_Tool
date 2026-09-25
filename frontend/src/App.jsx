import { useRef, useState } from 'react'
import parseGeoraster from 'georaster'
import { ProcessingProvider, useProcessing } from './context/ProcessingContext.jsx'
import AppLayout from './components/shared/AppLayout.jsx'
import ModeSwitch from './components/shared/ModeSwitch.jsx'
import BasicForm from './components/forms/BasicForm.jsx'
import AdvancedForm from './components/forms/AdvancedForm.jsx'
import MapPanel from './components/map/MapPanel.jsx'
import LoadingState from './components/results/LoadingState.jsx'
import ResultsSuccess from './components/results/ResultsSuccess.jsx'
import ResultsError from './components/results/ResultsError.jsx'
import { runProcess } from './api/client.js'
import { azimuthLine as computeAzimuthLine } from './utils/geometry.js'
import { getReadiness, isReadyToRun, parseSelectionRadiusKm } from './utils/readiness.js'
import { buildProcessPayload } from './utils/payload.js'
import { classifyErrorStep } from './utils/steps.js'

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

  // Only once the origin has resolved and the radius is a valid positive
  // number; shows up as soon as the user types it, before any run.
  const radiusKm = parseSelectionRadiusKm(formState.selectionRadiusKm)
  const selectionRadius = origin && radiusKm !== null ? { center: origin, radiusKm } : null

  return {
    extent,
    selectionRadius,
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

function ProcessingPage() {
  const { formState } = useProcessing()
  // Transient — deliberately not persisted to localStorage like formState,
  // so kept as local state here rather than in ProcessingContext.
  const [runState, setRunState] = useState(IDLE_RUN_STATE)
  // { id, n } -- the form (Basic or Advanced) reacts to a new request by
  // scrolling to that step's section, opening it first in Advanced. Cleared on
  // mode switches so a stale request can't re-fire when the other form mounts.
  const [focusRequest, setFocusRequest] = useState(null)
  const bodyRef = useRef(null)
  const { ready, missingText } = getReadiness(formState)

  async function handleRunModel() {
    if (!isReadyToRun(formState)) return
    setRunState({ status: 'running', startedAt: Date.now(), result: null, error: null })
    try {
      const { blob, contour, tiltedRasterBytes, reprojectedFrom, warnings, elevationSource, elevationNote, selectionSummary } =
        await runProcess(buildProcessPayload(formState))
      const resultMapData = await deriveMapDataFromResult({ contour, tiltedRasterBytes })
      setRunState({
        status: 'success',
        startedAt: null,
        result: { blob, filename: 'strandlines.gpkg', reprojectedFrom, warnings, elevationSource, elevationNote, selectionSummary },
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

  // Resets to idle and, if a step was implicated, asks the (re-mounted) form to
  // focus it. The form handles the request in an effect, so it runs once the
  // form is back in the DOM -- and, in Advanced, after opening a collapsed
  // section.
  function resetRun(stepId) {
    setRunState(IDLE_RUN_STATE)
    setFocusRequest(stepId ? (prev) => ({ id: stepId, n: (prev?.n ?? 0) + 1 }) : null)
  }

  function handleModeSwitched() {
    setFocusRequest(null)
    requestAnimationFrame(() => bodyRef.current?.scrollTo?.({ top: 0 }))
  }

  if (runState.status !== 'idle') {
    // Same layout as the idle form view, so the map stays visible while a run
    // is loading or its results are shown -- the result-preview half of the
    // map contract (contour / tiltedRasterPreview) is inherently tied to this
    // screen, not achievable earlier (see documentation/VISUALIZATION_PIPELINE_SPEC.md
    // Stage 3 / documentation/GIA_Tool_Penpot_Spec.md). The results panel
    // replaces the form column and the mode switch is hidden. Carries the
    // input-preview fields (extent/origin/azimuthLine) forward for context
    // alongside whatever the result adapter produced.
    const mapData = { ...deriveMapDataFromForm(formState), ...(runState.resultMapData || {}) }

    return (
      <AppLayout
        bodyRef={bodyRef}
        map={<MapPanel mapData={mapData} azimuthDeg={formState.tiltAzimuth} />}
      >
        <div className="p-5">
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
      </AppLayout>
    )
  }

  return (
    <AppLayout
      bodyRef={bodyRef}
      modeSwitch={<ModeSwitch onSwitch={handleModeSwitched} />}
      map={<MapPanel mapData={deriveMapDataFromForm(formState)} azimuthDeg={formState.tiltAzimuth} />}
      footer={
        <>
          <button
            onClick={handleRunModel}
            disabled={!ready}
            className="w-full rounded-md bg-gray-900 py-2 font-medium text-white
                       disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500"
          >
            Run model
          </button>
          {!ready && (
            <p className="mt-1 text-xs text-gray-500">Still needed: {missingText.join(', ')}</p>
          )}
        </>
      }
    >
      {formState.mode === 'advanced' ? (
        <AdvancedForm focusRequest={focusRequest} />
      ) : (
        <BasicForm focusRequest={focusRequest} />
      )}
    </AppLayout>
  )
}

export default function App() {
  return (
    <ProcessingProvider>
      <ProcessingPage />
    </ProcessingProvider>
  )
}
