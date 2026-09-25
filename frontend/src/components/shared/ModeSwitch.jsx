import { useProcessing } from '../../context/ProcessingContext.jsx'

const MODES = [
  { key: 'basic', label: 'Basic' },
  { key: 'advanced', label: 'Advanced' }
]

const CAPTIONS = {
  basic: 'Planar, linear tilt',
  advanced: 'All settings kept when switching'
}

// Two-button segmented control: grey track, active button raised in white.
// Switching only ever changes `mode` -- never any other field (spec C2 rule 1).
// `onSwitch` lets the layout reset the form body's scroll to the top.
export default function ModeSwitch({ onSwitch }) {
  const { formState, updateForm } = useProcessing()
  return (
    <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-3">
      <div role="group" aria-label="Input mode" className="inline-flex rounded-lg bg-gray-100 p-0.5">
        {MODES.map(({ key, label }) => {
          const active = formState.mode === key
          return (
            <button
              key={key}
              type="button"
              aria-pressed={active}
              onClick={() => {
                updateForm({ mode: key })
                onSwitch?.()
              }}
              className={`rounded-md px-3 py-1 text-sm ${
                active ? 'bg-white font-medium text-gray-900 shadow-sm' : 'bg-transparent text-gray-500'
              }`}
            >
              {label}
            </button>
          )
        })}
      </div>
      <span className="text-xs text-gray-500">{CAPTIONS[formState.mode] ?? CAPTIONS.basic}</span>
    </div>
  )
}
