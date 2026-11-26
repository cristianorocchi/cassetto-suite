"""The suite's core: the open project, the modules and the interfaces they talk through.

A module is one tool of the suite (Plastico, Puzzle Charts). It:
  - owns one folder of the project (``ctx.data_dir``) and a data version of its own;
  - is opened when a project opens and closed when it closes (``open`` / ``close``);
  - answers HTTP requests under the paths it claims (``api_prefixes`` and ``handle``);
  - serves a page from ``web_dir``, which the shell shows in its own frame;
  - offers named interfaces to the other modules (``provides``) and uses theirs through
    ``ctx.require`` / ``ctx.optional``, never by importing them.

The core never reads a module's files. It knows only the manifest, the interfaces and the events.
"""
from __future__ import annotations

import shutil
import threading
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from . import project as projects
from .events import EventLog


def _empty(folder: Path) -> None:
    for c in folder.iterdir():
        shutil.rmtree(c, ignore_errors=True) if c.is_dir() else c.unlink(missing_ok=True)


class MissingInterface(Exception):
    def __init__(self, name: str, why: str = ""):
        super().__init__(why or f"Nothing in this project offers {name!r}.")
        self.name = name


class NoProject(Exception):
    def __init__(self):
        super().__init__("No project is open.")


@dataclass
class Interface:
    """One function a module offers to the others. `doc` says what it takes and returns."""
    name: str
    fn: Callable
    doc: str = ""
    owner: str = ""


@dataclass
class ModuleContext:
    """What a module gets when a project opens: its folder, and the way to reach the rest of the suite."""
    core: "Core"
    module_id: str
    project: projects.Project
    data_dir: Path
    stored_version: int | None      # the module's data version in this project, None if it never wrote

    def emit(self, type_: str, **data) -> None:
        self.core.events.publish(type_, self.module_id, **data)

    def require(self, name: str, *args, **kw):
        return self.core.call(name, *args, caller=self.module_id, **kw)

    def optional(self, name: str, *args, default=None, **kw):
        try:
            return self.core.call(name, *args, caller=self.module_id, **kw)
        except MissingInterface:
            return default


class Module:
    id = ""
    title = ""
    data_version = 1
    web_dir: Path | None = None
    api_prefixes: tuple[str, ...] = ()     # first path parts after /api/ that this module answers

    def __init__(self) -> None:
        self.ctx: ModuleContext | None = None

    # lifecycle
    def open(self, ctx: ModuleContext) -> None:
        self.ctx = ctx

    def close(self) -> None:
        self.ctx = None

    # what the module offers
    def provides(self) -> list[Interface]:
        return []

    def handle(self, h, method: str, parts: list[str], q: dict):
        return h._err(404, "no such API")

    def page(self, html: str) -> str:
        """The module's page as the shell serves it (a module may point CDN assets at local copies)."""
        return html

    def fingerprint(self) -> str:
        """Changes whenever the module's data on disk changes, by Cassetto or by anyone else."""
        return ""

    def changed_event(self) -> str:
        return f"{self.id}.changed"

    def summary(self) -> dict:
        return {}

    def project_renamed(self, name: str) -> None:
        """The project got a new name (the shell's project menu)."""

    def seed(self, source: dict) -> None:
        """Fills a new project from what the person chose to start from (see Core.create_project)."""


class Core:
    def __init__(self, modules: list[Module]):
        self.modules: dict[str, Module] = {}
        for m in modules:
            if m.id in self.modules:
                raise ValueError(f"two modules called {m.id}")
            self.modules[m.id] = m
        self.events = EventLog()
        self.project: projects.Project | None = None
        self._interfaces: dict[str, Interface] = {}
        self._lock = threading.RLock()
        self._prints: dict[str, str] = {}
        self._watch_stop = threading.Event()
        self._watcher: threading.Thread | None = None
        self.last_error = ""

    # --- interfaces ---
    def interfaces(self) -> list[dict]:
        return [{"name": i.name, "owner": i.owner, "doc": i.doc} for i in sorted(self._interfaces.values(), key=lambda i: i.name)]

    def call(self, name: str, *args, caller: str = "", **kw):
        if self.project is None:
            raise NoProject()
        i = self._interfaces.get(name)
        if i is None:
            raise MissingInterface(name)
        if i.owner == caller:
            raise ValueError(f"{caller} called its own interface {name} through the core")
        return i.fn(*args, **kw)

    def optional(self, name: str, *args, default=None, **kw):
        try:
            return self.call(name, *args, **kw)
        except (MissingInterface, NoProject):
            return default

    # --- the open project ---
    def _open_modules(self, p: projects.Project) -> None:
        opened: list[Module] = []
        try:
            for m in self.modules.values():
                stored = p.module_version(m.id)
                if stored is not None and stored > m.data_version:
                    raise projects.ProjectError(
                        f"This project's {m.title} data was saved by a newer Cassetto (version {stored}; this one "
                        f"reads up to {m.data_version}). Update Cassetto to open it.")
                ctx = ModuleContext(self, m.id, p, p.module_dir(m.id), stored)
                m.open(ctx)
                opened.append(m)
                p.set_module_version(m.id, m.data_version)
            for m in opened:
                for i in m.provides():
                    i.owner = m.id
                    self._interfaces[i.name] = i
        except Exception:
            for m in reversed(opened):
                try:
                    m.close()
                except Exception:  # noqa: BLE001
                    traceback.print_exc()
            self._interfaces.clear()
            raise

    def open_project(self, path: Path) -> projects.Project:
        with self._lock:
            p = projects.load(Path(path))
            if self.project and self.project.path == p.path:
                return self.project
            self.close_project()
            p.lock()
            try:
                self._open_modules(p)
            except Exception:
                p.unlock()
                raise
            self.project = p
            self.last_error = ""
            projects.remember(p)
            self._prints = {mid: m.fingerprint() for mid, m in self.modules.items()}
            self.events.publish("project.opened", "core", project=p.info())
            self._start_watch()
            return p

    def create_project(self, path: Path, name: str, start: dict | None = None) -> projects.Project:
        """A new project. `start` says what to fill it from, per module: {"plastico": {...}, "puzzles": {...}}."""
        with self._lock:
            existed = Path(path).expanduser().exists()
            p = projects.create(Path(path), name)
            self.close_project()
            try:
                self.open_project(p.path)
                for mid, src in (start or {}).items():
                    m = self.modules.get(mid)
                    if m and src:
                        m.seed(src)
            except Exception:
                # the folder was new or empty: leave nothing half made behind
                self.close_project()
                shutil.rmtree(p.path, ignore_errors=True) if not existed else _empty(p.path)
                projects.forget(str(p.path))
                raise
            self._prints = {mid: m.fingerprint() for mid, m in self.modules.items()}
            return self.project  # type: ignore[return-value]

    def close_project(self) -> None:
        with self._lock:
            if self.project is None:
                return
            self._stop_watch()
            for m in reversed(list(self.modules.values())):
                try:
                    m.close()
                except Exception:  # noqa: BLE001
                    traceback.print_exc()
            self._interfaces.clear()
            old = self.project
            self.project = None
            old.unlock()
            self.events.publish("project.closed", "core", path=str(old.path))

    def rename_project(self, name: str) -> None:
        if self.project is None:
            raise NoProject()
        self.project.rename(name)
        projects.remember(self.project)
        for m in self.modules.values():
            m.project_renamed(self.project.name)
            self._prints[m.id] = self._safe(m.fingerprint) or ""
        self.events.publish("project.renamed", "core", name=self.project.name)

    def state(self) -> dict:
        p = self.project
        return {
            "project": p.info() if p else None,
            "modules": [{"id": m.id, "title": m.title, "version": m.data_version, "page": f"/m/{m.id}/",
                         "summary": (self._safe(m.summary) or {}) if p else {}} for m in self.modules.values()],
            "interfaces": self.interfaces() if p else [],
            "seq": self.events.seq,
            "error": self.last_error,
        }

    @staticmethod
    def _safe(fn):
        try:
            return fn()
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            return None

    # --- changes made outside the app (a text editor, git, Claude) ---
    def check_changes(self, quiet: str = "") -> list[str]:
        """Compares each module's fingerprint with the last one seen and announces the ones that moved.
        `quiet` is a module that already announced its own change."""
        changed = []
        with self._lock:
            if self.project is None:
                return changed
            for mid, m in self.modules.items():
                fp = self._safe(m.fingerprint) or ""
                if fp != self._prints.get(mid):
                    self._prints[mid] = fp
                    if mid != quiet:
                        changed.append(mid)
        for mid in changed:
            self.events.publish(self.modules[mid].changed_event(), "disk", external=True)
        return changed

    def settle(self, module_id: str, **data) -> bool:
        """After a request a module answered: if its data changed, announce it (as the module's own
        change, so it isn't announced again as an outside one). True if it changed."""
        with self._lock:
            if self.project is None or module_id not in self.modules:
                return False
            m = self.modules[module_id]
            fp = self._safe(m.fingerprint) or ""
            if fp == self._prints.get(module_id):
                return False
            self._prints[module_id] = fp
        self.events.publish(m.changed_event(), module_id, **data)
        return True

    def _start_watch(self, every: float = 2.0) -> None:
        self._watch_stop.clear()

        def run():
            while not self._watch_stop.wait(every):
                try:
                    self.check_changes()
                except Exception:  # noqa: BLE001
                    traceback.print_exc()
        self._watcher = threading.Thread(target=run, name="cassetto-watch", daemon=True)
        self._watcher.start()

    def _stop_watch(self) -> None:
        self._watch_stop.set()
        if self._watcher and self._watcher is not threading.current_thread():
            self._watcher.join(timeout=3)
        self._watcher = None

