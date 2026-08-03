import { ProcessingProvider, useProcessing } from './context/ProcessingContext.jsx'
import StepRail from './components/shared/StepRail.jsx'
import MapPanel from './components/map/MapPanel.jsx'
import UploadStep from './components/steps/UploadStep.jsx'
import { CoordinateModeStep, CoordinatesStep } from './components/steps/CoordinateSteps.jsx'
import { TiltStep, ProductsStep } from './components/steps/TiltAndProductsSteps.jsx'

// Derives the map's input-preview shape from form state alone — no backend
// call. This is the "input preview" half of the map contract; the "result
// preview" half gets populated separately once /process returns.
function deriveMapDataFromForm(formState) {
  return {
    // Real extent/origin/azimuth parsing is the next implementation step —
    // this wiring point is what matters for now.
    extent: null,
    origin: formState.originValue || null,
    azimuthLine: formState.tiltAzimuth ? formState.tiltAzimuth : null
  }
}

function ProcessingPage() {
  const { formState } = useProcessing()
  const completedIds = []
  if (formState.preflightStatus === 'valid') completedIds.push('upload')
  if (formState.originMode) completedIds.push('mode')

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
        <button className="mt-4 w-full rounded-md bg-gray-900 py-2 font-medium text-white">
          Run model
        </button>
      </div>

      <MapPanel mapData={deriveMapDataFromForm(formState)} />
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
