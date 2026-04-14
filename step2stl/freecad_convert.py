"""
FreeCAD headless STEP→STL conversion.

Architecture: subprocess, not `import FreeCAD` in-process.

Rationale:
- FreeCAD is not thread-safe; a segfault on corrupt STEP kills the FastAPI worker
  if the module is loaded in-process.
- Even with FREECAD_CONSOLE_MODE=1, some FreeCAD versions probe Qt on import;
  isolating it in a subprocess avoids polluting the server process's environment.
- Memory is reclaimed when the subprocess exits — important on a budget VPS.
- Swapping from apt FreeCAD to an AppImage extract only requires changing
  FREECADCMD_PATH in .env, with no changes here.
"""

import logging
import os
import subprocess
from pathlib import Path

from config import Settings

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# The embedded FreeCAD script
# ---------------------------------------------------------------------------
# Written to a temp file alongside the STEP file, then executed as:
#   freecadcmd <script> <step_path> <stl_path> <linear_defl> <angular_defl>
#
# Exit codes (structured for caller mapping):
#   0 — success
#   1 — unhandled FreeCAD internal error
#   2 — FreeCAD modules not importable (installation problem)
#   3 — STEP parse failure (corrupt file, wrong format, missing refs)
#   4 — empty geometry (valid STEP but no solid bodies, or zero volume)
#   5 — tessellation produced 0 facets (degenerate geometry)

FREECAD_SCRIPT = r"""
import sys
import os

os.environ.setdefault("FREECAD_CONSOLE_MODE", "1")

step_path = sys.argv[1]
stl_path  = sys.argv[2]
lin_defl  = float(sys.argv[3])
ang_defl  = float(sys.argv[4])

try:
    import FreeCAD
    import Part
    import Mesh
    import MeshPart
except ImportError as exc:
    sys.stderr.write(f"IMPORT_ERROR: {exc}\n")
    sys.exit(2)

doc = FreeCAD.newDocument("conv")

try:
    # Part.insert handles both simple STEP parts and AP214 assemblies with
    # external references — preferred over Part.read() for this reason.
    Part.insert(step_path, doc.Name)
except Exception as exc:
    sys.stderr.write(f"STEP_LOAD_ERROR: {exc}\n")
    sys.exit(3)

# Collect every Shape object the STEP importer created.
shapes = [
    obj.Shape
    for obj in doc.Objects
    if hasattr(obj, "Shape") and not obj.Shape.isNull()
]

if not shapes:
    sys.stderr.write("EMPTY_SHAPE_ERROR: no solid geometry found in document\n")
    sys.exit(4)

# Merge into one compound so multi-body assemblies are exported as a single STL.
compound = Part.makeCompound(shapes)

if compound.isNull():
    sys.stderr.write("EMPTY_SHAPE_ERROR: compound is null\n")
    sys.exit(4)

if compound.Volume == 0:
    sys.stderr.write("EMPTY_SHAPE_ERROR: compound has zero volume (surface-only geometry?)\n")
    sys.exit(4)

# Tessellate using both linear and angular deflection for watertight meshes.
# Relative=False means the deflection values are absolute (mm / degrees),
# not fractions of the bounding box — required for predictable mesh quality.
mesh = MeshPart.meshFromShape(
    Shape=compound,
    LinearDeflection=lin_defl,
    AngularDeflection=ang_defl,
    Relative=False,
)

if mesh.CountFacets == 0:
    sys.stderr.write("MESH_ERROR: tessellation produced 0 facets\n")
    sys.exit(5)

mesh_obj = doc.addObject("Mesh::Feature", "output")
mesh_obj.Mesh = mesh
Mesh.export([mesh_obj], stl_path)

sys.exit(0)
"""

# ---------------------------------------------------------------------------
# Exit code → (error_code_str, human_message)
# ---------------------------------------------------------------------------
_EXIT_MESSAGES: dict[int, tuple[str, str]] = {
    2: (
        "freecad_unavailable",
        "FreeCAD is not installed or its Python modules could not be imported",
    ),
    3: (
        "step_parse_error",
        "The STEP file could not be parsed — it may be corrupt, truncated, or not a STEP file",
    ),
    4: (
        "empty_geometry",
        "The STEP file contains no solid bodies or has zero volume (surface-only geometry)",
    ),
    5: (
        "mesh_failure",
        "Tessellation produced no facets — the geometry may be degenerate",
    ),
}


# ---------------------------------------------------------------------------
# Public exception
# ---------------------------------------------------------------------------

class ConversionError(Exception):
    """Raised by convert_step_to_stl on any anticipated failure."""

    def __init__(self, code: str, detail: str) -> None:
        self.code = code
        self.detail = detail
        super().__init__(detail)


# ---------------------------------------------------------------------------
# Public conversion function
# ---------------------------------------------------------------------------

def convert_step_to_stl(
    step_path: Path,
    stl_path: Path,
    settings: Settings,
) -> None:
    """
    Convert *step_path* to *stl_path* using FreeCAD in a subprocess.

    Raises:
        ConversionError         — any anticipated failure (bad file, bad geometry, …)
        subprocess.TimeoutExpired — conversion exceeded settings.timeout_seconds
        FileNotFoundError       — freecadcmd binary not found at settings.freecadcmd_path
    """
    # Write the embedded script next to the STEP file so it shares the
    # same TemporaryDirectory and is cleaned up automatically.
    script_file = step_path.parent / "_freecad_conv.py"
    script_file.write_text(FREECAD_SCRIPT)

    env = os.environ.copy()
    env["FREECAD_CONSOLE_MODE"] = "1"
    # FreeCAD ≤0.20 probes for a display even in console mode.
    # Setting DISPLAY=:99 (Xvfb) prevents the "cannot connect to X server" error.
    # FreeCAD 0.21+ ignores this when FREECAD_CONSOLE_MODE=1, so it's harmless.
    env.setdefault("DISPLAY", ":99")

    cmd = [
        settings.freecadcmd_path,
        str(script_file),
        str(step_path),
        str(stl_path),
        str(settings.linear_deflection),
        str(settings.angular_deflection),
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=settings.timeout_seconds,
            env=env,
            cwd=str(step_path.parent),
            # start_new_session=True ensures that if we kill this process on
            # timeout, any child processes FreeCAD spawned are also killed
            # (they share a new process group, and SIGKILL goes to the group).
            start_new_session=True,
        )
    except FileNotFoundError:
        raise ConversionError(
            "freecad_unavailable",
            f"freecadcmd not found at '{settings.freecadcmd_path}' — "
            "install FreeCAD or update FREECADCMD_PATH",
        )
    # subprocess.TimeoutExpired propagates naturally; the caller maps it to HTTP 504.

    if result.returncode != 0:
        code, default_msg = _EXIT_MESSAGES.get(
            result.returncode,
            (
                "conversion_failed",
                f"FreeCAD exited with unexpected code {result.returncode}",
            ),
        )
        # Log full stderr for operator visibility; never forward it to callers
        # (it may contain internal paths or other sensitive details).
        log.warning(
            "FreeCAD stderr (exit %d) for %s:\n%s",
            result.returncode,
            step_path.name,
            result.stderr[:4000],
        )
        raise ConversionError(code, default_msg)

    # Sanity-check that the file actually got written.
    if not stl_path.exists() or stl_path.stat().st_size == 0:
        raise ConversionError(
            "empty_output",
            "Conversion appeared to succeed but the output STL file is empty",
        )


# ---------------------------------------------------------------------------
# CLI smoke-test: python3 freecad_convert.py /path/to/part.step [out.stl]
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import sys

    logging.basicConfig(level=logging.DEBUG)

    if len(sys.argv) < 2:
        print("Usage: python3 freecad_convert.py <input.step> [output.stl]")
        sys.exit(1)

    step = Path(sys.argv[1])
    stl = Path(sys.argv[2]) if len(sys.argv) > 2 else step.with_suffix(".stl")

    cfg = Settings()
    try:
        convert_step_to_stl(step, stl, cfg)
        print(f"OK — written to {stl} ({stl.stat().st_size:,} bytes)")
    except ConversionError as e:
        print(f"ERROR [{e.code}]: {e.detail}", file=sys.stderr)
        sys.exit(1)
    except subprocess.TimeoutExpired:
        print(f"TIMEOUT — exceeded {cfg.timeout_seconds}s", file=sys.stderr)
        sys.exit(1)
