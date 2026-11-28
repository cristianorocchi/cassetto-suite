"""Cassetto and Godot: the one place the suite asks about a Godot project.

Cassetto works without Godot. A project is linked to a Godot game through Plastico's world (World
settings → Godot project); this module reports on that link for the whole suite and lists what the
link can do, separating what works today from what is only planned.

The reading and writing itself lives in Plastico (plastico.godot, plastico.tscn, plastico.apply,
plastico.smoke), unchanged: the game is always read fresh, never cached, and is only written when the
person presses Build, with a backup first.
"""
from __future__ import annotations

import shutil
from pathlib import Path

from plastico import godot as _godot

# state: "works" (in this version), "planned" (the place for it exists, nothing runs yet)
CAPABILITIES = [
    {"id": "read", "state": "works", "by": "plastico",
     "text": "Read the game's scenes, exits, spawn points, passages in code and people, every time Plastico opens or regains focus."},
    {"id": "pictures", "state": "works", "by": "plastico",
     "text": "Show each scene's own art for the chosen time of day."},
    {"id": "build", "state": "works", "by": "plastico",
     "text": "Build planned scenes and ways as grey stand-ins, with a backup first and Undo the last build."},
    {"id": "smoke", "state": "works", "by": "plastico", "needs": "godot",
     "text": "Run the game's tests/smoke_test.tscn headless (needs the godot command)."},
    {"id": "puzzle-ids", "state": "planned", "by": "puzzles",
     "text": "Check each puzzle step's game id against the items and flags in the game."},
    {"id": "puzzle-build", "state": "planned", "by": "puzzles",
     "text": "Build puzzle steps (items, flags, hotspot actions) into the game."},
    {"id": "editor", "state": "planned", "by": "core",
     "text": "Open a scene in the Godot editor from Cassetto."},
]


def find_games(base: Path | None = None) -> list[dict]:
    """The Godot games in ~/Desktop/Projects (and one folder down), for "Start from a Godot game"."""
    return _godot.find_godot_projects(base or Path.home() / "Desktop" / "Projects")


def godot_binary() -> str:
    return shutil.which("godot") or shutil.which("godot4") or ""


def status(path: str) -> dict:
    """What Cassetto knows about the linked game. Never raises: a broken link is a status, not an error."""
    out = {"linked": bool(path), "path": path or "", "found": False, "name": "", "editor_open": False,
           "godot_command": godot_binary(), "capabilities": CAPABILITIES}
    if not path:
        return out
    p = Path(path).expanduser()
    if not _godot.is_godot_project(p):
        out["problem"] = f"{p} isn't a Godot project any more (no project.godot)."
        return out
    out["found"] = True
    try:
        out["name"] = _godot.read_project_godot(p)["name"]
        out["editor_open"] = _godot.editor_open(p)
    except OSError as e:
        out["problem"] = f"Couldn't read {p}: {e}"
    return out
