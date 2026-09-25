"""
`tilt_model` schema and validation for /api/process and /api/profile-preview
(documentation/UPLIFT_MODEL_SPEC.md D4, as amended by
UPLIFT_MODEL_CORRECTIONS_SPEC.md G1/G2).

Pydantic lives here, in the API layer; backend/uplift.py takes the plain dict
that `parse_tilt_model` / `validate_tilt_model` return and has no Pydantic or
FastAPI imports. Every rule below raises TiltModelError with a specific,
user-facing message; the endpoints turn that into a 422 `detail`.

A quadratic profile's curvature may be given as a `rate_of_increase` k, or as a
`second_gradient` (a gradient at a distance up the uplift direction). The
backend stays canonical in k: this layer converts, so the math and
run_parameters.json have one representation. The conversion needs the
gradient at the spillway (`tilt_factor`), so the parse functions take it.

Specs 5 (vectors) and 6 (shore points) add direction types to `direction.type`.
"""
import json
import math
from typing import Any, Union

from pydantic import BaseModel, ConfigDict, StrictFloat, StrictInt, ValidationError

from backend.uplift import FAMILIES, HINGE_MODES

# Strict: JSON numbers only (no "0.3" strings, no true/false).
Number = Union[StrictInt, StrictFloat]

SUPPORTED_VERSION = 1
SUPPORTED_DIRECTION_TYPES = ("azimuth",)
MAX_EXTRA_COEFFICIENTS = 4  # c2..c5 (degree 2-5)

NATURAL_REMOVED_MESSAGE = (
    "hinge mode 'natural' was removed; use 'none' (the zero-gradient guard still applies)."
)
NON_FINITE_MESSAGE = "tilt_azimuth and tilt_factor must be finite numbers."


class TiltModelError(ValueError):
    """A tilt_model validation failure; str(e) is the 422 detail."""


class _Strict(BaseModel):
    # Unknown keys are rejected, so a typo never silently becomes a default.
    model_config = ConfigDict(extra="forbid")


# The literal-valued fields are typed Any and checked by hand below, so each
# gets a specific message instead of Pydantic's generic "input should be ...".
class Direction(_Strict):
    type: Any


class SecondGradient(_Strict):
    gradient_m_per_km: Number
    distance_km: Number


class Profile(_Strict):
    family: Any
    rate_of_increase: Number | None = None
    second_gradient: SecondGradient | None = None
    coefficients: list[Number] | None = None


class Hinge(_Strict):
    mode: Any
    distance_km: Number | None = None


class TiltModel(_Strict):
    version: Any
    direction: Direction
    profile: Profile
    hinge: Hinge | None = None  # absent = 'origin' (the default for every family)


def _finite(value):
    return value is not None and math.isfinite(value)


def _format_validation_error(err: ValidationError) -> str:
    first = err.errors()[0]
    where = ".".join(str(p) for p in first["loc"])
    if first["type"] == "extra_forbidden":
        return f"tilt_model has an unknown key: '{where}'."
    if first["type"] == "missing":
        return f"tilt_model.{where} is required."
    return f"tilt_model.{where}: {first['msg']}."


def _quadratic_rate(profile: Profile, tilt_factor) -> float:
    """The quadratic's canonical rate k, from whichever form was supplied."""
    rate, second = profile.rate_of_increase, profile.second_gradient
    if profile.coefficients is not None:
        raise TiltModelError("A quadratic profile does not take coefficients.")
    if rate is not None and second is not None:
        raise TiltModelError(
            "A quadratic profile takes either rate_of_increase or second_gradient, not both."
        )
    if rate is None and second is None:
        raise TiltModelError("A quadratic profile requires rate_of_increase or second_gradient.")
    if rate is not None:
        if not _finite(rate):
            raise TiltModelError("A quadratic profile requires a finite rate_of_increase.")
        return float(rate)

    if not _finite(second.distance_km) or second.distance_km <= 0:
        raise TiltModelError("second_gradient.distance_km must be finite and > 0.")
    if not _finite(second.gradient_m_per_km):
        raise TiltModelError("second_gradient.gradient_m_per_km must be finite.")
    if not (isinstance(tilt_factor, (int, float)) and math.isfinite(tilt_factor)):
        raise TiltModelError(NON_FINITE_MESSAGE)
    # g(d) = tilt_factor + k d, so g(distance) = gradient  =>  k as below.
    k = (second.gradient_m_per_km - tilt_factor) / second.distance_km
    if not math.isfinite(k):
        raise TiltModelError("second_gradient gives a non-finite rate_of_increase.")
    return float(k)


def validate_tilt_model(obj: Any, tilt_factor) -> dict:
    """
    Validates an already-decoded tilt_model object; returns a plain dict.

    For a quadratic given as a second_gradient, the returned profile carries the
    derived `rate_of_increase` (what the backend uses) alongside the
    `second_gradient` as supplied; for a rate it carries `second_gradient: None`.
    """
    if not isinstance(obj, dict):
        raise TiltModelError("tilt_model must be a JSON object.")
    try:
        model = TiltModel.model_validate(obj)
    except ValidationError as e:
        raise TiltModelError(_format_validation_error(e)) from None

    if model.version != SUPPORTED_VERSION or isinstance(model.version, bool):
        raise TiltModelError(f"tilt_model.version must be {SUPPORTED_VERSION}.")

    if model.direction.type not in SUPPORTED_DIRECTION_TYPES:
        raise TiltModelError(
            f"tilt_model.direction.type must be one of {list(SUPPORTED_DIRECTION_TYPES)}."
        )

    profile = model.profile
    family = profile.family
    if family not in FAMILIES:
        raise TiltModelError(f"tilt_model.profile.family must be one of {list(FAMILIES)}.")

    rate, coeffs, second = profile.rate_of_increase, profile.coefficients, profile.second_gradient
    if family == "linear":
        if rate is not None or coeffs is not None or second is not None:
            raise TiltModelError(
                "A linear profile takes none of rate_of_increase, second_gradient or coefficients."
            )
    elif family == "quadratic":
        rate = _quadratic_rate(profile, tilt_factor)
    else:  # polynomial
        if rate is not None:
            raise TiltModelError("A polynomial profile does not take rate_of_increase.")
        if second is not None:
            raise TiltModelError("A polynomial profile does not take second_gradient.")
        if not coeffs or len(coeffs) > MAX_EXTRA_COEFFICIENTS or not all(_finite(c) for c in coeffs):
            raise TiltModelError(
                f"A polynomial profile requires 1 to {MAX_EXTRA_COEFFICIENTS} finite coefficients "
                f"(c2 to c{MAX_EXTRA_COEFFICIENTS + 1})."
            )

    hinge = model.hinge
    if hinge is not None:
        if hinge.mode == "natural":
            raise TiltModelError(NATURAL_REMOVED_MESSAGE)
        if hinge.mode not in HINGE_MODES:
            raise TiltModelError(f"tilt_model.hinge.mode must be one of {list(HINGE_MODES)}.")
        if hinge.mode == "distance":
            if not _finite(hinge.distance_km) or hinge.distance_km <= 0:
                raise TiltModelError("A 'distance' hinge requires distance_km > 0 and finite.")
        elif hinge.distance_km is not None:
            raise TiltModelError(f"A '{hinge.mode}' hinge does not take distance_km.")

    return {
        "version": model.version,
        "direction": {"type": model.direction.type},
        "profile": {
            "family": family,
            "rate_of_increase": None if rate is None else float(rate),
            "second_gradient": None if second is None else {
                "gradient_m_per_km": float(second.gradient_m_per_km),
                "distance_km": float(second.distance_km),
            },
            "coefficients": None if coeffs is None else [float(c) for c in coeffs],
        },
        "hinge": None if hinge is None else {
            "mode": hinge.mode,
            "distance_km": None if hinge.distance_km is None else float(hinge.distance_km),
        },
    }


def parse_tilt_model(raw: str, tilt_factor) -> dict:
    """Parses and validates the `tilt_model` form field (a JSON string)."""
    try:
        obj = json.loads(raw)
    except (TypeError, ValueError) as e:
        raise TiltModelError(f"tilt_model must be valid JSON: {e}.") from None
    return validate_tilt_model(obj, tilt_factor)
