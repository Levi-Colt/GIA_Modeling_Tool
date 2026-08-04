import Banner from '../shared/Banner.jsx'
import { STEPS } from '../../utils/steps.js'

export default function ResultsError({ error, onBack }) {
  const stepIndex = error.stepId ? STEPS.findIndex((s) => s.id === error.stepId) : -1
  const step = stepIndex >= 0 ? STEPS[stepIndex] : null

  return (
    <div className="space-y-4 py-2">
      <Banner variant="danger">{error.message}</Banner>
      <button onClick={onBack} className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white">
        {step ? `Back to step ${stepIndex + 1} · ${step.label}` : 'Adjust inputs'}
      </button>
    </div>
  )
}
