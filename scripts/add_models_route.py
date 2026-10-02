#!/usr/bin/env python3
"""Add GET /v1/models to AInterceptor's OpenAI-compatible surface.

WHY
---
DSH (and any OpenAI-compatible client) discovers a route's models from
`GET {baseURL}/models`. AInterceptor answered 404 there, so the DSH provider
profile had to hand-list every provider. With this route, model discovery is
dynamic: enabling a provider in AInterceptor makes it appear automatically.

WHAT IT RETURNS
---------------
The OpenAI list envelope, where each entry's `id` is the PROVIDER NAME — because
AInterceptor's dispatcher routes on the request's `model` field. Active providers
come first; inactive ones are still listed (suffix "(inactive)") so the operator
can see the full catalogue, but a call to one will return AInterceptor's own
"no active session" error rather than failing discovery.

Idempotent, backs up first, and leaves the rest of the file untouched.
"""
from __future__ import annotations
import os
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(os.environ.get("AINTERCEPTOR_ROOT") or pathlib.Path.home() / "ainterceptor")
TARGET = ROOT / "backend" / "app" / "api" / "chat_routes.py"

ANCHOR = '''@router.post("/chat/completions")
'''

ROUTE = '''@router.get("/models")
def list_models(
    auth: tuple[User, ApiKey] | None = Depends(optional_key_user),
) -> dict:
    """OpenAI-compatible model listing.

    Each model id IS a provider name: AInterceptor routes on the request's
    `model` field. This exists so OpenAI-compatible clients (the DeepSeek
    Harness among them) can discover providers dynamically instead of having
    every provider hand-listed in their configuration. Without it, discovery
    does a GET on this path and gets a 404.

    Active providers are listed first. Inactive ones are included, suffixed
    "(inactive)", so the catalogue is visible; calling one returns
    AInterceptor's own "no active session" error instead of a discovery failure.
    """
    from app.control_plane import state as _state

    try:
        active = list(_state.list_active())
        inactive = list(_state.list_inactive())
    except Exception:
        active, inactive = [], list(_state.list_all())

    created = int(time.time())
    data = [
        {"id": p, "object": "model", "created": created, "owned_by": "ainterceptor"}
        for p in active
    ] + [
        {"id": p, "object": "model", "created": created, "owned_by": "ainterceptor",
         "ainterceptor": {"status": "inactive"},
         "name": f"{p} (inactive)"}
        for p in inactive
    ]
    return {"object": "list", "data": data}


@router.post("/chat/completions")
'''

OPTIONAL_DEP = '''

def optional_key_user(
    authorization: str | None = Header(None),
    db: Session = Depends(get_db),
) -> tuple[User, ApiKey] | None:
    """Like `key_user`, but tolerates a missing Authorization header.

    Model listing is metadata: it must not require the caller to hold a key, or
    discovery fails and the client cannot even present a model picker. When a
    header IS supplied it is validated exactly as `key_user` does, so an invalid
    credential is still rejected rather than silently ignored.
    """
    if not authorization:
        return None
    return key_user(authorization=authorization, db=db)
'''


def main() -> int:
    if not TARGET.exists():
        print(f"[FAIL] {TARGET} not found")
        return 1

    src = TARGET.read_text(encoding="utf-8")

    if '@router.get("/models")' in src:
        print("[skip] /v1/models already present")
        return 0
    if ANCHOR not in src:
        print('[FAIL] anchor @router.post("/chat/completions") not found')
        return 1

    backup = TARGET.with_suffix(".py.pre_models_route")
    if not backup.exists():
        shutil.copy2(TARGET, backup)
        print(f"[ok]   backup -> {backup.name}")

    # 1. Header must be importable from fastapi
    if "from fastapi import APIRouter, Depends, HTTPException" in src:
        src = src.replace(
            "from fastapi import APIRouter, Depends, HTTPException",
            "from fastapi import APIRouter, Depends, Header, HTTPException",
            1,
        )
        print("[ok]   imported Header from fastapi")
    elif "Header" not in src.split("\n\n")[0]:
        print("[WARN] could not confirm the fastapi import line; check manually")

    # 2. insert the optional dependency helper just before the route
    src = src.replace(ANCHOR, OPTIONAL_DEP.lstrip("\n") + "\n\n" + ROUTE, 1)
    print("[ok]   inserted optional_key_user() and GET /models")

    TARGET.write_text(src, encoding="utf-8")
    print(f"[ok]   wrote {TARGET}")

    rc = subprocess.run([sys.executable, "-m", "py_compile", str(TARGET)])
    print("compile rc:", rc.returncode)

    # confirm the pieces exist
    after = TARGET.read_text(encoding="utf-8")
    for needle in ('@router.get("/models")', "def optional_key_user", "Header"):
        print(f"  {needle!r:34} present={needle in after}")
    return rc.returncode


if __name__ == "__main__":
    sys.exit(main())
