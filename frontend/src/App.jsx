import { useMemo, useRef, useState } from 'react'
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
import { useProfilePreview } from './hooks/useProfilePreview.js'
import { useUpliftPreview } from './hooks/useUpliftPreview.js'
import { surfaceFitKey, useSurfaceFit } from './hooks/useSurfaceFit.js'
import { azimuthLine as computeAzimuthLine } from './utils/geometry.js'
import { getReadiness, isReadyToRun, parseSelectionRadiusKm } from './utils/readiness.js'
import { buildProcessPayload } from './utils/payload.js'
import { classifyErrorStep } from './utils/steps.js'
import { usingPoints, usingVectors } from './utils/tiltModel.js'
import { normalizeShorePoints, shorePointsToMapData } from './utils/shorePoints.js'
import { fieldsFromGeometry, newVector, normalizeVectors, vectorsToMapData } from './utils/vectors.js'

// Derives the map's input-preview shape from the form's fields alone — the
// extent/origin/demCrs fields come from /api/preflight and
// /api/resolve-point respectively (cached client-side in formState by
// UploadStep.jsx / CoordinateSteps.jsx), but the azimuth line geometry
// itself is pure client-side math, no backend call. This is the "input
// preview" half of the map contract; the "result preview" half (contour /
// tiltedRasterPreview) gets populated separately once /process returns —
// see the adapter in handleRunModel below.
function deriveMapDataFromForm(formState, hideAzimuthLine) {
  const extent = formState.boundsWgs84 || null
  const origin = formState.resolvedOrigin || null
  const azimuthDeg = formState.tiltAzimuth !== '' ? Number(formState.tiltAzimuth) : null

  // The single-azimuth line belongs to the azimuth direction source only; in
  // vectors mode the arrows and isobases (added by the caller) take its place, and
  // in shore-points mode the points and the fitted surface's isobases do.
  let azimuthLine = null
  if (!hideAzimuthLine && extent && origin && azimuthDeg !== null && !Number.isNaN(azimuthDeg)) {
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
  const { formState, setVectors, selectVector, setMapEditMode, requestVectorFocus } = useProcessing()
  // Transient — deliberately not persisted to localStorage like formState,
  // so kept as local state here rather than in ProcessingContext.
  const [runState, setRunState] = useState(IDLE_RUN_STATE)
  // { id, n } -- the form (Basic or Advanced) reacts to a new request by
  // scrolling to that step's section, opening it first in Advanced. Cleared on
  // mode switches so a stale request can't re-fire when the other form mounts.
  const [focusRequest, setFocusRequest] = useState(null)
  const bodyRef = useRef(null)
  const { ready, missingText } = getReadiness(formState)
  // Keeps formState.profilePreview current for the tilt-model chart and the
  // results screen's hinge summary, whichever view is showing.
  useProfilePreview()
  // Likewise the vectors direction source's isobases and per-vector fit.
  useUpliftPreview()
  // And the shore-points direction source's fitted surface.
  useSurfaceFit()

  // Map data. Each field is memoized on its own inputs so MapPanel's per-layer
  // effects only re-run for the layer that actually changed (an edit to the
  // vectors must not rebuild the raster). The vector and isobase fields only
  // exist in vectors mode.
  const vectorsMode = usingVectors(formState)
  const pointsMode = usingPoints(formState)
  const { boundsWgs84, resolvedOrigin, tiltAzimuth, selectionRadiusKm, rasterPreviewGeoraster } = formState
  const inputMapData = useMemo(
    () =>
      deriveMapDataFromForm(
        { boundsWgs84, resolvedOrigin, tiltAzimuth, selectionRadiusKm, rasterPreviewGeoraster },
        vectorsMode || pointsMode
      ),
    [boundsWgs84, resolvedOrigin, tiltAzimuth, selectionRadiusKm, rasterPreviewGeoraster, vectorsMode, pointsMode]
  )
  const vectorList = formState.advanced.vectors
  const selectedVectorId = formState.selectedVectorId
  const mapVectors = useMemo(() => {
    if (!vectorsMode) return null
    const list = vectorsToMapData(normalizeVectors(vectorList), selectedVectorId, boundsWgs84)
    return list.length ? list : null
  }, [vectorsMode, vectorList, selectedVectorId, boundsWgs84])
  const isobases = vectorsMode ? formState.upliftPreview?.data?.isobases ?? null : null
  // Shore points (drawn colored by residual once the fit answers exactly these
  // points), the fitted surface's isobases and the data hull -- shore-points mode only.
  const shorePointList = formState.advanced.shorePoints
  const surfaceFit = formState.surfaceFit
  const currentFitKey = pointsMode ? surfaceFitKey(formState) : null
  const fitIsCurrent = surfaceFit?.status === 'ready' && surfaceFit.key !== null && surfaceFit.key === currentFitKey
  const mapShorePoints = useMemo(() => {
    if (!pointsMode) return null
    const list = shorePointsToMapData(
      normalizeShorePoints(shorePointList),
      fitIsCurrent ? surfaceFit.data.selected : null
    )
    return list.length ? list : null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointsMode, shorePointList, fitIsCurrent, surfaceFit?.data])
  const surfaceIsobases = pointsMode ? surfaceFit?.data?.isobases ?? null : null
  const dataHull = pointsMode ? surfaceFit?.data?.hull ?? null : null
  const formMapData = useMemo(
    () => ({
      ...inputMapData,
      vectors: mapVectors,
      isobases,
      shorePoints: mapShorePoints,
      surfaceIsobases,
      dataHull
    }),
    [inputMapData, mapVectors, isobases, mapShorePoints, surfaceIsobases, dataHull]
  )
  const resultMapData = runState.resultMapData
  const resultsMapData = useMemo(() => ({ ...formMapData, ...(resultMapData || {}) }), [formMapData, resultMapData])

  // Geometry edits from the map (vectors mode, form view only). All commit on
  // drag end; structural ones are undoable.
  const editing = vectorsMode
    ? {
        mode: formState.mapEditMode,
        onAddVector: (geometry) => {
          const v = newVector(fieldsFromGeometry(geometry))
          setVectors((list) => [...list, v], { undoable: true })
          selectVector(v.id)
          // A click gives no azimuth: have the table take focus there.
          if (!Number.isFinite(geometry.azimuthDeg)) requestVectorFocus(v.id)
        },
        onUpdateVector: (id, geometry) =>
          setVectors(
            (list) => list.map((v) => (v.id === id ? { ...v, ...fieldsFromGeometry(geometry) } : v)),
            { undoable: true }
          ),
        onSelectVector: selectVector,
        onExitAddMode: () => setMapEditMode('none')
      }
    : undefined
  const compassAzimuth = vectorsMode || pointsMode ? '' : formState.tiltAzimuth

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
    setMapEditMode('none') // an armed "Add on map" never survives a mode switch
    requestAnimationFrame(() => bodyRef.current?.scrollTo?.({ top: 0 }))
  }

  if (runState.status !== 'idle') {
    // Same layout as the idle form view, so the map stays visible while a run
    // is loading or its results are shown -- the result-preview half of the
    // map contract (contour / tiltedRasterPreview) is inherently tied to this
    // screen, not achievable earlier (see documentation/VISUALIZATION_PIPELINE_SPEC.md
    // Stage 3 / documentation/GIA_Tool_Penpot_Spec.md). The results panel
    // replaces the form column and the mode switch is hidden. Carries the
    // input-preview fields (extent/origin/azimuthLine, and the vector arrows and
    // isobases, display-only here) forward for context alongside whatever the
    // result adapter produced.

    return (
      <AppLayout
        bodyRef={bodyRef}
        map={<MapPanel mapData={resultsMapData} azimuthDeg={compassAzimuth} />}
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
      map={<MapPanel mapData={formMapData} azimuthDeg={compassAzimuth} editing={editing} />}
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
