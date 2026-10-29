import { useProcessing } from '../../context/ProcessingContext.jsx'
import { useOriginChecks } from '../../hooks/useOriginChecks.js'
import Field, { statusBorder } from '../shared/Field.jsx'

const FORMAT_HELP = 'Decimal degrees with N/S and E/W, e.g. 12.5N, 34.25E. Or pick the point on the map.'

// Body only -- section wrappers/headings and the `step-coordinates` id live in
// BasicForm / AdvancedForm. Origin input is decimal degrees only (typed, or
// picked on the map), so there is no mode selector.
export function CoordinatesStep() {
  const { formState, updateForm, setMapEditMode } = useProcessing()
  const { checkOrigin } = useOriginChecks()
  const { originValue, resolveOriginStatus, resolveOriginMessage } = formState
  const picking = formState.mapEditMode === 'setOrigin'

  // Field state, shown on the input itself (not in a different section below):
  // blue while empty, a spinner while resolving, green once located, red on failure.
  let status = 'default'
  let message = null
  if (originValue.trim() === '') {
    status = 'required'
  } else if (resolveOriginStatus === 'checking') {
    status = 'checking'
    message = 'Looking up origin...'
  } else if (resolveOriginStatus === 'resolved') {
    status = 'valid'
    message = 'Origin located.'
  } else if (resolveOriginStatus === 'error') {
    status = 'invalid'
    message = resolveOriginMessage || 'Could not read that coordinate.'
  }

  return (
    <Field label="Origin (lat, lon)" htmlFor="origin-input" status={status} message={message} help={FORMAT_HELP}>
      <div className="flex gap-2">
        <input
          id="origin-input"
          type="text"
          placeholder="latitude, longitude"
          value={originValue}
          aria-invalid={status === 'invalid' || undefined}
          onChange={(e) =>
            updateForm({
              originValue: e.target.value,
              // Invalidates the previous blur-triggered check immediately, so a
              // stale elevationCheckValue/targetElevation from an earlier
              // coordinate can't look "current" just because the field hasn't
              // been re-blurred yet. isReadyToRun gates on this going back to
              // 'idle' until a fresh check resolves.
              elevationCheckStatus: 'idle',
              resolveOriginStatus: 'idle'
            })
          }
          onBlur={() => checkOrigin()}
          className={`min-w-0 flex-1 ${statusBorder(status)}`}
        />
        <button
          type="button"
          aria-pressed={picking}
          onClick={() => setMapEditMode(picking ? 'none' : 'setOrigin')}
          className={`shrink-0 rounded-md border px-2 py-1 text-xs ${
            picking ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300 bg-white text-gray-700'
          }`}
        >
          Pick on map
        </button>
      </div>
    </Field>
  )
}
