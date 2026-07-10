"""
Job-scoped temporary storage for the API layer.

Deliberately environment-agnostic: every path used by a request lives under
one configurable root directory, so the same code works identically whether
it's running on a laptop, inside a CryoCloud JupyterHub session, or on a
future dedicated host. Nothing here assumes a specific filesystem layout --
only that GIA_STORAGE_DIR (or the OS default temp dir, if unset) is a
writable directory.

Each request gets its own uuid4-named subdirectory containing its input and
output files, so concurrent requests never collide and cleanup is a single
recursive delete of one directory.
"""
import os
import shutil
import tempfile
import uuid
from contextlib import contextmanager


def _storage_root() -> str:
    """
    Resolves the root directory all job workspaces are created under.

    Sourced from the GIA_STORAGE_DIR environment variable so deployment can
    point this at whatever persistent/shared path makes sense for a given
    host (e.g. a mounted volume) without any code changes. Falls back to the
    OS temp directory, which is sufficient for local development and for any
    environment where job workspaces are genuinely disposable (the normal
    case here -- everything in a workspace is either a copy of a client
    upload or intermediate/output data superseded by the response).
    """
    root = os.environ.get("GIA_STORAGE_DIR", tempfile.gettempdir())
    os.makedirs(root, exist_ok=True)
    return root


def create_job_workspace() -> str:
    """
    Creates and returns a fresh, uniquely-named directory for one request's
    input/intermediate/output files.
    """
    job_dir = os.path.join(_storage_root(), f"gia-job-{uuid.uuid4().hex}")
    os.makedirs(job_dir, exist_ok=False)
    return job_dir


def cleanup_job_workspace(job_dir: str) -> None:
    """
    Recursively removes a job workspace. Safe to call even if the directory
    was already partially or fully removed (e.g. a prior failed run) --
    cleanup should never itself raise and mask the original error.
    """
    shutil.rmtree(job_dir, ignore_errors=True)


@contextmanager
def job_workspace():
    """
    Convenience context manager: yields a fresh job directory and guarantees
    cleanup on the way out, whether the block succeeded or raised.

    Not used for the success path in the API route itself, since a
    FileResponse needs the output file to still exist while it streams the
    response body -- that path cleans up via a BackgroundTask scheduled
    *after* the response instead (see api/main.py). This context manager is
    for any internal code path (e.g. tests, or future non-HTTP callers) that
    wants strict "gone by the time the block exits" semantics.
    """
    job_dir = create_job_workspace()
    try:
        yield job_dir
    finally:
        cleanup_job_workspace(job_dir)
