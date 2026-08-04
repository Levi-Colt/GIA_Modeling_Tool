import { useEffect, useState } from 'react'

function formatElapsed(ms) {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

// Indeterminate by design -- the backend is synchronous with no job queue,
// so there's no real progress to report. No fake phase list.
export default function LoadingState({ startedAt }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [])

  const elapsed = startedAt ? now - startedAt : 0

  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <div className="h-10 w-10 animate-spin rounded-full border-4 border-gray-200 border-t-gray-900" />
      <p className="text-sm font-medium text-gray-900">Running model&hellip; {formatElapsed(elapsed)}</p>
      <p className="max-w-xs text-xs text-gray-500">
        Large DEMs can take several minutes. You can leave this page open.
      </p>
    </div>
  )
}
