// The polynomial profile's formula: terms of `a x^p` summed, where x is the signed
// distance in km along the uplift direction from the spillway, `a` a number and
// `p` a whole-number exponent from 2 to 5. Example: "2e-4 x^2 - 1.5e-7 x^3".
//
// The linear term is not written here: it is the gradient at the spillway, entered
// separately. So the formula supplies c2..c5 of U(x) = c1 x + c2 x^2 + ... + c5 x^5.
//
// This is the live-validation copy of api/formula.py (the server parses
// authoritatively and sends back the same messages): same grammar, same errors.
// Keep tests/test_profile_formula.py and formula.test.js in step.
//
// Accepted spellings: x^2, x**2, x²; an optional * between coefficient and x;
// - / + / − between terms; scientific notation; a bare x^2 means 1 x^2; whitespace
// anywhere. Repeated exponents are summed.

export const MIN_EXPONENT = 2
export const MAX_EXPONENT = 5

const SUPERSCRIPTS = { '²': '^2', '³': '^3', '⁴': '^4', '⁵': '^5' }
const NUMBER = '(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?'
const TERM = new RegExp(
  `\\s*(?<sign>[+-])?\\s*(?<coef>${NUMBER})?\\s*\\*?\\s*(?<x>[xX])?\\s*(?:\\^\\s*(?<exp>-?\\d+(?:\\.\\d+)?))?\\s*`,
  'y'
)

export const FORMULA_EXAMPLE = '2e-4 x^2 - 1.5e-7 x^3'

const normalize = (text) => {
  let out = text.replace(/[−–]/g, '-').replace(/[×·]/g, '*')
  for (const [sup, plain] of Object.entries(SUPERSCRIPTS)) out = out.split(sup).join(plain)
  return out.replace(/\*\*/g, '^')
}

const fail = (error) => ({ ok: false, error, coefficients: null })

// { ok: true, coefficients: [c2, c3, ...] (dense; 0 for an exponent that doesn't
// appear), error: null } or { ok: false, error: <message>, coefficients: null }.
export function parseProfileFormula(text) {
  if (typeof text !== 'string' || text.trim() === '') return fail(`Enter a formula, e.g. ${FORMULA_EXAMPLE}.`)
  const s = normalize(text).trim()

  const byExponent = new Map()
  let pos = 0
  let first = true
  while (pos < s.length) {
    TERM.lastIndex = pos
    const m = TERM.exec(s)
    if (m === null || m[0].length === 0) {
      return fail(`Could not read the formula at '${s.slice(pos, pos + 12)}'. Write terms like 2e-4 x^2.`)
    }
    const { sign, coef, x, exp } = m.groups
    const end = pos + m[0].length
    if (!first && sign === undefined) {
      return fail(`Put + or - between terms (near '${s.slice(pos, pos + 12).trim()}').`)
    }
    if (x === undefined) {
      if (coef !== undefined && exp === undefined && (end >= s.length || '+-'.includes(s[end]))) {
        return fail("Constant terms aren't allowed: every term needs x raised to a power, like 2e-4 x^2.")
      }
      return fail(`Could not read the formula at '${s.slice(pos, pos + 12).trim()}'. Write terms like 2e-4 x^2.`)
    }
    if (exp === undefined) {
      return fail(
        'Every term needs an exponent from 2 to 5 (the linear term is the gradient at the spillway, entered above).'
      )
    }
    if (exp.includes('.') || exp.startsWith('-')) {
      return fail(`Exponents must be whole numbers from ${MIN_EXPONENT} to ${MAX_EXPONENT}.`)
    }
    const p = Number(exp)
    if (p < MIN_EXPONENT || p > MAX_EXPONENT) {
      return fail(
        p === 1
          ? 'The linear term is the gradient at the spillway, entered above; use exponents 2 to 5.'
          : `Exponents must be whole numbers from ${MIN_EXPONENT} to ${MAX_EXPONENT}.`
      )
    }
    let value = coef !== undefined ? Number(coef) : 1
    if (!Number.isFinite(value)) return fail('Coefficients must be finite numbers.')
    if (sign === '-') value = -value
    byExponent.set(p, (byExponent.get(p) ?? 0) + value)
    pos = end
    first = false
  }

  const top = Math.max(...byExponent.keys())
  const coefficients = []
  for (let p = MIN_EXPONENT; p <= top; p++) coefficients.push(byExponent.get(p) ?? 0)
  return { ok: true, coefficients, error: null }
}
