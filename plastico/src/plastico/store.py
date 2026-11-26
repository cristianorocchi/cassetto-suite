"""Worlds on disk: worlds/<id>.json (the plan), worlds/<id>.charts.json (the puzzle charts, synced
by Claude), worlds/<id>.files/ (pictures dropped in for scenes that aren't drawn yet).
Every save keeps the previous version in worlds/.history/<id>/ (the last 60)."""
from __future__ import annotations

import json
import math
import re
import shutil
import time
from pathlib import Path

import plastico as _pkg
from .godot import pascal

ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
HISTORY_KEEP = 60
DEFAULT_KIND = "inside"
VERSION = 2          # 2: every scene has a footprint in whole grid cells (w, d), edges on the grid,
                     #    a parent (a scene it sits in) and the puzzle charts it is associated with
# the same numbers as web/js/model.js: a new scene's footprint per kind, the grid cell
SIZES = {"outside": (12, 7), "inside": (6, 4), "closeup": (3, 2)}
GRID = 1.0
MAX_CELLS = 40


def snap_axis(c: float, size: int) -> float:
    """The centre that puts both edges of a block `size` cells long on grid lines."""
    return math.floor((c - size / 2) / GRID + 0.5) * GRID + size / 2


def _cells(v, default: int) -> int:
    try:
        n = int(round(float(v)))
    except (TypeError, ValueError):
        return default
    return min(MAX_CELLS, n) if n >= 1 else default


def _root(root: Path | None) -> Path:
    """The worlds folder: the one given, else the package's current one (plastico.WORLDS), which a host
    app such as Cassetto points at its open project."""
    return Path(root) if root is not None else _pkg.WORLDS


class Conflict(Exception):
    def __init__(self, world: dict):
        super().__init__("the world changed since it was loaded")
        self.world = world


def slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s[:48] or "world"


def scene_id(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    return s[:48] or "scene"


def nice_name(sid: str) -> str:
    return sid.replace("_", " ").strip().capitalize()


def world_path(wid: str, root: Path | None = None) -> Path:
    root = _root(root)
    if not ID_RE.match(wid):
        raise ValueError(f"bad world id {wid!r}")
    return root / f"{wid}.json"


def files_dir(wid: str, root: Path | None = None) -> Path:
    root = _root(root)
    return world_path(wid, root).with_suffix(".files")


def blank_world(wid: str, name: str, godot: str = "") -> dict:
    return {
        "v": VERSION, "id": wid, "name": name, "godot": godot, "start": "",
        "phases": [], "acts": [{"id": "1", "name": "", "start": ""}],
        "areas": [], "people": [], "scenes": [], "links": [],
        "rev": 0, "created": int(time.time() * 1000), "updated": int(time.time() * 1000),
    }


def normalize(w: dict) -> dict:
    """Fills missing fields and drops broken references, so the app can trust the shape."""
    old_version = int(w.get("v", 1) or 1)
    w.setdefault("name", w.get("id", "World"))
    w.setdefault("godot", "")
    w.setdefault("start", "")
    w.setdefault("phases", [])
    w.setdefault("acts", [{"id": "1", "name": "", "start": ""}])
    w.setdefault("areas", [])
    w.setdefault("people", [])
    w.setdefault("scenes", [])
    w.setdefault("links", [])
    w.setdefault("rev", 0)
    if not w["acts"]:
        w["acts"] = [{"id": "1", "name": "", "start": ""}]
    for a in w["acts"]:
        a.setdefault("name", "")
        a.setdefault("start", "")
    act_ids = {a["id"] for a in w["acts"]}
    seen = set()
    scenes = []
    for s in w["scenes"]:
        if not isinstance(s, dict) or not s.get("id") or s["id"] in seen:
            continue
        seen.add(s["id"])
        s.setdefault("name", nice_name(s["id"]))
        s.setdefault("kind", DEFAULT_KIND)
        if s["kind"] not in ("inside", "outside", "closeup"):
            s["kind"] = DEFAULT_KIND
        if s.get("act") not in act_ids:
            s["act"] = w["acts"][0]["id"]
        s.setdefault("area", "")
        for k in ("x", "z"):
            v = s.get(k, 0)
            s[k] = float(v) if isinstance(v, (int, float)) and math.isfinite(v) else 0.0
        s["floor"] = int(s.get("floor", 0) or 0)
        if s.get("status") not in ("idea", "ready"):
            s["status"] = "idea"
        s.setdefault("open", [])
        s.setdefault("people", {})
        s.setdefault("away", {})   # people the game puts here that the plan takes out, per time of day
        s.setdefault("notes", "")
        s["delete"] = bool(s.get("delete", False))
        dw, dd = SIZES.get(s["kind"], SIZES[DEFAULT_KIND])
        s["w"], s["d"] = _cells(s.get("w"), dw), _cells(s.get("d"), dd)
        if old_version < 2:      # from version 1: centres were on a half-unit grid, sizes fractional
            s["x"], s["z"] = snap_axis(s["x"], s["w"]), snap_axis(s["z"], s["d"])
        s["parent"] = s.get("parent") if isinstance(s.get("parent"), str) else ""
        ch, seen_c = [], set()
        for c in s.get("charts") or []:
            if isinstance(c, str) and c and c not in seen_c:
                seen_c.add(c)
                ch.append(c)
        s["charts"] = ch
        scenes.append(s)
    # a parent must be another scene, and no scene may end up inside itself
    by_id = {s["id"]: s for s in scenes}
    for s in scenes:
        if s["parent"] not in by_id or s["parent"] == s["id"]:
            s["parent"] = ""
    for s in scenes:
        p, hops = s["parent"], 0
        while p and hops <= len(scenes):
            if p == s["id"]:
                s["parent"] = ""
                break
            p, hops = by_id[p]["parent"], hops + 1
    for s in scenes:       # children are in their parent's act
        top, hops = s, 0
        while top["parent"] and hops <= len(scenes):
            top, hops = by_id[top["parent"]], hops + 1
        if top is not s:
            s["act"] = top["act"]
    w["scenes"] = scenes
    w["v"] = VERSION
    pairs = set()
    links = []
    for l in w["links"]:
        if not isinstance(l, dict) or l.get("from") not in seen or l.get("to") not in seen or l["from"] == l["to"]:
            continue
        key = (l["from"], l["to"])
        if key in pairs:
            continue
        pairs.add(key)
        l.setdefault("id", f"l_{l['from']}_{l['to']}")
        if l.get("status") not in ("idea", "ready"):
            l["status"] = "idea"
        lock = l.get("lock")
        if not (isinstance(lock, dict) and str(lock.get("needs", "")).strip()):
            l["lock"] = None
        else:
            lock.setdefault("type", "item")
            lock.setdefault("where", "")
            lock.setdefault("note", "")
        l.setdefault("open", [])
        l.setdefault("via", "")
        l.setdefault("notes", "")
        l["delete"] = bool(l.get("delete", False))
        links.append(l)
    w["links"] = links
    return w


def list_worlds(root: Path | None = None) -> list[dict]:
    root = _root(root)
    out = []
    root.mkdir(parents=True, exist_ok=True)
    for f in sorted(root.glob("*.json")):
        if f.name.endswith(".charts.json"):
            continue
        try:
            w = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        out.append({"id": w.get("id", f.stem), "name": w.get("name", f.stem), "godot": w.get("godot", ""),
                    "scenes": len(w.get("scenes", [])), "links": len(w.get("links", [])),
                    "updated": w.get("updated", 0)})
    out.sort(key=lambda x: -x["updated"])
    return out


def load(wid: str, root: Path | None = None) -> dict:
    root = _root(root)
    return normalize(json.loads(world_path(wid, root).read_text(encoding="utf-8")))


def exists(wid: str, root: Path | None = None) -> bool:
    root = _root(root)
    return world_path(wid, root).exists()


def _write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    tmp.replace(path)


def save(world: dict, base_rev: int | None = None, root: Path | None = None) -> dict:
    """Saves the plan. With base_rev, refuses (Conflict) if someone saved since that version."""
    root = _root(root)
    world = normalize(world)
    path = world_path(world["id"], root)
    if path.exists():
        current = json.loads(path.read_text(encoding="utf-8"))
        if base_rev is not None and int(current.get("rev", 0)) != int(base_rev):
            raise Conflict(normalize(current))
        hist = root / ".history" / world["id"]
        hist.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        shutil.copy2(path, hist / f"{stamp}-r{current.get('rev', 0)}.json")
        old = sorted(hist.glob("*.json"))
        for f in old[:-HISTORY_KEEP]:
            f.unlink(missing_ok=True)
        world["rev"] = int(current.get("rev", 0)) + 1
    else:
        world["rev"] = 1
    world["updated"] = int(time.time() * 1000)
    _write(path, world)
    return world


def create(name: str, godot: str = "", root: Path | None = None) -> dict:
    root = _root(root)
    base = slug(name)
    wid, k = base, 2
    while world_path(wid, root).exists():
        wid, k = f"{base}-{k}", k + 1
    return save(blank_world(wid, name.strip() or "New world", godot), root=root)


def remove(wid: str, root: Path | None = None) -> Path:
    """Moves a world (and its charts and pictures) to worlds/.trash/<time>/. Nothing is deleted."""
    root = _root(root)
    trash = root / ".trash" / time.strftime("%Y%m%d-%H%M%S")
    trash.mkdir(parents=True, exist_ok=True)
    for f in (world_path(wid, root), world_path(wid, root).with_suffix(".charts.json"), files_dir(wid, root)):
        if f.exists():
            shutil.move(str(f), str(trash / f.name))
    return trash


def load_charts(wid: str, root: Path | None = None) -> dict | None:
    root = _root(root)
    f = root / f"{wid}.charts.json"
    if not f.exists():
        return None
    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except ValueError:
        return None


def save_charts(wid: str, data: dict, root: Path | None = None) -> None:
    root = _root(root)
    _write(root / f"{wid}.charts.json", data)


# --- keeping the plan in step with the game ---

def _overlaps(a: tuple, b: tuple) -> bool:
    e = 1e-6
    return a[0] < b[1] - e and b[0] < a[1] - e and a[2] < b[3] - e and b[2] < a[3] - e


def _box(x: float, z: float, w: int, d: int) -> tuple:
    return (x - w / 2, x + w / 2, z - d / 2, z + d / 2)


def free_spot(world: dict, near: tuple[float, float] | None, w: int, d: int, floor: int) -> tuple[float, float]:
    """The grid position nearest to `near` where a w × d block on `floor` overlaps no other (as freeSpot in model.js)."""
    taken = [_box(s["x"], s["z"], s.get("w") or SIZES[DEFAULT_KIND][0], s.get("d") or SIZES[DEFAULT_KIND][1])
             for s in world["scenes"] if s.get("floor", 0) == floor]
    cx, cz = near if near else (0.0, 0.0)
    cx, cz = snap_axis(cx, w), snap_axis(cz, d)
    for r in range(0, 80):
        best, best_d = None, None
        for i in range(-r, r + 1):
            for j in range(-r, r + 1):
                if max(abs(i), abs(j)) != r:
                    continue
                x, z = cx + i * GRID, cz + j * GRID
                if any(_overlaps(_box(x, z, w, d), t) for t in taken):
                    continue
                dist = math.hypot(i, j)
                if best is None or dist < best_d:
                    best, best_d = (x, z), dist
        if best:
            return best
    return cx, cz + 40


def reconcile(world: dict, game: dict | None) -> bool:
    """Adds what the game has and the plan doesn't (scenes, ways), drops deletions the game has done.
    Returns True if the plan changed."""
    if not game:
        return False
    changed = False
    if game.get("phases") and world.get("phases") != game["phases"]:
        world["phases"] = list(game["phases"])
        changed = True
    if game.get("start") and world.get("start") != game["start"]:
        world["start"] = game["start"]
        changed = True
    by_id = {s["id"]: s for s in world["scenes"]}
    gs = game["scenes"]
    exits = [e for e in game["exits"] if e["to"] and e["to"] in gs]
    neighbours: dict[str, list[str]] = {}
    for e in exits:
        neighbours.setdefault(e["from"], []).append(e["to"])
        neighbours.setdefault(e["to"], []).append(e["from"])
    for sid, g in gs.items():
        if not g.get("exists"):
            continue
        s = by_id.get(sid)
        if s is None:
            near = None
            floor = 0
            for nb in neighbours.get(sid, []):
                if nb in by_id:
                    near = (by_id[nb]["x"], by_id[nb]["z"])
                    floor = by_id[nb]["floor"]
                    break
            w, d = SIZES.get(g["kind"], SIZES[DEFAULT_KIND])
            fr = g.get("frame")
            if g["kind"] == "outside" and isinstance(fr, list) and len(fr) == 2 and fr[0] > 0:
                d = max(4, min(9, round(w * fr[1] / fr[0])))      # an outdoor plate keeps its picture's shape
            if near:   # next to the scene it is joined to, not on top of it
                near = (near[0] + 12, near[1])
            x, z = free_spot(world, near, w, d, floor)
            s = {"id": sid, "name": nice_name(sid), "kind": g["kind"], "act": world["acts"][0]["id"], "area": "",
                 "x": x, "z": z, "w": w, "d": d, "floor": floor, "status": "ready", "open": [], "people": {}, "notes": "",
                 "delete": False, "parent": "", "charts": []}
            world["scenes"].append(s)
            by_id[sid] = s
            changed = True
        elif s["kind"] != g["kind"] and s["kind"] != "closeup":
            if (s.get("w"), s.get("d")) == SIZES.get(s["kind"]):     # the old kind's size: take the new one's
                s["w"], s["d"] = SIZES.get(g["kind"], SIZES[DEFAULT_KIND])
                s["x"], s["z"] = snap_axis(s["x"], s["w"]), snap_axis(s["z"], s["d"])
            s["kind"] = g["kind"]
            changed = True
    # scenes the plan deleted and the game no longer has
    keep = []
    for s in world["scenes"]:
        if s.get("delete") and not (s["id"] in gs and gs[s["id"]].get("exists")):
            changed = True
            continue
        keep.append(s)
    if len(keep) != len(world["scenes"]):
        world["scenes"] = keep
        ids = {s["id"] for s in keep}
        world["links"] = [l for l in world["links"] if l["from"] in ids and l["to"] in ids]
    game_pairs = {(e["from"], e["to"]) for e in exits}
    have = {(l["from"], l["to"]) for l in world["links"]}
    for a, b in sorted(game_pairs - have):
        if a in by_id and b in by_id:
            world["links"].append({"id": f"l_{a}_{b}", "from": a, "to": b, "status": "ready", "lock": None,
                                   "open": [], "via": "", "notes": "", "delete": False})
            changed = True
    links = []
    for l in world["links"]:
        if l.get("delete") and (l["from"], l["to"]) not in game_pairs:
            changed = True
            continue
        if l.get("via") and (l["from"], l["to"]) in game_pairs:
            l["via"] = ""   # built: the open end it was going to use is now this way
            changed = True
        links.append(l)
    world["links"] = links
    return changed


def default_scene_name(sid: str) -> str:
    return pascal(sid)
