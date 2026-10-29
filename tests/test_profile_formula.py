"""
The polynomial profile's formula grammar (api/formula.py): terms of `a x^p`,
p = 2..5, x in km. frontend/src/utils/formula.test.js checks the same cases
against the JavaScript copy used for live validation -- keep the two in step.
"""
import pytest

from api.formula import FormulaError, parse_profile_formula


@pytest.mark.parametrize("text,expected", [
    ("2e-4 x^2", [2e-4]),
    ("2e-4 x^2 - 1.5e-7 x^3", [2e-4, -1.5e-7]),
    ("-3e-5*x^3", [0.0, -3e-5]),
    ("x^2", [1.0]),
    ("-x^2 + x^3", [-1.0, 1.0]),
    ("0.5x^2+0.25x^4", [0.5, 0.0, 0.25]),
    ("1e-9 x^5", [0.0, 0.0, 0.0, 1e-9]),
    ("  2 x ^ 2  ", [2.0]),
    ("2 x**2", [2.0]),
    ("2 x\u00b2 + 1 x\u00b3", [2.0, 1.0]),
    ("2 X^2", [2.0]),
    ("2\u00d7x^2 \u2212 1\u00b7x^3", [2.0, -1.0]),
    (".5 x^2", [0.5]),
    ("1 x^2 + 2 x^2", [3.0]),          # repeated exponents are summed
    ("0 x^2", [0.0]),
    ("+2 x^2", [2.0]),
    ("2E-4 x^2", [2e-4]),
])
def test_valid_formulas(text, expected):
    assert parse_profile_formula(text) == pytest.approx(expected)


@pytest.mark.parametrize("text,message", [
    ("", "Enter a formula"),
    ("   ", "Enter a formula"),
    (None, "Enter a formula"),
    (5, "Enter a formula"),
    ("2e-4 x", "Every term needs an exponent"),
    ("2e-4 x^1", "linear term is the gradient at the spillway"),
    ("2e-4 x^0", "Exponents must be whole numbers from 2 to 5"),
    ("2e-4 x^6", "Exponents must be whole numbers from 2 to 5"),
    ("2e-4 x^2.5", "Exponents must be whole numbers from 2 to 5"),
    ("2e-4 x^-2", "Exponents must be whole numbers from 2 to 5"),
    ("2e-4 x^2 + 3", "Constant terms aren't allowed"),
    ("3", "Constant terms aren't allowed"),
    ("2e-4 x^2 3e-5 x^3", "Put + or - between terms"),
    ("2e-4 y^2", "Could not read the formula"),
    ("2e-4 x^", "Every term needs an exponent"),
    ("x^2 +", "Could not read the formula"),
    ("x^2 ++ x^3", "Could not read the formula"),
    ("abc", "Could not read the formula"),
])
def test_invalid_formulas(text, message):
    with pytest.raises(FormulaError) as exc:
        parse_profile_formula(text)
    assert message in str(exc.value)


def test_overflowing_coefficients_are_rejected():
    with pytest.raises(FormulaError) as exc:
        parse_profile_formula("1e999 x^2")
    assert "finite" in str(exc.value)
