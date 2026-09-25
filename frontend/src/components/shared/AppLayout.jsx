// Shared page layout for the form view and the results view (spec C1):
// header bar, then a form/results column beside a full-height map.
//
//   lg and up : h-screen; [minmax(380px,1fr) | 2fr] grid, only `children` scrolls
//   below lg  : stacked, map first at h-[55vh], form below at natural height
//
// Slots: `modeSwitch` (pinned above the body; omitted in the results view),
// `children` (the scrolling body), `footer` (pinned below it, e.g. Run button),
// `map` (the MapPanel). `bodyRef` lets the caller reset the body's scroll.
export default function AppLayout({ modeSwitch, footer, map, bodyRef, children }) {
  return (
    <div className="flex min-h-screen flex-col lg:h-screen">
      <header className="flex h-12 shrink-0 items-center border-b border-gray-200 bg-white px-4">
        <span className="text-sm font-semibold text-gray-900">GIA Modeling Tool</span>
      </header>
      <div className="grid min-h-0 flex-1 lg:grid-rows-1 lg:grid-cols-[minmax(380px,1fr)_2fr]">
        <div className="order-2 flex min-h-0 flex-col border-r border-gray-200 bg-white lg:order-1">
          {modeSwitch}
          <div ref={bodyRef} className="min-h-0 flex-1 lg:overflow-y-auto">
            {children}
          </div>
          {footer && <div className="border-t border-gray-200 px-4 py-3">{footer}</div>}
        </div>
        <div className="order-1 h-[55vh] lg:order-2 lg:h-auto lg:min-h-0">{map}</div>
      </div>
    </div>
  )
}
