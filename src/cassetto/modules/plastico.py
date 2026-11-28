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
import time
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

    def _game_scenes(self, w: dict) -> dict:
        """The game's scenes as Godot has them now ({id: scan}), for who is where. Read again only when a scene
        file or a character folder changes (or after half a minute), so the catalog stays quick."""
        path = str(w.get("godot") or "")
        if not path:
            return {}
        try:
            from plastico import godot
            proj = Path(path)
            if not godot.is_godot_project(proj):
                return {}
            files = [f for d in ("scenes", "characters") if (proj / d).is_dir() for f in (proj / d).rglob("*") if f.suffix in (".tscn", ".gd", "")]
            stamp = (path, len(files), max((f.stat().st_mtime_ns for f in files), default=0))
            hit = getattr(self, "_game_cache", None)
            if hit and hit[0] == stamp and time.monotonic() - hit[1] < 30:
                return hit[2]
            scenes = {sid: g for sid, g in godot.scan(proj)["scenes"].items() if g.get("exists")}
            self._game_cache = (stamp, time.monotonic(), scenes)
            return scenes
        except Exception:  # noqa: BLE001 - the game unreadable: the plan alone says who is where
            return {}

    @staticmethod
    def _people_at(w: dict, game: dict) -> dict:
        """{scene: {time of day: [person ids]}}: who is in each scene when. The game's own people (less the ones
        the plan takes away from it) and the ones the plan adds, as Plastico's People here shows them."""
        out = {}
        for s in w["scenes"]:
            if s.get("delete"):
                continue
            gp = (game.get(s["id"]) or {}).get("people") or {}
            away, plan = s.get("away") or {}, s.get("people") or {}
            per = {}
            for ph in list(dict.fromkeys(list(w.get("phases") or []) + list(gp) + list(plan))):
                ids = [i for i in gp.get(ph) or [] if i not in (away.get(ph) or [])]
                ids += [i for i in plan.get(ph) or [] if i not in ids]
                if ids:
                    per[ph] = ids
            if per:
                out[s["id"]] = per
        return out

    def catalog(self) -> dict:
        w = store.load(WORLD, self.ctx.data_dir)
        # Which charts go with a scene: every chart with a step placed in it (counted), plus the ones pinned
        # to it by hand in Plastico (a chart planned for a scene before it has steps there).
        from_steps: dict[str, dict[str, int]] = {}
        charts = self._charts(WORLD) or {}
        for c in charts.get("charts", []):
            for n in c.get("nodes", []):
                sid = n.get("scene")
                if sid and n.get("kind") not in ("goal", "setup"):
                    per = from_steps.setdefault(sid, {})
                    per[c["id"]] = per.get(c["id"], 0) + 1

        def scene_charts(s):
            pinned = list(s.get("charts") or [])
            derived = from_steps.get(s["id"], {})
            return pinned + [cid for cid in derived if cid not in pinned], pinned, derived

        game = self._game_scenes(w)
        hierarchy = []
        for s in w["scenes"]:
            allc, pinned, derived = scene_charts(s)
            hierarchy.append({"id": s["id"], "name": s["name"], "act": s["act"], "parent": s.get("parent", ""),
                              "in_game": s["id"] in game, "status": s.get("status", ""),
                              "charts": allc, "charts_pinned": pinned, "charts_from_steps": derived,
                              "steps": sum(derived.values()), "kind": s["kind"], "delete": bool(s.get("delete"))})
        return {
            "world": w["name"], "updated": w.get("updated", 0),
            "scenes": [[s["id"], s["name"]] for s in w["scenes"] if not s.get("delete")],
            "people": [[p["id"], p["name"] or p["id"]] for p in w["people"]],
            "phases": list(w.get("phases") or []),
            "acts": [[a["id"], a.get("name", "")] for a in w["acts"]],
            "start": w.get("start", ""),
            "godot": w.get("godot", ""),
            # the project's structure, for the tree: every scene with its act, the scene it is in, its charts
            "hierarchy": hierarchy,
            # who is in each scene at each time of day, so a step's Who can offer the people there and say who isn't
            "people_at": self._people_at(w, game),
            # the locked ways, so a step that gives an item or sets a flag can say which lock it opens
            "locks": [{"from": l["from"], "to": l["to"], "needs": l["lock"]["needs"], "type": l["lock"].get("type", "item"),
                       "where": l["lock"].get("where", "")}
                      for l in w["links"] if isinstance(l.get("lock"), dict) and l["lock"].get("needs") and not l.get("delete")],
        }

    # --- what the others can change: the world's people and scenes, from a puzzle step that needs one ---
    def _edit_world(self, change):
        with pserver._wlock(WORLD):
            w = store.load(WORLD, self.ctx.data_dir)
            out = change(w)
            store.save(w, root=self.ctx.data_dir)
        # by="suite": made for another module, so an open Plastico page reloads it (its own saves it already has)
        self.ctx.core.settle(self.id, added=out, by="suite")
        return out

    def add_person(self, name: str) -> str:
        """A new person in the world (or the one already called that). Returns their id."""
        name = " ".join(str(name or "").split())[:120]
        if not name:
            raise ValueError("A person needs a name.")

        def change(w):
            for p in w["people"]:
                if p["id"] == name or (p.get("name") or "").lower() == name.lower():
                    return p["id"]
            base = store.scene_id(name) or "person"
            pid, k = base, 2
            ids = {p["id"] for p in w["people"]}
            while pid in ids or pid == "player":
                pid, k = f"{base}_{k}", k + 1
            w["people"].append({"id": pid, "name": name})
            return pid
        return self._edit_world(change)

    def place_person(self, pid: str, scene: str, phases=None) -> list[str]:
        """Puts a person in a scene at those times of day (none: every time of day the world has), as a scene's
        People here does. Returns the times they were added at (empty if they were already there)."""
        def change(w):
            if not any(x["id"] == pid for x in w["people"]):
                raise ValueError(f"Nobody called {pid} in the world.")
            s = next((x for x in w["scenes"] if x["id"] == scene), None)
            if s is None:
                raise ValueError(f"No scene {scene} in the world.")
            all_ph = list(w.get("phases") or [])
            want = [ph for ph in (phases or all_ph) if ph in all_ph]
            added = []
            for ph in want:
                lst = s.setdefault("people", {}).setdefault(ph, [])
                away = (s.get("away") or {}).get(ph) or []
                if pid in away:
                    away.remove(pid)
                if pid not in lst:
                    lst.append(pid)
                    added.append(ph)
            return added
        return self._edit_world(change)

    def add_scene(self, name: str, act: str = "") -> str:
        """A new scene (an idea, indoors) in an act, at a free place on the map. Returns its id."""
        name = " ".join(str(name or "").split())[:120]
        if not name:
            raise ValueError("A scene needs a name.")

        def change(w):
            for s in w["scenes"]:
                if s["id"] == name or (s.get("name") or "").lower() == name.lower():
                    return s["id"]
            base = store.scene_id(name)
            sid, k = base, 2
            ids = {s["id"] for s in w["scenes"]}
            while sid in ids:
                sid, k = f"{base}_{k}", k + 1
            a = act if any(x["id"] == act for x in w["acts"]) else w["acts"][0]["id"]
            near = next(((s["x"] + 8, s["z"]) for s in w["scenes"] if s.get("act") == a and not s.get("delete")), None)
            wd, dd = store.SIZES[store.DEFAULT_KIND]
            x, z = store.free_spot(w, near, wd, dd, 0)
            w["scenes"].append({"id": sid, "name": name, "kind": store.DEFAULT_KIND, "act": a, "area": "", "x": x, "z": z,
                                "w": wd, "d": dd, "floor": 0, "status": "idea", "open": [], "people": {}, "notes": "",
                                "delete": False, "autoId": True, "parent": "", "charts": []})
            return sid
        return self._edit_world(change)

    def provides(self) -> list[Interface]:
        return [Interface("world.catalog", self.catalog,
                          "() -> {world, scenes: [[id, name]], people: [[id, name]], phases, acts: [[id, name]], start, godot, "
                          "hierarchy: [{id, name, act, parent, charts, charts_pinned, charts_from_steps, steps, kind, delete}], "
                          "locks: [{from, to, needs, type, where}]}. `scenes` leaves out scenes marked to delete; `hierarchy` "
                          "has them all, each with the scene it is in and its charts: the ones with steps placed in it "
                          "(charts_from_steps: chart id -> steps) and the ones pinned to it by hand."),
                Interface("world.add_person", self.add_person, "(name) -> id: a new person in the world, or the one already called that."),
                Interface("world.add_scene", self.add_scene, "(name, act) -> id: a new scene idea in that act, or the one already called that."),
                Interface("world.place_person", self.place_person,
                          "(person id, scene id, phases=None) -> [phases added]: puts the person in the scene at those times of day (none: all).")]

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
        bridge = '<script src="/shared/theme.js"></script>\n<script src="/shared/keys.js"></script>\n<script src="/shared/cassetto-bridge.js"></script>\n'
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
