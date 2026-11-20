"""
Safeguards against races from concurrency: overlapping requests in the API
(api/concurrency.py's run_exclusive) and the backend's own threads.
"""
import asyncio
import os
import threading
import time
import warnings

import numpy as np
import pytest
from rasterio.transform import from_origin
from starlette.background import BackgroundTasks

import api.main as api_main
from api.concurrency import run_exclusive
from api.main import ProfilePreviewRequest, health, process, profile_preview
from backend import main as bm

ORIGIN = "44.945N,104.945W"


async def _process(path):
    response = await process(
        background_tasks=BackgroundTasks(), dem_file=None, file_path=path,
        origin_value=ORIGIN, tilt_azimuth=90, tilt_factor=0.0, target_elevation=450,
        include_dem=True, selection_radius_km=None,
    )
    if response.background:
        await response.background()
    return response


def _slow_tagged_process_dem(monkeypatch, delay=0.3):
    """Wrap process_dem: warn with a tag naming its input, sleep, and record the
    peak number of runs inside it at the same moment."""
    real = api_main.process_dem
    state = {"active": 0, "peak": 0}
    guard = threading.Lock()

    def wrapped(*args, **kwargs):
        with guard:
            state["active"] += 1
            state["peak"] = max(state["peak"], state["active"])
        try:
            name = os.path.basename(kwargs["file_path"]).split("_")[0]  # 'sloped' / 'flat'
            warnings.warn(f"run:{name}", UserWarning)
            time.sleep(delay)
            return real(*args, **kwargs)
        finally:
            with guard:
                state["active"] -= 1

    monkeypatch.setattr(api_main, "process_dem", wrapped)
    return state


def test_concurrent_runs_never_overlap_and_keep_their_own_warnings(monkeypatch, sloped_dem_path, flat_dem_path):
    state = _slow_tagged_process_dem(monkeypatch)

    async def both():
        return await asyncio.gather(_process(sloped_dem_path), _process(flat_dem_path))

    sloped, flat = asyncio.run(both())
    assert state["peak"] == 1  # the second run waited for the first
    assert sloped.status_code == flat.status_code == 200
    assert "run:sloped" in sloped.headers["X-Processing-Warnings"]
    assert "run:flat" not in sloped.headers["X-Processing-Warnings"]
    assert "run:flat" in flat.headers["X-Processing-Warnings"]
    assert "run:sloped" not in flat.headers["X-Processing-Warnings"]


def test_a_preview_during_a_run_keeps_warnings_apart(monkeypatch, sloped_dem_path):
    _slow_tagged_process_dem(monkeypatch, delay=0.5)
    real_build = api_main._build_profile_preview

    def tagged_build(*args, **kwargs):
        warnings.warn("preview-warning", UserWarning)
        return real_build(*args, **kwargs)

    monkeypatch.setattr(api_main, "_build_profile_preview", tagged_build)
    body = ProfilePreviewRequest(
        tilt_azimuth=28.0, tilt_factor=0.4,
        tilt_model={"version": 1, "direction": {"type": "azimuth"},
                    "profile": {"family": "linear"}, "hinge": {"mode": "origin"}},
    )

    async def both():
        run = asyncio.create_task(_process(sloped_dem_path))
        await asyncio.sleep(0.1)  # the run is inside process_dem now
        return await run, await profile_preview(body)

    run_response, preview = asyncio.run(both())
    assert "preview-warning" not in run_response.headers["X-Processing-Warnings"]
    assert "preview-warning" in preview["warnings"]
    assert not any(w.startswith("run:") for w in preview["warnings"])


def test_the_server_stays_responsive_during_a_run(monkeypatch, sloped_dem_path):
    _slow_tagged_process_dem(monkeypatch, delay=0.6)
    finished = []

    async def run():
        await _process(sloped_dem_path)
        finished.append("run")

    async def ping():
        await asyncio.sleep(0.1)
        assert (await health()) == {"status": "ok"}
        finished.append("health")

    async def both():
        await asyncio.gather(run(), ping())

    asyncio.run(both())
    assert finished == ["health", "run"]  # answered while the run was still going


def test_run_exclusive_releases_the_lock_when_the_call_raises():
    def boom():
        raise RuntimeError("boom")

    async def go():
        with pytest.raises(RuntimeError, match="boom"):
            await run_exclusive(boom)
        # a deadlocked lock would hang here; wait_for turns that into a failure
        return await asyncio.wait_for(run_exclusive(lambda: 42), timeout=5)

    result, caught = asyncio.run(go())
    assert result == 42 and caught == []


def test_run_exclusive_captures_only_its_own_call():
    def warn(tag):
        warnings.warn(tag, UserWarning)
        time.sleep(0.05)
        return tag

    async def go():
        return await asyncio.gather(*(run_exclusive(warn, f"t{i}") for i in range(5)))

    for result, caught in asyncio.run(go()):
        assert [str(w.message) for w in caught] == [result]


# --- backend threads ---------------------------------------------------------------

def _dem():
    y, x = np.indices((120, 80))
    return (1000.0 - 0.5 * x - 0.25 * y).astype("float32")


TRANSFORM = from_origin(-105.0, 45.0, 0.01, 0.01)


def test_a_model_that_does_not_declare_thread_safety_runs_single_threaded():
    seen = set()

    class Plain:  # no thread_safe attribute
        extra_bytes_per_pixel = 0

        def evaluate(self, east_km, north_km):
            seen.add(threading.get_ident())
            return np.zeros(np.broadcast(east_km, north_km).shape)

    bm.calculate_tilt(_dem(), TRANSFORM, (-104.6, 44.4), 0, 0, uplift_model=Plain(), workers=8)
    assert seen == {threading.get_ident()}


def test_threaded_tilt_leaves_the_input_untouched_and_writable():
    dem = _dem()
    before = dem.copy()
    bm.calculate_tilt(dem, TRANSFORM, (-104.6, 44.4), 210, 0.5, workers=8)
    assert np.array_equal(dem, before) and dem.flags.writeable


def test_built_models_cannot_be_changed_in_place():
    from backend.uplift import build_uplift_model
    from backend.direction_field import build_vector_model_from_spec

    assert build_uplift_model(
        {"version": 1, "direction": {"type": "azimuth"},
         "profile": {"family": "linear", "coefficients": None, "rate_of_increase": None},
         "hinge": {"mode": "origin", "distance_km": None}}, 28.0, 0.4).thread_safe
    spec = {"version": 1,
            "direction": {"type": "vectors", "vectors": [
                {"lat": 44.6, "lon": -104.7, "azimuth_deg": 30.0, "range_km": None},
                {"lat": 44.5, "lon": -104.4, "azimuth_deg": 60.0, "range_km": None}]},
            "profile": {"family": "linear", "coefficients": None, "rate_of_increase": None},
            "hinge": {"mode": "origin", "distance_km": None}}
    model, _ = build_vector_model_from_spec(spec, 0.4, (-104.6, 44.4), TRANSFORM, (120, 80))
    assert model.thread_safe
    with pytest.raises(ValueError):
        model.values[0, 0] = 1.0
