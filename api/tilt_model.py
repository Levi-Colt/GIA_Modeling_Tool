"""
`tilt_model` schema and validation for /api/process and /api/profile-preview
(documentation/UPLIFT_MODEL_SPEC.md D4, as amended by
UPLIFT_MODEL_CORRECTIONS_SPEC.md G1/G2).

Pydantic lives here, in the API layer; backend/uplift.py takes the plain dict
that `parse_tilt_model` / `validate_tilt_model` return and has no Pydantic or
FastAPI imports. Every rule below raises TiltModelError with a specific,
user-facing message; the endpoints turn that into a 422 `detail`.

Profile families: `linear` (just the gradient at the spillway, `tilt_factor`),
`quadratic` (a `rate_of_increase` k of that gradient per km) and `polynomial`
(a `formula` of terms `a x^p`, p = 2..5, parsed by api/formula.py into the
coefficients c2..cN the backend uses). The backend only ever sees the canonical
numbers -- k, or the coefficient list -- so the math and run_parameters.json have
one representation; run_parameters.json also keeps the formula as typed.

Direction types: `azimuth` (spec 4), `vectors` (spec 5, VECTOR_FIELD_SPEC.md) and
`points` (spec 6, SHORE_POINT_SURFACE_SPEC.md: a trend surface fitted to shore
points, whose magnitude comes from the data -- so the top-level `profile` and
`hinge` must be absent, and neither tilt_azimuth nor tilt_factor is needed). In
`vectors` mode the vectors only give directions: magnitude always comes from the one
global `profile` (and `tilt_factor`), so the `profile` is required for `azimuth`
and `vectors`. The tilt_azimuth / tilt_factor requirement rules live here too, so
/api/process and the preview endpoints give the same messages.
"""
import json
import math
from typing import Any, Union

from pydantic import BaseModel, ConfigDict, StrictFloat, StrictInt, ValidationError

from api.formula import FormulaError, parse_profile_formula
from backend.uplift import FAMILIES, HINGE_MODES
from backend.uplift_surface import (
    DEFAULT_EXTRAPOLATION, DEFAULT_HINGE_MODE as DEFAULT_SURFACE_HINGE, EXTRAPOLATION_MODES,
    HINGE_MODES as SURFACE_HINGE_MODES, ORDERS as SURFACE_ORDERS, min_points,
)

# Strict: JSON numbers only (no "0.3" strings, no true/false).
Number = Union[StrictInt, StrictFloat]

SUPPORTED_VERSION = 1
SUPPORTED_DIRECTION_TYPES = ("azimuth", "vectors", "points")
MAX_VECTORS = 200
MAX_POINTS = 5000
MAX_POINT_LABEL_LENGTH = 100
MAX_EXTRA_COEFFICIENTS = 4  # c2..c5 (degree 2-5)

NATURAL_REMOVED_MESSAGE = (
    "hinge mode 'natural' was removed; use 'none' (the zero-gradient guard still applies)."
)
NON_FINITE_MESSAGE = "tilt_azimuth and tilt_factor must be finite numbers."
POINTS_PROFILE_HINGE_MESSAGE = (
    "profile and hinge don't apply to shore-point surfaces — magnitude comes from the data."
)


class TiltModelError(ValueError):
    """A tilt_model validation failure; str(e) is the 422 detail."""


class _Strict(BaseModel):
    # Unknown keys are rejected, so a typo never silently becomes a default.
    model_config = ConfigDict(extra="forbid")


# The literal-valued fields are typed Any and checked by hand below, so each
# gets a specific message instead of Pydantic's generic "input should be ...".
class VectorModel(_Strict):
    lat: Number
    lon: Number
    azimuth_deg: Number
    range_km: Number | None = None


class PointModel(_Strict):
    lat: Number
    lon: Number
    elevation_m: Number
    label: Any = None  # optional site name; checked by hand (a string of at most 100 characters)


class Direction(_Strict):
    type: Any
    vectors: list[VectorModel] | None = None
    # `points` mode only (spec 6). order / hinge / extrapolation are checked by hand.
    points: list[PointModel] | None = None
    order: Any = None
    hinge: Any = None
    extrapolation: Any = None


class Profile(_Strict):
    family: Any
    rate_of_increase: Number | None = None
    formula: Any = None  # a string, checked by hand (api/formula.py)


class Hinge(_Strict):
    mode: Any
    distance_km: Number | None = None


class TiltModel(_Strict):
    version: Any
    direction: Direction
    profile: Profile | None = None  # required for `azimuth` and `vectors`; absent for `points`
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


def _validate_vector(i, v: VectorModel) -> dict:
    who = f"Vector {i + 1}: "
    if not _finite(v.lat) or not -90 <= v.lat <= 90:
        raise TiltModelError(f"{who}lat must be between -90 and 90.")
    if not _finite(v.lon) or not -180 <= v.lon <= 180:
        raise TiltModelError(f"{who}lon must be between -180 and 180.")
    if not _finite(v.azimuth_deg) or not 0 <= v.azimuth_deg < 360:
        raise TiltModelError(f"{who}azimuth_deg must be at least 0 and less than 360.")
    if v.range_km is not None and (not _finite(v.range_km) or v.range_km <= 0):
        raise TiltModelError(f"{who}range_km, if given, must be finite and > 0.")

    return {
        "lat": float(v.lat), "lon": float(v.lon), "azimuth_deg": float(v.azimuth_deg),
        "range_km": None if v.range_km is None else float(v.range_km),
    }


def _validate_point(i, p: PointModel) -> dict:
    who = f"Shore point {i + 1}: "
    if not _finite(p.lat) or not -90 <= p.lat <= 90:
        raise TiltModelError(f"{who}lat must be between -90 and 90.")
    if not _finite(p.lon) or not -180 <= p.lon <= 180:
        raise TiltModelError(f"{who}lon must be between -180 and 180.")
    if not _finite(p.elevation_m):
        raise TiltModelError(f"{who}elevation_m must be a finite number.")
    label = p.label
    if label is not None:
        if not isinstance(label, str):
            raise TiltModelError(f"{who}label must be a string.")
        if len(label) > MAX_POINT_LABEL_LENGTH:
            raise TiltModelError(f"{who}label must be at most {MAX_POINT_LABEL_LENGTH} characters.")
    return {"lat": float(p.lat), "lon": float(p.lon), "elevation_m": float(p.elevation_m), "label": label}


def _validate_points_direction(direction: Direction) -> dict:
    """The `direction` object of a `points` model, validated and normalized.
    Duplicate coordinates are allowed (real data has them)."""
    raw = direction.points
    if raw is None:
        raise TiltModelError("tilt_model.direction.points is required when direction.type is 'points'.")
    if not 1 <= len(raw) <= MAX_POINTS:
        raise TiltModelError(f"tilt_model.direction.points must contain 1 to {MAX_POINTS} points.")
    points = [_validate_point(i, p) for i, p in enumerate(raw)]

    order = direction.order
    if type(order) is not int or order not in SURFACE_ORDERS:  # not a bool or a float
        raise TiltModelError(f"tilt_model.direction.order must be one of {list(SURFACE_ORDERS)}.")
    if len(points) < min_points(order):
        raise TiltModelError(
            f"An order-{order} surface needs at least {min_points(order)} shore points "
            f"(got {len(points)}); add points or choose a lower order."
        )
    hinge = DEFAULT_SURFACE_HINGE if direction.hinge is None else direction.hinge
    if hinge not in SURFACE_HINGE_MODES:
        raise TiltModelError(f"tilt_model.direction.hinge must be one of {list(SURFACE_HINGE_MODES)}.")
    extrapolation = DEFAULT_EXTRAPOLATION if direction.extrapolation is None else direction.extrapolation
    if extrapolation not in EXTRAPOLATION_MODES:
        raise TiltModelError(
            f"tilt_model.direction.extrapolation must be one of {list(EXTRAPOLATION_MODES)}."
        )
    return {"type": "points", "points": points, "order": order, "hinge": hinge,
            "extrapolation": extrapolation}


def require_direction_inputs(direction_type, tilt_azimuth, tilt_factor):
    """
    The tilt_azimuth / tilt_factor requirement rules. `direction_type` is None
    for a basic run (no tilt_model). A `vectors` model needs the gradient at the
    spillway (its directions come from the vectors, so no single azimuth); a
    `points` model needs neither field (only non-finite values are rejected).
    Raises TiltModelError naming the condition that applied.
    """
    if direction_type in (None, "azimuth"):
        why = "a single-azimuth model" if direction_type else "a basic run"
        if tilt_azimuth is None:
            raise TiltModelError(f"tilt_azimuth is required for {why}.")
        if tilt_factor is None:
            raise TiltModelError(f"tilt_factor (gradient at the spillway) is required for {why}.")
    elif direction_type == "vectors" and tilt_factor is None:
        raise TiltModelError("tilt_factor (gradient at the spillway) is required for a multi-direction model.")
    for name, value in (("tilt_azimuth", tilt_azimuth), ("tilt_factor", tilt_factor)):
        if value is not None and not math.isfinite(value):
            raise TiltModelError(NON_FINITE_MESSAGE)


def validate_tilt_model(obj: Any, tilt_factor, tilt_azimuth=None) -> dict:
    """
    Validates an already-decoded tilt_model object; returns a plain dict.

    `tilt_factor` (and, for the azimuth direction, `tilt_azimuth`) may be None
    where the requirement rules allow it -- see require_direction_inputs.

    A polynomial profile is returned with its `coefficients` (c2..cN, parsed from
    the `formula`, which is kept as typed); a quadratic with its `rate_of_increase`.
    """
    if not isinstance(obj, dict):
        raise TiltModelError("tilt_model must be a JSON object.")
    try:
        model = TiltModel.model_validate(obj)
    except ValidationError as e:
        raise TiltModelError(_format_validation_error(e)) from None

    if model.version != SUPPORTED_VERSION or isinstance(model.version, bool):
        raise TiltModelError(f"tilt_model.version must be {SUPPORTED_VERSION}.")

    direction_type = model.direction.type
    if direction_type not in SUPPORTED_DIRECTION_TYPES:
        raise TiltModelError(
            f"tilt_model.direction.type must be one of {list(SUPPORTED_DIRECTION_TYPES)}."
        )

    vectors = None
    points_direction = None
    if direction_type != "points":
        stray = [k for k in ("points", "order", "hinge", "extrapolation") if getattr(model.direction, k) is not None]
        if stray:
            raise TiltModelError(
                f"tilt_model.direction.{stray[0]} is only allowed when direction.type is 'points'."
            )
    if direction_type == "points":
        if model.profile is not None or model.hinge is not None:
            raise TiltModelError(POINTS_PROFILE_HINGE_MESSAGE)
        if model.direction.vectors is not None:
            raise TiltModelError("tilt_model.direction.vectors is only allowed when direction.type is 'vectors'.")
        points_direction = _validate_points_direction(model.direction)
    elif direction_type == "vectors":
        raw = model.direction.vectors
        if raw is None:
            raise TiltModelError("tilt_model.direction.vectors is required when direction.type is 'vectors'.")
        if not 1 <= len(raw) <= MAX_VECTORS:
            raise TiltModelError(f"tilt_model.direction.vectors must contain 1 to {MAX_VECTORS} vectors.")
        vectors = [_validate_vector(i, v) for i, v in enumerate(raw)]
    elif model.direction.vectors is not None:
        raise TiltModelError("tilt_model.direction.vectors is only allowed when direction.type is 'vectors'.")

    require_direction_inputs(direction_type, tilt_azimuth, tilt_factor)

    profile_out = None
    if direction_type != "points":
        if model.profile is None:
            raise TiltModelError("tilt_model.profile is required.")
        profile_out = _validate_profile(model.profile)

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

    if points_direction is not None:
        return {"version": model.version, "direction": points_direction, "profile": None, "hinge": None}

    direction_out = {"type": direction_type}
    if vectors is not None:
        direction_out["vectors"] = vectors
    return {
        "version": model.version,
        "direction": direction_out,
        "profile": profile_out,
        "hinge": None if hinge is None else {
            "mode": hinge.mode,
            "distance_km": None if hinge.distance_km is None else float(hinge.distance_km),
        },
    }


def _validate_profile(profile: Profile) -> dict:
    family = profile.family
    if family not in FAMILIES:
        raise TiltModelError(f"tilt_model.profile.family must be one of {list(FAMILIES)}.")

    rate, formula = profile.rate_of_increase, profile.formula
    coeffs = None
    if family == "linear":
        if rate is not None or formula is not None:
            raise TiltModelError("A linear profile takes neither rate_of_increase nor formula.")
    elif family == "quadratic":
        if formula is not None:
            raise TiltModelError("A quadratic profile does not take a formula; use rate_of_increase.")
        if rate is None:
            raise TiltModelError("A quadratic profile requires rate_of_increase.")
        if not _finite(rate):
            raise TiltModelError("A quadratic profile requires a finite rate_of_increase.")
    else:  # polynomial
        if rate is not None:
            raise TiltModelError("A polynomial profile does not take rate_of_increase; use formula.")
        if formula is None:
            raise TiltModelError("A polynomial profile requires a formula.")
        try:
            coeffs = parse_profile_formula(formula)
        except FormulaError as e:
            raise TiltModelError(f"tilt_model.profile.formula: {e}") from None

    return {
        "family": family,
        "rate_of_increase": None if rate is None else float(rate),
        "formula": formula.strip() if family == "polynomial" else None,
        "coefficients": coeffs,
    }


def parse_tilt_model(raw: str, tilt_factor, tilt_azimuth=None) -> dict:
    """Parses and validates the `tilt_model` form field (a JSON string)."""
    try:
        obj = json.loads(raw)
    except (TypeError, ValueError) as e:
        raise TiltModelError(f"tilt_model must be valid JSON: {e}.") from None
    return validate_tilt_model(obj, tilt_factor, tilt_azimuth)
