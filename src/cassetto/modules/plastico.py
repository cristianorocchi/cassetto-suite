"""Plastico as a Cassetto module.

Plastico itself is unchanged (plastico/): its page, its checks, its Godot reading and building. Here it
gets the project's folder instead of its own worlds/ folder, one world per project, and the puzzle charts
live from the Puzzle Charts module instead of a copy synced by Claude.

Data:   <project>/plastico/world.json (the plan), world.files/ (sketches), .history/world/ (last 60 saves)
        <project>/backups/world/<time>/ (what each Godot build replaced)
Offers: world.catalog   the scenes, people, times of day and acts, for the other modules
Uses:   puzzles.charts  the charts, to list the steps in each scene and find where locks get their keys
"""
from __future__ import annotations

import json
from pathlib import Path

import plastico as _pkg
from plastico import apply, store
from plastico import server as pserver

from ..core.modules import Interface, Module
from ..core.project import ProjectError
from ..paths import PLASTICO_WEB

WORLD = "world"
WORLD_VERSION = store.VERSION      # plastico.store's "v" (2: grid sizes, scenes inside scenes, charts per scene)


class PlasticoModule(Module):
    id = "plastico"
    title = "Plastico"
    data_version = 2      # 2: the world is at store version 2 (opening a version 1 project brings it up)
    web_dir = PLASTICO_WEB
    api_prefixes = ("worlds", "godot-projects")

    def __init__(self) -> None:
        super().__init__()
        self._saved_paths = (_pkg.WORLDS, apply.BACKUPS)

    # --- lifecycle ---
    def open(self, ctx) -> None:
        super().open(ctx)
        root = ctx.data_dir
        f = store.world_path(WORLD, root)
        if f.exists():
            try:
                raw = json.loads(f.read_text(encoding="utf-8"))
            except ValueError as e:
                raise ProjectError(f"Plastico's world in this project is damaged and can't be read ({f}: {e}). "
                                   f"The last good saves are in {root / '.history' / WORLD}.") from e
            if int(raw.get("v", 1)) > WORLD_VERSION:
                raise ProjectError("This project's world was saved by a newer Plastico. Update Cassetto to open it.")
        _pkg.WORLDS = root
        apply.BACKUPS = ctx.project.backups_dir
        pserver.set_charts_source(self._charts)
        if not f.exists():
            store.save(store.blank_world(WORLD, ctx.project.name), root=root)
        else:
            self.project_renamed(ctx.project.name)

    def close(self) -> None:
        pserver.set_charts_source(None)
        _pkg.WORLDS, apply.BACKUPS = self._saved_paths
        super().close()

    def project_renamed(self, name: str) -> None:
        w = store.load(WORLD, self.ctx.data_dir)
        if w["name"] != name:
            w["name"] = name
            store.save(w, root=self.ctx.data_dir)

    def seed(self, source: dict) -> None:
        """A new project starts from a Godot game (its scenes and exits) or from a Plastico world file."""
        root = self.ctx.data_dir
        if source.get("godot"):
            from plastico import godot
            proj = str(Path(source["godot"]).expanduser())
            if not godot.is_godot_project(Path(proj)):
                raise ProjectError(f"{proj} isn't a Godot project (no project.godot in it).")
            w = store.load(WORLD, root)
            w["godot"] = proj
            store.save(w, root=root)
        if source.get("world_file"):
            src = Path(source["world_file"]).expanduser()
            try:
                w = json.loads(src.read_text(encoding="utf-8"))
            except (OSError, ValueError) as e:
                raise ProjectError(f"Couldn't read the Plastico world {src}: {e}") from e
            if not isinstance(w, dict) or not isinstance(w.get("scenes"), list):
                raise ProjectError(f"{src} isn't a Plastico world.")
            w["id"] = WORLD
            w["name"] = self.ctx.project.name
            store.save(w, root=root)
            pics = src.with_suffix(".files")
            if pics.is_dir():
                import shutil
                shutil.copytree(pics, store.files_dir(WORLD, root), dirs_exist_ok=True)

    # --- what the others get ---
    def _charts(self, wid: str):
        return self.ctx.optional("puzzles.charts") if self.ctx else None

    def catalog(self) -> dict:
        w = store.load(WORLD, self.ctx.data_dir)
        return {
            "world": w["name"], "updated": w.get("updated", 0),
            "scenes": [[s["id"], s["name"]] for s in w["scenes"] if not s.get("delete")],
            "people": [[p["id"], p["name"] or p["id"]] for p in w["people"]],
            "phases": list(w.get("phases") or []),
            "acts": [[a["id"], a.get("name", "")] for a in w["acts"]],
            "start": w.get("start", ""),
            "godot": w.get("godot", ""),
            # the project's structure, for the tree: every scene with its act, the scene it is in, its charts
            "hierarchy": [{"id": s["id"], "name": s["name"], "act": s["act"], "parent": s.get("parent", ""),
                           "charts": list(s.get("charts") or []), "kind": s["kind"], "delete": bool(s.get("delete"))}
                          for s in w["scenes"]],
        }

    def provides(self) -> list[Interface]:
        return [Interface("world.catalog", self.catalog,
                          "() -> {world, scenes: [[id, name]], people: [[id, name]], phases, acts: [[id, name]], start, godot, "
                          "hierarchy: [{id, name, act, parent, charts, kind, delete}]}. `scenes` leaves out scenes marked "
                          "to delete; `hierarchy` has them all, each with the scene it is in and the chart ids associated with it.")]

    # --- HTTP: Plastico's own API, one world per project ---
    def handle(self, h, method: str, parts: list[str], q: dict):
        if parts == ["worlds"] and method == "POST":
            return h._err(403, "In Cassetto a project has one world. Make a new project for another world.")
        if len(parts) >= 2 and parts[0] == "worlds" and parts[1] != WORLD:
            return h._err(404, "no such world in this project")
        if parts == ["worlds", WORLD] and method == "DELETE":
            return h._err(403, "The world is the project's: close or delete the project instead.")
        return pserver.handle(h, method, "/".join(parts), q)

    def page(self, html: str) -> str:
        """Plastico's page with the suite's bridge, so it can follow the project and reach Puzzle Charts."""
        tag = '<script type="module"'
        i = html.find(tag)
        bridge = '<script src="/shared/cassetto-bridge.js"></script>\n'
        return html[:i] + bridge + html[i:] if i >= 0 else html + bridge

    def fingerprint(self) -> str:
        root = self.ctx.data_dir if self.ctx else None
        if root is None:
            return ""
        parts = []
        for f in (store.world_path(WORLD, root),):
            try:
                st = f.stat()
                parts.append(f"{st.st_mtime_ns}:{st.st_size}")
            except OSError:
                parts.append("-")
        fd = store.files_dir(WORLD, root)
        if fd.is_dir():
            parts.append(",".join(sorted(p.name for p in fd.iterdir())))
        return "|".join(parts)

    def changed_event(self) -> str:
        return "world.changed"

    def summary(self) -> dict:
        w = store.load(WORLD, self.ctx.data_dir)
        return {"scenes": len([s for s in w["scenes"] if not s.get("delete")]), "ways": len(w["links"]),
                "godot": w.get("godot", "")}
