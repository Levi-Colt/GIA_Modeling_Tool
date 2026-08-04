import { createContext, useContext, useState } from 'react'

const STORAGE_KEY = 'gia-tool:last-run'

const defaultState = {
  demFile: null,
  demPath: '',
  preflightStatus: 'idle', // idle | checking | valid | invalid
  preflightMessage: '',
  originMode: 'decimal_degrees', // match_raster | decimal_degrees | epsg
  originValue: '',
  originEpsg: '',
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
// merge the two. See GIA_Tool_Penpot_Spec.md.
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
      // or transient preflight/elevation-check status.
      const { demFile, preflightStatus, preflightMessage, elevationCheckStatus, elevationCheckValue, ...persisted } = next
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
