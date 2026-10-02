#!/usr/bin/env python3
"""Fix GET /v1/models: it must use the `get_state()` singleton.

`app.control_plane.state` exposes a module-level `get_state()` factory and no
module-level `list_active()` / `list_inactive()`. My first version called them on
the module, which raised AttributeError and surfaced as HTTP 500. This mirrors
how health_routes does it (`from app.control_plane.state import get_state`).
"""
from __future__ import annotations
import os
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(os.environ.get("AINTERCEPTOR_ROOT") or pathlib.Path.home() / "ainterceptor")
TARGET = ROOT / "backend" / "app" / "api" / "chat_routes.py"

OLD = '''    from app.control_plane import state as _state

    try:
        active = list(_state.list_active())
        inactive = list(_state.list_inactive())
    except Exception:
        active, inactive = [], list(_state.list_all())
'''

NEW = '''    # The control plane exposes a module-level singleton factory, not module
    # level list_* helpers - mirror health_routes here.
    from app.control_plane.state import get_state as _get_state

    _st = _get_state()
    try:
        active = list(_st.list_active())
        inactive = list(_st.list_inactive())
    except Exception:
        active, inactive = [], list(_st.list_all())
'''


def main() -> int:
    if not TARGET.exists():
        print(f"[FAIL] {TARGET} not found")
        return 1
    src = TARGET.read_text(encoding="utf-8")
    if "get_state as _get_state" in src:
        print("[skip] already using get_state()")
        return 0
    if OLD not in src:
        print("[FAIL] anchor not found; current /models block:")
        i = src.find('@router.get("/models")')
        print(src[i:i + 1200] if i >= 0 else "  (route missing)")
        return 1

    backup = TARGET.with_suffix(".py.pre_models_statefix")
    if not backup.exists():
        shutil.copy2(TARGET, backup)
        print(f"[ok]   backup -> {backup.name}")

    TARGET.write_text(src.replace(OLD, NEW, 1), encoding="utf-8")
    print("[ok]   /v1/models now resolves the state singleton")

    rc = subprocess.run([sys.executable, "-m", "py_compile", str(TARGET)])
    print("compile rc:", rc.returncode)

    after = TARGET.read_text(encoding="utf-8")
    print("  get_state present :", "get_state as _get_state" in after)
    print("  list_active call  :", "_st.list_active()" in after)
    return rc.returncode


if __name__ == "__main__":
    sys.exit(main())
