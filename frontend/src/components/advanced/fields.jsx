import Field, { statusBorder, valueStatus } from '../shared/Field.jsx'
import { parseFiniteNumber, parsePositiveNumber } from '../../utils/tiltModel.js'

// Small form controls shared by the tilt-model body and the vector table.

// Text input with numeric validation, not type="number", which mangles
// exponent notation in some browsers. Placeholders are units only. `required`
// fields show the blue "still needed" outline while empty.
export function NumberField({ label, value, onChange, placeholder, positive = false, required = false }) {
  const parsed = positive ? parsePositiveNumber(value) : parseFiniteNumber(value)
  const status = valueStatus(value, { required, ok: parsed !== null })
  const invalid = status === 'invalid'
  return (
    <Field
      label={label}
      status={status}
      message={invalid ? (positive ? 'Enter a number greater than 0.' : 'Enter a number.') : null}
    >
      <input
        type="text"
        inputMode="decimal"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid || undefined}
        className={`w-full ${statusBorder(status)}`}
      />
    </Field>
  )
}

export function Help({ children }) {
  return <p className="mt-1 text-xs text-gray-500">{children}</p>
}

// Segmented control (same look as the Basic/Advanced mode switch). An option may
// be `disabled`, with a `title` tooltip saying why.
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
              disabled={o.disabled || undefined}
              title={o.title}
              onClick={() => onChange(o.value)}
              className={`rounded-md px-3 py-1 text-sm ${
                active ? 'bg-white font-medium text-gray-900 shadow-sm' : 'bg-transparent text-gray-500'
              } ${o.disabled ? 'cursor-not-allowed opacity-40' : ''}`}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
