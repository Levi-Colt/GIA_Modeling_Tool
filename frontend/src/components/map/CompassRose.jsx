// Fixed UI chrome, not a map layer -- always rendered regardless of whether
// any map data has resolved yet. See "Compass rose" in
// documentation/VISUALIZATION_PIPELINE_SPEC.md: useful even before the rest of Stage 1
// (extent/origin/azimuth) lands, so it's built first.
export default function CompassRose({ azimuthDeg }) {
  const rotation = Number.isFinite(Number(azimuthDeg)) ? Number(azimuthDeg) : 0

  return (
    <div
      className="pointer-events-none absolute right-3 top-3 z-[1000] flex h-14 w-14 items-center justify-center rounded-full border border-gray-300 bg-white/90 shadow-sm"
      title={`Tilt azimuth: ${rotation}°`}
    >
      <svg
        viewBox="0 0 40 40"
        className="h-9 w-9 transition-transform duration-200"
        style={{ transform: `rotate(${rotation}deg)` }}
      >
        <circle cx="20" cy="20" r="18" fill="none" stroke="#d1d5db" strokeWidth="1" />
        <polygon points="20,4 24,20 20,17 16,20" fill="#dc2626" />
        <polygon points="20,36 24,20 20,23 16,20" fill="#9ca3af" />
        <text x="20" y="12" textAnchor="middle" fontSize="6" fill="#374151">N</text>
      </svg>
    </div>
  )
}
