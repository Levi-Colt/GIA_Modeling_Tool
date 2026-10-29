import { useEffect } from 'react'
import { useProcessing } from '../../context/ProcessingContext.jsx'
import { Help } from './fields.jsx'
import { parseVector } from '../../utils/vectors.js'

// Help text is generic and unit-only (the tool is location-agnostic).
const RANGE_HELP = 'Range of influence: how far this vector’s direction is trusted. It is not a magnitude.'

// Fit is shown in amber above this many degrees of misfit.
export const FIT_WARN_DEG = 15

const cellInput = 'w-full min-w-[4.5rem] px-1 py-0.5 text-sm'

function TextCell({ id, label, value, onChange, placeholder, invalid, required = false }) {
  return (
    <input
      id={id}
      type="text"
      inputMode="decimal"
      aria-label={label}
      aria-invalid={invalid || undefined}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`${cellInput} ${
        invalid ? 'border-red-400' : required && value.trim() === '' ? 'border-blue-400' : ''
      }`}
    />
  )
}

// The vectors table (artboard B): #, Lat, Lon, Azim °, Range km, Fit °, remove.
// Vectors are always *drawn on the map* (rows are created only by the map); the
// table is where their start point, azimuth and range are then adjusted
// precisely. Selecting a row (focus or click) selects its arrow on the map, and
// vice versa.
export default function VectorTable() {
  const {
    formState,
    setVectors,
    undoVectors,
    undoDepth,
    selectVector,
    setMapEditMode,
    updateForm
  } = useProcessing()
  const vectors = formState.advanced.vectors
  const selectedId = formState.selectedVectorId
  const adding = formState.mapEditMode === 'addVector'
  const fits = formState.upliftPreview?.data?.vectors ?? null

  // A click-added vector has no azimuth yet: focus its azimuth input.
  const focusRequest = formState.vectorFocusRequest
  useEffect(() => {
    if (!focusRequest) return
    document.getElementById(`vector-${focusRequest.id}-azimuth`)?.focus()
    updateForm({ vectorFocusRequest: null }) // handled: a later remount must not steal focus
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest])

  // Keep the selected arrow's row in view when the selection came from the map.
  useEffect(() => {
    if (!selectedId) return
    document.getElementById(`vector-row-${selectedId}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedId])

  const patch = (id, fields) =>
    setVectors((list) => list.map((v) => (v.id === id ? { ...v, ...fields } : v)))

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={adding}
          onClick={() => setMapEditMode(adding ? 'none' : 'addVector')}
          className={`rounded-md border px-2 py-1 text-xs ${
            adding ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300'
          }`}
        >
          Draw vector
        </button>
        <button
          type="button"
          onClick={undoVectors}
          disabled={undoDepth === 0}
          className="rounded-md border border-gray-300 px-2 py-1 text-xs disabled:opacity-50"
        >
          Undo
        </button>
      </div>
      {adding && (
        <Help>
          Drag on the map to draw a vector (the drag sets its start point, direction and range); a click places just the
          start point, and you enter its azimuth here. Press Escape or Done to stop.
        </Help>
      )}

      {vectors.length === 0 ? (
        <p className="rounded-md bg-gray-50 px-3 py-4 text-center text-xs text-gray-500">
          No vectors yet. Use Draw vector, then drag on the map from where the vector starts, in its uplift direction.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="text-gray-500">
                <th scope="col" className="px-1 py-1 font-normal">#</th>
                <th scope="col" className="px-1 py-1 font-normal">Lat</th>
                <th scope="col" className="px-1 py-1 font-normal">Lon</th>
                <th scope="col" className="px-1 py-1 font-normal">Azim °</th>
                <th scope="col" className="whitespace-nowrap px-1 py-1 font-normal" title={RANGE_HELP}>Range km</th>
                <th scope="col" className="whitespace-nowrap px-1 py-1 font-normal" title="Direction misfit of the fitted surface at this vector">
                  Fit °
                </th>
                <th scope="col" className="px-1 py-1 font-normal"><span className="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody>
              {vectors.map((v, i) => {
                const n = i + 1
                const p = parseVector(v)
                const misfit = fits?.[i]?.misfit_deg
                const hasFit = Number.isFinite(misfit)
                const warn = hasFit && misfit > FIT_WARN_DEG
                const selected = v.id === selectedId
                return (
                  <tr
                    key={v.id}
                    id={`vector-row-${v.id}`}
                    aria-selected={selected}
                    onFocusCapture={() => selectVector(v.id)}
                    onClick={() => selectVector(v.id)}
                    className={selected ? 'bg-amber-50' : undefined}
                  >
                    <td className="px-1 py-1 text-gray-500">{n}</td>
                    <td className="px-1 py-1">
                      <TextCell
                        id={`vector-${v.id}-lat`}
                        required
                        label={`Vector ${n} latitude`}
                        placeholder="deg"
                        value={v.lat}
                        invalid={v.lat.trim() !== '' && p.lat === null}
                        onChange={(lat) => patch(v.id, { lat })}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <TextCell
                        id={`vector-${v.id}-lon`}
                        required
                        label={`Vector ${n} longitude`}
                        placeholder="deg"
                        value={v.lon}
                        invalid={v.lon.trim() !== '' && p.lon === null}
                        onChange={(lon) => patch(v.id, { lon })}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <TextCell
                        id={`vector-${v.id}-azimuth`}
                        required
                        label={`Vector ${n} azimuth`}
                        placeholder="deg"
                        value={v.azimuthDeg}
                        invalid={v.azimuthDeg.trim() !== '' && p.azimuth === null}
                        onChange={(azimuthDeg) => patch(v.id, { azimuthDeg })}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <TextCell
                        id={`vector-${v.id}-range`}
                        label={`Vector ${n} range (km)`}
                        placeholder="km"
                        value={v.rangeKm}
                        invalid={!p.range.ok}
                        onChange={(rangeKm) => patch(v.id, { rangeKm })}
                      />
                    </td>
                    <td
                      aria-label={`Vector ${n} fit`}
                      className={`px-1 py-1 tabular-nums ${warn ? 'font-medium text-amber-600' : 'text-gray-600'}`}
                      title={warn ? `Above ${FIT_WARN_DEG}°: the fitted surface cannot honor this direction.` : undefined}
                    >
                      {hasFit ? `${misfit.toFixed(1)}°` : '—'}
                    </td>
                    <td className="px-1 py-1">
                      <button
                        type="button"
                        aria-label={`Remove vector ${n}`}
                        onClick={() => setVectors((list) => list.filter((x) => x.id !== v.id), { undoable: true })}
                        className="rounded px-1.5 text-gray-500 hover:bg-gray-100"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {vectors.length > 0 && <Help>{RANGE_HELP}</Help>}
    </div>
  )
}
