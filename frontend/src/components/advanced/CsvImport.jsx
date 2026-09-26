import { useState } from 'react'
import { useProcessing } from '../../context/ProcessingContext.jsx'
import { applyImport, describeImport, parseVectorsCsv, MAX_VECTORS } from '../../utils/vectors.js'

// CSV import panel for the vector table. Header names are matched without regard
// to case (lat/latitude, lon/lng/long/longitude, azimuth/azimuth_deg/az, and the
// optional range/range_km, gradient/local_gradient, rate/rate_of_increase). Rows
// that fail validation are skipped whole and reported, never imported partially.
// When vectors already exist the user picks Replace or Append with the two
// buttons below (not a browser confirm()); with none, the import applies directly.
export default function CsvImport({ onClose }) {
  const { formState, setVectors } = useProcessing()
  const existing = formState.advanced.vectors
  // { parsed, applied: 'replace' | 'append' | null }
  const [state, setState] = useState(null)

  async function onFile(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // the same file can be chosen again
    if (!file) return
    let parsed
    try {
      parsed = parseVectorsCsv(await file.text())
    } catch {
      parsed = { vectors: [], skipped: [], error: 'Could not read that file.' }
    }
    if (parsed.error || parsed.vectors.length === 0) {
      setState({ parsed, applied: null }) // nothing to import; the report says why
    } else if (existing.length === 0) {
      setVectors(applyImport(existing, parsed.vectors, 'replace'), { undoable: true })
      setState({ parsed, applied: 'replace' })
    } else {
      setState({ parsed, applied: null, choosing: true }) // ask Replace / Append
    }
  }

  function choose(mode) {
    setVectors(applyImport(existing, state.parsed.vectors, mode), { undoable: true })
    setState({ parsed: state.parsed, applied: mode })
  }

  const parsed = state?.parsed
  const overLimit = state?.applied === 'append' && existing.length + parsed.vectors.length > MAX_VECTORS

  return (
    <div className="space-y-2 rounded-md border border-gray-200 bg-gray-50 p-3">
      <div className="flex items-center justify-between gap-2">
        <label className="block text-xs text-gray-500">
          CSV file
          <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={onFile} className="mt-1 block w-full text-sm" />
        </label>
        <button type="button" onClick={onClose} className="self-start rounded-md border border-gray-300 px-2 py-1 text-xs">
          Close
        </button>
      </div>
      <p className="text-xs text-gray-500">
        Needs lat, lon and azimuth columns; range, gradient (makes the row a custom tilt) and rate (makes it quadratic)
        are optional.
      </p>

      {parsed?.error && (
        <p role="alert" className="text-xs text-red-600">
          {parsed.error}
        </p>
      )}
      {parsed && !parsed.error && (
        <p role="status" className="text-xs text-gray-700">
          {describeImport(parsed)}
          {state.applied === 'replace' && parsed.vectors.length > 0 && ' (replaced the vector list)'}
          {state.applied === 'append' && ' (appended to the vector list)'}
          {overLimit && ` (the list is capped at ${MAX_VECTORS} vectors)`}
        </p>
      )}
      {state?.choosing && !state.applied && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-600">You already have vectors:</span>
          <button type="button" onClick={() => choose('replace')} className="rounded-md bg-gray-900 px-3 py-1 text-xs text-white">
            Replace existing vectors
          </button>
          <button type="button" onClick={() => choose('append')} className="rounded-md border border-gray-300 px-3 py-1 text-xs">
            Append
          </button>
          <button type="button" onClick={() => setState(null)} className="rounded-md border border-gray-300 px-3 py-1 text-xs">
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
