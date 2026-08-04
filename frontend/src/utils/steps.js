export const STEPS = [
  { id: 'upload', label: 'Upload' },
  { id: 'mode', label: 'Mode' },
  { id: 'coordinates', label: 'Coordinates' },
  { id: 'tilt', label: 'Tilt' },
  { id: 'products', label: 'Products' }
]

export function scrollToStep(id) {
  document.getElementById(`step-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
