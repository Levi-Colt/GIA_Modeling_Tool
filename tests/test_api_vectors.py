"""
API tests for `direction.type == "vectors"` (documentation/VECTOR_FIELD_SPEC.md,
spec 5): vector validation, the relaxed tilt_azimuth / tilt_factor rules, the
diagnostics header and run_parameters, and POST /api/uplift-preview.

Calls api.main handlers directly (in-process), like the other API tests. The
sloped fixture spans lon [-105.0, -104.9], lat [44.9, 45.0]; the run's origin
(44.945N, 104.945W) is inside it.
"""
import asyncio
import io
import json
import zipfile

import pytest
from fastapi import HTTPException
from starlette.background import BackgroundTasks

from api.main import (
    ProfilePreviewRequest, UpliftPreviewRequest, process, profile_preview, uplift_preview,
)


def _vec(lat=44.93, lon=-104.96, az=28.0, range_km=None, custom=None):
    return {"lat": lat, "lon": lon, "azimuth_deg": az, "range_km": range_km, "custom": custom}


def _vtm(vectors=None, profile="default", hinge=None):
    """A valid vectors tilt_model (global linear profile, origin hinge unless overridden)."""
    obj = {
        "version": 1,
        "direction": {"type": "vectors", "vectors": [_vec()] if vectors is None else vectors},
        "hinge": hinge or {"mode": "origin", "distance_km": None},
    }
    if profile == "default":
        obj["profile"] = {"family": "linear"}
    elif profile is not None:
        obj["profile"] = profile
    return obj


def _azimuth_model(**profile):
    return {
        "version": 1, "direction": {"type": "azimuth"},
        "profile": profile or {"family": "linear"},
        "hinge": {"mode": "origin", "distance_km": None},
    }


def _second(gradient, distance):
    return {"gradient_m_per_km": gradient, "distance_km": distance}


def _custom_linear(g=0.4):
    return {"family": "linear", "local_gradient": g}


def _custom_quad(g=0.4, **form):
    return {"family": "quadratic", "local_gradient": g, **form}


def _run(file_path, tilt_model, tilt_factor=0.4, tilt_azimuth=None):
    """tilt_model: a dict, a raw string, or None (a basic run)."""
    raw = tilt_model if tilt_model is None or isinstance(tilt_model, str) else json.dumps(tilt_model)

    async def _call():
        background_tasks = BackgroundTasks()
        response = await process(
            background_tasks=background_tasks, dem_file=None, file_path=file_path,
            origin_mode="decimal_degrees", origin_value="44.945N,104.945W", origin_epsg=None,
            tilt_azimuth=tilt_azimuth, tilt_factor=tilt_factor, target_elevation=450,
            include_dem=False, selection_radius_km=None, tilt_model=raw,
        )
        if response.background:
            await response.background()
        return response

    return asyncio.run(_call())


def _zip_json(response, name):
    with zipfile.ZipFile(io.BytesIO(response.body)) as zf:
        return json.loads(zf.read(name))


def _params(response):
    return _zip_json(response, "run_parameters.json")


def _contour(response):
    return _zip_json(response, "contour.geojson")


# --- vector validation: every rule is a 422 with a specific message ----------------

def _bad_cases():
    many = [_vec(lat=44.9 + i * 1e-4) for i in range(201)]
    no_vectors = _vtm()
    del no_vectors["direction"]["vectors"]
    azimuth_with_vectors = _azimuth_model()
    azimuth_with_vectors["direction"]["vectors"] = [_vec()]
    return [
        (_vtm(vectors=[]), "must contain 1 to 200 vectors"),
        (_vtm(vectors=many), "must contain 1 to 200 vectors"),
        (no_vectors, "direction.vectors is required"),
        (azimuth_with_vectors, "only allowed when direction.type is 'vectors'"),
        (_vtm(vectors=[_vec(lat=91)]), "Vector 1: lat must be between -90 and 90"),
        (_vtm(vectors=[_vec(), _vec(lon=-181)]), "Vector 2: lon must be between -180 and 180"),
        (_vtm(vectors=[_vec(az=360)]), "Vector 1: azimuth_deg must be at least 0 and less than 360"),
        (_vtm(vectors=[_vec(az=-1)]), "azimuth_deg must be at least 0 and less than 360"),
        (_vtm(vectors=[_vec(range_km=0)]), "range_km, if given, must be finite and > 0"),
        (_vtm(vectors=[_vec(range_km=-5)]), "range_km, if given, must be finite and > 0"),
        (_vtm(vectors=[{**_vec(), "extra": 1}]), "unknown key: 'direction.vectors.0.extra'"),
        (_vtm(vectors=[{**_vec(), "lat": "44.9"}]), "direction.vectors.0.lat"),
        # custom tilts
        (_vtm(vectors=[_vec(custom={"family": "cubic", "local_gradient": 0.4})]),
         "Vector 1: custom.family must be one of ['linear', 'quadratic']"),
        (_vtm(vectors=[_vec(custom={"family": "polynomial", "local_gradient": 0.4})]),
         "custom.family must be one of"),
        (_vtm(vectors=[_vec(custom={"family": "linear"})]), "local_gradient is required"),
        (_vtm(vectors=[_vec(custom={"family": "linear", "local_gradient": 0.4, "rate_of_increase": 0.1})]),
         "linear custom tilt takes neither rate_of_increase nor second_gradient"),
        (_vtm(vectors=[_vec(custom={"family": "linear", "local_gradient": 0.4,
                                    "second_gradient": _second(1.0, 10)})]),
         "linear custom tilt takes neither"),
        (_vtm(vectors=[_vec(custom=_custom_quad())]),
         "Vector 1: a quadratic custom tilt requires rate_of_increase or second_gradient"),
        (_vtm(vectors=[_vec(custom=_custom_quad(rate_of_increase=0.1, second_gradient=_second(1.0, 10)))]),
         "takes either rate_of_increase or second_gradient, not both"),
        (_vtm(vectors=[_vec(custom=_custom_quad(second_gradient=_second(1.0, 0)))]),
         "second_gradient.distance_km must be finite and > 0"),
        (_vtm(vectors=[_vec(custom=_custom_quad(second_gradient=_second(1.0, -3)))]),
         "second_gradient.distance_km must be finite and > 0"),
        # global profile / hinge rules still apply
        (_vtm(profile={"family": "quadratic"}), "requires rate_of_increase or second_gradient"),
        (_vtm(hinge={"mode": "natural"}), "hinge mode 'natural' was removed"),
    ]


@pytest.mark.parametrize("model,message", _bad_cases())
def test_invalid_vector_models_are_422_with_specific_messages(sloped_dem_path, model, message):
    with pytest.raises(HTTPException) as exc:
        _run(sloped_dem_path, model)
    assert exc.value.status_code == 422
    assert message in exc.value.detail


def test_non_finite_vector_numbers_are_422(sloped_dem_path):
    raw = json.dumps(_vtm()).replace('"lat": 44.93', '"lat": NaN')
    with pytest.raises(HTTPException) as exc:
        _run(sloped_dem_path, raw)
    assert exc.value.status_code == 422
    assert "lat" in exc.value.detail


# --- runs, diagnostics ---------------------------------------------------------------

def test_vectors_run_needs_no_tilt_azimuth_and_reports_diagnostics(sloped_dem_path):
    response = _run(sloped_dem_path, _vtm())
    assert response.status_code == 200

    header = json.loads(response.headers["X-Tilt-Model-Diagnostics"])
    assert set(header) == {"misfit_rms_deg", "misfit_max_deg", "worst_vector"}
    assert header["worst_vector"] == 0 and header["misfit_max_deg"] < 5

    params = _params(response)
    assert params["tilt_azimuth"] is None
    assert params["tilt_model"]["direction"]["type"] == "vectors"
    d = params["diagnostics"]
    assert d["case"] == "A" and len(d["misfit_deg"]) == 1
    assert d["misfit_max_deg"] == pytest.approx(header["misfit_max_deg"])
    assert "phi_grid" not in d
    assert (params["hinge_km"], params["hinge_source"]) == (0.0, "mode")
    assert len(_contour(response)["features"]) > 0


def test_azimuth_and_basic_runs_have_no_diagnostics(sloped_dem_path):
    with_model = _run(sloped_dem_path, _azimuth_model(), tilt_factor=20.0, tilt_azimuth=90.0)
    assert "X-Tilt-Model-Diagnostics" not in with_model.headers
    assert _params(with_model)["diagnostics"] is None
    assert _params(_run(sloped_dem_path, None, tilt_factor=20.0, tilt_azimuth=90.0))["diagnostics"] is None


def test_one_global_vector_matches_the_azimuth_run(sloped_dem_path):
    """A single vector at the origin with the global linear profile is the planar model."""
    azimuth = _contour(_run(sloped_dem_path, _azimuth_model(), tilt_factor=20.0, tilt_azimuth=45.0))
    vectors = _contour(_run(sloped_dem_path, _vtm(vectors=[_vec(lat=44.945, lon=-104.945, az=45.0)]),
                            tilt_factor=20.0))
    a = azimuth["features"][0]["geometry"]["coordinates"]
    v = vectors["features"][0]["geometry"]["coordinates"]
    assert len(a) == len(v)
    assert max(abs(x - y) for pa, pv in zip(a, v) for x, y in zip(pa, pv)) < 1e-5


def test_vector_warnings_reach_the_response_header(sloped_dem_path):
    far = _vtm(vectors=[_vec(), _vec(lat=50.0, lon=-95.0)])
    assert "Vector 2 lies far outside the DEM" in _run(sloped_dem_path, far).headers["X-Processing-Warnings"]


# --- relaxed tilt_azimuth / tilt_factor ---------------------------------------------

def test_tilt_azimuth_is_required_for_an_azimuth_model(sloped_dem_path):
    with pytest.raises(HTTPException) as exc:
        _run(sloped_dem_path, _azimuth_model(), tilt_factor=20.0, tilt_azimuth=None)
    assert exc.value.status_code == 422
    assert "tilt_azimuth is required for a single-azimuth model" in exc.value.detail


def test_tilt_azimuth_and_factor_are_required_for_a_basic_run(sloped_dem_path):
    with pytest.raises(HTTPException) as exc:
        _run(sloped_dem_path, None, tilt_factor=20.0, tilt_azimuth=None)
    assert "tilt_azimuth is required for a basic run" in exc.value.detail
    with pytest.raises(HTTPException) as exc:
        _run(sloped_dem_path, None, tilt_factor=None, tilt_azimuth=90.0)
    assert "tilt_factor (gradient at the spillway) is required for a basic run" in exc.value.detail


def test_tilt_factor_is_required_when_a_vector_uses_the_global_profile(sloped_dem_path):
    model = _vtm(vectors=[_vec(custom=_custom_linear()), _vec(lon=-104.92), _vec(lon=-104.91)])
    with pytest.raises(HTTPException) as exc:
        _run(sloped_dem_path, model, tilt_factor=None)
    assert exc.value.status_code == 422
    assert exc.value.detail == (
        "tilt_factor (global gradient at the spillway) is required because vector 2 uses the global profile."
    )


def test_tilt_factor_and_profile_are_optional_when_every_vector_is_custom(sloped_dem_path):
    model = _vtm(vectors=[_vec(custom=_custom_linear(0.4)), _vec(lon=-104.92, custom=_custom_linear(0.6))],
                 profile=None)
    response = _run(sloped_dem_path, model, tilt_factor=None)
    assert response.status_code == 200
    params = _params(response)
    assert params["tilt_factor"] is None
    assert params["tilt_model"]["profile"] is None
    assert params["diagnostics"]["case"] == "B"


def test_profile_is_required_when_a_vector_uses_it(sloped_dem_path):
    model = _vtm(vectors=[_vec(custom=_custom_linear()), _vec(lon=-104.92)], profile=None)
    with pytest.raises(HTTPException) as exc:
        _run(sloped_dem_path, model)
    assert "tilt_model.profile is required because vector 2 uses the global profile" in exc.value.detail


def test_an_unused_profile_is_ignored_when_every_vector_is_custom(sloped_dem_path):
    # A second-gradient quadratic needs c1 (tilt_factor) to convert; unused, so not needed.
    model = _vtm(vectors=[_vec(custom=_custom_linear())],
                 profile={"family": "quadratic", "second_gradient": _second(1.0, 30.0)})
    response = _run(sloped_dem_path, model, tilt_factor=None)
    assert _params(response)["tilt_model"]["profile"] is None


def test_non_finite_tilt_factor_with_a_vectors_model_is_422(sloped_dem_path):
    with pytest.raises(HTTPException) as exc:
        _run(sloped_dem_path, _vtm(), tilt_factor=float("nan"))
    assert "finite" in exc.value.detail


def test_custom_second_gradient_is_relative_to_the_vector_and_recorded(sloped_dem_path):
    # k = (gradient - local_gradient) / distance = (1.0 - 0.4) / 30 = 0.02
    model = _vtm(vectors=[_vec(custom=_custom_quad(0.4, second_gradient=_second(1.0, 30.0)))], profile=None)
    custom = _params(_run(sloped_dem_path, model, tilt_factor=None))["tilt_model"]["direction"]["vectors"][0]["custom"]
    assert custom["rate_of_increase"] == pytest.approx(0.02)
    assert custom["second_gradient"] == _second(1.0, 30.0)

    by_rate = _vtm(vectors=[_vec(custom=_custom_quad(0.4, rate_of_increase=0.02))], profile=None)
    custom = _params(_run(sloped_dem_path, by_rate, tilt_factor=None))["tilt_model"]["direction"]["vectors"][0]["custom"]
    assert custom["rate_of_increase"] == 0.02 and custom["second_gradient"] is None


# --- /api/uplift-preview --------------------------------------------------------------

def _uplift(**overrides):
    body = dict(
        tilt_azimuth=None, tilt_factor=0.4,
        tilt_model=_vtm(vectors=[_vec(lat=44.92, lon=-104.97, az=5.0), _vec(lat=44.92, lon=-104.93, az=30.0)]),
        origin=[-104.945, 44.945], bounds_wgs84=[-105.0, 44.9, -104.9, 45.0],
    )
    body.update(overrides)
    return asyncio.run(uplift_preview(UpliftPreviewRequest(**body)))


def test_uplift_preview_returns_isobases_and_per_vector_misfit():
    out = _uplift()
    fc = out["isobases"]
    assert fc["type"] == "FeatureCollection" and fc["features"]
    assert all(f["geometry"]["type"] == "LineString" and "uplift_m" in f["properties"] for f in fc["features"])
    assert 0.0 in {f["properties"]["uplift_m"] for f in fc["features"]}
    assert out["interval_m"] > 0
    assert [v["index"] for v in out["vectors"]] == [0, 1]
    assert all(v["misfit_deg"] is not None for v in out["vectors"])
    assert out["misfit_max_deg"] >= out["misfit_rms_deg"] >= 0
    assert out["worst_vector"] in (0, 1)
    assert out["hinge_source"] == "mode" and out["hinge_km"] == 0.0
    assert out["warnings"] == []


def test_uplift_preview_reports_warnings_and_unmeasurable_vectors():
    out = _uplift(tilt_model=_vtm(vectors=[_vec(), _vec(lat=50.0, lon=-95.0)]))
    assert any("far outside the DEM" in w for w in out["warnings"])
    assert out["vectors"][1]["misfit_deg"] is None


def test_uplift_preview_needs_no_tilt_azimuth_and_supports_custom_tilts():
    model = _vtm(vectors=[_vec(custom=_custom_linear(0.4)), _vec(lon=-104.92, custom=_custom_linear(0.9))],
                 profile=None)
    out = _uplift(tilt_factor=None, tilt_model=model)
    assert out["isobases"]["features"]


@pytest.mark.parametrize("override,message", [
    (dict(tilt_model=_azimuth_model(), tilt_azimuth=90.0), "use /api/profile-preview"),
    (dict(tilt_factor=None), "tilt_factor (global gradient at the spillway) is required because vector 1"),
    (dict(tilt_model=_vtm(vectors=[_vec(lat=95)])), "Vector 1: lat"),
    (dict(origin=[1.0]), "origin must be"),
    (dict(bounds_wgs84=[1.0, 2.0, 0.0, 3.0]), "bounds_wgs84 must be"),
])
def test_uplift_preview_rejects_bad_input(override, message):
    with pytest.raises(HTTPException) as exc:
        _uplift(**override)
    assert exc.value.status_code == 422
    assert message in exc.value.detail


def test_profile_preview_points_vectors_at_the_uplift_preview():
    body = ProfilePreviewRequest(tilt_azimuth=28.0, tilt_factor=0.4, tilt_model=_vtm())
    with pytest.raises(HTTPException) as exc:
        asyncio.run(profile_preview(body))
    assert exc.value.status_code == 422
    assert "use /api/uplift-preview" in exc.value.detail
