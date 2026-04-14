"""
STEP → STL conversion microservice.

POST /convert  — upload a STEP file, receive STL bytes
GET  /health   — liveness + readiness probe
"""

import logging
import re
import subprocess
import tempfile
from pathlib import Path

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response

from config import Settings, get_settings
from freecad_convert import ConversionError, convert_step_to_stl

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(
    title="STEP → STL Converter",
    version="1.0.0",
    description="Accepts a STEP file upload and returns binary STL bytes, "
                "converted via FreeCAD headless.",
)

# ---------------------------------------------------------------------------
# Security helpers
# ---------------------------------------------------------------------------

_ALLOWED_EXTENSIONS = {".step", ".stp"}

# All STEP/AP2xx files start with this ASCII header (ISO 10303-21 §8).
_STEP_MAGIC = b"ISO-10303-21;"

# Safe filename: alphanumeric, dash, underscore, dot, space — no path separators.
_SAFE_NAME_RE = re.compile(r"^[\w.\- ]{1,100}$")


def sanitize_filename(raw: str) -> str:
    """
    Strip directory components, replace unsafe characters, enforce allowed
    extension.  Returns a safe filename string suitable for use on disk.

    Raises HTTPException(400) if the extension is not .step or .stp.
    """
    # Strip any directory traversal (../../etc/passwd → passwd)
    name = Path(raw).name or "upload"
    # Replace every character that isn't alphanumeric, dash, underscore,
    # dot, or space with an underscore.
    name = re.sub(r"[^\w.\- ]", "_", name)
    # Collapse sequences of dots (prevents hidden-file tricks on some systems)
    name = re.sub(r"\.{2,}", ".", name).strip(". ")
    # Hard length cap
    stem = name[:96]
    suffix = Path(name).suffix.lower()

    if suffix not in _ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file extension '{suffix}'. "
                   f"Only .step and .stp files are accepted.",
        )
    # Re-attach suffix in case the stem truncation ate it
    safe = Path(stem).stem[:96] + suffix
    return safe


def check_step_magic(data: bytes) -> bool:
    """Return True if *data* starts with the ISO 10303-21 STEP magic header."""
    return data[: len(_STEP_MAGIC)] == _STEP_MAGIC


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health", summary="Liveness and readiness probe")
async def health(settings: Settings = Depends(get_settings)) -> dict:
    """
    Returns service status and whether freecadcmd is accessible.
    Suitable for use as a load-balancer health check.
    """
    fc = Path(settings.freecadcmd_path)
    return {
        "status": "ok",
        "freecadcmd_found": fc.exists(),
        "freecadcmd_path": str(fc),
        "max_file_size_mb": round(settings.max_file_size / (1024 * 1024), 1),
        "timeout_seconds": settings.timeout_seconds,
        "linear_deflection": settings.linear_deflection,
        "angular_deflection": settings.angular_deflection,
    }


@app.post(
    "/convert",
    summary="Convert STEP to STL",
    response_class=Response,
    responses={
        200: {"content": {"application/octet-stream": {}}, "description": "Binary STL file"},
        400: {"description": "Bad file extension or filename"},
        413: {"description": "File exceeds MAX_FILE_SIZE"},
        415: {"description": "File is not a valid STEP file (magic bytes check failed)"},
        422: {"description": "STEP parse failure, empty geometry, or mesh failure"},
        503: {"description": "FreeCAD is not installed / misconfigured"},
        504: {"description": "Conversion timed out"},
    },
)
async def convert(
    file: UploadFile = File(..., description="STEP or STP file to convert"),
    settings: Settings = Depends(get_settings),
) -> Response:
    """
    Upload a STEP file and receive the equivalent binary STL.

    Security checks (in order):
    1. Extension must be .step or .stp
    2. File size must not exceed MAX_FILE_SIZE (checked during streaming read)
    3. First 14 bytes must match the ISO 10303-21 STEP magic header

    The conversion runs in an isolated subprocess (FreeCAD) with a configurable
    timeout.  All temporary files are cleaned up regardless of outcome.
    """
    # --- 1. Extension check (fast, before reading the body) ---
    safe_name = sanitize_filename(file.filename or "upload.step")

    # --- 2. Streaming read with size enforcement ---
    # Read in chunks so we can reject oversized files without buffering them
    # entirely in memory first.
    chunks: list[bytes] = []
    total = 0
    async for chunk in file:
        total += len(chunk)
        if total > settings.max_file_size:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"File exceeds the maximum allowed size of "
                    f"{settings.max_file_size // (1024 * 1024)} MB"
                ),
            )
        chunks.append(chunk)

    body = b"".join(chunks)

    # --- 3. Magic bytes check ---
    if not check_step_magic(body):
        raise HTTPException(
            status_code=415,
            detail=(
                "File does not appear to be a valid STEP file. "
                "Expected an ISO 10303-21 header (starts with 'ISO-10303-21;')."
            ),
        )

    # --- 4. Convert inside an auto-cleaning temp directory ---
    # tempfile.TemporaryDirectory guarantees cleanup even if conversion raises.
    # When running under systemd with PrivateTmp=true, this resolves into the
    # service's private /tmp namespace, providing an additional isolation layer.
    with tempfile.TemporaryDirectory(prefix="step2stl_") as tmpdir:
        tmp = Path(tmpdir)
        step_path = tmp / safe_name
        stl_path = tmp / (Path(safe_name).stem + ".stl")

        step_path.write_bytes(body)
        log.info("Converting %s (%s bytes)", safe_name, f"{total:,}")

        try:
            convert_step_to_stl(step_path, stl_path, settings)
        except ConversionError as exc:
            log.warning("Conversion error [%s] for %s: %s", exc.code, safe_name, exc.detail)
            status = 503 if exc.code == "freecad_unavailable" else 422
            raise HTTPException(
                status_code=status,
                detail={"error": exc.code, "message": exc.detail},
            )
        except subprocess.TimeoutExpired:
            log.warning(
                "FreeCAD timed out after %ds for %s", settings.timeout_seconds, safe_name
            )
            raise HTTPException(
                status_code=504,
                detail={
                    "error": "conversion_timeout",
                    "message": (
                        f"Conversion exceeded the {settings.timeout_seconds}s time limit. "
                        "Try a smaller or simpler file, or increase TIMEOUT_SECONDS."
                    ),
                },
            )

        stl_bytes = stl_path.read_bytes()
        stl_size = len(stl_bytes)

    # TemporaryDirectory.__exit__ has already deleted all temp files here.
    log.info("Converted %s → %s bytes STL", safe_name, f"{stl_size:,}")

    output_name = Path(safe_name).stem + ".stl"
    return Response(
        content=stl_bytes,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{output_name}"',
            "X-Original-Filename": safe_name,
            "Content-Length": str(stl_size),
        },
    )
