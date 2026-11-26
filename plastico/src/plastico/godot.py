"""Reads a Godot project built on the SceneRouter / GameState framework: which scenes there are, how they
connect, who is in them at each time of day.

- Scenes: SceneRouter.SCENES in autoload/scene_router.gd (or every scenes/<id>/<id>.tscn).
- Inside or outside: the scene script extends InteriorLocation or ExteriorLocation.
- Exits: Hotspot nodes (core/hotspot.gd) with action "exit"; an empty target_scene is a way that
  leads nowhere yet. Scripts that call SceneRouter.go(&"x") make passages too ("script").
- Times of day: GameState.PHASES; a node tagged metadata/phases only exists in those phases, and a
  scene only drawn in some phases (root metadata/art_phases) shows midnight's art in the others
  (core/phase_art.gd).
- People: talk hotspots (their dialogue file names the character) and the sprites under
  Characters / World/NPCs that are named like a character folder or like a hotspot you can use.
"""
from __future__ import annotations

import os
import re
import time
from pathlib import Path

from .tscn import Scene, Section, parse_value

HOTSPOT_SCRIPT = "res://core/hotspot.gd"
_ROUTER_ENTRY = re.compile(r'^\s*&"(\w+)"\s*:\s*"(res://[^"]+)"\s*,?\s*$', re.M)
_GO_CALL = re.compile(r'SceneRouter\.go(?:\.call_deferred)?\(\s*&?"(\w+)"')
_PHASES = re.compile(r"const\s+PHASES\s*:\s*Array\[StringName\]\s*=\s*\[([^\]]*)\]")
_EXTENDS = re.compile(r"^extends\s+(\w+)", re.M)
_GODOT_EXE = re.compile(r"^godot(?![-_]?mcp)[\w.\-]*$")


def res_to_path(project: Path, res: str) -> Path:
    return project / res.removeprefix("res://")


def snake(name: str) -> str:
    s = re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", name)
    return re.sub(r"[^a-z0-9_]+", "_", s.lower()).strip("_")


def pascal(sid: str) -> str:
    return "".join(p.capitalize() for p in re.split(r"[_\W]+", sid) if p)


def read_project_godot(project: Path) -> dict:
    out = {"name": project.name, "main_scene": ""}
    f = project / "project.godot"
    if not f.exists():
        return out
    section = ""
    for line in f.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("["):
            section = line.strip("[]")
            continue
        if section == "application" and "=" in line:
            k, v = line.split("=", 1)
            v = v.strip().strip('"')
            if k == "config/name":
                out["name"] = v
            elif k == "run/main_scene":
                out["main_scene"] = v
    return out


def is_godot_project(path: Path) -> bool:
    return (Path(path) / "project.godot").is_file()


def find_godot_projects(base: Path, depth: int = 2) -> list[dict]:
    """Godot projects in `base` and its subfolders, for the "link a project" menu."""
    found = []
    base = Path(base)
    if not base.is_dir():
        return found
    stack = [(base, 0)]
    while stack:
        d, k = stack.pop()
        if is_godot_project(d):
            found.append({"path": str(d), "name": read_project_godot(d)["name"]})
            continue
        if k >= depth:
            continue
        try:
            for c in sorted(d.iterdir()):
                if c.is_dir() and not c.name.startswith(".") and c.name not in ("node_modules", "__pycache__"):
                    stack.append((c, k + 1))
        except OSError:
            pass
    return sorted(found, key=lambda p: p["name"].lower())


def router_scenes(project: Path) -> dict[str, str] | None:
    f = project / "autoload" / "scene_router.gd"
    if not f.exists():
        return None
    text = f.read_text(encoding="utf-8")
    m = re.search(r"const\s+SCENES\s*:?=\s*\{(.*?)\n\}", text, re.S)
    if not m:
        return None
    return {sid: res for sid, res in _ROUTER_ENTRY.findall(m.group(1))}


def game_phases(project: Path) -> list[str]:
    f = project / "autoload" / "game_state.gd"
    if f.exists():
        m = _PHASES.search(f.read_text(encoding="utf-8"))
        if m:
            return re.findall(r'&?"(\w+)"', m.group(1))
    return []


def editor_open(project: Path) -> bool:
    """True if a Godot process has this project open (editor or game). Plastico never writes then."""
    project = Path(project).resolve()
    keys = {str(project), project.name}
    try:
        pids = [p for p in os.listdir("/proc") if p.isdigit()]
    except OSError:
        return False
    for pid in pids:
        try:
            raw = Path(f"/proc/{pid}/cmdline").read_bytes()
        except OSError:
            continue
        if not raw:
            continue
        parts = [a.decode("utf-8", "replace") for a in raw.split(b"\0") if a]
        exe = os.path.basename(parts[0]).lower() if parts else ""
        flatpak = exe == "flatpak" and any("org.godotengine.godot" in a.lower() for a in parts)
        if not (flatpak or _GODOT_EXE.match(exe)):
            continue   # node, npm, shells (the Godot MCP server runs from the project folder too)
        if "--headless" in parts:
            continue   # a test or a script run (ours, or Claude's): not an editor holding the files
        joined = " ".join(parts)
        if any(k in joined for k in keys):
            return True
        # opened from the Project Manager: the editor's working directory is the project
        try:
            if Path(os.readlink(f"/proc/{pid}/cwd")).resolve() == project:
                return True
        except OSError:
            pass
    return False


# --- one scene ---

def _phase_tags(node: Section) -> list[str] | None:
    v = node.get("metadata/phases")
    return [str(x) for x in v] if isinstance(v, list) else None


def effective_phases(scene: Scene, node: Section) -> list[str] | None:
    """The phases a node exists in: the intersection of its own tags and its ancestors'. None = all."""
    result: set[str] | None = None
    path = node.path
    while True:
        n = scene.node(path)
        if n is not None:
            tags = _phase_tags(n)
            if tags is not None:
                result = set(tags) if result is None else result & set(tags)
        if path in (".", ""):
            break
        path = path.rsplit("/", 1)[0] if "/" in path else "."
    return None if result is None else sorted(result)


def present_in(phases_tag: list[str] | None, art_phases: list[str], all_phases: list[str]) -> list[str]:
    """The game's phases in which something tagged `phases_tag` shows (core/phase_art.gd's rule)."""
    if not all_phases:
        return [] if phases_tag is None else list(phases_tag)
    out = []
    for p in all_phases:
        shown = p if p in art_phases else "midnight"
        if phases_tag is None or shown in phases_tag:
            out.append(p)
    return out


def scene_kind(project: Path, scene: Scene) -> str:
    root = scene.root()
    if root is None:
        return "inside"
    script = root.get("script")
    res = scene.ext_resources().get(script.args[0]) if script is not None and hasattr(script, "args") else None
    seen = set()
    while res and res not in seen:
        seen.add(res)
        f = res_to_path(project, res)
        if not f.exists():
            break
        m = _EXTENDS.search(f.read_text(encoding="utf-8"))
        if not m:
            break
        base = m.group(1)
        if base == "InteriorLocation":
            return "inside"
        if base == "ExteriorLocation":
            return "outside"
        if base.startswith('"'):
            res = base.strip('"')
            continue
        break
    return "outside" if scene.node("WalkArea") is not None else "inside"


def read_scene(project: Path, sid: str, res: str, phases: list[str], char_ids: set[str]) -> dict:
    f = res_to_path(project, res)
    info = {"id": sid, "res": res, "file": str(f), "exists": f.exists(), "kind": "inside", "art_phases": [],
            "hotspots": 0, "exits": [], "spawns": [], "people": {}, "scripts": [], "script_passages": [],
            "has_art": False, "views": []}
    if not f.exists():
        return info
    scene = Scene.load(f)
    root = scene.root()
    info["kind"] = scene_kind(project, scene)
    info["frame"] = [1920, 1080]
    cam = scene.node("Camera2D")
    if info["kind"] == "outside" and cam is not None:
        l, t, r, b = (cam.get(k) for k in ("limit_left", "limit_top", "limit_right", "limit_bottom"))
        if all(isinstance(v, (int, float)) for v in (l, t, r, b)) and r > l and b > t:
            info["frame"] = [r - l, b - t]
    art = root.get("metadata/art_phases") if root else None
    info["art_phases"] = [str(x) for x in art] if isinstance(art, list) else (["midnight"] if phases else [])
    ext = scene.ext_resources()
    info["has_art"] = any(p.endswith(".png") and "/art/" in p for p in ext.values())
    hotspot_ids = {rid for rid, p in ext.items() if p == HOTSPOT_SCRIPT}
    talkers: dict[str, list[str]] = {}
    usable: dict[str, Section] = {}
    for n in scene.nodes():
        if n.parent == "Views" and n.type in ("Node2D", "") and n.get("script") is not None:
            info["views"].append(n.name)
        if n.parent == "SpawnPoints":
            info["spawns"].append(n.name)
        script = n.get("script")
        if not (script is not None and hasattr(script, "args") and script.args and script.args[0] in hotspot_ids):
            continue
        info["hotspots"] += 1
        hid = str(n.get("id", "") or "")
        action = str(n.get("action", "use") or "use")
        tag = effective_phases(scene, n)
        shows = present_in(tag, info["art_phases"], phases)
        view = ""
        parts = n.path.split("/")
        if len(parts) >= 3 and parts[0] == "Views":
            view = parts[1]
        target = str(n.get("target_scene", "") or "")
        if action == "exit" and (n.get("view") or (view and not target)):
            action = "view"   # steps between the room and its close-ups: not a way to another scene
        if action == "exit":
            info["exits"].append({
                "hotspot": hid, "node": n.path, "name": str(n.get("display_name", "") or ""),
                "to": str(n.get("target_scene", "") or ""), "spawn": str(n.get("target_spawn", "default") or "default"),
                "phases": shows if tag is not None else None, "view": view,
                "walk_off": n.get_raw("walk_off") is not None,
            })
        elif action == "talk":
            dlg = str(n.get("dialogue", "") or "")
            m = re.match(r"res://characters/([^/]+)/", dlg)
            who = m.group(1) if m else (hid or snake(n.name))
            talkers.setdefault(who, [])
            talkers[who] = sorted(set(talkers[who]) | set(shows))
        if action in ("talk", "use") and hid:
            usable[hid] = n
    # sprites that are people: under Characters (inside) or World/NPCs (outside)
    for holder in ("Characters", "World/NPCs"):
        for n in scene.children(holder):
            who = snake(n.name)
            if who == "player":
                continue
            if who in char_ids or who in usable:
                shows = present_in(effective_phases(scene, n), info["art_phases"], phases)
                talkers[who] = sorted(set(talkers.get(who, [])) | set(shows))
    people: dict[str, list[str]] = {p: [] for p in phases}
    for who, when in talkers.items():
        for p in when:
            people.setdefault(p, []).append(who)
    info["people"] = {p: sorted(set(v)) for p, v in people.items()}
    # passages made by the scene's own scripts
    folder = f.parent
    for gd in sorted(folder.glob("*.gd")):
        rel = str(gd.relative_to(project))
        info["scripts"].append(rel)
        for i, line in enumerate(gd.read_text(encoding="utf-8").splitlines(), 1):
            for to in _GO_CALL.findall(line):
                if to != sid:
                    info["script_passages"].append({"to": to, "file": rel, "line": i})
    return info


def scan(project: Path) -> dict:
    project = Path(project).resolve()
    t0 = time.time()
    meta = read_project_godot(project)
    phases = game_phases(project)
    routed = router_scenes(project)
    scenes_res: dict[str, str] = {}
    if routed is not None:
        scenes_res = routed
    else:
        for f in sorted((project / "scenes").glob("*/*.tscn")):
            if f.stem == f.parent.name:
                scenes_res[f.stem] = "res://" + str(f.relative_to(project))
    chars = project / "characters"
    char_ids = {d.name for d in chars.iterdir() if d.is_dir()} if chars.is_dir() else set()
    char_ids -= {"player", "debug"}
    scenes = {sid: read_scene(project, sid, res, phases, char_ids) for sid, res in scenes_res.items()}
    start = ""
    for sid, res in scenes_res.items():
        if res == meta["main_scene"]:
            start = sid
    exits, problems = [], []
    for sid, s in scenes.items():
        if not s["exists"]:
            problems.append({"level": "error", "scene": sid, "text": f"SceneRouter lists {sid}, but {s['res']} is missing."})
            continue
        for e in s["exits"]:
            exits.append({"from": sid, "to": e["to"], "via": "exit", "hotspot": e["hotspot"], "node": e["node"],
                          "name": e["name"], "spawn": e["spawn"], "phases": e["phases"], "view": e["view"]})
            if e["to"] and e["to"] not in scenes:
                problems.append({"level": "error", "scene": sid,
                                 "text": f"The exit {e['hotspot']} in {sid} leads to {e['to']}, which isn't a scene."})
            elif e["to"] and scenes[e["to"]]["kind"] == "outside" and e["spawn"] not in scenes[e["to"]]["spawns"]:
                problems.append({"level": "warn", "scene": sid,
                                 "text": f"The exit {e['hotspot']} in {sid} arrives at spawn point {e['spawn']}, which {e['to']} doesn't have: the player appears at its default point."})
        for p in s["script_passages"]:
            exits.append({"from": sid, "to": p["to"], "via": "script", "file": p["file"], "line": p["line"],
                          "hotspot": "", "name": "", "spawn": "", "phases": None, "view": ""})
            if p["to"] not in scenes:
                problems.append({"level": "error", "scene": sid, "text": f"{p['file']}:{p['line']} goes to {p['to']}, which isn't a scene."})
    return {
        "project": str(project), "name": meta["name"], "start": start, "phases": phases,
        "scenes": scenes, "exits": exits, "problems": problems,
        "has_router": routed is not None,
        "has_smoke_test": (project / "tests" / "smoke_test.tscn").exists(),
        "editor_open": editor_open(project), "scanned_at": int(time.time() * 1000),
        "scan_ms": int((time.time() - t0) * 1000),
    }


def value(raw: str):
    return parse_value(raw)
