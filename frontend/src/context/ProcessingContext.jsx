import { createContext, useContext, useRef, useState } from 'react'
import {
  DEFAULT_DIRECTION_SOURCE,
  DEFAULT_HINGE,
  DEFAULT_PROFILE,
  directionSourceOf,
  normalizeHingeMode
} from '../utils/tiltModel.js'
import { normalizeVectors, popUndo, pushUndo } from '../utils/vectors.js'

const STORAGE_KEY = 'gia-tool:last-run'

const defaultState = {
  // 'basic' | 'advanced' -- persisted. Switching only ever changes this key;
  // see documentation/LAYOUT_AND_MODES_SPEC.md C2.
  mode: 'basic',
  demFile: null,
  demPath: '',
  preflightStatus: 'idle', // idle | checking | valid | invalid
  preflightMessage: '',
  // Structured preflight results, cached client-side so later steps (the
  // map's input preview, /api/resolve-point's match_raster mode) don't need
  // to re-read the raster -- see documentation/VISUALIZATION_PIPELINE_SPEC.md Stage 1.
  boundsWgs84: null, // [west, south, east, north] WGS84, from /api/preflight
  demCrs: null, // e.g. "EPSG:32612", from /api/preflight
  // Parsed georaster object from /api/raster-preview (georeferenced WGS84
  // preview of the uploaded DEM) -- holds typed arrays, never persisted.
  rasterPreviewGeoraster: null,
  originMode: 'decimal_degrees', // match_raster | decimal_degrees | epsg
  originValue: '',
  originEpsg: '',
  // Preview-only state for the /api/resolve-point call, driven by the same
  // coordinate-field blur that drives elevationCheckStatus below (see
  // CoordinateSteps.jsx). Feeds the map's origin marker + azimuth line.
  resolveOriginStatus: 'idle', // idle | checking | resolved | error
  resolvedOrigin: null, // [lon, lat]
  tiltAzimuth: '',
  tiltFactor: '',
  targetElevation: '',
  // Preview-only state for the /api/origin-elevation check, driven by
  // blurring the coordinate input(s) — see CoordinateSteps.jsx. Not a
  // "mode" for targetElevation itself (which stays one plain field either
  // way); this just tracks whether a preview lookup is in flight or what
  // it found, so TiltAndProductsSteps.jsx can render accordingly.
  elevationCheckStatus: 'idle', // idle | checking | dem | outside_bounds | nodata
  elevationCheckValue: null,
  includeDem: true,
  // Optional (km, kept as the raw input string): '' means no filtering. A
  // user input, so persisted like the other form fields.
  selectionRadiusKm: '',
  // Advanced-only fields. Anything both modes use stays at the top level under
  // its existing name (tiltAzimuth = Advanced's "single azimuth", tiltFactor =
  // Advanced's "gradient at origin") -- later specs must reuse those keys, not
  // add duplicates here. Persisted; transient advanced state (e.g. a fitted
  // surface or validation response) must be added to TRANSIENT_KEYS below.
  advanced: {
    sectionsOpen: { dem: true, origin: true, tilt: true, output: false },
    // Uplift model (documentation/UPLIFT_MODEL_SPEC.md D5, amended by
    // UPLIFT_MODEL_CORRECTIONS_SPEC.md). `tiltFactor` (top level) is the
    // gradient at the spillway in every family. `degree` sets how many
    // coefficient inputs show; the hidden curvature form and hidden coefficient
    // slots keep their typed values.
    profile: DEFAULT_PROFILE,
    // mode: 'origin' | 'distance' | 'none'; the default is 'origin' for every family.
    hinge: DEFAULT_HINGE,
    // Direction source (documentation/VECTOR_FIELD_SPEC.md, spec 5):
    // 'azimuth' uses the top-level tiltAzimuth; 'vectors' uses the list below.
    // Each vector's fields are strings; the ids link table rows to map arrows.
    // Selection, add-on-map mode and the preview are transient, so they live at
    // the top level below (TRANSIENT_KEYS only excludes top-level keys).
    directionSource: DEFAULT_DIRECTION_SOURCE,
    vectors: []
  },
  // Latest /api/profile-preview result for the tilt-model chart:
  // { status: 'loading' | 'ready' | 'error', data, error } | null. Transient.
  // Lives at the top level (not under `advanced`) because TRANSIENT_KEYS only
  // excludes top-level keys, and it is read by both the chart and the results
  // screen's hinge summary.
  profilePreview: null,
  // Latest /api/uplift-preview result (vectors mode): the map's isobases and the
  // per-vector fit. Same shape as profilePreview. Transient.
  upliftPreview: null,
  // Vector-table / map interaction state, all transient (a reload never
  // restores a selection, an armed "Add on map", or a pending focus request).
  selectedVectorId: null,
  mapEditMode: 'none', // 'none' | 'addVector'
  vectorFocusRequest: null // { id, n }: focus that vector's azimuth input
}

// Keys never written to localStorage: file objects and transient
// preflight/elevation-check/resolve-point status, all re-derived from a fresh
// preflight/blur and not safe to carry forward stale across a reload.
const TRANSIENT_KEYS = [
  'demFile',
  'preflightStatus',
  'preflightMessage',
  'boundsWgs84',
  'demCrs',
  'rasterPreviewGeoraster',
  'elevationCheckStatus',
  'elevationCheckValue',
  'resolveOriginStatus',
  'resolvedOrigin',
  'profilePreview',
  'upliftPreview',
  'selectedVectorId',
  'mapEditMode',
  'vectorFocusRequest'
]

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// defaults <- saved, recursing into plain objects, so keys added to `advanced`
// (or to sectionsOpen) by later specs get their defaults when an older save
// loads. Arrays and scalars in `saved` replace the default wholesale.
function deepMerge(defaults, saved) {
  if (!isPlainObject(defaults)) return saved
  if (!isPlainObject(saved)) return defaults // absent/corrupt save: keep defaults
  const out = { ...defaults }
  for (const key of Object.keys(saved)) {
    out[key] = key in defaults ? deepMerge(defaults[key], saved[key]) : saved[key]
  }
  return out
}

// Carry-forward: silently restores the last run's values on load. This is
// separate from the presets mechanism (which is explicit/named) — don't
// merge the two. See documentation/GIA_Tool_Penpot_Spec.md.
function loadCarriedForwardState() {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (!saved) return defaultState
    const parsed = JSON.parse(saved)
    // Only `advanced` needs a deep merge; the rest is a flat spread.
    const advanced = deepMerge(defaultState.advanced, parsed.advanced)
    // Spec 4a removed the hinge modes 'default' and 'natural'; a save from
    // before that (only ever run locally) maps them to the default, 'origin'.
    advanced.hinge = { ...advanced.hinge, mode: normalizeHingeMode(advanced.hinge?.mode) }
    // Every saved vector gets an id and all keys (deepMerge replaces arrays wholesale).
    advanced.vectors = normalizeVectors(advanced.vectors)
    advanced.directionSource = directionSourceOf(advanced)
    return { ...defaultState, ...parsed, advanced }
  } catch {
    return defaultState
  }
}

const ProcessingContext = createContext(null)

export function ProcessingProvider({ children }) {
  const [formState, setFormState] = useState(loadCarriedForwardState)
  // One console.warn per provider lifetime, not one per keystroke.
  const persistWarned = useRef(false)

  // Applies `compute(prev) -> next` and persists the result. Persistence is
  // best-effort: shore-point tables can exceed the localStorage quota, and a
  // failed write must never take the app down -- in-memory state is unaffected.
  function commit(compute) {
    setFormState((prev) => {
      const next = compute(prev)
      const persisted = { ...next }
      for (const key of TRANSIENT_KEYS) delete persisted[key]
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted))
      } catch (err) {
        if (!persistWarned.current) {
          persistWarned.current = true
          console.warn('Could not save form state to localStorage:', err)
        }
      }
      return next
    })
  }

  function updateForm(patch) {
    commit((prev) => ({ ...prev, ...patch }))
  }

  // Shallow-merges into formState.advanced (callers replacing a nested object,
  // e.g. sectionsOpen, pass the whole object).
  function updateAdvanced(patch) {
    commit((prev) => ({ ...prev, advanced: { ...prev.advanced, ...patch } }))
  }

  // --- Vector list edits. All go through setVectors so the undo stack (the last
  // 20 list states, in a ref: it is UI history, not form state) sees the
  // structural ones. `vectorsRef` mirrors the list synchronously, so two edits in
  // one tick each start from the previous one's result. ---
  const vectorsRef = useRef(formState.advanced.vectors)
  vectorsRef.current = formState.advanced.vectors
  const undoStack = useRef([])
  const [undoDepth, setUndoDepth] = useState(0)

  function applyVectors(next) {
    vectorsRef.current = next
    commit((prev) => ({
      ...prev,
      advanced: { ...prev.advanced, vectors: next },
      selectedVectorId: next.some((v) => v.id === prev.selectedVectorId) ? prev.selectedVectorId : null
    }))
  }

  // update: the new list, or (list) => new list. undoable: true for structural
  // edits (add, remove, import, map drags); false for typing in a cell.
  function setVectors(update, { undoable = false } = {}) {
    const base = vectorsRef.current
    const next = typeof update === 'function' ? update(base) : update
    if (next === base) return
    if (undoable) {
      undoStack.current = pushUndo(undoStack.current, base)
      setUndoDepth(undoStack.current.length)
    }
    applyVectors(next)
  }

  function undoVectors() {
    const { stack, snapshot } = popUndo(undoStack.current)
    if (snapshot === null) return
    undoStack.current = stack
    setUndoDepth(stack.length)
    applyVectors(snapshot)
  }

  const selectVector = (id) => updateForm({ selectedVectorId: id })
  const setMapEditMode = (mode) => updateForm({ mapEditMode: mode })
  const requestVectorFocus = (id) =>
    updateForm({ vectorFocusRequest: { id, n: (formState.vectorFocusRequest?.n ?? 0) + 1 } })

  return (
    <ProcessingContext.Provider
      value={{
        formState,
        updateForm,
        updateAdvanced,
        setVectors,
        undoVectors,
        undoDepth,
        selectVector,
        setMapEditMode,
        requestVectorFocus
      }}
    >
      {children}
    </ProcessingContext.Provider>
  )
}

export function useProcessing() {
  const ctx = useContext(ProcessingContext)
  if (!ctx) throw new Error('useProcessing must be used within ProcessingProvider')
  return ctx
}
