"""
Unit tests for backend/uplift.py (documentation/UPLIFT_MODEL_SPEC.md D1/D2, as
amended by UPLIFT_MODEL_CORRECTIONS_SPEC.md G1: hinge modes origin | distance |
none, with the zero-gradient point as a guard applied in every mode).
"""
import warnings

import numpy as np
import pytest

from backend.uplift import (
    DEFAULT_HINGE_MODE,
    PlanarUpliftModel,
    PolynomialProfile,
    build_uplift_model,
    linear_planar_model,
)

# Realistic example values for a concave-up profile (a gradient at the spillway
# of 0.35 m/km that increases by 0.006494 m/km per km). Fixtures only -- the
# tool has no such defaults.
G0 = 0.350
K = 64.94e-4
GUARD_KM = -G0 / K  # the gradient's zero behind the spillway, ~ -53.9


def _spec(family, hinge_mode=None, distance_km=None, rate=None, coefficients=None):
    spec = {
        "version": 1,
        "direction": {"type": "azimuth"},
        "profile": {"family": family, "rate_of_increase": rate, "coefficients": coefficients},
    }
    if hinge_mode is not None:
        spec["hinge"] = {"mode": hinge_mode, "distance_km": distance_km}
    return spec


FAMILY_PROFILES = {
    "linear": PolynomialProfile((0.35,)),
    "quadratic": PolynomialProfile((0.35, K / 2)),
    "cubic": PolynomialProfile((0.35, 0.003, -1e-5)),
    "quintic": PolynomialProfile((0.35, 0.003, 1e-5, -2e-8, 3e-11)),
}
CONCAVE_UP = FAMILY_PROFILES["quadratic"]


# --- profile math -------------------------------------------------------------

@pytest.mark.parametrize("name", sorted(FAMILY_PROFILES))
def test_uplift_is_zero_at_origin(name):
    profile = FAMILY_PROFILES[name]
    assert profile.U(0.0) == 0.0
    assert np.all(profile.U(np.zeros((3, 4))) == 0.0)


@pytest.mark.parametrize("name", sorted(FAMILY_PROFILES))
def test_gradient_matches_numerical_derivative(name):
    profile = FAMILY_PROFILES[name]
    d = np.linspace(-80.0, 200.0, 57)
    h = 1e-4
    numeric = (profile.U(d + h) - profile.U(d - h)) / (2 * h)
    np.testing.assert_allclose(profile.g(d), numeric, rtol=1e-6, atol=1e-8)


def test_linear_gradient_broadcasts_to_input_shape():
    g = FAMILY_PROFILES["linear"].g(np.zeros((2, 3)))
    assert g.shape == (2, 3)
    assert np.all(g == 0.35)


def test_quadratic_from_gradient_and_rate_gives_g0_plus_k_d():
    model = build_uplift_model(_spec("quadratic", "origin", rate=K), 28.0, G0)
    assert model.profile.coeffs == (G0, K / 2)
    d = np.linspace(-50, 150, 41)
    np.testing.assert_allclose(model.profile.g(d), G0 + K * d, atol=1e-12)


def test_polynomial_coefficients_follow_tilt_factor():
    model = build_uplift_model(_spec("polynomial", "origin", coefficients=[0.002, -1e-6]), 0.0, 0.5)
    assert model.profile.coeffs == (0.5, 0.002, -1e-6)


# --- hinge modes + guard (G1) -------------------------------------------------

def test_default_hinge_mode_is_origin_for_every_family():
    assert DEFAULT_HINGE_MODE == "origin"
    for spec in (
        _spec("linear"),
        _spec("quadratic", rate=K),
        _spec("polynomial", coefficients=[0.003, -1e-5]),
    ):
        model = build_uplift_model(spec, 0.0, G0)
        assert model.hinge_d == 0.0
        assert model.hinge_source == "mode"


def test_origin_mode_is_zero_and_never_guarded():
    assert CONCAVE_UP.resolve_hinge("origin") == (0.0, "mode")
    # Even a profile whose gradient hits zero behind the spillway: origin wins,
    # because the flat region starts at the spillway, before any zero.
    assert PolynomialProfile((0.35, 0.0, 0.01 / 3)).resolve_hinge("origin") == (0.0, "mode")


def test_distance_mode_before_the_guard_is_used_as_given():
    assert CONCAVE_UP.resolve_hinge("distance", 30.0) == (-30.0, "mode")
    assert CONCAVE_UP.hinge_location("distance", 30.0) == -30.0


def test_distance_mode_beyond_the_guard_clamps_at_the_guard():
    d_h, source = CONCAVE_UP.resolve_hinge("distance", 200.0)
    assert d_h == pytest.approx(GUARD_KM, rel=1e-9)
    assert d_h == pytest.approx(-53.9, abs=0.1)
    assert source == "guard"


def test_none_mode_with_concave_up_profile_clamps_at_the_guard():
    d_h, source = CONCAVE_UP.resolve_hinge("none")
    assert d_h == pytest.approx(GUARD_KM, rel=1e-9)
    assert source == "guard"
    assert CONCAVE_UP.hinge_location("none") == d_h


def test_linear_with_none_is_valid_and_unclamped():
    linear = FAMILY_PROFILES["linear"]
    assert linear.resolve_hinge("none") == (None, None)
    model = build_uplift_model(_spec("linear", "none"), 90.0, 0.35)
    assert model.hinge_d is None and model.hinge_source is None
    # The linear profile continues behind the spillway (negative uplift there).
    assert model.evaluate(np.array([[-40.0]]), np.array([[0.0]]))[0, 0] == pytest.approx(-14.0)


def test_none_mode_without_a_zero_is_unclamped_and_does_not_warn():
    # g(d) = 0.35 + 0.01 d^2 has only imaginary roots.
    profile = PolynomialProfile((0.35, 0.0, 0.01 / 3))
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        assert profile.resolve_hinge("none") == (None, None)
    # Concave-down (zero is up-tilt, not behind): also unclamped, also no warning.
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        assert PolynomialProfile((0.35, -0.003)).resolve_hinge("none") == (None, None)


def test_guard_never_emits_a_warning():
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        CONCAVE_UP.resolve_hinge("none")
        CONCAVE_UP.resolve_hinge("distance", 200.0)


def test_distance_mode_on_linear_is_unguarded():
    assert FAMILY_PROFILES["linear"].resolve_hinge("distance", 30.0) == (-30.0, "mode")


@pytest.mark.parametrize("distance", [None, 0.0, -5.0, float("nan"), float("inf")])
def test_distance_mode_rejects_bad_distance(distance):
    with pytest.raises(ValueError, match="distance_km"):
        FAMILY_PROFILES["linear"].hinge_location("distance", distance)


@pytest.mark.parametrize("mode", ["natural", "midpoint", ""])
def test_unknown_hinge_mode_raises(mode):
    with pytest.raises(ValueError, match="Unknown hinge mode"):
        CONCAVE_UP.hinge_location(mode)


def test_complex_roots_are_ignored_and_the_real_root_is_the_guard():
    # g(d) = (d + 30)(d^2 + 4) = d^3 + 30 d^2 + 4 d + 120: one real root (-30),
    # two imaginary (+-2i). U = 120 d + 2 d^2 + 10 d^3 + d^4/4.
    profile = PolynomialProfile((120.0, 2.0, 10.0, 0.25))
    assert profile.hinge_location("none") == pytest.approx(-30.0, abs=1e-6)


def test_largest_of_several_negative_roots_is_the_guard():
    # g(d) = (d + 10)(d + 40)(d - 5): roots -40, -10, 5 -> the first zero behind
    # the spillway is -10.
    # g = d^3 + 45 d^2 + 150 d - 2000  -> c1=-2000, c2=150/2, c3=45/3, c4=1/4
    profile = PolynomialProfile((-2000.0, 75.0, 15.0, 0.25))
    assert profile.hinge_location("none") == pytest.approx(-10.0, abs=1e-6)
    # A distance hinge between the two roots is beyond the first zero's reach
    # only if it is further back than -10; at 5 km it is used as given.
    assert profile.resolve_hinge("distance", 5.0) == (-5.0, "mode")
    assert profile.resolve_hinge("distance", 20.0) == (pytest.approx(-10.0, abs=1e-6), "guard")


def test_zero_gradient_at_origin_is_not_a_spurious_guard():
    # c1 == 0: g = k d has a root at exactly 0 -- "at" the spillway, not behind it.
    profile = PolynomialProfile((0.0, 0.003))
    assert profile.resolve_hinge("none") == (None, None)


def test_evaluate_holds_uplift_constant_behind_the_guard():
    model = build_uplift_model(_spec("quadratic", "none", rate=K), 90.0, G0)
    hinge = model.hinge_d
    east = np.array([[-200.0, hinge, 0.0, 100.0]])
    u = model.evaluate(east, np.zeros_like(east))
    assert u[0, 0] == pytest.approx(model.profile.U(hinge))
    assert u[0, 1] == pytest.approx(model.profile.U(hinge))
    assert u[0, 2] == 0.0
    assert u[0, 3] == pytest.approx(model.profile.U(100.0))


def test_origin_hinge_is_flat_behind_the_spillway():
    model = build_uplift_model(_spec("quadratic", "origin", rate=K), 90.0, G0)
    east = np.array([[-200.0, -1.0, 0.0]])
    assert np.all(model.evaluate(east, np.zeros_like(east))[0, :2] == 0.0)


def test_gradient_at_distance_is_zero_where_clamped():
    model = build_uplift_model(_spec("quadratic", "none", rate=K), 0.0, G0)
    d = np.array([-100.0, model.hinge_d - 1e-6, 0.0, 50.0])
    g = model.gradient_at_distance(d)
    assert g[0] == 0.0 and g[1] == 0.0
    assert g[2] == pytest.approx(G0)
    assert g[3] == pytest.approx(G0 + K * 50.0)


# --- planar model plumbing ----------------------------------------------------

def test_evaluate_projects_onto_azimuth():
    model = linear_planar_model(0.0, 2.0)  # due north
    assert model.evaluate(np.array([[10.0]]), np.array([[3.0]]))[0, 0] == pytest.approx(6.0)


def test_extra_bytes_per_pixel():
    assert linear_planar_model(0.0, 1.0).extra_bytes_per_pixel == 0
    assert build_uplift_model(_spec("quadratic", "origin", rate=0.01), 0.0, 0.3).extra_bytes_per_pixel == 16
    assert build_uplift_model(
        _spec("polynomial", "origin", coefficients=[0.1, 0.2]), 0.0, 0.3
    ).extra_bytes_per_pixel == 16


def test_linear_planar_model_keeps_input_types():
    model = linear_planar_model(28.0, 0.35)
    assert isinstance(model, PlanarUpliftModel)
    assert model.profile.coeffs == (0.35,)
    assert model.hinge_d == 0.0


def test_forward_sign_change_warns_with_distance():
    # g(d) = 0.35 - 0.006 d changes sign near +58.3 km.
    model = build_uplift_model(_spec("quadratic", "origin", rate=-0.006), 0.0, 0.35)
    with pytest.warns(UserWarning, match=r"changes sign about 5[89]\.\d km"):
        model.warn_for_range(-100.0, 200.0)


def test_forward_sign_change_outside_range_does_not_warn():
    model = build_uplift_model(_spec("quadratic", "origin", rate=-0.006), 0.0, 0.35)
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        model.warn_for_range(-100.0, 40.0)


def test_concave_up_profile_has_no_forward_warning():
    model = build_uplift_model(_spec("quadratic", rate=K), 0.0, G0)
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        model.warn_for_range(-100.0, 500.0)


@pytest.mark.parametrize("azimuth,factor", [(float("nan"), 0.3), (10.0, float("inf"))])
def test_non_finite_inputs_raise(azimuth, factor):
    with pytest.raises(ValueError, match="finite"):
        build_uplift_model(_spec("quadratic", "origin", rate=0.01), azimuth, factor)


def test_unknown_direction_type_raises():
    spec = _spec("linear")
    spec["direction"] = {"type": "vectors"}
    with pytest.raises(ValueError, match="direction"):
        build_uplift_model(spec, 0.0, 0.3)
