"""
API tests for the `tilt_model` form field, `run_parameters.json`, and
POST /api/profile-preview (documentation/UPLIFT_MODEL_SPEC.md D4/D7, as amended
by UPLIFT_MODEL_CORRECTIONS_SPEC.md: hinge modes origin | distance | none, and a
quadratic curvature given as a rate or as a second gradient).

Calls api.main handlers directly (in-process), like the other API tests.
"""
import asyncio
import copy
import io
import json
import zipfile

import pytest
from fastapi import HTTPException
from starlette.background import BackgroundTasks

from api.main import ProfilePreviewRequest, process, profile_preview

# Realistic example values for a concave-up profile -- fixtures only, not defaults.
G0 = 0.350
K = 64.94e-4

VALID = {
    "version": 1,
    "direction": {"type": "azimuth"},
    "profile": {"family": "quadratic", "rate_of_increase": 0.5},
    "hinge": {"mode": "none", "distance_km": None},
}


def _tm(**overrides):
    """A valid tilt_model dict, with dotted-path overrides ('profile.family': 'linear')."""
    obj = copy.deepcopy(VALID)
    for path, value in overrides.items():
        node = obj
        *parents, leaf = path.split(".")
        for p in parents:
            node = node[p]
        node[leaf] = value
    return obj


def _linear(**overrides):
    return _tm(**{"profile": {"family": "linear"}, **overrides})


def _second(gradient, distance):
    return {"gradient_m_per_km": gradient, "distance_km": distance}


def _run(file_path, tilt_model, tilt_factor=20.0, include_dem=False, azimuth=90):
    async def _call():
        background_tasks = BackgroundTasks()
        response = await process(
            background_tasks=background_tasks,
            dem_file=None,
            file_path=file_path,
            origin_mode="decimal_degrees",
            origin_value="44.945N,104.945W",
            origin_epsg=None,
            tilt_azimuth=azimuth,
            tilt_factor=tilt_factor,
            target_elevation=450,
            include_dem=include_dem,
            selection_radius_km=None,
            tilt_model=tilt_model,
        )
        if response.background:
            await response.background()
        return response

    return asyncio.run(_call())


def _run_parameters(response):
    with zipfile.ZipFile(io.BytesIO(response.body)) as zf:
        return json.loads(zf.read("run_parameters.json"))


def _contour(response):
    with zipfile.ZipFile(io.BytesIO(response.body)) as zf:
        return json.loads(zf.read("contour.geojson"))


# --- validation: every rule is a 422 with a specific message ------------------

def _bad_cases():
    no_profile = {k: v for k, v in _tm().items() if k != "profile"}
    return [
        # envelope
        ("not json {", "valid JSON"),
        ("[]", "must be a JSON object"),
        (json.dumps(_tm(version=2)), "version must be 1"),
        (json.dumps(_tm(version=True)), "version must be 1"),
        (json.dumps(_tm(**{"direction.type": "vectors"})), "direction.type must be one of"),
        (json.dumps({**_tm(), "extra": 1}), "unknown key: 'extra'"),
        (json.dumps(_tm(**{"profile.exponent": 2})), "unknown key: 'profile.exponent'"),
        (json.dumps(_tm(**{"hinge.km": 2})), "unknown key: 'hinge.km'"),
        (json.dumps(no_profile), "profile is required"),
        (json.dumps(_tm(**{"profile.family": "cubic"})), "family must be one of"),
        # quadratic: exactly one curvature form
        (
            json.dumps(_tm(**{"profile.rate_of_increase": None})),
            "requires rate_of_increase or second_gradient",
        ),
        (
            json.dumps(_tm(**{"profile.second_gradient": _second(1.0, 100)})),
            "either rate_of_increase or second_gradient, not both",
        ),
        (json.dumps(_tm(**{"profile.coefficients": [0.1]})), "quadratic profile does not take coefficients"),
        (json.dumps(_tm(**{"profile.rate_of_increase": "0.5"})), "profile.rate_of_increase"),
        (
            '{"version":1,"direction":{"type":"azimuth"},'
            '"profile":{"family":"quadratic","rate_of_increase":NaN}}',
            "requires a finite rate_of_increase",
        ),
        # second_gradient
        (
            json.dumps(_tm(**{"profile.rate_of_increase": None, "profile.second_gradient": _second(1.0, 0)})),
            "distance_km must be finite and > 0",
        ),
        (
            json.dumps(_tm(**{"profile.rate_of_increase": None, "profile.second_gradient": _second(1.0, -5)})),
            "distance_km must be finite and > 0",
        ),
        (
            '{"version":1,"direction":{"type":"azimuth"},"profile":{"family":"quadratic",'
            '"second_gradient":{"gradient_m_per_km":Infinity,"distance_km":100}}}',
            "gradient_m_per_km must be finite",
        ),
        (
            '{"version":1,"direction":{"type":"azimuth"},"profile":{"family":"quadratic",'
            '"second_gradient":{"gradient_m_per_km":1.0,"distance_km":NaN}}}',
            "distance_km must be finite and > 0",
        ),
        (
            json.dumps(_tm(**{"profile.rate_of_increase": None,
                              "profile.second_gradient": {"gradient_m_per_km": 1.0}})),
            "second_gradient.distance_km is required",
        ),
        (
            json.dumps(_tm(**{"profile.rate_of_increase": None,
                              "profile.second_gradient": {**_second(1.0, 100), "foo": 1}})),
            "unknown key: 'profile.second_gradient.foo'",
        ),
        # other families
        (json.dumps(_linear(**{"profile": {"family": "linear", "second_gradient": _second(1.0, 100)}})),
         "linear profile takes none of"),
        (json.dumps(_linear(**{"profile": {"family": "linear", "rate_of_increase": 0.1}})),
         "linear profile takes none of"),
        (json.dumps(_linear(**{"profile": {"family": "linear", "coefficients": [0.1]}})),
         "linear profile takes none of"),
        (
            json.dumps(_tm(**{"profile": {"family": "polynomial"}})),
            "requires 1 to 4 finite coefficients",
        ),
        (
            json.dumps(_tm(**{"profile": {"family": "polynomial", "coefficients": [0.1] * 5}})),
            "requires 1 to 4 finite coefficients",
        ),
        (
            json.dumps(_tm(**{"profile": {"family": "polynomial", "coefficients": [0.1], "rate_of_increase": 0.1}})),
            "polynomial profile does not take rate_of_increase",
        ),
        (
            json.dumps(_tm(**{"profile": {"family": "polynomial", "coefficients": [0.1],
                                          "second_gradient": _second(1.0, 100)}})),
            "polynomial profile does not take second_gradient",
        ),
        # hinge
        (json.dumps(_tm(**{"hinge.mode": "natural"})),
         "hinge mode 'natural' was removed; use 'none' (the zero-gradient guard still applies)."),
        (json.dumps(_tm(**{"hinge.mode": "midpoint"})), "hinge.mode must be one of"),
        (json.dumps(_tm(**{"hinge.mode": "default"})), "hinge.mode must be one of"),
        (json.dumps(_tm(**{"hinge.mode": "distance"})), "requires distance_km > 0"),
        (json.dumps(_tm(**{"hinge.mode": "distance", "hinge.distance_km": 0})), "requires distance_km > 0"),
        (json.dumps(_tm(**{"hinge.mode": "distance", "hinge.distance_km": -3})), "requires distance_km > 0"),
        (json.dumps(_tm(**{"hinge.mode": "origin", "hinge.distance_km": 5})), "'origin' hinge does not take distance_km"),
        (json.dumps(_tm(**{"hinge.distance_km": 5})), "'none' hinge does not take distance_km"),
    ]


@pytest.mark.parametrize("raw,message", _bad_cases())
def test_invalid_tilt_model_is_422_with_specific_message(sloped_dem_path, raw, message):
    with pytest.raises(HTTPException) as exc:
        _run(sloped_dem_path, raw)
    assert exc.value.status_code == 422
    assert message in exc.value.detail


def test_empty_string_tilt_model_is_rejected_not_treated_as_absent(sloped_dem_path):
    with pytest.raises(HTTPException) as exc:
        _run(sloped_dem_path, "")
    assert exc.value.status_code == 422


def test_non_finite_tilt_factor_with_tilt_model_is_422(sloped_dem_path):
    with pytest.raises(HTTPException) as exc:
        _run(sloped_dem_path, json.dumps(_tm()), tilt_factor=float("nan"))
    assert exc.value.status_code == 422
    assert "finite" in exc.value.detail


def test_non_finite_tilt_factor_with_second_gradient_is_422(sloped_dem_path):
    model = _tm(**{"profile.rate_of_increase": None, "profile.second_gradient": _second(1.0, 50)})
    with pytest.raises(HTTPException) as exc:
        _run(sloped_dem_path, json.dumps(model), tilt_factor=float("inf"))
    assert exc.value.status_code == 422
    assert "finite" in exc.value.detail


def test_linear_with_no_hinge_mode_is_a_valid_run(sloped_dem_path):
    # linear + none: the profile simply continues behind the spillway.
    response = _run(sloped_dem_path, json.dumps(_linear(**{"hinge.mode": "none"})))
    assert response.status_code == 200
    params = _run_parameters(response)
    assert params["hinge_km"] is None and params["hinge_source"] is None


# --- valid runs + run_parameters.json -------------------------------------------

def test_valid_quadratic_run_returns_200_with_run_parameters(sloped_dem_path):
    response = _run(sloped_dem_path, json.dumps(_tm()))
    assert response.status_code == 200

    params = _run_parameters(response)
    assert params["tilt_model"] == {
        "version": 1,
        "direction": {"type": "azimuth"},
        "profile": {
            "family": "quadratic", "rate_of_increase": 0.5, "second_gradient": None, "coefficients": None,
        },
        "hinge": {"mode": "none", "distance_km": None},
    }
    assert params["tilt_azimuth"] == 90
    assert params["tilt_factor"] == 20.0


def test_run_parameters_record_the_guard_as_the_hinge_source(sloped_dem_path):
    # gradient 20 at the spillway, rate 0.5: g reaches zero 40 km behind it.
    params = _run_parameters(_run(sloped_dem_path, json.dumps(_tm())))
    assert params["hinge_km"] == pytest.approx(-40.0)
    assert params["hinge_source"] == "guard"


def test_run_parameters_record_the_mode_as_the_hinge_source(sloped_dem_path):
    origin = _run_parameters(_run(sloped_dem_path, json.dumps(_tm(**{"hinge.mode": "origin"}))))
    assert (origin["hinge_km"], origin["hinge_source"]) == (0.0, "mode")

    near = _tm(**{"hinge.mode": "distance", "hinge.distance_km": 10})
    params = _run_parameters(_run(sloped_dem_path, json.dumps(near)))
    assert (params["hinge_km"], params["hinge_source"]) == (-10.0, "mode")

    far = _tm(**{"hinge.mode": "distance", "hinge.distance_km": 100})
    params = _run_parameters(_run(sloped_dem_path, json.dumps(far)))
    assert params["hinge_km"] == pytest.approx(-40.0)
    assert params["hinge_source"] == "guard"


def test_second_gradient_is_converted_to_a_rate_and_both_forms_are_recorded(sloped_dem_path):
    # k = (gradient - tilt_factor) / distance = (30 - 20) / 10 = 1.0
    model = _tm(**{"profile.rate_of_increase": None, "profile.second_gradient": _second(30.0, 10.0)})
    params = _run_parameters(_run(sloped_dem_path, json.dumps(model)))
    assert params["tilt_model"]["profile"]["rate_of_increase"] == pytest.approx(1.0)
    assert params["tilt_model"]["profile"]["second_gradient"] == _second(30.0, 10.0)


def test_rate_form_records_no_second_gradient(sloped_dem_path):
    profile = _run_parameters(_run(sloped_dem_path, json.dumps(_tm())))["tilt_model"]["profile"]
    assert profile["rate_of_increase"] == 0.5 and profile["second_gradient"] is None


def test_second_gradient_run_matches_the_equivalent_rate_run(sloped_dem_path):
    # Azimuth 0 (north): the sloped fixture's contour runs north-south, so a
    # north-dependent uplift is what bends it.
    by_rate = _contour(_run(sloped_dem_path, json.dumps(
        _tm(**{"profile.rate_of_increase": 1.0, "hinge.mode": "origin"})), azimuth=0))
    by_second = _contour(_run(sloped_dem_path, json.dumps(
        _tm(**{"profile.rate_of_increase": None, "profile.second_gradient": _second(30.0, 10.0),
               "hinge.mode": "origin"})), azimuth=0))
    assert by_rate["features"] == by_second["features"]


def test_basic_run_records_null_tilt_model_and_hinge(sloped_dem_path):
    params = _run_parameters(_run(sloped_dem_path, None))
    assert params["tilt_model"] is None
    assert params["hinge_km"] is None and params["hinge_source"] is None


def test_run_parameters_contents(sloped_dem_path):
    params = _run_parameters(_run(sloped_dem_path, None, include_dem=True))

    assert params["schema_version"] == 1
    assert "app_commit" in params
    assert params["generated_at"].endswith("+00:00")
    # File name only, never a server path.
    assert params["input_file"] == "sloped_dem.tif"
    assert params["origin"]["lon"] == pytest.approx(-104.945)
    assert params["origin"]["lat"] == pytest.approx(44.945)
    assert params["target_elevation_source"] == "dem"
    assert params["submitted_target_elevation"] == 450
    assert params["effective_target_elevation"] == pytest.approx(500.0, abs=100.0)
    assert params["include_dem"] is True
    assert params["selection_radius_km"] is None
    assert params["reprojected"] == {"was_reprojected": False, "from_crs": None}


def test_tilt_model_changes_the_output_relative_to_basic(sloped_dem_path):
    # Azimuth 0 (north): see test_second_gradient_run_matches_the_equivalent_rate_run.
    def contour(tilt_model):
        return _contour(_run(sloped_dem_path, tilt_model, azimuth=0))

    basic = contour(None)
    linear = contour(json.dumps(_linear(**{"hinge.mode": "origin"})))
    quad = contour(json.dumps(_tm(**{"profile.rate_of_increase": 40.0, "hinge.mode": "origin"})))
    # An explicit linear/origin model is the basic run, geometry for geometry.
    assert linear["features"] == basic["features"]
    assert quad["features"] != basic["features"]


def test_forward_sign_change_warning_reaches_response_header(sloped_dem_path):
    response = _run(sloped_dem_path, json.dumps(_tm(**{
        "profile.rate_of_increase": -40.0, "hinge.mode": "origin",
    })))
    assert "changes sign" in response.headers["X-Processing-Warnings"]


def test_the_guard_is_information_not_a_warning(sloped_dem_path):
    response = _run(sloped_dem_path, json.dumps(_tm()))  # rate 0.5, none: the guard clamps at -40 km
    assert "X-Processing-Warnings" not in response.headers


# --- /api/profile-preview -------------------------------------------------------

def _preview(**overrides):
    body = dict(
        tilt_azimuth=28.0, tilt_factor=G0,
        tilt_model=_tm(**{"profile.rate_of_increase": K}),
        origin=[-104.945, 44.945], bounds_wgs84=[-106.0, 44.0, -103.0, 46.0], samples=121,
    )
    body.update(overrides)
    return asyncio.run(profile_preview(ProfilePreviewRequest(**body)))


def test_preview_happy_path_with_the_guard_setting_the_clamp():
    out = _preview()  # hinge mode 'none' + concave-up: the guard clamps
    n = len(out["d_km"])
    assert n == 121 == len(out["uplift_m"]) == len(out["gradient_m_per_km"])
    dmin, dmax = out["d_range_km"]
    assert out["d_km"][0] == pytest.approx(dmin) and out["d_km"][-1] == pytest.approx(dmax)
    assert dmin < 0 < dmax
    assert out["hinge_km"] == pytest.approx(-G0 / K, rel=1e-9)
    assert out["hinge_source"] == "guard"
    assert out["warnings"] == []  # the guard is information, not a warning

    # U(0) == 0 (the d grid may not hit 0 exactly, so look at the pair around it)
    d, u = out["d_km"], out["uplift_m"]
    i = next(k for k in range(n - 1) if d[k] <= 0 <= d[k + 1])
    assert min(abs(u[i]), abs(u[i + 1])) < 0.1 * max(abs(u[0]), abs(u[-1]))

    # Gradient is zero where clamped and equals g0 + k d elsewhere.
    hinge = out["hinge_km"]
    for dk, gk in zip(d, out["gradient_m_per_km"]):
        if dk < hinge:
            assert gk == 0.0
        else:
            assert gk == pytest.approx(G0 + K * dk, abs=1e-9)


def test_preview_uplift_is_flat_behind_the_hinge():
    out = _preview()
    behind = [u for d, u in zip(out["d_km"], out["uplift_m"]) if d < out["hinge_km"]]
    assert behind, "range should extend behind the hinge for this fixture"
    assert max(behind) - min(behind) == pytest.approx(0.0, abs=1e-9)


def test_preview_origin_hinge_is_the_default_shape():
    out = _preview(tilt_model=_tm(**{"profile.rate_of_increase": K, "hinge.mode": "origin"}))
    assert (out["hinge_km"], out["hinge_source"]) == (0.0, "mode")
    assert all(u == 0.0 for d, u in zip(out["d_km"], out["uplift_m"]) if d < 0)


def test_preview_distance_hinge_reports_mode_or_guard():
    near = _preview(tilt_model=_linear(**{"hinge.mode": "distance", "hinge.distance_km": 30.0}))
    assert (near["hinge_km"], near["hinge_source"]) == (-30.0, "mode")

    far = _preview(tilt_model=_tm(**{"profile.rate_of_increase": K,
                                     "hinge.mode": "distance", "hinge.distance_km": 500.0}))
    assert far["hinge_km"] == pytest.approx(-G0 / K, rel=1e-9)
    assert far["hinge_source"] == "guard"


def test_preview_linear_with_no_hinge_is_unclamped():
    out = _preview(tilt_model=_linear(**{"hinge.mode": "none"}))
    assert out["hinge_km"] is None and out["hinge_source"] is None
    assert out["warnings"] == []
    assert min(out["uplift_m"]) < 0  # the profile continues behind the spillway


def test_preview_nominal_range_fallback_without_origin_or_bounds():
    for missing in (dict(origin=None), dict(bounds_wgs84=None), dict(origin=None, bounds_wgs84=None)):
        out = _preview(**missing)
        assert out["d_range_km"] == [-100.0, 100.0]
        assert any("nominal" in w for w in out["warnings"])


def test_preview_forward_sign_change_is_a_warning():
    out = _preview(tilt_model=_tm(**{"profile.rate_of_increase": -0.006, "hinge.mode": "origin"}),
                   origin=None, bounds_wgs84=None)
    assert any("changes sign" in w for w in out["warnings"])  # g = 0.35 - 0.006 d flips ~58 km


def test_preview_second_gradient_curve_passes_through_the_given_gradient():
    # Gradient 0.7 m/km at 50 km, from 0.35 at the spillway: k = 0.007. The
    # nominal range with 201 samples has a sample at exactly d = 50.
    model = _tm(**{"profile.rate_of_increase": None, "profile.second_gradient": _second(0.7, 50.0),
                   "hinge.mode": "origin"})
    out = _preview(tilt_model=model, origin=None, bounds_wgs84=None, samples=201)
    i = out["d_km"].index(50.0)
    assert out["gradient_m_per_km"][i] == pytest.approx(0.7)
    # And it is the same curve as the equivalent rate.
    by_rate = _preview(tilt_model=_tm(**{"profile.rate_of_increase": 0.007, "hinge.mode": "origin"}),
                       origin=None, bounds_wgs84=None, samples=201)
    assert out["uplift_m"] == pytest.approx(by_rate["uplift_m"])


def test_preview_uses_the_same_validation_messages_as_process():
    with pytest.raises(HTTPException) as exc:
        _preview(tilt_model=_tm(**{"profile.rate_of_increase": None}))
    assert exc.value.status_code == 422
    assert "requires rate_of_increase or second_gradient" in exc.value.detail

    with pytest.raises(HTTPException) as exc:
        _preview(tilt_model=_tm(**{"hinge.mode": "natural"}))
    assert "hinge mode 'natural' was removed" in exc.value.detail


@pytest.mark.parametrize("override", [
    dict(samples=1), dict(samples=5000), dict(origin=[1.0]), dict(origin=[float("nan"), 1.0]),
    dict(bounds_wgs84=[1.0, 2.0, 0.0, 3.0]), dict(bounds_wgs84=[1.0, 2.0, 3.0]),
])
def test_preview_rejects_bad_geometry_inputs(override):
    with pytest.raises(HTTPException) as exc:
        _preview(**override)
    assert exc.value.status_code == 422


def test_preview_rejects_non_finite_result():
    with pytest.raises(HTTPException) as exc:
        _preview(tilt_factor=1e308, tilt_model=_tm(**{"profile.rate_of_increase": 1e308}))
    assert exc.value.status_code == 422
