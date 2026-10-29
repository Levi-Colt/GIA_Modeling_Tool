// Same cases as tests/test_profile_formula.py: the JS copy used for live
// validation must agree with the server's parser on what is valid and why not.
import { describe, it, expect } from 'vitest'
import { parseProfileFormula } from './formula.js'

const VALID = [
  ['2e-4 x^2', [2e-4]],
  ['2e-4 x^2 - 1.5e-7 x^3', [2e-4, -1.5e-7]],
  ['-3e-5*x^3', [0, -3e-5]],
  ['x^2', [1]],
  ['-x^2 + x^3', [-1, 1]],
  ['0.5x^2+0.25x^4', [0.5, 0, 0.25]],
  ['1e-9 x^5', [0, 0, 0, 1e-9]],
  ['  2 x ^ 2  ', [2]],
  ['2 x**2', [2]],
  ['2 x² + 1 x³', [2, 1]],
  ['2 X^2', [2]],
  ['2×x^2 − 1·x^3', [2, -1]],
  ['.5 x^2', [0.5]],
  ['1 x^2 + 2 x^2', [3]],
  ['0 x^2', [0]],
  ['+2 x^2', [2]],
  ['2E-4 x^2', [2e-4]]
]

const INVALID = [
  ['', 'Enter a formula'],
  ['   ', 'Enter a formula'],
  [null, 'Enter a formula'],
  [5, 'Enter a formula'],
  ['2e-4 x', 'Every term needs an exponent'],
  ['2e-4 x^1', 'linear term is the gradient at the spillway'],
  ['2e-4 x^0', 'Exponents must be whole numbers from 2 to 5'],
  ['2e-4 x^6', 'Exponents must be whole numbers from 2 to 5'],
  ['2e-4 x^2.5', 'Exponents must be whole numbers from 2 to 5'],
  ['2e-4 x^-2', 'Exponents must be whole numbers from 2 to 5'],
  ['2e-4 x^2 + 3', "Constant terms aren't allowed"],
  ['3', "Constant terms aren't allowed"],
  ['2e-4 x^2 3e-5 x^3', 'Put + or - between terms'],
  ['2e-4 y^2', 'Could not read the formula'],
  ['2e-4 x^', 'Every term needs an exponent'],
  ['x^2 +', 'Could not read the formula'],
  ['x^2 ++ x^3', 'Could not read the formula'],
  ['abc', 'Could not read the formula'],
  ['1e999 x^2', 'finite']
]

describe('parseProfileFormula', () => {
  it.each(VALID)('reads %s', (text, expected) => {
    const r = parseProfileFormula(text)
    expect(r.ok).toBe(true)
    expect(r.error).toBeNull()
    expect(r.coefficients).toHaveLength(expected.length)
    r.coefficients.forEach((c, i) => expect(c).toBeCloseTo(expected[i], 15))
  })

  it.each(INVALID)('rejects %j', (text, message) => {
    const r = parseProfileFormula(text)
    expect(r.ok).toBe(false)
    expect(r.coefficients).toBeNull()
    expect(r.error).toContain(message)
  })
})
