"""Builds the plan in the Godot project: new scenes (grey stand-ins with their exits), new ways,
ways and scenes removed. Nothing happens while Godot has the project open.

Every build first copies each file it will touch into backups/<world>/<time>/ (a deleted scene's
folder is moved there whole), with a manifest, so `undo_last` can put everything back as long as
nobody has changed those files since.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import time
from pathlib import Path

from . import BACKUPS
from .godot import HOTSPOT_SCRIPT, editor_open, pascal, res_to_path
from .tscn import (Scene, Section, fmt_points, fmt_vec2, quote, string_name, vec2)

STAND_IN_NOTE = "Plastico put this here as a stand-in: move it where it belongs in the picture."


class BuildError(Exception):
    pass


# --- what differs between the plan and the game ---

def plan_changes(world: dict, game: dict | None) -> list[dict]:
    if not game:
        return []
    gs = {k: v for k, v in game["scenes"].items() if v.get("exists")}
    scenes = {s["id"]: s for s in world["scenes"]}
    names = {s["id"]: s["name"] for s in world["scenes"]}
    out: list[dict] = []
    creating = set()
    for s in world["scenes"]:
        if s.get("delete") or s["id"] in gs:
            continue
        creating.add(s["id"])
        out.append({"id": f"scene+{s['id']}", "op": "create_scene", "scene": s["id"], "name": s["name"],
                    "kind": "outside" if s["kind"] == "outside" else "inside", "ready": s["status"] == "ready",
                    "text": f"Make {s['name']} ({'outside, third person' if s['kind'] == 'outside' else 'inside, first person'}): a grey stand-in scene, listed in the SceneRouter",
                    "files": [f"scenes/{s['id']}/{s['id']}.tscn", f"scenes/{s['id']}/{s['id']}.gd", "autoload/scene_router.gd"]})
    by_pair: dict[tuple[str, str], list[dict]] = {}
    for e in game["exits"]:
        if e["to"]:
            by_pair.setdefault((e["from"], e["to"]), []).append(e)
    for l in world["links"]:
        pair = (l["from"], l["to"])
        a, b = names.get(l["from"], l["from"]), names.get(l["to"], l["to"])
        exits = by_pair.get(pair, [])
        if l.get("delete"):
            for e in exits:
                if e["via"] == "exit":
                    out.append({"id": f"exit-{l['from']}:{e['node']}", "op": "remove_exit", "scene": l["from"], "to": l["to"],
                                "node": e["node"], "hotspot": e["hotspot"], "ready": True, "mode": "remove",
                                "text": f"Remove the way from {a} to {b} (hotspot {e['hotspot']})",
                                "files": [f"scenes/{l['from']}/{l['from']}.tscn"]})
                else:
                    out.append({"id": f"script-{l['from']}:{e['file']}:{e['line']}", "op": "manual", "scene": l["from"],
                                "to": l["to"], "ready": False,
                                "text": f"The way from {a} to {b} is made in code ({e['file']}, line {e['line']}): change it there, by hand or with Claude",
                                "files": [e["file"]]})
            continue
        if exits or scenes.get(l["from"], {}).get("delete") or scenes.get(l["to"], {}).get("delete"):
            continue
        blocked = [x for x in pair if x not in gs and x not in creating]
        item = {"id": f"exit+{l['from']}>{l['to']}", "op": "add_exit", "scene": l["from"], "to": l["to"],
                "to_name": b, "via": l.get("via", ""), "ready": l["status"] == "ready",
                "text": (f"Lead the way {l['via']} in {a}, which goes nowhere yet, to {b}" if l.get("via")
                         else f"Add a way from {a} to {b} (a stand-in exit to place in the picture)"),
                "files": [f"scenes/{l['from']}/{l['from']}.tscn"] + (
                    [f"scenes/{l['to']}/{l['to']}.tscn"] if gs.get(l["to"], {}).get("kind") == "outside" or (
                        l["to"] in creating and scenes[l["to"]]["kind"] == "outside") else [])}
        if blocked:
            item["blocked"] = f"needs {', '.join(names.get(x, x) for x in blocked)} in the game first"
        out.append(item)
    for s in world["scenes"]:
        if s.get("delete") and s["id"] in gs:
            if s["id"] == game.get("start"):
                out.append({"id": f"scene-{s['id']}", "op": "delete_scene", "scene": s["id"], "name": s["name"], "ready": False,
                            "blocked": "it is where the game starts: make another scene the start first (project.godot, run/main_scene)",
                            "text": f"Delete {s['name']} from the game", "files": []})
                continue
            into = sorted({e["from"] for e in game["exits"] if e["to"] == s["id"] and e["from"] != s["id"] and e["via"] == "exit"})
            out.append({"id": f"scene-{s['id']}", "op": "delete_scene", "scene": s["id"], "name": s["name"], "ready": True,
                        "mode": "remove",
                        "text": f"Delete {s['name']}: its folder goes to Plastico's backups, it leaves the SceneRouter"
                                + (f", and the exits to it in {', '.join(names.get(x, x) for x in into)} go too" if into else ""),
                        "files": [f"scenes/{s['id']}/", "autoload/scene_router.gd"] + [f"scenes/{x}/{x}.tscn" for x in into]})
    return out


# --- backups ---

class Backup:
    def __init__(self, project: Path, world_id: str):
        self.project = project
        self.dir = BACKUPS / world_id / time.strftime("%Y%m%d-%H%M%S")
        k = 2
        while self.dir.exists():
            self.dir = self.dir.with_name(self.dir.name.split("~")[0] + f"~{k}")
            k += 1
        (self.dir / "files").mkdir(parents=True)
        self.entries: list[dict] = []
        self._seen: set[str] = set()

    def rel(self, p: Path) -> str:
        p = Path(p).resolve()
        if not p.is_relative_to(self.project):
            raise BuildError(f"{p} is outside the project")
        return str(p.relative_to(self.project))

    def touch(self, p: Path) -> None:
        """Call before writing or creating `p`."""
        rel = self.rel(p)
        if rel in self._seen:
            return
        self._seen.add(rel)
        if Path(p).exists():
            dst = self.dir / "files" / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, dst)
            self.entries.append({"path": rel, "kind": "file", "existed": True})
        else:
            self.entries.append({"path": rel, "kind": "file", "existed": False})

    def move_dir(self, d: Path) -> None:
        rel = self.rel(d)
        dst = self.dir / "files" / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(d), str(dst))
        self.entries.append({"path": rel, "kind": "dir", "existed": True})
        self._seen.add(rel)

    def finish(self, report: dict) -> None:
        after = {}
        for e in self.entries:
            p = self.project / e["path"]
            if e["kind"] == "file" and p.is_file():
                after[e["path"]] = _hash(p)
        manifest = {"project": str(self.project), "time": int(time.time() * 1000), "entries": self.entries,
                    "after": after, "report": report}
        (self.dir / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")


def _hash(p: Path) -> str:
    return hashlib.sha1(Path(p).read_bytes()).hexdigest()


def last_backup(world_id: str) -> dict | None:
    d = BACKUPS / world_id
    if not d.is_dir():
        return None
    for b in sorted(d.iterdir(), reverse=True):
        m = b / "manifest.json"
        if m.exists() and not (b / "undone").exists():
            data = json.loads(m.read_text(encoding="utf-8"))
            data["dir"] = str(b)
            return data
    return None


def undo_last(world_id: str) -> dict:
    b = last_backup(world_id)
    if b is None:
        raise BuildError("There is no build to undo.")
    project = Path(b["project"])
    if not (project / "project.godot").is_file():
        raise BuildError(f"The Godot project of that build isn't at {project} any more: nothing undone.")
    if editor_open(project):
        raise BuildError("Godot has the project open: close it first, then undo.")
    changed = [rel for rel, h in b["after"].items()
               if (project / rel).is_file() and _hash(project / rel) != h]
    if changed:
        raise BuildError("These files changed after the build, so undoing it would lose that work: "
                         + ", ".join(changed) + ". Use git to go back instead.")
    src = Path(b["dir"]) / "files"
    restored = []
    for e in reversed(b["entries"]):
        p = project / e["path"]
        if e["kind"] == "dir":
            if p.exists():
                raise BuildError(f"{e['path']} exists again: not overwriting it.")
            shutil.move(str(src / e["path"]), str(p))
        elif e["existed"]:
            p.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src / e["path"], p)
        else:
            # the file, and what Godot made for it since (script uids, import settings)
            for q in (p, p.with_name(p.name + ".uid"), p.with_name(p.name + ".import")):
                if q.exists():
                    q.unlink()
            # remove the folder a new scene was made in, if it is empty now
            parent = p.parent
            if parent != project and parent.exists() and not any(parent.iterdir()):
                parent.rmdir()
        restored.append(e["path"])
    (Path(b["dir"]) / "undone").write_text(str(int(time.time())), encoding="utf-8")
    return {"restored": restored, "build": b["report"]}


# --- writing ---

def _router_file(project: Path) -> Path:
    return project / "autoload" / "scene_router.gd"


def register_scene(project: Path, sid: str, bk: Backup) -> None:
    f = _router_file(project)
    if not f.exists():
        raise BuildError("This project has no autoload/scene_router.gd to list the scene in.")
    text = f.read_text(encoding="utf-8")
    m = re.search(r"const\s+SCENES\s*:?=\s*\{(.*?)\n\}", text, re.S)
    if not m:
        raise BuildError("Couldn't find `const SCENES := {` in scene_router.gd.")
    if re.search(rf'&"{re.escape(sid)}"\s*:', m.group(1)):
        return
    entry = f'\t&"{sid}": "res://scenes/{sid}/{sid}.tscn",\n'
    at = m.end(1) + 1   # just after the newline that ends the last entry
    bk.touch(f)
    f.write_text(text[:at] + entry + text[at:], encoding="utf-8")


def unregister_scene(project: Path, sid: str, bk: Backup) -> None:
    f = _router_file(project)
    if not f.exists():
        return
    text = f.read_text(encoding="utf-8")
    new = re.sub(rf'^[ \t]*&"{re.escape(sid)}"\s*:\s*"[^"]*"\s*,?[ \t]*\n', "", text, flags=re.M)
    if new != text:
        bk.touch(f)
        f.write_text(new, encoding="utf-8")


def _label_props(name: str, w: int, h: int) -> list[tuple[str, str]]:
    return [("offset_top", f"{h // 2 - 120}.0"), ("offset_right", f"{w}.0"), ("offset_bottom", f"{h // 2 + 120}.0"),
            ("theme_override_colors/font_color", "Color(0.86, 0.87, 0.89, 1)"),
            ("theme_override_font_sizes/font_size", "56"),
            ("text", quote(f"{name}\n(a stand-in made by Plastico: no art yet)")),
            ("horizontal_alignment", "1"), ("vertical_alignment", "1")]


def create_scene(project: Path, sid: str, name: str, kind: str, bk: Backup) -> list[str]:
    folder = project / "scenes" / sid
    if folder.exists():
        raise BuildError(f"scenes/{sid}/ already exists: Plastico won't overwrite it.")
    template = project / "core" / ("exterior_location.tscn" if kind == "outside" else "interior_location.tscn")
    if not template.exists():
        raise BuildError(f"This project has no {template.relative_to(project)} to make the scene from.")
    sc = Scene.load(template)
    base = "ExteriorLocation" if kind == "outside" else "InteriorLocation"
    w, h = (3840, 2160) if kind == "outside" else (1920, 1080)
    root = sc.root()
    # the scene's own script instead of the template's
    old_script = root.get("script")
    rid = str(old_script.args[0]) if old_script is not None else ""
    for s in sc.sections:
        if s.kind == "ext_resource" and s.attr("id") == rid:
            s.head = f'[ext_resource type="Script" path="res://scenes/{sid}/{sid}.gd" id="{rid}"]\n'
    root.head = re.sub(r'name="[^"]*"', f'name="{pascal(sid)}"', root.head, count=1)
    root.set_raw("scene_id", string_name(sid))
    hs = sc.ensure_ext_resource("Script", HOTSPOT_SCRIPT, "plastico_hotspot")
    # fresh unique ids
    for s in sc.nodes():
        s.head = re.sub(r"unique_id=\d+", lambda _m: f"unique_id={sc.new_unique_id()}", s.head)
    # a grey box with the scene's name, behind everything, ignoring the mouse
    grey = Section("node", f'[node name="Greybox" type="ColorRect" parent="." unique_id={sc.new_unique_id()}]\n',
                   [f"offset_right = {w}.0\n", f"offset_bottom = {h}.0\n", "mouse_filter = 2\n",
                    "color = Color(0.2, 0.21, 0.23, 1)\n", "\n"])
    title = Section("node", f'[node name="Title" type="Label" parent="Greybox" unique_id={sc.new_unique_id()}]\n',
                    [f"{k} = {v}\n" for k, v in _label_props(name, w, h)] + ["\n"])
    first_child = next(i for i, s in enumerate(sc.sections) if s.kind == "node" and s.parent == ".")
    sc.sections[first_child:first_child] = [grey, title]
    # one hotspot, so the place has something to click (the smoke test wants every scene to have one)
    spawn = sc.node("SpawnPoints/default")
    sx, sy = vec2(spawn.get("position"), (w / 2, h / 2)) if spawn is not None else (w / 2, h / 2)
    sign_pos = (sx, sy - 260) if kind == "outside" else (w / 2, h / 2 + 260)
    sign = _hotspot_sections(sc, "Hotspots", "StandIn", hs, sign_pos, 160, 110, [
        ("id", string_name("stand_in")), ("display_name", quote(name)),
        ("examine_text", quote(f"{name}. Nothing here yet: it's only a plan.")), ("action", quote("use")),
    ], walk_to=(sx, sy) if kind == "outside" else None)
    sc.insert_after_subtree("Hotspots", sign)
    folder.mkdir(parents=True)
    gd = folder / f"{sid}.gd"
    tscn = folder / f"{sid}.tscn"
    bk.touch(gd)
    bk.touch(tscn)
    gd.write_text(
        f"extends {base}\n"
        f"## {name}. Made by Plastico as a grey stand-in with its exits: no art yet. Draw it with the\n"
        f"## art pipeline (guide, section 5), then add its story logic here: match on h.id in\n"
        f"## on_hotspot() and call super for the defaults (exits already work from their settings).\n",
        encoding="utf-8")
    sc.save(tscn)
    register_scene(project, sid, bk)
    return [str(gd.relative_to(project)), str(tscn.relative_to(project)), "autoload/scene_router.gd"]


def _hotspot_sections(sc: Scene, parent: str, name: str, script_id: str, pos: tuple[float, float],
                      half_w: float, half_h: float, props: list[tuple[str, str]],
                      walk_to: tuple[float, float] | None = None) -> list[Section]:
    taken = {s.name for s in sc.children(parent)}
    node_name, k = name, 2
    while node_name in taken:
        node_name, k = f"{name}{k}", k + 1
    path = f"{parent}/{node_name}" if parent != "." else node_name
    extra = ' node_paths=PackedStringArray("walk_to")' if walk_to else ""
    head = f'[node name="{node_name}" type="Area2D" parent="{parent}" unique_id={sc.new_unique_id()}{extra}]\n'
    body = [f"position = {fmt_vec2(*pos)}\n", "collision_layer = 2\n", "collision_mask = 0\n",
            "input_pickable = false\n", "monitoring = false\n", f"editor_description = {quote(STAND_IN_NOTE)}\n",
            f'script = ExtResource("{script_id}")\n']
    body += [f"{k} = {v}\n" for k, v in props]
    body.append("pick_priority = 4\n")
    if walk_to:
        body.append('walk_to = NodePath("WalkTo")\n')
    body.append("\n")
    out = [Section("node", head, body)]
    poly = [(-half_w, -half_h), (half_w, -half_h), (half_w, half_h), (-half_w, half_h)]
    out.append(Section("node", f'[node name="CollisionPolygon2D" type="CollisionPolygon2D" parent="{path}" unique_id={sc.new_unique_id()}]\n',
                       [f"polygon = {fmt_points(poly)}\n", "\n"]))
    if walk_to:
        out.append(Section("node", f'[node name="WalkTo" type="Marker2D" parent="{path}" unique_id={sc.new_unique_id()}]\n',
                           [f"position = {fmt_vec2(walk_to[0] - pos[0], walk_to[1] - pos[1])}\n", "\n"]))
    return out


def _scene_file(project: Path, sid: str, game: dict) -> Path:
    g = game["scenes"].get(sid)
    if g:
        return Path(g["file"])
    return project / "scenes" / sid / f"{sid}.tscn"


def _kind_of(sc: Scene) -> str:
    return "outside" if sc.node("WalkArea") is not None else "inside"


def add_exit(project: Path, game: dict, src: str, dst: str, dst_name: str, via: str, slot: int, bk: Backup) -> list[str]:
    f = _scene_file(project, src, game)
    if not f.exists():
        raise BuildError(f"{src} isn't in the game yet.")
    sc = Scene.load(f)
    hs = sc.ensure_ext_resource("Script", HOTSPOT_SCRIPT, "plastico_hotspot")
    spawn_name = f"from_{src}"
    touched = []
    if via:
        node = next((n for n in sc.nodes() if n.get("id") == via), None)
        if node is None:
            raise BuildError(f"{src} has no hotspot {via} any more.")
        node.set_raw("target_scene", string_name(dst))
        node.set_raw("target_spawn", string_name(spawn_name))
    else:
        kind = _kind_of(sc)
        ids = {str(n.get("id")) for n in sc.nodes() if n.get("id") is not None}
        hid, k = f"exit_to_{dst}", 2
        while hid in ids:
            hid, k = f"exit_to_{dst}_{k}", k + 1
        props = [("id", string_name(hid)), ("display_name", quote(f"To {dst_name}")),
                 ("examine_text", quote(f"The way to {dst_name}.")), ("action", quote("exit")),
                 ("target_scene", string_name(dst)), ("target_spawn", string_name(spawn_name))]
        if kind == "outside":
            spawn = sc.node("SpawnPoints/default")
            sx, sy = vec2(spawn.get("position"), (1920, 1250)) if spawn is not None else (1920, 1250)
            pos = (sx - 600 + (slot % 5) * 300, sy - 420)
            secs = _hotspot_sections(sc, "Hotspots", f"ExitTo{pascal(dst)}", hs, pos, 120, 120, props, walk_to=(sx, sy))
        else:
            pos = (240 + (slot % 6) * 290, 930)
            secs = _hotspot_sections(sc, "Hotspots", f"ExitTo{pascal(dst)}", hs, pos, 130, 90, props)
        if sc.node("Hotspots") is None:
            raise BuildError(f"{src} has no Hotspots node to put the exit in.")
        sc.insert_after_subtree("Hotspots", secs)
    bk.touch(f)
    sc.save(f)
    touched.append(str(f.relative_to(project)))
    # outdoors the player arrives at a spawn point named after where they come from
    tf = _scene_file(project, dst, game)
    if tf.exists():
        tsc = Scene.load(tf)
        if _kind_of(tsc) == "outside" and tsc.node("SpawnPoints") is not None and tsc.node(f"SpawnPoints/{spawn_name}") is None:
            default = tsc.node("SpawnPoints/default")
            dx, dy = vec2(default.get("position"), (1920, 1250)) if default is not None else (1920, 1250)
            sec = Section("node", f'[node name="{spawn_name}" type="Marker2D" parent="SpawnPoints" unique_id={tsc.new_unique_id()}]\n',
                          [f"position = {fmt_vec2(dx, dy)}\n", "\n"])
            tsc.insert_after_subtree("SpawnPoints", [sec])
            bk.touch(tf)
            tsc.save(tf)
            touched.append(str(tf.relative_to(project)))
    return touched


def remove_exit(project: Path, game: dict, src: str, node_path: str, mode: str, bk: Backup) -> list[str]:
    f = _scene_file(project, src, game)
    if not f.exists():
        return []
    sc = Scene.load(f)
    node = sc.node(node_path)
    if node is None:
        return []
    if mode == "nowhere":
        node.set_raw("target_scene", string_name(""))
    else:
        sc.remove_subtree(node_path)
    bk.touch(f)
    sc.save(f)
    return [str(f.relative_to(project))]


_REF_EXT = (".gd", ".tscn", ".tres", ".cfg", ".godot")


def references(project: Path, sid: str) -> list[dict]:
    """Places outside the scene's folder that still name it (code, other scenes, tests)."""
    pats = [re.compile(rf'&"{re.escape(sid)}"'), re.compile(rf"res://scenes/{re.escape(sid)}/")]
    out = []
    own = project / "scenes" / sid
    for p in project.rglob("*"):
        if not p.is_file() or p.suffix not in _REF_EXT:
            continue
        parts = p.relative_to(project).parts
        if parts[0] in (".godot", ".git", "addons") or p.is_relative_to(own):
            continue
        try:
            for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
                if any(rx.search(line) for rx in pats):
                    out.append({"file": str(p.relative_to(project)), "line": i, "text": line.strip()[:160]})
        except (OSError, UnicodeDecodeError):
            continue
    return out


def delete_scene(project: Path, game: dict, sid: str, mode: str, bk: Backup) -> tuple[list[str], list[dict]]:
    if sid == game.get("start"):
        raise BuildError("That is where the game starts.")
    touched = []
    for e in game["exits"]:
        if e["to"] == sid and e["from"] != sid and e["via"] == "exit":
            touched += remove_exit(project, game, e["from"], e["node"], mode, bk)
    unregister_scene(project, sid, bk)
    touched.append("autoload/scene_router.gd")
    folder = project / "scenes" / sid
    if folder.exists():
        bk.move_dir(folder)
        touched.append(f"scenes/{sid}/ (moved to Plastico's backups)")
    refs = references(project, sid)
    return touched, refs


def build(project: Path, world: dict, game: dict, chosen: list[str], modes: dict[str, str]) -> dict:
    """Applies the chosen changes (ids from plan_changes). Returns a report."""
    project = Path(project).resolve()
    if editor_open(project):
        raise BuildError("Godot has the project open. Close Godot (editor and game), then build again: "
                         "Godot would otherwise write its own copy of these files over the changes.")
    changes = {c["id"]: c for c in plan_changes(world, game)}
    todo = [changes[i] for i in chosen if i in changes]
    bad = [c for c in todo if c.get("blocked") or c["op"] == "manual"]
    if bad:
        raise BuildError("These can't be built: " + "; ".join(c["text"] + (f" ({c['blocked']})" if c.get("blocked") else "") for c in bad))
    if not todo:
        raise BuildError("Nothing chosen to build.")
    order = {"create_scene": 0, "add_exit": 1, "remove_exit": 2, "delete_scene": 3}
    todo.sort(key=lambda c: order.get(c["op"], 9))
    bk = Backup(project, world["id"])
    report = {"done": [], "files": [], "references": [], "time": int(time.time() * 1000)}
    slots: dict[str, int] = {}
    try:
        for c in todo:
            if c["op"] == "create_scene":
                files = create_scene(project, c["scene"], c["name"], c["kind"], bk)
                game["scenes"][c["scene"]] = {"exists": True, "kind": c["kind"],
                                              "file": str(project / "scenes" / c["scene"] / f"{c['scene']}.tscn")}
            elif c["op"] == "add_exit":
                slot = slots.get(c["scene"], 0)
                slots[c["scene"]] = slot + 1
                files = add_exit(project, game, c["scene"], c["to"], c["to_name"], c.get("via", ""), slot, bk)
            elif c["op"] == "remove_exit":
                files = remove_exit(project, game, c["scene"], c["node"], modes.get(c["id"], "remove"), bk)
            elif c["op"] == "delete_scene":
                files, refs = delete_scene(project, game, c["scene"], modes.get(c["id"], "remove"), bk)
                report["references"] += [dict(r, scene=c["scene"]) for r in refs]
            else:
                continue
            report["done"].append(c["text"])
            report["files"] += files
    finally:
        report["files"] = sorted(set(report["files"]))
        bk.finish(report)
    report["backup"] = str(bk.dir)
    return report
