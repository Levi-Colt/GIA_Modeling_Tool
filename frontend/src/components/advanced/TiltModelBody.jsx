import { useProcessing } from '../../context/ProcessingContext.jsx'
import Field, { statusBorder } from '../shared/Field.jsx'
import { TiltInputs } from '../steps/TiltAndProductsSteps.jsx'
import ProfileChart from './ProfileChart.jsx'
import VectorTable from './VectorTable.jsx'
import VectorFitSummary from './VectorFitSummary.jsx'
import ShorePointsPanel from './ShorePointsPanel.jsx'
import { Help, NumberField, Segmented } from './fields.jsx'
import {
  DEFAULT_HINGE,
  DEFAULT_PROFILE,
  FAMILIES,
  HINGE_MODES,
  directionSourceOf,
  formatNumber,
  normalizeHingeMode
} from '../../utils/tiltModel.js'
import { FORMULA_EXAMPLE, parseProfileFormula } from '../../utils/formula.js'

// Help text is deliberately generic: the tool is location-agnostic, so nothing
// here may point users at a particular paper, basin, or set of values.
const GRADIENT_HELP =
  "Present-day slope of this shoreline's (tilted) water plane at the spillway, measured in the direction of maximum uplift."
const RATE_HELP =
  'How much the gradient increases per km in the uplift direction. 0 gives a linear profile.'
const FORMULA_HELP =
  `Write the curve's extra terms as a x^p, joined by + or -. x is the distance in km up the uplift direction from ` +
  `the spillway, a is a number (scientific notation works: 2e-4 is 0.0002) and p is a whole number from 2 to 5. ` +
  `The linear term is the gradient above, so don't repeat it. Example: ${FORMULA_EXAMPLE}`
const HINGE_HELP = 'Where uplift stops changing as you move behind the spillway.'

// Two sources in the switch; "multiple directions" is a checkbox inside the first
// (stored as directionSource 'azimuth' unchecked, 'vectors' checked).
const SOURCE_CHOICES = [
  { value: 'direction', label: 'Uplift direction' },
  { value: 'points', label: 'Shore points' }
]
const MULTI_HELP =
  'Off: one uplift direction (azimuth) for the whole DEM. On: draw vectors on the map, each with its own start point, azimuth and range, then adjust their values in the table. The profile below sets the magnitude everywhere.'

const SUPERSCRIPT = { 2: '²', 3: '³', 4: '⁴', 5: '⁵' }
const SUBSCRIPT = { 2: '₂', 3: '₃', 4: '₄', 5: '₅' }

// How a valid formula was read, so a typo like 2e-4 vs 2e-5 is visible.
function readAs(coefficients) {
  return coefficients
    .map((c, i) => `c${SUBSCRIPT[i + 2]} = ${formatNumber(c, 4)} m/km${SUPERSCRIPT[i + 2]}`)
    .join(', ')
}

// The Tilt model section body.
//
// Direction and magnitude are separate: the direction block says *which way* uplift
// increases (one azimuth, or vectors drawn on the map), and the Profile block, the
// only place tilt is set, says *how much* (gradient at the spillway, family, hinge).
// `tiltFactor` (top level) is the gradient at the spillway in every profile family;
// never add a second key for it.
export default function TiltModelBody() {
  const { formState, updateAdvanced, setMapEditMode } = useProcessing()
  const source = directionSourceOf(formState.advanced)
  const vectorsMode = source === 'vectors'
  const pointsMode = source === 'points'
  const profile = formState.advanced.profile ?? DEFAULT_PROFILE
  const hinge = formState.advanced.hinge ?? DEFAULT_HINGE
  const { family } = profile

  const setProfile = (patch) => updateAdvanced({ profile: { ...profile, ...patch } })
  const setHinge = (patch) => updateAdvanced({ hinge: { ...hinge, ...patch } })
  const hingeMode = normalizeHingeMode(hinge.mode)

  const setSource = (choice) => {
    updateAdvanced({ directionSource: choice === 'points' ? 'points' : 'azimuth' })
    setMapEditMode('none') // leaving vectors mode disarms drawing
  }
  // Turning multiple directions on arms drawing straight away; turning it off
  // returns to the single azimuth (the drawn vectors are kept, not cleared).
  const setMulti = (on) => {
    updateAdvanced({ directionSource: on ? 'vectors' : 'azimuth' })
    setMapEditMode(on ? 'addVector' : 'none')
  }
  const sourceChoice = pointsMode ? 'points' : 'direction'

  if (pointsMode) {
    // Magnitude comes from the data: no gradient, profile family or hinge.
    return (
      <div className="space-y-3">
        <Segmented label="Direction source" options={SOURCE_CHOICES} value={sourceChoice} onChange={setSource} />
        <ShorePointsPanel />
        <p className="text-xs text-gray-500">Magnitude comes from the fitted surface.</p>
      </div>
    )
  }

  const formulaText = profile.formula ?? ''
  const parsedFormula = parseProfileFormula(formulaText)
  const formulaBlank = formulaText.trim() === ''
  const formulaStatus = formulaBlank ? 'required' : parsedFormula.ok ? 'valid' : 'invalid'

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <Segmented label="Direction source" options={SOURCE_CHOICES} value={sourceChoice} onChange={setSource} />

        <div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={vectorsMode} onChange={(e) => setMulti(e.target.checked)} />
            Use multiple directions
          </label>
          <Help>{MULTI_HELP}</Help>
        </div>

        {vectorsMode ? <VectorTable /> : <TiltInputs showGradient={false} azimuthLabel="Single azimuth" />}
      </div>

      <div className="space-y-3 border-t border-gray-100 pt-3">
        <div className="text-sm font-medium text-gray-700">Profile</div>

        <TiltInputs showAzimuth={false} factorLabel="Gradient at spillway (m/km)" factorHelp={GRADIENT_HELP} />

        <label className="block text-xs font-medium text-gray-700">
          Profile family
          <select
            value={family}
            onChange={(e) => setProfile({ family: e.target.value })}
            className="mt-1 w-full"
          >
            {FAMILIES.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>

        {family === 'quadratic' && (
          <div>
            <NumberField
              label="Rate of increase (m/km per km)"
              placeholder="m/km per km"
              required
              value={profile.rateOfIncrease}
              onChange={(rateOfIncrease) => setProfile({ rateOfIncrease })}
            />
            <Help>{RATE_HELP}</Help>
          </div>
        )}

        {family === 'polynomial' && (
          <Field
            label="Formula"
            status={formulaStatus}
            message={
              formulaBlank
                ? null
                : parsedFormula.ok
                  ? `Reads as ${readAs(parsedFormula.coefficients)}`
                  : parsedFormula.error
            }
            help={FORMULA_HELP}
          >
            <input
              type="text"
              spellCheck={false}
              autoComplete="off"
              placeholder="a x^p + …"
              value={formulaText}
              onChange={(e) => setProfile({ formula: e.target.value })}
              aria-invalid={formulaStatus === 'invalid' || undefined}
              className={`w-full font-mono ${statusBorder(formulaStatus)}`}
            />
          </Field>
        )}

        <div>
          <label className="block text-xs font-medium text-gray-700">
            Hinge behind spillway
            <select value={hingeMode} onChange={(e) => setHinge({ mode: e.target.value })} className="mt-1 w-full">
              {HINGE_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <Help>{HINGE_HELP}</Help>
        </div>

        {hingeMode === 'distance' && (
          <NumberField
            label="Hinge distance (km)"
            placeholder="km"
            positive
            required
            value={hinge.distanceKm}
            onChange={(distanceKm) => setHinge({ distanceKm })}
          />
        )}
      </div>

      {vectorsMode ? (
        <VectorFitSummary preview={formState.upliftPreview} />
      ) : (
        <ProfileChart preview={formState.profilePreview} />
      )}
    </div>
  )
}
