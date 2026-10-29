// The one field primitive (FRONTEND_REVIEW items 2, 3, 4, 8): a label, the control,
// an optional status message and help text, all styled the same everywhere.
//
// `status` is the four-state palette every field expresses:
//   default  untouched and optional   (gray)
//   required still empty and needed   (blue; deliberately not red -- red means an
//                                      invalid value, not "you haven't got to it yet")
//   valid    filled and accepted      (green)
//   invalid  filled but unusable      (red)
// plus `checking`, an in-flight async check, which keeps the field's border neutral
// and shows a spinner next to the message.

const BORDER = {
  default: 'border-gray-300',
  required: 'border-blue-400',
  valid: 'border-green-500',
  invalid: 'border-red-400',
  checking: 'border-gray-300'
}

// Utility classes to put on an <input>/<select> for a status (they override the
// base-layer control style in index.css).
export const statusBorder = (status = 'default') => BORDER[status] ?? BORDER.default

// Status for a plain required/optional text value: `ok` is whether it parses.
export function valueStatus(text, { required = false, ok = true } = {}) {
  const empty = String(text ?? '').trim() === ''
  if (empty) return required ? 'required' : 'default'
  return ok ? 'valid' : 'invalid'
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600"
    />
  )
}

const MESSAGE_COLOR = { invalid: 'text-red-600', valid: 'text-green-700', checking: 'text-gray-600' }

// With `htmlFor` the label is a sibling of the control (use it when `children`
// holds more than one control); without it the label wraps the control, which is
// what keeps getByLabelText working for the simple one-input case.
export default function Field({ label, htmlFor, status = 'default', message = null, help = null, children }) {
  const text = <span className="mb-1 block text-xs font-medium text-gray-700">{label}</span>
  return (
    <div>
      {htmlFor ? (
        <>
          <label htmlFor={htmlFor}>{text}</label>
          {children}
        </>
      ) : (
        <label className="block">
          {text}
          {children}
        </label>
      )}
      {message && (
        <p role="status" className={`mt-1 flex items-center gap-1.5 text-xs ${MESSAGE_COLOR[status] ?? 'text-gray-500'}`}>
          {status === 'checking' && <Spinner />}
          {message}
        </p>
      )}
      {help && <p className="mt-1 text-xs text-gray-500">{help}</p>}
    </div>
  )
}

// A status/empty-state placeholder. Deliberately not dashed: a dashed border is the
// drag-and-drop zone's look, and nothing else in the form may imply "drop a file here".
export function Placeholder({ children, className = '' }) {
  return <p className={`rounded-md bg-gray-50 px-3 py-4 text-center text-xs text-gray-500 ${className}`}>{children}</p>
}
