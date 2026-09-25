// The four form sections, in order. `id` doubles as the suffix of the
// `step-<id>` DOM id that both BasicForm and AdvancedForm put on their section
// (used for error routing and scroll targets); `advancedKey` is the matching
// key in formState.advanced.sectionsOpen.
export const STEPS = [
  { id: 'upload', label: 'DEM', advancedKey: 'dem' },
  { id: 'coordinates', label: 'Origin', advancedKey: 'origin' },
  { id: 'tilt', label: 'Tilt', advancedKey: 'tilt' },
  { id: 'products', label: 'Output', advancedKey: 'output' }
]

export function scrollToStep(id) {
  // Optional-called: jsdom (Vitest) doesn't implement scrollIntoView.
  document.getElementById(`step-${id}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
}

// Best-effort keyword heuristic over the backend's free-text `detail`
// strings (there are no typed error codes) — a routing hint for which step
// to send the user back to, not a correctness-critical classification.
//
// The elevation-range check goes first: target elevation lives in the Origin
// section now, and the origin regex's bare `500` would otherwise match digits
// inside the message's own numbers (e.g. "Target elevation 1500 ...").
export function classifyErrorStep(message) {
  const text = (message || '').toLowerCase()
  if (/elevation range/.test(text)) return 'coordinates'
  if (/extent|origin|500|geodesic/.test(text)) return 'coordinates'
  if (/file type|corrupted|geotiff|extension/.test(text)) return 'upload'
  return null
}
