// The shore-points UI inside the Tilt model section (spec 6): the direction-source
// switch, order feasibility, the comparison table, CSV import with a column
// picker, and the editable, sortable points table.
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ProcessingProvider, useProcessing } from '../../context/ProcessingContext.jsx'
import { surfaceFitKey } from '../../hooks/useSurfaceFit.js'
import TiltModelBody from './TiltModelBody.jsx'
import { newShorePoint } from '../../utils/shorePoints.js'

let ctx
function Readout() {
  ctx = useProcessing()
  return null
}

function renderBody() {
  return render(
    <ProcessingProvider>
      <TiltModelBody />
      <Readout />
    </ProcessingProvider>
  )
}

const pts = (n, patch = () => ({})) =>
  Array.from({ length: n }, (_, i) =>
    newShorePoint({ lat: String(45 + i / 50), lon: String(-105 + i / 50), elevationM: String(300 + i), ...patch(i) })
  )

// Puts the body into points mode with `n` valid points.
function withPoints(n, patch) {
  act(() => {
    ctx.updateForm({
      mode: 'advanced',
      resolvedOrigin: [-104.9, 44.9],
      boundsWgs84: [-105, 44, -104, 46]
    })
    ctx.updateAdvanced({ directionSource: 'points', shorePoints: pts(n, patch) })
  })
}

const ORDERS = [
  { order: 1, n: 12, terms: 3, r2: 0.912, adj_r2: 0.9, rmse_m: 4.5 },
  { order: 2, n: 12, terms: 6, r2: 0.981, adj_r2: 0.97, rmse_m: 1.9 }
]

// A fit answering exactly the current inputs (the key is the request it answers).
function withFit({ residuals, outliers = [], orders = ORDERS, warnings = [] }) {
  const selected = {
    order: 2, n: residuals.length, terms: 6, r2: 0.981, adj_r2: 0.97, rmse_m: 1.9, cond: 12,
    residuals_m: residuals, std_residuals: residuals, outlier_indices: outliers
  }
  const data = {
    orders, selected, interval_m: 10, warnings, dem_fraction_outside_hull: 0.1,
    isobases: { inside: { type: 'FeatureCollection', features: [] }, outside: { type: 'FeatureCollection', features: [] } },
    hull: { type: 'Polygon', coordinates: [[]] }
  }
  act(() => ctx.updateForm({ surfaceFit: { status: 'ready', data, error: null, key: surfaceFitKey(ctx.formState) } }))
}

const orderButton = (n) => within(screen.getByRole('group', { name: 'Fit order' })).getByRole('button', { name: String(n) })

beforeEach(() => window.localStorage.clear())

describe('direction source', () => {
  it('has a Shore points segment; choosing it shows the panel and hides the profile and hinge blocks', async () => {
    const user = userEvent.setup()
    renderBody()
    expect(screen.getByRole('button', { name: 'Shore points' })).toHaveAttribute('aria-pressed', 'false')
    await user.click(screen.getByRole('button', { name: 'Shore points' }))

    expect(ctx.formState.advanced.directionSource).toBe('points')
    expect(screen.getByRole('button', { name: 'Shore points' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('0 points')).toBeInTheDocument()
    expect(screen.getByText('Magnitude comes from the fitted surface.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Single azimuth')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Gradient at spillway (m/km)')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Profile family')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Hinge behind spillway')).not.toBeInTheDocument()
  })

  it('switching away and back keeps the points (nothing is cleared)', async () => {
    const user = userEvent.setup()
    renderBody()
    withPoints(9)
    await user.click(screen.getByRole('button', { name: 'Single azimuth' }))
    expect(screen.getByLabelText('Single azimuth')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Shore points' }))
    expect(screen.getByText('9 points')).toBeInTheDocument()
    expect(ctx.formState.advanced.shorePoints).toHaveLength(9)
  })
})

describe('fit order', () => {
  it('disables the orders the point count cannot support, with a tooltip giving the minimum', () => {
    renderBody()
    withPoints(9)
    expect(orderButton(1)).toBeEnabled()
    expect(orderButton(2)).toBeEnabled()
    expect(orderButton(3)).toBeDisabled()
    expect(orderButton(3)).toHaveAttribute('title', 'Needs at least 13 points')
    expect(orderButton(1)).not.toHaveAttribute('title')
  })

  it('with too few points for any order, all three are disabled (6 is the fewest)', () => {
    renderBody()
    withPoints(5)
    for (const n of [1, 2, 3]) expect(orderButton(n)).toBeDisabled()
    expect(orderButton(1)).toHaveAttribute('title', 'Needs at least 6 points')
    expect(orderButton(2)).toHaveAttribute('title', 'Needs at least 9 points')
  })

  it('defaults to 2 and changes the surface order', async () => {
    const user = userEvent.setup()
    renderBody()
    withPoints(13)
    expect(orderButton(2)).toHaveAttribute('aria-pressed', 'true')
    await user.click(orderButton(3))
    expect(ctx.formState.advanced.surface.order).toBe(3)
    expect(orderButton(3)).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('options', () => {
  it('Behind the spillway defaults to "Apply surface as fitted"; Outside the data to "Warn"', async () => {
    const user = userEvent.setup()
    renderBody()
    withPoints(9)
    const behind = screen.getByLabelText('Behind the spillway')
    const outside = screen.getByLabelText('Outside the data')
    expect(behind).toHaveValue('none')
    expect(outside).toHaveValue('warn')
    expect(within(behind).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Apply surface as fitted',
      'No change behind origin'
    ])
    expect(within(outside).getAllByRole('option').map((o) => o.textContent)).toEqual(['Warn', 'Mask (no contours)'])

    await user.selectOptions(behind, 'origin')
    await user.selectOptions(outside, 'mask')
    expect(ctx.formState.advanced.surface).toMatchObject({ hinge: 'origin', extrapolation: 'mask' })
  })
})

describe('the fit', () => {
  it('shows the order comparison with the selected order highlighted, the fit line and warnings', () => {
    renderBody()
    withPoints(12)
    withFit({ residuals: Array(12).fill(0.5), warnings: ['31% of the DEM lies outside the shore points\' buffered hull; extrapolated.'] })

    const table = screen.getByRole('table', { name: 'Fit comparison' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getAllByRole('cell').map((c) => c.textContent)).toEqual(['1', '0.912', '0.900', '4.50'])
    expect(rows[1]).toHaveAttribute('aria-current', 'true')
    expect(rows[0]).not.toHaveAttribute('aria-current')

    expect(screen.getByText(/Order-2 fit to 12 points: RMSE 1.90 m, R² 0.981\./)).toBeInTheDocument()
    expect(screen.getByText(/Isobases every 10 m a\.s\.l\./)).toBeInTheDocument()
    expect(screen.getByText(/31% of the DEM lies outside/)).toBeInTheDocument()
  })

  it('says what is needed before there is a fit, and shows an error', () => {
    renderBody()
    withPoints(3)
    expect(screen.getByText(/Complete the shore points, DEM and origin/)).toBeInTheDocument()
    act(() => ctx.updateForm({ surfaceFit: { status: 'error', data: null, error: 'boom', key: null } }))
    expect(screen.getByText('boom')).toBeInTheDocument()
  })

  it('a stale fit (the points changed since) is not used for residuals', async () => {
    const user = userEvent.setup()
    renderBody()
    withPoints(9)
    withFit({ residuals: [1, 2, 3, 4, 5, 6, 7, 8, 9] })
    await user.click(screen.getByRole('button', { name: 'View table' }))
    expect(screen.getByLabelText('Point 1 site').closest('tr')).toHaveTextContent('+1.00')

    await user.clear(screen.getByLabelText('Point 1 elevation (m)'))
    await user.type(screen.getByLabelText('Point 1 elevation (m)'), '999')
    expect(screen.getByLabelText('Point 1 site').closest('tr')).not.toHaveTextContent('+1.00')
  })
})

describe('the points table', () => {
  it('is behind a "View table" disclosure and lists site, lat, lon, elevation and residual', async () => {
    const user = userEvent.setup()
    renderBody()
    withPoints(9, (i) => ({ label: `Site ${i + 1}` }))
    expect(screen.queryByLabelText('Point 1 latitude')).not.toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: 'View table' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)

    expect(screen.getByRole('button', { name: 'Hide table' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByLabelText('Point 2 site')).toHaveValue('Site 2')
    expect(screen.getByLabelText('Point 2 latitude')).toHaveValue('45.02')
    expect(screen.getByLabelText('Point 2 longitude')).toHaveValue('-104.98')
    expect(screen.getByLabelText('Point 2 elevation (m)')).toHaveValue('301')
  })

  it('rows are editable and deletable, so an obvious outlier can be removed', async () => {
    const user = userEvent.setup()
    renderBody()
    withPoints(10)
    await user.click(screen.getByRole('button', { name: 'View table' }))

    await user.clear(screen.getByLabelText('Point 3 elevation (m)'))
    await user.type(screen.getByLabelText('Point 3 elevation (m)'), '305.5')
    expect(ctx.formState.advanced.shorePoints[2].elevationM).toBe('305.5')

    await user.click(screen.getByRole('button', { name: 'Remove point 4' }))
    expect(ctx.formState.advanced.shorePoints).toHaveLength(9)
    expect(screen.getByText('9 points')).toBeInTheDocument()
    expect(ctx.formState.advanced.shorePoints.map((p) => p.elevationM)).not.toContain('303')
  })

  it('marks an invalid number and can add a blank point', async () => {
    const user = userEvent.setup()
    renderBody()
    withPoints(9)
    await user.click(screen.getByRole('button', { name: 'View table' }))
    await user.clear(screen.getByLabelText('Point 1 latitude'))
    await user.type(screen.getByLabelText('Point 1 latitude'), 'abc')
    expect(screen.getByLabelText('Point 1 latitude')).toHaveAttribute('aria-invalid', 'true')

    await user.click(screen.getByRole('button', { name: 'Add point' }))
    expect(screen.getByText('10 points')).toBeInTheDocument()
    expect(screen.getByLabelText('Point 10 latitude')).toHaveValue('')
  })

  it('flags outliers (with text, not color alone) and sorts by size of residual', async () => {
    const user = userEvent.setup()
    renderBody()
    withPoints(9)
    withFit({ residuals: [0.1, -0.2, 0.3, 12, -0.4, 0.5, -0.6, 0.7, -25], outliers: [3, 8] })
    await user.click(screen.getByRole('button', { name: 'View table' }))

    const row = (n) => screen.getByLabelText(`Point ${n} site`).closest('tr')
    expect(row(4)).toHaveTextContent('outlier')
    expect(row(9)).toHaveTextContent('−25.00')
    expect(row(9)).toHaveTextContent('outlier')
    expect(row(1)).not.toHaveTextContent('outlier')

    const numberOrder = () =>
      within(screen.getByLabelText('Point 1 site').closest('table')).getAllByRole('row').slice(1).map((r) => r.querySelector('td').textContent)
    expect(numberOrder()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9'])
    await user.click(screen.getByRole('button', { name: /Residual \(m\)/ }))
    expect(numberOrder().slice(0, 3)).toEqual(['9', '4', '8'])
  })

  it('offers no residual sort until a fit exists', async () => {
    const user = userEvent.setup()
    renderBody()
    withPoints(9)
    await user.click(screen.getByRole('button', { name: 'View table' }))
    expect(screen.getByRole('button', { name: /Residual \(m\)/ })).toBeDisabled()
  })
})

describe('CSV import', () => {
  const file = (text) => new File([text], 'shore.csv', { type: 'text/csv' })

  it('imports rows with recognized headers and reports skipped ones', async () => {
    const user = userEvent.setup()
    renderBody()
    act(() => ctx.updateAdvanced({ directionSource: 'points' }))
    await user.click(screen.getByRole('button', { name: 'Import CSV' }))
    await user.upload(
      screen.getByLabelText('CSV file'),
      file('Latitude,Longitude,Elevation,Site\n45,-105,300,A\n45,-105,,B\n95,-105,10,C\n46,-104,310,D\n')
    )

    expect(await screen.findByRole('status')).toHaveTextContent(
      '2 imported, 2 skipped: row 2 elevation missing, row 3 latitude out of range (replaced the point list)'
    )
    expect(ctx.formState.advanced.shorePoints.map((p) => [p.label, p.elevationM])).toEqual([
      ['A', '300'],
      ['D', '310']
    ])
    expect(screen.getByText('2 points')).toBeInTheDocument()
  })

  it('shows a column picker when a required column cannot be matched, and imports with the chosen columns', async () => {
    const user = userEvent.setup()
    renderBody()
    act(() => ctx.updateAdvanced({ directionSource: 'points' }))
    await user.click(screen.getByRole('button', { name: 'Import CSV' }))
    // A messy supplementary-sheet style header: unrelated columns, repeated names.
    await user.upload(
      screen.getByLabelText('CSV file'),
      file('Site,Notes,Y,X,Elevation Source,Elevation Source\nA,ok,45.1,-104.9,GPS,331.4\nB,,45.2,-104.8,LiDAR,340.2\n')
    )

    const picker = await screen.findByRole('group', { name: 'Column picker' })
    expect(ctx.formState.advanced.shorePoints).toHaveLength(0) // nothing imported yet
    expect(within(picker).getByText('First 2 rows')).toBeInTheDocument()
    expect(within(picker).getByText('331.4')).toBeInTheDocument() // the preview shows the data
    const importButton = within(picker).getByRole('button', { name: 'Import with these columns' })
    expect(importButton).toBeDisabled()

    await user.selectOptions(within(picker).getByLabelText('Latitude column'), 'Y · column 3')
    await user.selectOptions(within(picker).getByLabelText('Longitude column'), 'X · column 4')
    expect(importButton).toBeDisabled() // elevation still unchosen
    await user.selectOptions(within(picker).getByLabelText('Elevation (m) column'), 'Elevation Source · column 6')
    expect(importButton).toBeEnabled()
    // The optional site-name column was pre-matched from its header.
    expect(within(picker).getByLabelText('Site name (optional) column')).toHaveValue('0')

    await user.click(importButton)
    expect(await screen.findByRole('status')).toHaveTextContent('2 imported (replaced the point list)')
    expect(ctx.formState.advanced.shorePoints.map((p) => [p.label, p.lat, p.lon, p.elevationM])).toEqual([
      ['A', '45.1', '-104.9', '331.4'],
      ['B', '45.2', '-104.8', '340.2']
    ])
    expect(screen.queryByRole('group', { name: 'Column picker' })).not.toBeInTheDocument()
  })

  it('with points already present it asks Replace or Append', async () => {
    const user = userEvent.setup()
    renderBody()
    withPoints(3)
    await user.click(screen.getByRole('button', { name: 'Import CSV' }))
    await user.upload(screen.getByLabelText('CSV file'), file('lat,lon,elevation\n10,-105,300\n11,-105,301\n'))

    expect(await screen.findByRole('button', { name: 'Replace existing points' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Append' }))
    expect(ctx.formState.advanced.shorePoints).toHaveLength(5)
    expect(screen.getByRole('status')).toHaveTextContent('2 imported (appended to the point list)')
  })

  it('reports a file with no usable rows', async () => {
    const user = userEvent.setup()
    renderBody()
    act(() => ctx.updateAdvanced({ directionSource: 'points' }))
    await user.click(screen.getByRole('button', { name: 'Import CSV' }))
    await user.upload(screen.getByLabelText('CSV file'), file('lat,lon,elevation\n'))
    expect(await screen.findByRole('alert')).toHaveTextContent('The CSV has no data rows.')
  })
})
