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
import shutil
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
    if os.name == "nt":
        return _pid_alive_windows(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass             # alive but another user's (pid 1 after a reboot): its command line still tells
    try:
        cmd = Path(f"/proc/{pid}/cmdline").read_bytes().decode("utf-8", "replace").lower()
    except OSError:
        return True      # no /proc (not Linux): trust the pid
    return "cassetto" in cmd


def _pid_alive_windows(pid: int) -> bool:
    """Windows has no os.kill(pid, 0): it sends Ctrl+C there. Ask the process itself, and count it only
    if it is a Python or a packaged Cassetto (a pid left by a crash may belong to something else now)."""
    import ctypes
    from ctypes import wintypes
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    k32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
    k32.QueryFullProcessImageNameW.argtypes = (wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD))
    k32.CloseHandle.argtypes = (wintypes.HANDLE,)
    h = k32.OpenProcess(0x1000, False, pid)     # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return ctypes.get_last_error() == 5     # access denied: it runs, as someone else; anything else: gone
    try:
        code = wintypes.DWORD()
        if not k32.GetExitCodeProcess(h, ctypes.byref(code)) or code.value != 259:     # STILL_ACTIVE
            return False
        buf, size = ctypes.create_unicode_buffer(1024), wintypes.DWORD(1024)
        if not k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return True      # can't tell what it is: trust the pid
        exe = Path(buf.value).name.lower()
        return "python" in exe or "cassetto" in exe
    finally:
        k32.CloseHandle(h)


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


# --- a project as one file (export / import) ---
# A .cassetto file is a zip of the project folder: the manifest and every module's folder, under one top folder
# named after the project. The lock and half-written files stay out.

EXPORT_SUFFIX = ".cassetto"
EXPORT_SKIP = {LOCK}
IMPORT_MAX_BYTES = 2 * 1024 ** 3        # unpacked: a damaged or hostile file can't fill the disk
IMPORT_MAX_FILES = 50_000


def export_file(p: Project, dest: Path) -> Path:
    """Writes the whole project to `dest` (a .cassetto file) and returns where it went."""
    import zipfile
    dest = Path(dest).expanduser()
    if dest.is_dir():
        dest = dest / (_file_name(p.name) + EXPORT_SUFFIX)
    if dest.suffix != EXPORT_SUFFIX:
        dest = dest.with_name(dest.name + EXPORT_SUFFIX)
    dest = dest.resolve()
    if dest == p.path or p.path in dest.parents:
        raise ProjectError("Save the exported file outside the project's own folder.")
    top = _file_name(p.name)
    tmp = dest.with_name(dest.name + ".tmp")
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            for f in sorted(p.path.rglob("*")):
                rel = f.relative_to(p.path)
                if f.is_symlink() or not f.is_file() or rel.name in EXPORT_SKIP or rel.name.endswith(".tmp"):
                    continue
                z.write(f, f"{top}/{rel.as_posix()}")
        tmp.replace(dest)
    except OSError as e:
        tmp.unlink(missing_ok=True)
        raise ProjectError(f"Can't write {dest}: {e.strerror or e}.") from e
    return dest


def import_file(src: Path, into: Path) -> Path:
    """Unpacks a .cassetto file into a new folder inside `into` and returns that folder (not opened yet).
    The folder takes the project's name, with " 2", " 3"… when one by that name is already there."""
    import zipfile
    src = Path(src).expanduser()
    if not src.is_file():
        raise ProjectError(f"There's no file {src}.")
    try:
        z = zipfile.ZipFile(src)
    except (zipfile.BadZipFile, OSError) as e:
        raise ProjectError(f"{src.name} isn't an exported Cassetto project (or it's damaged).") from e
    with z:
        infos = [i for i in z.infolist() if not i.is_dir()]
        names = [i.filename for i in infos]
        # the manifest sits at the top, or in the one folder at the top
        if MANIFEST in names:
            root = ""
        else:
            tops = {n.split("/", 1)[0] for n in names}
            root = next(iter(tops)) + "/" if len(tops) == 1 and f"{next(iter(tops))}/{MANIFEST}" in names else None
        if root is None:
            raise ProjectError(f"{src.name} has no Cassetto project in it (no {MANIFEST}).")
        try:
            m = json.loads(z.read(root + MANIFEST).decode("utf-8"))
        except (ValueError, KeyError, UnicodeDecodeError) as e:
            raise ProjectError(f"The project file in {src.name} is damaged and can't be read.") from e
        if not isinstance(m, dict) or m.get("format") != FORMAT:
            raise ProjectError(f"{src.name} has no Cassetto project in it.")
        if isinstance(m.get("version"), int) and m["version"] > VERSION:
            raise ProjectError(f"{src.name} was saved by a newer Cassetto (project format {m['version']}; this one "
                               f"reads up to {VERSION}). Update Cassetto to import it.")
        if len(infos) > IMPORT_MAX_FILES or sum(i.file_size for i in infos) > IMPORT_MAX_BYTES:
            raise ProjectError(f"{src.name} is too big to be a Cassetto project.")
        into = Path(into).expanduser()
        base = _file_name(str(m.get("name") or src.stem))
        dest, n = into / base, 2
        while dest.exists():
            dest, n = into / f"{base} {n}", n + 1
        tmp = into / f".{dest.name}.importing"
        shutil.rmtree(tmp, ignore_errors=True)
        try:
            for i in infos:
                if not i.filename.startswith(root):
                    continue
                rel = Path(i.filename[len(root):])
                if rel.is_absolute() or ".." in rel.parts or not rel.parts or rel.name == LOCK:
                    continue      # nothing gets written outside the new folder
                out = tmp / rel
                out.parent.mkdir(parents=True, exist_ok=True)
                with z.open(i) as r, open(out, "wb") as w:
                    shutil.copyfileobj(r, w)
            tmp.rename(dest)
        except OSError as e:
            shutil.rmtree(tmp, ignore_errors=True)
            raise ProjectError(f"Can't unpack the project into {into}: {e.strerror or e}.") from e
    return dest


def _file_name(name: str) -> str:
    keep = "".join(c if c.isalnum() or c in " -_." else "-" for c in name).strip(" .")
    return keep[:80] or "Project"
