import { parseFiniteNumber, parsePositiveNumber } from '../../utils/tiltModel.js'

// Small form controls shared by the tilt-model body and the vector table.

// Text input with numeric validation, not type="number", which mangles
// exponent notation in some browsers. Placeholders are units only.
export function NumberField({ label, value, onChange, placeholder, positive = false }) {
  const parsed = positive ? parsePositiveNumber(value) : parseFiniteNumber(value)
  const invalid = value.trim() !== '' && parsed === null
  return (
    <div>
      <label className="block text-xs text-gray-500">
        {label}
        <input
          type="text"
          inputMode="decimal"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={invalid || undefined}
          className={`mt-1 w-full ${invalid ? 'border-red-400' : ''}`}
        />
      </label>
      {invalid && <p className="text-xs text-red-600">{positive ? 'Enter a number greater than 0.' : 'Enter a number.'}</p>}
    </div>
  )
}

export function Help({ children }) {
  return <p className="mt-1 text-xs text-gray-500">{children}</p>
}

// Two-option segmented control (same look as the Basic/Advanced mode switch).
export function Segmented({ label, options, value, onChange }) {
  return (
    <div>
      <div className="mb-1 text-xs text-gray-500">{label}</div>
      <div role="group" aria-label={label} className="inline-flex rounded-lg bg-gray-100 p-0.5">
        {options.map((o) => {
          const active = o.value === value
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(o.value)}
              className={`rounded-md px-3 py-1 text-sm ${
                active ? 'bg-white font-medium text-gray-900 shadow-sm' : 'bg-transparent text-gray-500'
              }`}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
