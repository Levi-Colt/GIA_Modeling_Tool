import { useState } from 'react'
import { useProcessing } from '../../context/ProcessingContext.jsx'
import { surfaceFitKey } from '../../hooks/useSurfaceFit.js'
import Banner from '../shared/Banner.jsx'
import { CsvImportPanel } from './CsvImport.jsx'
import { Help, Segmented } from './fields.jsx'
import { formatNumber } from '../../utils/tiltModel.js'
import {
  EXTRAPOLATIONS,
  MAX_SHORE_POINTS,
  SURFACE_HINGES,
  SURFACE_ORDERS,
  minPointsForOrder,
  newShorePoint,
  parseShorePoint,
  parseShorePointsCsv,
  surfaceOf
} from '../../utils/shorePoints.js'

// Help text is generic and unit-only: the tool is location-agnostic, so nothing
// here may point users at a particular paper, basin, or set of values.
const IMPORT_HELP =
  'Needs latitude, longitude and elevation (m) columns; a site name column is optional. Header names are matched ' +
  'without regard to case; if they cannot be matched you will choose the columns.'
const ORDER_HELP = 'A smooth trend surface through the points, not an exact fit. The comparison below is advisory.'
const HINGE_HELP =
  'As fitted applies the surface on both sides of the spillway. No change behind origin keeps only positive uplift, so nothing changes where the surface lies below its value at the spillway.'
const EXTRAPOLATION_HELP =
  'A polynomial surface can diverge outside its data. Warn computes everywhere; Mask leaves no contours there.'

const PAGE = 200
const cellInput = 'w-full min-w-[4rem] px-1 py-0.5 text-sm'

const signed = (r) => `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(2)}`

function TextCell({ label, value, onChange }) {
  return (
    <input type="text" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={cellInput} />
  )
}

// A numeric cell: red while its text is non-empty and not a valid value.
function NumCell({ label, value, valid, onChange, placeholder }) {
  const invalid = value.trim() !== '' && !valid
  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={label}
      aria-invalid={invalid || undefined}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`${cellInput} ${invalid ? 'border-red-400' : ''}`}
    />
  )
}

function OrderComparison({ orders, selectedOrder }) {
  return (
    <table className="w-full text-left text-xs text-gray-700">
      <caption className="pb-1 text-left text-xs text-gray-500">Fit comparison</caption>
      <thead>
        <tr className="text-gray-500">
          <th className="px-1 py-0.5 font-medium">Order</th>
          <th className="px-1 py-0.5 font-medium">R²</th>
          <th className="px-1 py-0.5 font-medium">Adj. R²</th>
          <th className="px-1 py-0.5 font-medium">RMSE (m)</th>
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => (
          <tr
            key={o.order}
            aria-current={o.order === selectedOrder ? 'true' : undefined}
            className={o.order === selectedOrder ? 'bg-blue-50 font-medium' : ''}
          >
            <td className="px-1 py-0.5">{o.order}</td>
            <td className="px-1 py-0.5">{Number.isFinite(o.r2) ? o.r2.toFixed(3) : '–'}</td>
            <td className="px-1 py-0.5">{Number.isFinite(o.adj_r2) ? o.adj_r2.toFixed(3) : '–'}</td>
            <td className="px-1 py-0.5">{Number.isFinite(o.rmse_m) ? o.rmse_m.toFixed(2) : '–'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function FitStatus({ fit, current }) {
  const data = fit?.data ?? null
  if (!data) {
    return (
      <p className="rounded-md border border-dashed border-gray-300 px-3 py-4 text-center text-xs text-gray-500">
        {fit?.status === 'error'
          ? fit.error
          : fit?.status === 'loading'
            ? 'Fitting the surface...'
            : 'Complete the shore points, DEM and origin to fit the surface and see its isobases on the map.'}
      </p>
    )
  }
  const s = data.selected
  const outliers = s.outlier_indices.length
  return (
    <div className={`space-y-2 ${current ? '' : 'opacity-60'}`}>
      <p className="text-xs text-gray-700">
        Order-{s.order} fit to {s.n} points: RMSE {Number.isFinite(s.rmse_m) ? s.rmse_m.toFixed(2) : '–'} m, R²{' '}
        {Number.isFinite(s.r2) ? s.r2.toFixed(3) : '–'}.
        {Number.isFinite(data.interval_m) && ` Isobases every ${formatNumber(data.interval_m)} m a.s.l.; dashed parts lie outside the data.`}
      </p>
      {outliers > 0 && (
        <p className="text-xs text-gray-700">
          {outliers} possible {outliers === 1 ? 'outlier' : 'outliers'} flagged (standardized residual beyond ±3). None are
          removed automatically.
        </p>
      )}
    </div>
  )
}

function PointsTable({ points, setPoints, selected }) {
  const [sortByResidual, setSortByResidual] = useState(false)
  const [visible, setVisible] = useState(PAGE)
  const residuals = selected?.residuals_m ?? null
  const outliers = new Set(selected?.outlier_indices ?? [])

  let rows = points.map((p, i) => ({ p, i }))
  const sorted = sortByResidual && residuals
  if (sorted) rows = [...rows].sort((a, b) => Math.abs(residuals[b.i]) - Math.abs(residuals[a.i]))

  const patch = (id, change) => setPoints(points.map((p) => (p.id === id ? { ...p, ...change } : p)))
  const remove = (id) => setPoints(points.filter((p) => p.id !== id))

  return (
    <div className="space-y-1">
      <div className="max-h-72 overflow-auto rounded-md border border-gray-200">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-gray-50 text-gray-500">
            <tr>
              <th className="px-1 py-1 font-medium">#</th>
              <th className="px-1 py-1 font-medium">Site</th>
              <th className="px-1 py-1 font-medium">Lat</th>
              <th className="px-1 py-1 font-medium">Lon</th>
              <th className="px-1 py-1 font-medium">Elev (m)</th>
              <th className="px-1 py-1 font-medium" aria-sort={sorted ? 'descending' : 'none'}>
                <button
                  type="button"
                  disabled={!residuals}
                  onClick={() => setSortByResidual(!sortByResidual)}
                  title={residuals ? 'Sort by size of residual, largest first' : 'Residuals appear once the surface is fitted'}
                  className="font-medium underline-offset-2 enabled:hover:underline disabled:cursor-not-allowed"
                >
                  Residual (m){sorted ? ' ↓' : ''}
                </button>
              </th>
              <th className="px-1 py-1" />
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, visible).map(({ p, i }) => {
              const n = i + 1
              const r = parseShorePoint(p)
              const residual = residuals?.[i]
              const flagged = outliers.has(i)
              return (
                <tr key={p.id} className={flagged ? 'bg-amber-50' : ''}>
                  <td className="px-1 py-0.5 text-gray-500">{n}</td>
                  <td className="px-1 py-0.5">
                    <TextCell label={`Point ${n} site`} value={p.label} onChange={(label) => patch(p.id, { label })} />
                  </td>
                  <td className="px-1 py-0.5">
                    <NumCell label={`Point ${n} latitude`} value={p.lat} valid={r.lat !== null} onChange={(lat) => patch(p.id, { lat })} />
                  </td>
                  <td className="px-1 py-0.5">
                    <NumCell label={`Point ${n} longitude`} value={p.lon} valid={r.lon !== null} onChange={(lon) => patch(p.id, { lon })} />
                  </td>
                  <td className="px-1 py-0.5">
                    <NumCell
                      label={`Point ${n} elevation (m)`}
                      value={p.elevationM}
                      valid={r.elevation !== null}
                      onChange={(elevationM) => patch(p.id, { elevationM })}
                    />
                  </td>
                  <td className="whitespace-nowrap px-1 py-0.5 text-gray-700">
                    {Number.isFinite(residual) ? signed(residual) : '–'}
                    {flagged && (
                      <span className="ml-1 rounded bg-amber-200 px-1 text-[10px] font-medium text-amber-900">outlier</span>
                    )}
                  </td>
                  <td className="px-1 py-0.5">
                    <button
                      type="button"
                      aria-label={`Remove point ${n}`}
                      onClick={() => remove(p.id)}
                      className="rounded px-1.5 text-gray-500 hover:bg-gray-100"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {points.length > visible && (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span>
            Showing {visible} of {points.length}
            {sorted ? ' (largest residuals first)' : ''}.
          </span>
          <button type="button" onClick={() => setVisible(visible + PAGE)} className="rounded-md border border-gray-300 px-2 py-0.5">
            Show more
          </button>
        </div>
      )}
    </div>
  )
}

// The shore-points direction source (documentation/SHORE_POINT_SURFACE_SPEC.md,
// spec 6): import or enter points (a place and the present elevation of a
// shoreline feature there), pick the trend surface's order, and see how well it
// fits. The surface itself and its residuals are drawn on the map. Magnitude comes
// from the data, so none of the profile controls appear in this mode.
export default function ShorePointsPanel() {
  const { formState, updateAdvanced } = useProcessing()
  const [importOpen, setImportOpen] = useState(false)
  const [tableOpen, setTableOpen] = useState(false)
  const points = formState.advanced.shorePoints ?? []
  const surface = surfaceOf(formState.advanced)
  const fit = formState.surfaceFit
  // Residuals belong to the request that produced them: a stale fit (points edited,
  // answer still pending) is dimmed and its residuals are not shown as current.
  const current = fit?.status === 'ready' && fit.key !== null && fit.key === surfaceFitKey(formState)
  const selected = current ? fit.data.selected : null

  const setPoints = (next) => updateAdvanced({ shorePoints: next })
  const setSurface = (patch) => updateAdvanced({ surface: { ...surface, ...patch } })

  const orderOptions = SURFACE_ORDERS.map((o) => {
    const need = minPointsForOrder(o)
    const feasible = points.length >= need
    return {
      value: o,
      label: String(o),
      disabled: !feasible,
      title: feasible ? undefined : `Needs at least ${need} points`
    }
  })

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-gray-800">
          {points.length} {points.length === 1 ? 'point' : 'points'}
        </span>
        <button
          type="button"
          aria-expanded={importOpen}
          onClick={() => setImportOpen(!importOpen)}
          className="rounded-md border border-gray-300 px-2 py-1 text-xs"
        >
          Import CSV
        </button>
        <button
          type="button"
          disabled={points.length >= MAX_SHORE_POINTS}
          onClick={() => {
            setPoints([...points, newShorePoint()])
            setTableOpen(true)
          }}
          className="rounded-md border border-gray-300 px-2 py-1 text-xs disabled:text-gray-400"
        >
          Add point
        </button>
        <button
          type="button"
          aria-expanded={tableOpen}
          onClick={() => setTableOpen(!tableOpen)}
          className="rounded-md border border-gray-300 px-2 py-1 text-xs"
        >
          {tableOpen ? 'Hide table' : 'View table'}
        </button>
      </div>

      {importOpen && (
        <CsvImportPanel
          existing={points}
          limit={MAX_SHORE_POINTS}
          noun="points"
          listName="point list"
          help={IMPORT_HELP}
          parse={parseShorePointsCsv}
          commit={setPoints}
          onClose={() => setImportOpen(false)}
        />
      )}

      {tableOpen && <PointsTable points={points} setPoints={setPoints} selected={selected} />}

      <div>
        <Segmented label="Fit order" options={orderOptions} value={surface.order} onChange={(order) => setSurface({ order })} />
        <Help>{ORDER_HELP}</Help>
      </div>

      {fit?.data?.orders?.length > 0 && <OrderComparison orders={fit.data.orders} selectedOrder={surface.order} />}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="block text-xs text-gray-500">
          Behind the spillway
          <select value={surface.hinge} onChange={(e) => setSurface({ hinge: e.target.value })} className="mt-1 w-full">
            {SURFACE_HINGES.map((h) => (
              <option key={h.value} value={h.value}>
                {h.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-gray-500">
          Outside the data
          <select
            value={surface.extrapolation}
            onChange={(e) => setSurface({ extrapolation: e.target.value })}
            className="mt-1 w-full"
          >
            {EXTRAPOLATIONS.map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Help>{HINGE_HELP}</Help>
      <Help>{EXTRAPOLATION_HELP}</Help>

      <div className="space-y-2">
        <div className="text-xs text-gray-500">Surface fit</div>
        <FitStatus fit={fit} current={current} />
        {(fit?.data?.warnings ?? []).map((w) => (
          <Banner key={w} variant="warning">
            {w}
          </Banner>
        ))}
      </div>
    </div>
  )
}
