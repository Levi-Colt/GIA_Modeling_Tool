import { useState } from 'react'
import { useProcessing } from '../../context/ProcessingContext.jsx'
import { applyImport, describeImport, parseVectorsCsv, MAX_VECTORS } from '../../utils/vectors.js'

// CSV import panel, configured by props so the vector table and the shore-point
// panel share it. Rows that fail validation are skipped whole and reported, never
// imported partially. When the list already has rows the user picks Replace or
// Append with the two buttons below (not a browser confirm()); with none, the
// import applies directly.
//
// Props:
//   existing   the current list           limit    the list's cap
//   noun       'vectors' | 'points' ...   listName ('vector list'; defaults to `${noun} list`)
//   help       the format hint under the file input
//   parse(text, mapping?) -> { items, skipped, error, needsMapping?, columns? }
//   commit(list)  receives the resulting list (replace / append applied, capped)
//   onClose
// A parser that returns `needsMapping: true` (a required column has no header match)
// with `columns: { headers, preview, mapping, fields }` gets a column picker: one
// select per field over the file's own headers, the first rows previewed, and
// `parse` is called again with the chosen `mapping` (field key -> column index).
export function CsvImportPanel({ existing, limit, noun, listName = `${noun} list`, help, parse, commit, onClose }) {
  // { text, parsed, applied: 'replace' | 'append' | null, choosing?, pick? }
  const [state, setState] = useState(null)

  function run(text, mapping) {
    let parsed
    try {
      parsed = parse(text, mapping)
    } catch {
      parsed = { items: [], skipped: [], error: 'Could not read that file.' }
    }
    if (parsed.needsMapping) {
      setState({ text, parsed, applied: null, pick: { ...parsed.columns.mapping } })
    } else if (parsed.error || parsed.items.length === 0) {
      setState({ text, parsed, applied: null }) // nothing to import; the report says why
    } else if (existing.length === 0) {
      commit(applyImport(existing, parsed.items, 'replace', limit))
      setState({ text, parsed, applied: 'replace' })
    } else {
      setState({ text, parsed, applied: null, choosing: true }) // ask Replace / Append
    }
  }

  async function onFile(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // the same file can be chosen again
    if (!file) return
    let text
    try {
      text = await file.text()
    } catch {
      setState({ text: '', parsed: { items: [], skipped: [], error: 'Could not read that file.' }, applied: null })
      return
    }
    run(text)
  }

  function choose(mode) {
    commit(applyImport(existing, state.parsed.items, mode, limit))
    setState({ ...state, applied: mode, choosing: false })
  }

  const parsed = state?.parsed
  const overLimit = state?.applied === 'append' && existing.length + parsed.items.length > limit
  const columns = parsed?.needsMapping ? parsed.columns : null
  const requiredPicked = columns
    ? columns.fields.filter((f) => f.required).every((f) => state.pick[f.key] !== null && state.pick[f.key] !== undefined)
    : false

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
      <p className="text-xs text-gray-500">{help}</p>

      {parsed?.error && (
        <p role="alert" className="text-xs text-red-600">
          {parsed.error}
        </p>
      )}

      {columns && (
        <div className="space-y-2" role="group" aria-label="Column picker">
          <p role="status" className="text-xs text-gray-700">
            Some required columns could not be matched by header name. Choose which column holds each value.
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {columns.fields.map((f) => (
              <label key={f.key} className="block text-xs text-gray-500">
                {f.label} column
                <select
                  value={state.pick[f.key] ?? ''}
                  onChange={(e) =>
                    setState({ ...state, pick: { ...state.pick, [f.key]: e.target.value === '' ? null : Number(e.target.value) } })
                  }
                  className="mt-1 w-full"
                >
                  <option value="">{f.required ? '— choose a column —' : '— none —'}</option>
                  {columns.headers.map((h, i) => (
                    <option key={i} value={i}>
                      {`${h || '(blank)'} · column ${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-gray-600">
              <caption className="pb-1 text-left text-xs text-gray-500">First {columns.preview.length} rows</caption>
              <thead>
                <tr>
                  {columns.headers.map((h, i) => (
                    <th key={i} className="whitespace-nowrap px-1 py-0.5 font-medium">
                      {h || `(column ${i + 1})`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {columns.preview.map((row, r) => (
                  <tr key={r}>
                    {columns.headers.map((_, i) => (
                      <td key={i} className="whitespace-nowrap px-1 py-0.5">
                        {row[i] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            disabled={!requiredPicked}
            onClick={() => run(state.text, state.pick)}
            className="rounded-md bg-gray-900 px-3 py-1 text-xs text-white disabled:bg-gray-300 disabled:text-gray-500"
          >
            Import with these columns
          </button>
        </div>
      )}

      {parsed && !parsed.error && !columns && (
        <p role="status" className="text-xs text-gray-700">
          {describeImport(parsed)}
          {state.applied === 'replace' && parsed.items.length > 0 && ` (replaced the ${listName})`}
          {state.applied === 'append' && ` (appended to the ${listName})`}
          {overLimit && ` (the list is capped at ${limit} ${noun})`}
        </p>
      )}
      {state?.choosing && !state.applied && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-600">You already have {noun}:</span>
          <button type="button" onClick={() => choose('replace')} className="rounded-md bg-gray-900 px-3 py-1 text-xs text-white">
            Replace existing {noun}
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

// The vector table's import: lat, lon and azimuth columns (range, gradient and
// rate optional), matched by header name.
const parseVectors = (text) => {
  const r = parseVectorsCsv(text)
  return { ...r, items: r.vectors }
}

export default function CsvImport({ onClose }) {
  const { formState, setVectors } = useProcessing()
  return (
    <CsvImportPanel
      existing={formState.advanced.vectors}
      limit={MAX_VECTORS}
      noun="vectors"
      listName="vector list"
      help="Needs lat, lon and azimuth columns; range, gradient (makes the row a custom tilt) and rate (makes it quadratic) are optional."
      parse={parseVectors}
      commit={(list) => setVectors(list, { undoable: true })}
      onClose={onClose}
    />
  )
}
