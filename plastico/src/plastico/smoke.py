"""Runs the game's own smoke test (res://tests/smoke_test.tscn) after a build, the way the
project's CLAUDE.md says: import, run headless with a time limit, keep the player's autosave.
One run at a time; the app polls `status()`."""
from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path

from .godot import editor_open, read_project_godot

_lock = threading.Lock()
_state: dict = {"running": False}


def _userdata(project: Path) -> list[Path]:
    name = read_project_godot(project)["name"]
    home = Path.home()
    return [home / ".var/app/org.godotengine.Godot/data/godot/app_userdata" / name,
            home / ".local/share/godot/app_userdata" / name]


def status() -> dict:
    with _lock:
        return dict(_state)


def start(project: Path) -> dict:
    project = Path(project).resolve()
    with _lock:
        if _state.get("running"):
            return dict(_state)
        if not (project / "tests" / "smoke_test.tscn").exists():
            return {"running": False, "error": "This project has no tests/smoke_test.tscn."}
        if editor_open(project):
            return {"running": False, "error": "Godot has the project open: close it first (the test re-imports the project)."}
        godot = shutil.which("godot")
        if not godot:
            return {"running": False, "error": "The godot command isn't on the PATH."}
        _state.clear()
        _state.update({"running": True, "project": str(project), "started": int(time.time() * 1000), "step": "Importing"})
    threading.Thread(target=_run, args=(project, godot), daemon=True).start()
    return status()


def _run(project: Path, godot: str) -> None:
    saves = []
    keep = Path(tempfile.mkdtemp(prefix="plastico-save-"))
    for i, d in enumerate(_userdata(project)):
        s = d / "save_0.json"
        if s.exists():
            b = keep / f"{i}_save_0.json"
            shutil.copy2(s, b)   # the test's scene changes autosave over the player's slot 0
            saves.append((s, b))
    result: dict = {}
    try:
        subprocess.run([godot, "--headless", "--path", str(project), "--import"], cwd=project,
                       capture_output=True, text=True, timeout=900)
        with _lock:
            _state["step"] = "Running the smoke test"
        try:
            p = subprocess.run([godot, "--headless", "--path", str(project), "res://tests/smoke_test.tscn"], cwd=project,
                               capture_output=True, text=True, timeout=240)
            out, code = p.stdout + p.stderr, p.returncode
        except subprocess.TimeoutExpired as e:
            def text(x):
                return x.decode("utf-8", "replace") if isinstance(x, bytes) else (x or "")
            out, code = text(e.stdout) + text(e.stderr), 124
        m = re.search(r"SMOKE TEST: (\d+) checks, (\d+) failed", out)
        fails = [l.strip() for l in out.splitlines() if l.strip().startswith("FAIL")]
        errors = [l.strip() for l in out.splitlines() if "SCRIPT ERROR" in l or l.startswith("ERROR:")]
        result = {"exit": code, "checks": int(m.group(1)) if m else None, "failed": int(m.group(2)) if m else None,
                  "fails": fails[:200], "errors": errors[:200], "log_tail": out.splitlines()[-40:],
                  "timed_out": code == 124,
                  "passed": code == 0 and m is not None and m.group(2) == "0" and not errors}
    except Exception as e:  # noqa: BLE001 - reported to the app
        result = {"passed": False, "error": str(e)}
    finally:
        for s, b in saves:
            shutil.copy2(b, s)
        shutil.rmtree(keep, ignore_errors=True)
        for d in _userdata(project):
            (d / "save_9.json").unlink(missing_ok=True)
        with _lock:
            _state.update(result)
            _state["running"] = False
            _state["finished"] = int(time.time() * 1000)
