"""
Safeguards for running geoprocessing inside the API's single process.

FastAPI serves requests concurrently (async handlers on one event loop, sync
work in a thread pool), and two things in this app are not safe to overlap:

* **Heavy runs.** process_dem, reprojection and full-raster preview reads each
  size themselves to the RAM free *right now* and use every CPU the pod has
  (backend/main.py: check_available_ram_mb, available_cpu_count). Two at once
  would each believe they have the whole machine, and together could exceed
  the pod's memory limit.
* **Warning capture.** `warnings.catch_warnings` swaps module-global state, so
  two overlapping captures (say a run and a profile preview) can lose each
  other's warnings, or show a user warnings from another request.

`run_exclusive` handles both: it runs the function in a worker thread that
first takes one process-wide lock, so these calls happen strictly one at a
time, and captures that call's warnings while it holds the lock. The lock is
acquired and released inside the worker thread, never on the event loop, so
the server stays responsive while a call waits; and a client disconnecting
can't leave the lock held, since the thread that took it always releases it.

Trade-off: a preview requested during a run waits for the run to finish. In
this single-user app the form isn't shown during a run, so that only happens
with two browser tabs open on one server.
"""
import threading
import warnings

from starlette.concurrency import run_in_threadpool

_COMPUTE_LOCK = threading.Lock()


def _call_locked(fn, args, kwargs):
    with _COMPUTE_LOCK:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            result = fn(*args, **kwargs)
        return result, list(caught)


async def run_exclusive(fn, *args, **kwargs):
    """Run `fn(*args, **kwargs)` in a worker thread, one such call at a time.

    Returns `(result, recorded_warnings)`, the warnings as `warnings.WarningMessage`
    objects. Exceptions propagate unchanged (the lock is released first).
    """
    return await run_in_threadpool(_call_locked, fn, args, kwargs)
