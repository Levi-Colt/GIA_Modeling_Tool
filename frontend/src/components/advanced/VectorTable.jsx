import { useEffect, useState } from 'react'
import { useProcessing } from '../../context/ProcessingContext.jsx'
import CsvImport from './CsvImport.jsx'
import { Help, NumberField, Segmented } from './fields.jsx'
import { CURVATURE_INPUTS, curvatureForm } from '../../utils/tiltModel.js'
import { CUSTOM_FAMILIES, MAX_VECTORS, isCustom, newVector, parseVector } from '../../utils/vectors.js'

// Help text is generic and unit-only (the tool is location-agnostic).
const LOCAL_GRADIENT_HELP =
  'Gradient at this vector’s own location, measured in its direction (the uplift direction).'
const RANGE_HELP = 'Range of influence: how far this vector’s direction is trusted. It is not a magnitude.'

// Fit is shown in amber above this many degrees of misfit.
export const FIT_WARN_DEG = 15

const cellInput = 'w-full min-w-[4.5rem] px-1 py-0.5 text-sm'

function TextCell({ id, label, value, onChange, placeholder, invalid }) {
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
      className={`${cellInput} ${invalid ? 'border-red-400' : ''}`}
    />
  )
}

function CustomRow({ vector, n, onPatch }) {
  const c = vector.custom
  const setCustom = (patch) => onPatch({ custom: { ...c, ...patch } })
  const form = curvatureForm(c)
  return (
    <tr className="bg-gray-50">
      <td colSpan={8} className="px-2 pb-3 pt-1">
        <div className="space-y-2 border-l-2 border-gray-300 pl-3">
          <div className="text-xs font-medium text-gray-600">Custom tilt for vector {n}</div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-gray-500">
              Family
              <select
                value={c.family}
                aria-label={`Vector ${n} custom family`}
                onChange={(e) => setCustom({ family: e.target.value })}
                className="mt-1 w-full"
              >
                {CUSTOM_FAMILIES.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            <NumberField
              label={`Vector ${n} local gradient (m/km)`}
              placeholder="m/km"
              value={c.localGradient}
              onChange={(localGradient) => setCustom({ localGradient })}
            />
          </div>
          <Help>{LOCAL_GRADIENT_HELP}</Help>
          {c.family === 'quadratic' && (
            <div className="space-y-2">
              <Segmented
                label={`Vector ${n} curvature from`}
                options={CURVATURE_INPUTS}
                value={form}
                onChange={(curvatureInput) => setCustom({ curvatureInput })}
              />
              {form === 'secondGradient' ? (
                <div className="grid grid-cols-2 gap-2">
                  <NumberField
                    label={`Vector ${n} second gradient (m/km)`}
                    placeholder="m/km"
                    value={c.secondGradient}
                    onChange={(secondGradient) => setCustom({ secondGradient })}
                  />
                  <NumberField
                    label={`Vector ${n} distance (km) up the uplift direction from this vector`}
                    placeholder="km"
                    positive
                    value={c.secondGradientDistanceKm}
                    onChange={(secondGradientDistanceKm) => setCustom({ secondGradientDistanceKm })}
                  />
                </div>
              ) : (
                <NumberField
                  label={`Vector ${n} rate of increase (m/km per km)`}
                  placeholder="m/km per km"
                  value={c.rateOfIncrease}
                  onChange={(rateOfIncrease) => setCustom({ rateOfIncrease })}
                />
              )}
            </div>
          )}
        </div>
      </td>
    </tr>
  )
}

// The vectors table (artboard B): #, Lat, Lon, Azim °, Range km, Tilt, Fit °,
// remove. Selecting a row (focus or click) selects its arrow on the map, and
// vice versa. The table is the precise, accessible path; the map is the quick one.
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
  const [importOpen, setImportOpen] = useState(false)
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

  function addRow() {
    const v = newVector()
    setVectors((list) => [...list, v], { undoable: true })
    selectVector(v.id)
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={addRow}
          disabled={vectors.length >= MAX_VECTORS}
          className="rounded-md border border-gray-300 px-2 py-1 text-xs disabled:opacity-50"
        >
          + Add row
        </button>
        <button
          type="button"
          aria-pressed={adding}
          onClick={() => setMapEditMode(adding ? 'none' : 'addVector')}
          className={`rounded-md border px-2 py-1 text-xs ${
            adding ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300'
          }`}
        >
          Add on map
        </button>
        <button
          type="button"
          onClick={undoVectors}
          disabled={undoDepth === 0}
          className="rounded-md border border-gray-300 px-2 py-1 text-xs disabled:opacity-50"
        >
          Undo
        </button>
        <button
          type="button"
          aria-expanded={importOpen}
          onClick={() => setImportOpen((open) => !open)}
          className="rounded-md border border-gray-300 px-2 py-1 text-xs"
        >
          Import CSV
        </button>
      </div>
      {adding && (
        <Help>
          Drag on the map to place a vector (the drag sets its direction and range); click to place one and enter its
          azimuth here. Press Escape or Done to stop.
        </Help>
      )}
      {importOpen && <CsvImport onClose={() => setImportOpen(false)} />}

      {vectors.length === 0 ? (
        <p className="rounded-md border border-dashed border-gray-300 px-3 py-4 text-center text-xs text-gray-500">
          No vectors yet. Add a row, drag on the map, or import a CSV.
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
                <th scope="col" className="px-1 py-1 font-normal">Tilt</th>
                <th scope="col" className="whitespace-nowrap px-1 py-1 font-normal" title="Direction misfit of the fitted surface at this vector">
                  Fit °
                </th>
                <th scope="col" className="px-1 py-1 font-normal"><span className="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody>
              {vectors.flatMap((v, i) => {
                const n = i + 1
                const p = parseVector(v)
                const misfit = fits?.[i]?.misfit_deg
                const hasFit = Number.isFinite(misfit)
                const warn = hasFit && misfit > FIT_WARN_DEG
                const selected = v.id === selectedId
                const rows = [
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
                    <td className="px-1 py-1">
                      <select
                        aria-label={`Vector ${n} tilt`}
                        value={v.tilt}
                        onChange={(e) => patch(v.id, { tilt: e.target.value })}
                        className="w-full min-w-[5.5rem] px-1 py-0.5 text-sm"
                      >
                        <option value="global">Global</option>
                        <option value="custom">Custom</option>
                      </select>
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
                ]
                if (isCustom(v)) {
                  rows.push(
                    <CustomRow key={`${v.id}-custom`} vector={v} n={n} onPatch={(fields) => patch(v.id, fields)} />
                  )
                }
                return rows
              })}
            </tbody>
          </table>
        </div>
      )}
      {vectors.length > 0 && <Help>{RANGE_HELP}</Help>}
    </div>
  )
}
