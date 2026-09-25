// One collapsible section of the Advanced form. The header is a real button
// (title left, status line right); the body mounts only while open, unless
// `keepMounted` -- then it stays in the DOM (just `hidden`) so state held in
// uncontrolled inputs / in-flight requests (the DEM upload) survives collapsing.
//
// status: { complete: boolean, summary?: string, mono?: boolean, needs?: string[] }
//   complete -> "✓ <summary>"; otherwise "Needs: <needs joined>" in muted text.
//
// `sectionId` is the `step-*` DOM id error routing scrolls to; the same ids are
// used by BasicForm.
export default function CollapsibleSection({
  sectionId,
  title,
  status,
  open,
  onToggle,
  keepMounted = false,
  children
}) {
  const bodyId = `${sectionId}-body`
  return (
    <section id={sectionId} className="border-b border-gray-100">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
          className="flex w-full items-center justify-between gap-3 bg-transparent px-4 py-3 text-left"
        >
          <span className="flex items-center gap-2 text-sm font-medium text-gray-900">
            <span aria-hidden="true" className="text-xs text-gray-400">
              {open ? '▾' : '▸'}
            </span>
            {title}
          </span>
          <StatusLine status={status} />
        </button>
      </h3>
      {(open || keepMounted) && (
        <div id={bodyId} hidden={!open} className="px-4 pb-4">
          {children}
        </div>
      )}
    </section>
  )
}

function StatusLine({ status }) {
  if (!status) return null
  if (status.complete) {
    return (
      <span className="min-w-0 truncate text-xs text-green-700">
        <span aria-hidden="true">✓ </span>
        <span className={status.mono ? 'font-mono' : ''}>{status.summary}</span>
      </span>
    )
  }
  const needs = status.needs || []
  return (
    <span className="min-w-0 truncate text-xs text-gray-400">
      {needs.length > 0 ? `Needs: ${needs.join(', ')}` : ''}
    </span>
  )
}
