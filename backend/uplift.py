"""
Pluggable uplift models for the tilt pipeline (documentation/UPLIFT_MODEL_SPEC.md).

The tilted DEM is `DEM - U`, where `U` is the uplift (meters) *relative to the
origin*, evaluated per pixel from the pixel's local (east_km, north_km) offset
from the origin. `U(origin) == 0` always holds, which keeps the
DEM-authoritative target-elevation logic valid.

This module is pure numpy: no FastAPI/Pydantic (those stay in `api/`) and no
import of `backend.main` (which imports this module). `build_uplift_model`
takes an already-validated plain dict from the API layer.

Uplift-model interface (duck typed):
    extra_bytes_per_pixel: int   -- added to the tilt memory estimate
    evaluate(east_km, north_km)  -- broadcastable arrays -> U in meters, float64
Optional:
    signed_distance_km(east_km, north_km) -- planar models only; the signed
        distance along the azimuth used by `evaluate` (before clamping).
    warn_for_range(d_min_km, d_max_km)    -- emit UserWarnings that depend on
        the DEM's extent (which a model cannot know when it is built).
"""
import warnings
from dataclasses import dataclass

import numpy as np

# Imaginary-part tolerance for treating a polynomial root as real, and the
# distance from zero within which a root counts as "at the origin", not behind it
# (numpy.roots can return -1e-17 for a mathematically-zero root).
_IMAG_TOL = 1e-9
_ZERO_TOL = 1e-12

FAMILIES = ("linear", "quadratic", "polynomial")
# Hinge modes (documentation/UPLIFT_MODEL_CORRECTIONS_SPEC.md G1): 'origin' = no
# change behind the spillway (the default for every family), 'distance' = uplift
# stops changing that far behind it, 'none' = the profile continues behind the
# spillway to the DEM edge. The zero-gradient point is NOT a hinge mode; it is a
# guard applied in every mode (see PolynomialProfile.resolve_hinge).
HINGE_MODES = ("origin", "distance", "none")
DEFAULT_HINGE_MODE = "origin"


@dataclass(frozen=True)
class PolynomialProfile:
    """U(d) = sum_k c_k * d**k for k = 1..n, no constant term (so U(0) == 0).

    coeffs = (c1, ..., cn), n >= 1. c1 is always the gradient at the origin
    (m/km), i.e. the API's `tilt_factor`.
    """
    coeffs: tuple

    def U(self, d):
        c = self.coeffs
        if len(c) == 1:
            # A literal multiply (not a Horner loop starting from 0.0 + ...) so
            # the single-term case is obviously identical to the legacy
            # `projected_distance_km * tilt_factor` -- bit-for-bit.
            return d * c[0]
        # Horner on U(d) = d * (c1 + d * (c2 + d * (...))).
        acc = c[-1]
        for coef in reversed(c[:-1]):
            acc = acc * d + coef
        return acc * d

    def g(self, d):
        """Local gradient U'(d) = sum_k k * c_k * d**(k-1)."""
        c = self.coeffs
        acc = len(c) * c[-1]
        for k in range(len(c) - 1, 0, -1):
            acc = acc * d + k * c[k - 1]
        # `+ 0.0 * d` broadcasts a linear profile's constant gradient to d's shape.
        return acc + 0.0 * d

    def _zero_behind_spillway(self, lower=-np.inf):
        """The largest real root of g in (lower, 0), or None (numpy.roots, once)."""
        # g's coefficients highest-degree first, as numpy.roots wants them.
        g_coeffs = [k * c for k, c in enumerate(self.coeffs, start=1)][::-1]
        roots = np.roots(g_coeffs) if any(v != 0.0 for v in g_coeffs) else np.array([])
        real = [
            r.real for r in roots
            if abs(r.imag) < _IMAG_TOL and lower < r.real < -_ZERO_TOL
        ]
        return max(real) if real else None

    def resolve_hinge(self, mode, distance_km=None):
        """
        (d_h, source): where (d_h <= 0, km) uplift stops changing behind the
        spillway, and what set it. Evaluation is U(max(d, d_h)); d_h None means
        unclamped.

        The mode gives a point: 'origin' -> 0, 'distance' -> -distance_km,
        'none' -> nowhere (None). The monotonicity guard is then applied in
        EVERY mode: if g reaches zero behind the spillway *before* that point
        (the largest real root of g in (point, 0)), uplift is held constant from
        that zero instead -- uplift must never start increasing again as you
        move away behind the spillway (the unphysical turn-around of a
        concave-up quadratic past its vertex). source is 'mode' when the mode's
        own point sets the clamp, 'guard' when the guard does, None if unclamped.
        """
        if mode == "origin":
            return 0.0, "mode"  # the guard's interval (0, 0) is empty
        if mode == "distance":
            if distance_km is None or not np.isfinite(distance_km) or distance_km <= 0:
                raise ValueError("A 'distance' hinge requires distance_km > 0 and finite.")
            d_h = -float(distance_km)
            zero = self._zero_behind_spillway(lower=d_h)
            return (d_h, "mode") if zero is None else (zero, "guard")
        if mode == "none":
            zero = self._zero_behind_spillway()
            return (None, None) if zero is None else (zero, "guard")
        raise ValueError(f"Unknown hinge mode '{mode}'. Expected one of {HINGE_MODES}.")

    def hinge_location(self, mode, distance_km=None):
        """d_h from resolve_hinge (None = unclamped)."""
        return self.resolve_hinge(mode, distance_km)[0]


@dataclass(frozen=True)
class PlanarUpliftModel:
    """Uplift as a polynomial profile of signed distance along one azimuth."""
    azimuth_deg: float
    profile: PolynomialProfile
    hinge_d: float | None  # resolved once at build time; None = unclamped
    hinge_source: str | None = None  # 'mode' | 'guard' | None (see resolve_hinge)

    @property
    def extra_bytes_per_pixel(self):
        # Horner evaluation of a degree>=2 polynomial holds ~2 float64
        # temporaries beyond today's pipeline (2 x 8B). Estimated, not profiled
        # -- see the TILT_BYTES_PER_PIXEL notes in backend/app.py.
        return 0 if len(self.profile.coeffs) == 1 else 16

    def signed_distance_km(self, east_km, north_km):
        # Projection of the (east_km, north_km) vector onto the tilt azimuth's
        # own unit vector -- equivalent to distance * cos(bearing_to_pixel -
        # tilt_azimuth) without needing bearing or distance separately. Same
        # expression, same operand order as the pre-refactor _tilt_block.
        rad = np.radians(self.azimuth_deg)
        return east_km * np.sin(rad) + north_km * np.cos(rad)

    def _clamp(self, d):
        if self.hinge_d is not None:
            # Behind the hinge, uplift is held at its value there. For
            # hinge_d == 0.0 this is exactly the legacy "south cells get no
            # change" clamp.
            d = np.where(d < self.hinge_d, self.hinge_d, d)
        return d

    def uplift_at_distance(self, d_km):
        """U(max(d, d_h)) for signed distances along the azimuth (km)."""
        return self.profile.U(self._clamp(d_km))

    def gradient_at_distance(self, d_km):
        """Local gradient g(d) with the hinge applied: zero where clamped."""
        d = np.asarray(d_km, dtype='float64')
        g = self.profile.g(d)
        if self.hinge_d is not None:
            g = np.where(d < self.hinge_d, 0.0, g)
        return g

    def evaluate(self, east_km, north_km):
        return self.uplift_at_distance(self.signed_distance_km(east_km, north_km))

    def warn_for_range(self, d_min_km, d_max_km):
        """
        UserWarning if the gradient changes sign in the forward direction
        (0 < d <= d_max_km) -- a concave-down profile. Unusual but not wrong,
        so it is a warning, not a guard (no forward clamping).
        """
        if not (np.isfinite(d_max_km) and d_max_km > 0):
            return
        d = np.linspace(0.0, d_max_km, 2001)[1:]
        g = self.profile.g(d)
        if g[0] == 0.0:
            return
        flips = np.nonzero(np.sign(g) != np.sign(g[0]))[0]
        if flips.size:
            d_flip = float(d[flips[0]])
            warnings.warn(
                f"The profile's gradient changes sign about {d_flip:.1f} km up-tilt of the "
                "origin (a concave-down profile); the profile is applied as given.",
                UserWarning,
            )


def _profile_from_spec(profile_spec, tilt_factor):
    family = profile_spec.get("family")
    if family == "linear":
        return PolynomialProfile((float(tilt_factor),))
    if family == "quadratic":
        rate = profile_spec.get("rate_of_increase")
        if rate is None:
            raise ValueError("A quadratic profile requires rate_of_increase.")
        # g(d) = c1 + 2*c2*d and the paper's rate is dg/dd, so c2 = k / 2.
        return PolynomialProfile((float(tilt_factor), float(rate) / 2.0))
    if family == "polynomial":
        extra = profile_spec.get("coefficients")
        if not extra:
            raise ValueError("A polynomial profile requires coefficients.")
        return PolynomialProfile((float(tilt_factor), *(float(v) for v in extra)))
    raise ValueError(f"Unknown profile family '{family}'. Expected one of {FAMILIES}.")


def build_uplift_model(spec, tilt_azimuth, tilt_factor):
    """
    Builds an uplift model from the API layer's already-validated `tilt_model`
    dict (see api/tilt_model.py). `tilt_factor` is always c1, the gradient at
    the origin; `tilt_azimuth` is the planar direction.

    Resolves the hinge once, here, so per-block work is purely elementwise and
    windowed and in-memory runs agree.
    UserWarning; raises ValueError for combinations that cannot be built
    (non-finite inputs, an unknown hinge mode, a bad hinge distance).
    """
    if not (np.isfinite(tilt_azimuth) and np.isfinite(tilt_factor)):
        raise ValueError("tilt_azimuth and tilt_factor must be finite numbers.")

    direction = (spec.get("direction") or {}).get("type", "azimuth")
    if direction != "azimuth":
        raise ValueError(f"Unsupported direction type '{direction}'.")

    profile = _profile_from_spec(spec["profile"], tilt_factor)

    hinge = spec.get("hinge") or {}
    # A caller that supplies a profile without a hinge gets 'origin', whatever
    # the family (the API always sends an explicit mode).
    mode = hinge.get("mode") or DEFAULT_HINGE_MODE
    hinge_d, hinge_source = profile.resolve_hinge(mode, hinge.get("distance_km"))

    return PlanarUpliftModel(
        azimuth_deg=float(tilt_azimuth), profile=profile, hinge_d=hinge_d, hinge_source=hinge_source,
    )


def linear_planar_model(tilt_azimuth, tilt_factor):
    """Basic mode's model: linear profile, hinge at the origin. Bit-identical to
    the pre-refactor tilt arithmetic."""
    return PlanarUpliftModel(
        azimuth_deg=tilt_azimuth,
        profile=PolynomialProfile((tilt_factor,)),
        hinge_d=0.0,
        hinge_source="mode",
    )
