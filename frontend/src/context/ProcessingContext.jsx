import { createContext, useContext, useState } from 'react'

const STORAGE_KEY = 'gia-tool:last-run'

const defaultState = {
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
  includeDem: true
}

// Carry-forward: silently restores the last run's values on load. This is
// separate from the presets mechanism (which is explicit/named) — don't
// merge the two. See documentation/GIA_Tool_Penpot_Spec.md.
function loadCarriedForwardState() {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    return saved ? { ...defaultState, ...JSON.parse(saved) } : defaultState
  } catch {
    return defaultState
  }
}

const ProcessingContext = createContext(null)

export function ProcessingProvider({ children }) {
  const [formState, setFormState] = useState(loadCarriedForwardState)

  function updateForm(patch) {
    setFormState((prev) => {
      const next = { ...prev, ...patch }
      // Persist only the fields worth carrying forward — not file objects
      // or transient preflight/elevation-check/resolve-point status (the
      // latter three are re-derived from a fresh preflight/blur, not safe
      // to carry forward stale across a reload).
      const {
        demFile,
        preflightStatus,
        preflightMessage,
        boundsWgs84,
        demCrs,
        rasterPreviewGeoraster,
        elevationCheckStatus,
        elevationCheckValue,
        resolveOriginStatus,
        resolvedOrigin,
        ...persisted
      } = next
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted))
      return next
    })
  }

  return (
    <ProcessingContext.Provider value={{ formState, updateForm }}>
      {children}
    </ProcessingContext.Provider>
  )
}

export function useProcessing() {
  const ctx = useContext(ProcessingContext)
  if (!ctx) throw new Error('useProcessing must be used within ProcessingProvider')
  return ctx
}
