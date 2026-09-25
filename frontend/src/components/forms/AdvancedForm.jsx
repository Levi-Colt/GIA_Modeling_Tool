import { useEffect, useRef } from 'react'
import { useProcessing } from '../../context/ProcessingContext.jsx'
import CollapsibleSection from '../shared/CollapsibleSection.jsx'
import UploadStep from '../steps/UploadStep.jsx'
import { CoordinateModeStep, CoordinatesStep } from '../steps/CoordinateSteps.jsx'
import { TargetElevationField, ProductsStep } from '../steps/TiltAndProductsSteps.jsx'
import TiltModelBody from '../advanced/TiltModelBody.jsx'
import { getReadiness, parseSelectionRadiusKm } from '../../utils/readiness.js'
import { STEPS, scrollToStep } from '../../utils/steps.js'

// "028°" -- azimuth zero-padded to three integer digits, like a compass bearing.
function formatAzimuth(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return `${value}°`
  const [whole, frac] = String(Math.abs(n)).split('.')
  return `${n < 0 ? '-' : ''}${whole.padStart(3, '0')}${frac ? `.${frac}` : ''}°`
}

// Advanced mode: the same inputs as Basic in four collapsible sections
// (artboard B). Open state persists in formState.advanced.sectionsOpen; more
// than one section can be open. `focusRequest` ({ id, n }, lifted into
// ProcessingPage) opens the section containing that `step-*` id, then scrolls.
export default function AdvancedForm({ focusRequest }) {
  const { formState, updateAdvanced } = useProcessing()
  const { sectionsOpen } = formState.advanced
  const { missing } = getReadiness(formState)
  const needs = (section) => missing.filter((m) => m.section === section).map((m) => m.text)

  function setOpen(key, open) {
    updateAdvanced({ sectionsOpen: { ...sectionsOpen, [key]: open } })
  }

  // Error routing: open the target's section (it may be collapsed), and scroll
  // only once it is open, after the next paint.
  const pendingScroll = useRef(null)
  useEffect(() => {
    if (!focusRequest) return
    const step = STEPS.find((s) => s.id === focusRequest.id)
    if (!step) return
    pendingScroll.current = focusRequest.id
    if (!sectionsOpen[step.advancedKey]) setOpen(step.advancedKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest])

  useEffect(() => {
    const id = pendingScroll.current
    if (!id) return
    const step = STEPS.find((s) => s.id === id)
    if (!sectionsOpen[step.advancedKey]) return // re-runs once the open lands
    pendingScroll.current = null
    // No cleanup: this effect re-runs every render, and cancelling here would
    // drop the scroll if anything re-rendered before the frame fired.
    requestAnimationFrame(() => scrollToStep(id))
  })

  const { preflightStatus, resolvedOrigin, tiltAzimuth, tiltFactor, selectionRadiusKm, includeDem } = formState
  const family = formState.advanced.profile?.family ?? 'linear'
  const radiusKm = parseSelectionRadiusKm(selectionRadiusKm)

  const originNeeds = needs('origin')
  const originSummary = resolvedOrigin
    ? `${resolvedOrigin[1].toFixed(5)}, ${resolvedOrigin[0].toFixed(5)}`
    : formState.originValue

  const sections = {
    dem: {
      title: 'DEM',
      status: {
        complete: preflightStatus === 'valid',
        summary: formState.demFile?.name || formState.demPath,
        needs: needs('dem')
      },
      // Stays mounted while collapsed so an in-flight preflight (and the
      // uncontrolled path input) isn't lost.
      keepMounted: true,
      body: <UploadStep />
    },
    origin: {
      title: 'Origin (spillway)',
      status: { complete: originNeeds.length === 0, summary: originSummary, mono: true, needs: originNeeds },
      body: (
        <div className="space-y-2">
          <CoordinateModeStep />
          <CoordinatesStep />
          <TargetElevationField />
        </div>
      )
    },
    tilt: {
      title: 'Tilt model',
      status: {
        complete: needs('tilt').length === 0,
        summary: `${formatAzimuth(tiltAzimuth)} · ${tiltFactor} m/km${family === 'linear' ? '' : ` · ${family}`}`,
        mono: true,
        needs: needs('tilt')
      },
      body: <TiltModelBody />
    },
    output: {
      title: 'Output',
      status: {
        complete: needs('output').length === 0,
        summary: `${radiusKm !== null ? `radius ${radiusKm} km` : 'no radius limit'} · ${
          includeDem ? 'with DEM' : 'contours only'
        }`,
        needs: needs('output')
      },
      body: <ProductsStep />
    }
  }

  return (
    <div>
      {STEPS.map((step) => {
        const section = sections[step.advancedKey]
        return (
          <CollapsibleSection
            key={step.id}
            sectionId={`step-${step.id}`}
            title={section.title}
            status={section.status}
            open={!!sectionsOpen[step.advancedKey]}
            onToggle={() => setOpen(step.advancedKey, !sectionsOpen[step.advancedKey])}
            keepMounted={section.keepMounted}
          >
            {section.body}
          </CollapsibleSection>
        )
      })}
    </div>
  )
}
