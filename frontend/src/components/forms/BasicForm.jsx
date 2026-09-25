import { useEffect } from 'react'
import UploadStep from '../steps/UploadStep.jsx'
import { CoordinateModeStep, CoordinatesStep } from '../steps/CoordinateSteps.jsx'
import { TargetElevationField, TiltInputs, ProductsStep } from '../steps/TiltAndProductsSteps.jsx'
import { scrollToStep } from '../../utils/steps.js'

// One numbered, non-collapsible section. `id` is the `step-*` DOM id error
// routing scrolls to (same ids as AdvancedForm).
function Section({ id, number, title, children }) {
  return (
    <section id={id} className="border-b border-gray-100 px-4 py-4">
      <h3 className="mb-3 text-sm font-medium text-gray-900">
        <span className="mr-1.5 text-gray-400">{number}</span>
        {title}
      </h3>
      {children}
    </section>
  )
}

// Basic mode: the four sections as a single scrolling page (artboard A).
// `focusRequest` ({ id, n }) is lifted into ProcessingPage; Basic just scrolls
// to the requested section.
export default function BasicForm({ focusRequest }) {
  useEffect(() => {
    if (!focusRequest) return
    const frame = requestAnimationFrame(() => scrollToStep(focusRequest.id))
    return () => cancelAnimationFrame(frame)
  }, [focusRequest])

  return (
    <div>
      <Section id="step-upload" number="1" title="DEM">
        <UploadStep />
      </Section>

      <Section id="step-coordinates" number="2" title="Origin (spillway)">
        <div className="space-y-2">
          <CoordinateModeStep />
          <CoordinatesStep />
          <TargetElevationField />
        </div>
      </Section>

      <Section id="step-tilt" number="3" title="Tilt">
        <TiltInputs />
      </Section>

      <Section id="step-products" number="4" title="Output">
        <ProductsStep />
      </Section>
    </div>
  )
}
