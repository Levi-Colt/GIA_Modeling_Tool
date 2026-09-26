"""
API tests for `direction.type == "points"` (documentation/SHORE_POINT_SURFACE_SPEC.md,
spec 6): shore-point validation (including the profile/hinge exclusion), the run's
diagnostics header / run_parameters.json / shore_points.csv, and
POST /api/fit-uplift-surface.

Calls api.main handlers directly (in-process), like the other API tests. The sloped
fixture spans lon [-105.0, -104.9], lat [44.9, 45.0]; the run's origin
(44.945N, 104.945W) is inside it. The points are synthetic example values.
"""
import asyncio
import copy
import csv
import io
import json
import zipfile

import pytest
from fastapi import HTTPException
from starlette.background import BackgroundTasks

from api.main import (
    FitSurfaceRequest, ProfilePreviewRequest, UpliftPreviewRequest, fit_uplift_surface, process,
    profile_preview, uplift_preview,
)

ORIGIN = [-104.945, 44.945]
BOUNDS = [-105.0, 44.9, -104.9, 45.0]


def _points(count=16, labels=True):
    """A spread of points over the DEM on a gently tilted plane (1000 m per degree of
    longitude, 500 per degree of latitude) with a little deterministic scatter."""
    out = []
    side = 4 if count == 16 else int(count ** 0.5) + 1
    for i in range(count):
        lon = -104.99 + 0.02 * (i % side)
        lat = 44.91 + 0.02 * (i // side)
        z = 300.0 + 1000.0 * (lon + 104.945) + 500.0 * (lat - 44.945) + (i % 3 - 1) * 0.4
        p = {"lat": lat, "lon": lon, "elevation_m": z}
        if labels:
            p["label"] = f"site {i + 1}"
        out.append(p)
    return out


def _ptm(points=None, order=2, hinge=None, extrapolation=None, **top):
    direction = {"type": "points", "points": _points() if points is None else points, "order": order}
    if hinge is not None:
        direction["hinge"] = hinge
    if extrapolation is not None:
        direction["extrapolation"] = extrapolation
    return {"version": 1, "direction": direction, **top}


def _run(file_path, tilt_model, tilt_factor=None, tilt_azimuth=None, target=450):
    raw = tilt_model if tilt_model is None or isinstance(tilt_model, str) else json.dumps(tilt_model)

    async def _call():
        background_tasks = BackgroundTasks()
        response = await process(
            background_tasks=background_tasks, dem_file=None, file_path=file_path,
            origin_mode="decimal_degrees", origin_value="44.945N,104.945W", origin_epsg=None,
            tilt_azimuth=tilt_azimuth, tilt_factor=tilt_factor, target_elevation=target,
            include_dem=False, selection_radius_km=None, tilt_model=raw,
        )
        if response.background:
            await response.background()
        return response

    return asyncio.run(_call())


def _zip(response):
    return zipfile.ZipFile(io.BytesIO(response.body))


def _params(response):
    return json.loads(_zip(response).read("run_parameters.json"))


def _fit(**over):
    body = {"points": _points(), "order": 2, "origin": ORIGIN, "bounds_wgs84": BOUNDS}
    body.update(over)
    return asyncio.run(fit_uplift_surface(FitSurfaceRequest(**body)))


# --- validation: every rule is a 422 with a specific message -------------------------------

def _bad_cases():
    def mutated(fn):
        model = _ptm()
        fn(model)
        return model

    no_points = _ptm()
    del no_points["direction"]["points"]
    vectors_and_points = _ptm()
    vectors_and_points["direction"]["vectors"] = [{"lat": 44.9, "lon": -104.9, "azimuth_deg": 1.0}]
    azimuth_with_points = {"version": 1, "direction": {"type": "azimuth", "points": _points()},
                           "profile": {"family": "linear"}}
    return [
        (_ptm(profile={"family": "linear"}), "profile and hinge don't apply to shore-point surfaces"),
        (mutated(lambda m: m.update(hinge={"mode": "origin", "distance_km": None})),
         "profile and hinge don't apply"),
        (no_points, "direction.points is required"),
        (_ptm(points=[]), "must contain 1 to 5000 points"),
        (_ptm(points=[{"lat": 45.0, "lon": -105.0, "elevation_m": 300.0}] * 5001), "must contain 1 to 5000 points"),
        (_ptm(order=4), "direction.order must be one of [1, 2, 3]"),
        (_ptm(order=2.0), "direction.order must be one of"),
        (_ptm(order=True), "direction.order must be one of"),
        (_ptm(order="2"), "direction.order must be one of"),
        (_ptm(points=_points(8), order=2), "An order-2 surface needs at least 9 shore points (got 8)"),
        (_ptm(points=_points(12), order=3), "An order-3 surface needs at least 13 shore points (got 12)"),
        (_ptm(points=_points(5), order=1), "An order-1 surface needs at least 6 shore points (got 5)"),
        (_ptm(hinge="distance"), "direction.hinge must be one of ['none', 'origin']"),
        (_ptm(extrapolation="clip"), "direction.extrapolation must be one of ['warn', 'mask']"),
        (mutated(lambda m: m["direction"]["points"][2].update(lat=91.0)), "Shore point 3: lat must be between -90 and 90"),
        (mutated(lambda m: m["direction"]["points"][0].update(lon=-181.0)), "Shore point 1: lon must be between -180 and 180"),
        (mutated(lambda m: m["direction"]["points"][0].update(elevation_m=None)), "elevation_m"),
        (mutated(lambda m: m["direction"]["points"][0].update(label="x" * 101)), "label must be at most 100 characters"),
        (mutated(lambda m: m["direction"]["points"][0].update(label=7)), "label must be a string"),
        (mutated(lambda m: m["direction"]["points"][0].update(site="x")), "unknown key"),
        (vectors_and_points, "direction.vectors is only allowed when direction.type is 'vectors'"),
        (azimuth_with_points, "direction.points is only allowed when direction.type is 'points'"),
    ]


@pytest.mark.parametrize("model,message", _bad_cases())
def test_invalid_points_models_are_422_with_specific_messages(sloped_dem_path, model, message):
    with pytest.raises(HTTPException) as exc:
        _run(sloped_dem_path, model)
    assert exc.value.status_code == 422
    assert message in exc.value.detail


def test_duplicate_coordinates_and_missing_labels_are_allowed(sloped_dem_path):
    pts = _points(labels=False) + _points(labels=False)[:3]
    assert _run(sloped_dem_path, _ptm(points=pts, order=2)).status_code == 200


def test_non_finite_tilt_factor_is_still_rejected(sloped_dem_path):
    with pytest.raises(HTTPException) as exc:
        _run(sloped_dem_path, _ptm(), tilt_factor=float("nan"))
    assert exc.value.status_code == 422 and "finite" in exc.value.detail


# --- runs -------------------------------------------------------------------------------------

def test_points_run_needs_neither_tilt_azimuth_nor_tilt_factor(sloped_dem_path):
    response = _run(sloped_dem_path, _ptm())
    assert response.status_code == 200
    assert len(json.loads(_zip(response).read("contour.geojson"))["features"]) > 0


def test_points_run_reports_the_fit_in_the_header_and_run_parameters(sloped_dem_path):
    response = _run(sloped_dem_path, _ptm(order=2, hinge="origin"))
    header = json.loads(response.headers["X-Tilt-Model-Diagnostics"])
    assert set(header) == {"order", "r2", "rmse_m", "dem_fraction_outside_hull"}
    assert header["order"] == 2 and 0.9 < header["r2"] <= 1.0

    params = _params(response)
    assert params["tilt_azimuth"] is None and params["tilt_factor"] is None
    direction = params["tilt_model"]["direction"]
    assert (direction["type"], direction["order"], direction["hinge"], direction["extrapolation"]) == \
        ("points", 2, "origin", "warn")
    assert len(direction["points"]) == 16
    assert params["tilt_model"]["profile"] is None and params["tilt_model"]["hinge"] is None
    assert (params["hinge_km"], params["hinge_source"]) == (None, None)

    d = params["diagnostics"]
    assert d["type"] == "points" and d["fit"]["order"] == 2 and d["fit"]["n"] == 16
    assert d["fit"]["r2"] == pytest.approx(header["r2"])
    assert len(d["fit"]["coefficients"]) == 6 and len(d["fit"]["residuals_m"]) == 16
    assert {"east_power", "north_power", "scaled", "per_km"} <= set(d["fit"]["coefficients"][0])
    assert [o["order"] for o in d["orders"]] == [1, 2, 3]
    assert d["dem_fraction_outside_hull"] == pytest.approx(header["dem_fraction_outside_hull"])


def test_points_run_bundles_the_fitted_points_as_a_csv(sloped_dem_path):
    response = _run(sloped_dem_path, _ptm())
    rows = list(csv.DictReader(io.StringIO(_zip(response).read("shore_points.csv").decode())))
    sent = _points()
    assert list(rows[0]) == ["lat", "lon", "elevation_m", "label", "residual_m"]
    assert len(rows) == len(sent)
    for row, p in zip(rows, sent):
        assert float(row["lat"]) == p["lat"] and float(row["lon"]) == p["lon"]
        assert float(row["elevation_m"]) == p["elevation_m"]
        assert row["label"] == p["label"]
    residuals = _params(response)["diagnostics"]["fit"]["residuals_m"]
    assert [float(r["residual_m"]) for r in rows] == pytest.approx(residuals)


def test_other_runs_have_no_shore_points_csv(sloped_dem_path):
    response = _run(sloped_dem_path, None, tilt_factor=20.0, tilt_azimuth=90.0)
    assert "shore_points.csv" not in _zip(response).namelist()


def test_a_mask_run_succeeds_and_reports_the_masked_share(sloped_dem_path):
    # Data only near the origin and east of it (the DEM rises east, so the spillway's
    # elevation is inside the unmasked part).
    east = [p for p in _points() if p["lon"] > -104.96]
    response = _run(sloped_dem_path, _ptm(points=east * 2, order=1, extrapolation="mask"))
    assert response.status_code == 200
    assert "masked" in response.headers["X-Processing-Warnings"]
    assert json.loads(response.headers["X-Tilt-Model-Diagnostics"])["dem_fraction_outside_hull"] > 0.2


def test_warn_mode_warning_reaches_the_response_header(sloped_dem_path):
    west = [p for p in _points() if p["lon"] < -104.95]
    response = _run(sloped_dem_path, _ptm(points=west * 2, order=1))
    assert "lies outside the shore points' buffered hull" in response.headers["X-Processing-Warnings"]


def test_an_unbuildable_surface_is_a_422(sloped_dem_path):
    same = [{"lat": 44.93, "lon": -104.96, "elevation_m": 300.0 + i} for i in range(9)]
    with pytest.raises(HTTPException) as exc:
        _run(sloped_dem_path, _ptm(points=same, order=1))
    assert exc.value.status_code == 422 and "same location" in exc.value.detail


# --- POST /api/fit-uplift-surface ------------------------------------------------------------------

def test_fit_returns_only_the_orders_the_point_count_allows():
    assert [o["order"] for o in _fit(points=_points(16), order=2)["orders"]] == [1, 2, 3]
    out = _fit(points=_points(10), order=2)
    assert [o["order"] for o in out["orders"]] == [1, 2]
    assert all(set(o) == {"order", "n", "terms", "r2", "adj_r2", "rmse_m"} for o in out["orders"])
    assert [o["order"] for o in _fit(points=_points(6), order=1)["orders"]] == [1]


def test_fit_returns_the_selected_order_isobases_and_hull():
    out = _fit(order=2)
    sel = out["selected"]
    assert sel["order"] == 2 and len(sel["residuals_m"]) == 16 == len(sel["std_residuals"])
    assert isinstance(sel["outlier_indices"], list) and sel["cond"] > 1
    assert sel["rmse_m"] == pytest.approx(next(o for o in out["orders"] if o["order"] == 2)["rmse_m"])

    inside, outside = out["isobases"]["inside"], out["isobases"]["outside"]
    assert inside["type"] == "FeatureCollection" and inside["features"]
    assert outside["type"] == "FeatureCollection"
    assert all("elevation_m" in f["properties"] for f in inside["features"])
    assert out["interval_m"] > 0
    assert out["hull"]["type"] == "Polygon" and out["hull"]["coordinates"][0][0] == out["hull"]["coordinates"][0][-1]
    assert 0.0 <= out["dem_fraction_outside_hull"] <= 1.0
    assert isinstance(out["origin_inside_hull"], bool)
    assert isinstance(out["warnings"], list)


def test_fit_in_mask_mode_draws_nothing_outside_the_hull():
    west = [p for p in _points(labels=False) if p["lon"] < -104.95] * 2
    out = _fit(points=west, order=1, extrapolation="mask")
    assert out["isobases"]["outside"]["features"] == []
    assert any("masked" in w for w in out["warnings"])
    assert out["dem_fraction_outside_hull"] > 0.2


def test_fit_with_collinear_points_reports_a_null_condition_or_a_warning():
    line = [{"lat": 44.91 + 0.008 * i, "lon": -104.99 + 0.008 * i, "elevation_m": 300.0 + i}
            for i in range(12)]
    out = _fit(points=line, order=1)
    assert out["selected"]["cond"] is None or out["selected"]["cond"] > 1e8
    assert any("collinear" in w for w in out["warnings"])
    json.dumps(out)        # no Infinity/NaN slipped into the response


@pytest.mark.parametrize("override,message", [
    (dict(order=3, points=_points(12)), "An order-3 surface needs at least 13"),
    (dict(order=5), "direction.order must be one of"),
    (dict(points=[]), "must contain 1 to 5000 points"),
    (dict(points=[{"lat": 95.0, "lon": 0.0, "elevation_m": 1.0}] * 9), "Shore point 1: lat"),
    (dict(origin=[1.0]), "origin must be"),
    (dict(bounds_wgs84=[1.0, 2.0, 0.0, 3.0]), "bounds_wgs84 must be"),
    (dict(hinge="distance"), "direction.hinge must be one of"),
    (dict(extrapolation="clip"), "direction.extrapolation must be one of"),
])
def test_fit_rejects_bad_input(override, message):
    with pytest.raises(HTTPException) as exc:
        _fit(**override)
    assert exc.value.status_code == 422
    assert message in exc.value.detail


def test_the_other_preview_endpoints_point_at_the_fit_endpoint():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(profile_preview(ProfilePreviewRequest(tilt_azimuth=28.0, tilt_factor=0.4, tilt_model=_ptm())))
    assert "use /api/fit-uplift-surface" in exc.value.detail
    with pytest.raises(HTTPException) as exc:
        asyncio.run(uplift_preview(UpliftPreviewRequest(tilt_model=_ptm(), origin=ORIGIN, bounds_wgs84=BOUNDS)))
    assert "/api/fit-uplift-surface" in exc.value.detail
