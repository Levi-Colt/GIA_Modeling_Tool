"""
Regression guard for UPLIFT_MODEL_CORRECTIONS_SPEC.md G3: the tool is
location-agnostic, so user-facing code (labels, help text, placeholders,
warnings, `detail` messages, results text, aria-labels, defaults) must not be
tuned to, or point users toward, one paper or one set of basins.

Scans frontend/src/**/*.{js,jsx} (excluding *.test.*) and api/**/*.py. backend/
is deliberately excluded: its comments may legitimately cite the paper as
background for the model's *form*, and it has no user-facing strings of its own
(they all originate in api/ and frontend/). Test fixtures may use realistic
values; they aren't scanned either.
"""
import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent

# Why this list exists: the paper (and the basins it fits) informed the model's
# form only; it is not a calibration source, and no default, placeholder or help
# text may point users at it. Names match case-insensitively; the numbers are
# the paper's own published values, matched literally.
NAME_TERMS = [
    "Lewis", "Breckenridge", "Teller", "Table 3", "Iroquois", "Algonquin", "Champlain",
    "Agassiz", "Whittlesey", "Warren", "Nipissing", "Duluth", "Washburn",
]
NUMBER_TERMS = ["0.647", "64.94", "6494", "0.350"]

PATTERN = re.compile(
    "|".join([re.escape(t) for t in NAME_TERMS] + [re.escape(t) for t in NUMBER_TERMS]),
    re.IGNORECASE,
)


def _scanned_files():
    frontend = [
        p for ext in ("*.js", "*.jsx") for p in (REPO / "frontend" / "src").rglob(ext)
        if ".test." not in p.name and "node_modules" not in p.parts
    ]
    api = [p for p in (REPO / "api").rglob("*.py") if "__pycache__" not in p.parts]
    return sorted(frontend + api)


def test_scanner_covers_the_user_facing_layers():
    names = {p.name for p in _scanned_files()}
    # Guards against the glob silently matching nothing.
    assert {"TiltModelBody.jsx", "ProfileChart.jsx", "tiltModel.js", "tilt_model.py", "main.py"} <= names
    assert not any(".test." in n for n in names)
    assert not any(p.is_relative_to(REPO / "backend") for p in _scanned_files())


def test_pattern_actually_matches_the_terms():
    for term in NAME_TERMS + NUMBER_TERMS:
        assert PATTERN.search(f"text {term} text")
    assert PATTERN.search("iroquois west")  # case-insensitive names
    assert not PATTERN.search("Enter a number, in m/km per km")


@pytest.mark.parametrize("path", _scanned_files(), ids=lambda p: str(p.relative_to(REPO)))
def test_no_basin_specific_text_in_user_facing_code(path):
    hits = [
        f"{path.relative_to(REPO)}:{n}: {line.strip()[:100]}"
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1)
        if PATTERN.search(line)
    ]
    assert not hits, "basin- or paper-specific text in user-facing code:\n" + "\n".join(hits)
