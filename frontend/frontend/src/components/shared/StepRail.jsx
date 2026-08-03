const STEPS = [
  { id: 'upload', label: 'Upload' },
  { id: 'mode', label: 'Mode' },
  { id: 'coordinates', label: 'Coordinates' },
  { id: 'tilt', label: 'Tilt' },
  { id: 'products', label: 'Products' }
]

// Anchor nav only — never disables/gates a step. See spec: nothing should
// block a user from reaching step 5 because step 3 "looks unfinished."
export default function StepRail({ completedIds = [], currentId }) {
  function scrollToStep(id) {
    document.getElementById(`step-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="relative mb-5 flex justify-between px-1">
      <div className="absolute left-5 right-5 top-[13px] h-px bg-gray-200" />
      {STEPS.map((step) => {
        const isCompleted = completedIds.includes(step.id)
        const isCurrent = step.id === currentId
        return (
          <button
            key={step.id}
            onClick={() => scrollToStep(step.id)}
            className="z-10 flex flex-col items-center gap-1 bg-transparent"
          >
            <span
              className={`flex h-[26px] w-[26px] items-center justify-center rounded-full text-[11px] ${
                isCompleted
                  ? 'bg-green-600 text-white'
                  : isCurrent
                  ? 'bg-blue-600 text-white font-medium'
                  : 'border border-gray-300 bg-gray-50 text-gray-400'
              }`}
            >
              {isCompleted ? '✓' : STEPS.findIndex((s) => s.id === step.id) + 1}
            </span>
            <span className={`text-[10px] ${isCurrent ? 'font-medium text-gray-900' : 'text-gray-400'}`}>
              {step.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}
