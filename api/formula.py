"""
The polynomial profile's formula: terms of `a x^p` summed, where x is the signed
distance in km along the uplift direction from the spillway, `a` is a number and
`p` a whole-number exponent from 2 to 5. Example: "2e-4 x^2 - 1.5e-7 x^3".

The linear term is not written here: it is the gradient at the spillway
(`tilt_factor`, c1), entered separately. So the formula supplies c2..c5 of
U(x) = c1 x + c2 x^2 + ... + c5 x^5, in meters, and an exponent of 1 (or no
exponent) is rejected with a message saying so.

Parsing happens in the API layer (backend/uplift.py only ever sees the resulting
coefficient list, like every other profile). frontend/src/utils/formula.js
implements the same grammar for live validation; the two share their test
cases' intent (tests/test_profile_formula.py / formula.test.js) -- keep them
in step.

Accepted spellings: `x^2`, `x**2`, `x²`; an optional `*` between coefficient and
x; `-`/`+`/`−` between terms; scientific notation (`1e-6`); a bare `x^2` means
1 x^2; whitespace anywhere. Repeated exponents are summed.
"""
import math
import re

MIN_EXPONENT = 2
MAX_EXPONENT = 5

_SUPERSCRIPTS = {"²": "^2", "³": "^3", "⁴": "^4", "⁵": "^5"}
_NUMBER = r"(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?"
# sign? number? ('*')? x ('^' exponent)?  -- the exponent is matched loosely so a
# decimal or negative one gets its own message.
_TERM = re.compile(
    rf"\s*(?P<sign>[+-])?\s*(?P<coef>{_NUMBER})?\s*\*?\s*(?P<x>[xX])?\s*(?:\^\s*(?P<exp>-?\d+(?:\.\d+)?))?\s*"
)


class FormulaError(ValueError):
    """A formula that can't be read; str(e) is user-facing."""


def _normalize(text: str) -> str:
    text = text.replace("−", "-").replace("–", "-").replace("×", "*").replace("·", "*")
    for sup, plain in _SUPERSCRIPTS.items():
        text = text.replace(sup, plain)
    return text.replace("**", "^")


def parse_profile_formula(text) -> list[float]:
    """
    The formula's coefficients c2..cN as a dense list (index 0 is c2; exponents
    that don't appear are 0.0). Raises FormulaError with a specific message.
    """
    if not isinstance(text, str) or not text.strip():
        raise FormulaError("Enter a formula, e.g. 2e-4 x^2 - 1.5e-7 x^3.")
    s = _normalize(text).strip()

    by_exponent: dict[int, float] = {}
    pos = 0
    first = True
    while pos < len(s):
        m = _TERM.match(s, pos)
        if m is None or m.end() == pos:
            raise FormulaError(f"Could not read the formula at '{s[pos:pos + 12]}'. Write terms like 2e-4 x^2.")
        sign, coef, x, exp = m.group("sign"), m.group("coef"), m.group("x"), m.group("exp")
        if not first and sign is None:
            raise FormulaError(f"Put + or - between terms (near '{s[pos:pos + 12].strip()}').")
        if x is None:
            if coef is not None and exp is None and (m.end() >= len(s) or s[m.end()] in "+-"):
                raise FormulaError("Constant terms aren't allowed: every term needs x raised to a power, like 2e-4 x^2.")
            raise FormulaError(f"Could not read the formula at '{s[pos:pos + 12].strip()}'. Write terms like 2e-4 x^2.")
        if exp is None:
            raise FormulaError(
                "Every term needs an exponent from 2 to 5 (the linear term is the gradient at the spillway, "
                "entered above)."
            )
        if "." in exp or exp.startswith("-"):
            raise FormulaError(f"Exponents must be whole numbers from {MIN_EXPONENT} to {MAX_EXPONENT}.")
        p = int(exp)
        if not MIN_EXPONENT <= p <= MAX_EXPONENT:
            if p == 1:
                raise FormulaError("The linear term is the gradient at the spillway, entered above; use exponents 2 to 5.")
            raise FormulaError(f"Exponents must be whole numbers from {MIN_EXPONENT} to {MAX_EXPONENT}.")
        value = float(coef) if coef is not None else 1.0
        if not math.isfinite(value):
            raise FormulaError("Coefficients must be finite numbers.")
        if sign == "-":
            value = -value
        by_exponent[p] = by_exponent.get(p, 0.0) + value
        pos = m.end()
        first = False

    if not by_exponent:
        raise FormulaError("Enter a formula, e.g. 2e-4 x^2 - 1.5e-7 x^3.")
    top = max(by_exponent)
    return [by_exponent.get(p, 0.0) for p in range(MIN_EXPONENT, top + 1)]
