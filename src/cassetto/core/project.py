"""A Cassetto project on disk: one folder with a manifest and one sub-folder per module.

    My game/
      cassetto.json          the manifest: format and version, name, which modules wrote data, and at which version
      plastico/              Plastico's data (the world plan, its history and sketches)
      puzzles/               Puzzle Charts' data (one file per chart)
      backups/               what Godot builds replaced

The manifest is the only file the core owns. Each module owns its folder and its own data version;
the core records those versions so a newer project is refused instead of being misread.
"""
from __future__ import annotations

import json
import os
import re
import time
import uuid
from pathlib import Path

from .. import __version__
from ..paths import config_dir

MANIFEST = "cassetto.json"
FORMAT = "cassetto.project"
VERSION = 1          # bump when the manifest or the folder layout changes; add a migration below
LOCK = ".cassetto.lock"
RECENT_KEEP = 12


class ProjectError(Exception):
    """A project that can't be opened or written, with a message for the person using the app."""


# From version N to N+1: a function that takes the manifest (and the folder) and returns it updated.
MIGRATIONS: dict[int, callable] = {}


def _write_json(path: Path, data: dict | list) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    tmp.replace(path)


def is_project(path: Path) -> bool:
    return (Path(path) / MANIFEST).is_file()


def _pid_alive(pid: int) -> bool:
    """True if `pid` is a running Cassetto (a lock left by one that crashed doesn't count)."""
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    try:
        cmd = Path(f"/proc/{pid}/cmdline").read_bytes().decode("utf-8", "replace").lower()
    except OSError:
        return True      # no /proc (not Linux): trust the pid
    return "cassetto" in cmd


class Project:
    def __init__(self, path: Path, manifest: dict):
        self.path = Path(path).resolve()
        self.manifest = manifest

    # --- what the rest of the app reads ---
    @property
    def id(self) -> str:
        return self.manifest["id"]

    @property
    def name(self) -> str:
        return self.manifest["name"]

    def module_dir(self, module_id: str) -> Path:
        if not re.match(r"^[a-z][a-z0-9_-]*$", module_id):
            raise ValueError(f"bad module id {module_id!r}")
        d = self.path / module_id
        d.mkdir(parents=True, exist_ok=True)
        return d

    @property
    def backups_dir(self) -> Path:
        return self.path / "backups"

    def module_version(self, module_id: str) -> int | None:
        m = self.manifest.get("modules", {}).get(module_id)
        return int(m["version"]) if isinstance(m, dict) and "version" in m else None

    def info(self) -> dict:
        return {"id": self.id, "name": self.name, "path": str(self.path), "format": FORMAT,
                "version": self.manifest["version"], "created": self.manifest.get("created", 0),
                "modules": self.manifest.get("modules", {})}

    # --- writing ---
    def save(self) -> None:
        self.manifest["updated"] = int(time.time() * 1000)
        self.manifest["app"] = f"cassetto {__version__}"
        _write_json(self.path / MANIFEST, self.manifest)

    def set_module_version(self, module_id: str, version: int) -> None:
        mods = self.manifest.setdefault("modules", {})
        if (mods.get(module_id) or {}).get("version") != version:
            mods[module_id] = {"version": version}
            self.save()

    def rename(self, name: str) -> None:
        name = name.strip()
        if not name:
            raise ProjectError("A project needs a name.")
        self.manifest["name"] = name[:120]
        self.save()

    # --- one app at a time per project ---
    def lock(self) -> None:
        f = self.path / LOCK
        if f.exists():
            try:
                pid = int(f.read_text().strip() or 0)
            except (OSError, ValueError):
                pid = 0
            if pid != os.getpid() and _pid_alive(pid):
                raise ProjectError(f"{self.name} is already open in another Cassetto window (process {pid}). "
                                   "Close it there first.")
        try:
            f.write_text(str(os.getpid()))
        except OSError as e:
            raise ProjectError(f"Can't write to {self.path}: {e.strerror}. Is the folder read-only?") from e

    def unlock(self) -> None:
        f = self.path / LOCK
        try:
            if f.exists() and f.read_text().strip() == str(os.getpid()):
                f.unlink()
        except OSError:
            pass


def create(path: Path, name: str) -> Project:
    path = Path(path).expanduser()
    if is_project(path):
        raise ProjectError(f"There is already a Cassetto project in {path}.")
    if path.exists() and not path.is_dir():
        raise ProjectError(f"{path} is a file, not a folder.")
    if path.exists() and any(p for p in path.iterdir() if not p.name.startswith(".")):
        raise ProjectError(f"{path} isn't empty. Pick an empty folder, or a new one.")
    now = int(time.time() * 1000)
    manifest = {"format": FORMAT, "version": VERSION, "id": uuid.uuid4().hex[:12], "name": name.strip() or path.name,
                "created": now, "updated": now, "app": f"cassetto {__version__}", "modules": {}}
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise ProjectError(f"Can't make the folder {path}: {e.strerror}.") from e
    p = Project(path, manifest)
    p.save()
    return p


def load(path: Path) -> Project:
    """Reads and checks the manifest, migrating it to the current version when it's older."""
    path = Path(path).expanduser()
    f = path / MANIFEST
    if not f.is_file():
        raise ProjectError(f"{path} isn't a Cassetto project (there's no {MANIFEST} in it).")
    try:
        m = json.loads(f.read_text(encoding="utf-8"))
    except ValueError as e:
        raise ProjectError(f"The project file {f} is damaged and can't be read ({e}).") from e
    except OSError as e:
        raise ProjectError(f"Can't read {f}: {e.strerror}.") from e
    if not isinstance(m, dict) or m.get("format") != FORMAT:
        raise ProjectError(f"{f} isn't a Cassetto project file.")
    v = m.get("version")
    if not isinstance(v, int) or v < 1:
        raise ProjectError(f"{f} has no valid format version.")
    if v > VERSION:
        raise ProjectError(f"This project was saved by a newer Cassetto (project format {v}; this one reads up "
                           f"to {VERSION}). Update Cassetto to open it.")
    migrated = False
    while v < VERSION:
        step = MIGRATIONS.get(v)
        if step is None:
            raise ProjectError(f"No way to bring project format {v} up to {VERSION}.")
        m = step(m, path)
        v += 1
        m["version"] = v
        migrated = True
    m.setdefault("id", uuid.uuid4().hex[:12])
    m.setdefault("name", path.name)
    m.setdefault("modules", {})
    p = Project(path, m)
    if migrated:
        p.save()
    return p


# --- recent projects (per user, not per project) ---

def _recent_file() -> Path:
    return config_dir() / "recent.json"


def recent() -> list[dict]:
    try:
        data = json.loads(_recent_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    out = []
    for r in data if isinstance(data, list) else []:
        if isinstance(r, dict) and r.get("path"):
            r["exists"] = is_project(Path(r["path"]))
            out.append(r)
    return out


def remember(p: Project) -> None:
    items = [r for r in recent() if r.get("path") != str(p.path)]
    items.insert(0, {"path": str(p.path), "name": p.name, "opened": int(time.time() * 1000)})
    _write_json(_recent_file(), items[:RECENT_KEEP])


def forget(path: str) -> None:
    _write_json(_recent_file(), [r for r in recent() if r.get("path") != path])
