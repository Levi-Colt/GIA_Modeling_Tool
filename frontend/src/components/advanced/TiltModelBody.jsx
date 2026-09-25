import { useProcessing } from '../../context/ProcessingContext.jsx'
import { TiltInputs } from '../steps/TiltAndProductsSteps.jsx'
import ProfileChart from './ProfileChart.jsx'
import {
  CURVATURE_INPUTS,
  DEFAULT_HINGE,
  DEFAULT_PROFILE,
  DEGREES,
  FAMILIES,
  HINGE_MODES,
  curvatureForm,
  extraCoefficientCount,
  normalizeHingeMode,
  parseFiniteNumber,
  parsePositiveNumber,
  parseSecondGradient
} from '../../utils/tiltModel.js'

// Help text is deliberately generic: the tool is location-agnostic, so nothing
// here may point users at a particular paper, basin, or set of values.
const GRADIENT_HELP =
  "Present-day slope of this shoreline's (tilted) water plane at the spillway, measured in the direction of maximum uplift."
const RATE_HELP =
  'How much the gradient increases per km in the uplift direction. 0 gives a linear profile.'
const SECOND_GRADIENT_HELP =
  'Your estimate of the gradient at a second location up the uplift direction; the curve is fitted through both.'
const HINGE_HELP = 'Where uplift stops changing as you move behind the spillway.'
const POLYNOMIAL_HELP =
  'Terms of U(d) = g₀·d + c₂·d² + …, with d in km along the uplift direction from the spillway.'

const SUBSCRIPT = { 2: '₂', 3: '₃', 4: '₄', 5: '₅' }
const SUPERSCRIPT = { 2: '²', 3: '³', 4: '⁴', 5: '⁵' }

// Text input with numeric validation, not type="number", which mangles
// exponent notation in some browsers. Placeholders are units only.
function NumberField({ label, value, onChange, placeholder, positive = false }) {
  const parsed = positive ? parsePositiveNumber(value) : parseFiniteNumber(value)
  const invalid = value.trim() !== '' && parsed === null
  return (
    <div>
      <label className="block text-xs text-gray-500">
        {label}
        <input
          type="text"
          inputMode="decimal"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={invalid || undefined}
          className={`mt-1 w-full ${invalid ? 'border-red-400' : ''}`}
        />
      </label>
      {invalid && <p className="text-xs text-red-600">{positive ? 'Enter a number greater than 0.' : 'Enter a number.'}</p>}
    </div>
  )
}

function Help({ children }) {
  return <p className="mt-1 text-xs text-gray-500">{children}</p>
}

// Two-option segmented control (same look as the Basic/Advanced mode switch).
function Segmented({ label, options, value, onChange }) {
  return (
    <div>
      <div className="mb-1 text-xs text-gray-500">{label}</div>
      <div role="group" aria-label={label} className="inline-flex rounded-lg bg-gray-100 p-0.5">
        {options.map((o) => {
          const active = o.value === value
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(o.value)}
              className={`rounded-md px-3 py-1 text-sm ${
                active ? 'bg-white font-medium text-gray-900 shadow-sm' : 'bg-transparent text-gray-500'
              }`}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// The Tilt model section body.
//
// EXTENSION POINT: this is the one place later specs grow the tilt model -- the
// direction-source switch (replacing the "Single azimuth" row), vectors, and
// shore points all mount here, reading/writing formState.advanced via
// updateAdvanced. `tiltFactor` (top level) is the gradient at the spillway in
// every profile family; never add a second key for it.
export default function TiltModelBody() {
  const { formState, updateAdvanced } = useProcessing()
  const profile = formState.advanced.profile ?? DEFAULT_PROFILE
  const hinge = formState.advanced.hinge ?? DEFAULT_HINGE
  const { family } = profile

  const setProfile = (patch) => updateAdvanced({ profile: { ...profile, ...patch } })
  const setHinge = (patch) => updateAdvanced({ hinge: { ...hinge, ...patch } })

  const coefficientCount = extraCoefficientCount(profile)
  const hingeMode = normalizeHingeMode(hinge.mode)
  const form = curvatureForm(profile)
  // The chart marks the second-gradient point while that form is active.
  const secondGradient = family === 'quadratic' && form === 'secondGradient' ? parseSecondGradient(profile) : null

  return (
    <div className="space-y-3">
      <TiltInputs
        azimuthLabel="Single azimuth"
        factorLabel="Gradient at spillway (m/km)"
        factorHelp={GRADIENT_HELP}
      />

      <label className="block text-xs text-gray-500">
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
        <div className="space-y-2">
          <Segmented
            label="Curvature from"
            options={CURVATURE_INPUTS}
            value={form}
            onChange={(curvatureInput) => setProfile({ curvatureInput })}
          />
          {form === 'secondGradient' ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                <NumberField
                  label="Gradient (m/km)"
                  placeholder="m/km"
                  value={profile.secondGradient}
                  onChange={(secondGradient) => setProfile({ secondGradient })}
                />
                <NumberField
                  label="at distance (km) up the uplift direction from the spillway"
                  placeholder="km"
                  positive
                  value={profile.secondGradientDistanceKm}
                  onChange={(secondGradientDistanceKm) => setProfile({ secondGradientDistanceKm })}
                />
              </div>
              <Help>{SECOND_GRADIENT_HELP}</Help>
            </>
          ) : (
            <>
              <NumberField
                label="Rate of increase (m/km per km)"
                placeholder="m/km per km"
                value={profile.rateOfIncrease}
                onChange={(rateOfIncrease) => setProfile({ rateOfIncrease })}
              />
              <Help>{RATE_HELP}</Help>
            </>
          )}
        </div>
      )}

      {family === 'polynomial' && (
        <div className="space-y-2">
          <label className="block text-xs text-gray-500">
            Degree
            <select
              value={coefficientCount + 1}
              onChange={(e) => setProfile({ degree: Number(e.target.value) })}
              className="mt-1 w-full"
            >
              {DEGREES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          {/* Only the first `coefficientCount` slots show; the rest keep any
              typed values, so lowering the degree never erases them. */}
          <div className="grid grid-cols-2 gap-2">
            {Array.from({ length: coefficientCount }, (_, i) => {
              const k = i + 2
              const units = `m/km${SUPERSCRIPT[k]}`
              return (
                <NumberField
                  key={k}
                  label={`c${SUBSCRIPT[k]} (${units})`}
                  placeholder={units}
                  value={profile.coefficients[i] ?? ''}
                  onChange={(text) => {
                    const coefficients = [...profile.coefficients]
                    coefficients[i] = text
                    setProfile({ coefficients })
                  }}
                />
              )
            })}
          </div>
          <Help>{POLYNOMIAL_HELP}</Help>
        </div>
      )}

      <div>
        <label className="block text-xs text-gray-500">
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
          value={hinge.distanceKm}
          onChange={(distanceKm) => setHinge({ distanceKm })}
        />
      )}

      <ProfileChart preview={formState.profilePreview} secondGradient={secondGradient} />
    </div>
  )
}
