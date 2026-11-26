"""Puzzle Charts as a Cassetto module.

The page is the same one that runs as a claude.ai artifact (puzzle-charts/index.html). There it saves
through the artifact's database; here a small stand-in for that database (puzzle-charts/cassetto-db.js)
saves through this module into the project. The page doesn't know the difference.

Data:   <project>/puzzles/charts/<id>.json   one chart: its steps (nodes) and links (edges), as the page
                                             writes them ("v": 1)
        <project>/puzzles/.trash/<time>/      deleted charts (nothing is deleted for good)
Offers: puzzles.charts        the charts, in the shape Plastico reads (steps per scene, keys for locks)
        puzzles.rename_scene  a scene got a new id in the world: move the steps that were there
        puzzles.references    steps that point at scenes or people the world doesn't have
Uses:   world.catalog         the scene and people lists for the page's pickers (its meta/world document)
"""
from __future__ import annotations

import json
import re
import secrets
import shutil
import time
from pathlib import Path

from ..core.modules import Interface, Module
from ..core.project import ProjectError
from ..paths import PUZZLES_WEB

CHART_VERSION = 1
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAX_CHART = 4 * 1024 * 1024
NODE_KEYS = ("id", "kind", "title", "scene", "who", "when", "gid", "status")

# The artifact page loads these from CDNs; the desktop app has its own copies (works offline).
PAGE_ASSETS = [
    ('<script src="https://cdn.jsdelivr.net/npm/elkjs@0.9.3/lib/elk.bundled.js"></script>',
     '<script src="vendor/elk.bundled.js"></script>'),
    ('<script src="https://cdnjs.cloudflare.com/ajax/libs/dagre/0.8.5/dagre.min.js"></script>',
     '<script src="vendor/dagre.min.js"></script>'),
    ('<link rel="preconnect" href="https://fonts.googleapis.com">\n', ''),
    ('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n', ''),
]
FONTS_RE = re.compile(r'<link rel="stylesheet" href="https://fonts\.googleapis\.com/[^"]*">')
BRIDGE = '<script src="/shared/cassetto-bridge.js"></script>\n<script src="cassetto-db.js"></script>\n'


def new_id() -> str:
    return "c" + secrets.token_hex(8)


def _str(v, n=4000) -> str:
    return v[:n] if isinstance(v, str) else ""


def chart_from(d: dict) -> dict | None:
    """One chart from any of the shapes charts travel in, or None:
    - the page's own document ({name, act, nodes, edges, ...}), maybe wrapped in {"data": ...};
    - the page's "Copy as JSON" ({chart, act, steps: [{..., game_id, needs}]});
    - Plastico's synced copy (a chart in {"charts": [...]}: nodes without positions)."""
    if not isinstance(d, dict):
        return None
    if isinstance(d.get("data"), dict) and isinstance(d["data"].get("nodes"), list):
        d = {**d["data"], "id": d.get("id") or d["data"].get("id")}
    if isinstance(d.get("steps"), list):
        nodes, edges = [], []
        for s in d["steps"]:
            if not isinstance(s, dict) or not isinstance(s.get("id"), str):
                continue
            nodes.append({"id": s["id"], "kind": s.get("kind", "action"), "title": _str(s.get("title")), "scene": _str(s.get("scene")),
                          "who": _str(s.get("who")), "when": _str(s.get("when")), "gid": _str(s.get("game_id") or s.get("gid")),
                          "status": _str(s.get("status")) or "idea", "notes": _str(s.get("notes")), "x": 0, "y": 0})
            for p in s.get("needs") or []:
                if isinstance(p, str):
                    edges.append({"from": p, "to": s["id"]})
        return {"v": CHART_VERSION, "name": _str(d.get("chart")) or "Imported chart", "act": d.get("act", 1),
                "notes": _str(d.get("notes")), "nodes": nodes, "edges": edges, "auto": True}
    if isinstance(d.get("nodes"), list):
        positioned = any(isinstance(n, dict) and ("x" in n or "y" in n) for n in d["nodes"])
        out = {k: d[k] for k in ("name", "act", "notes", "nodes", "edges", "auto", "createdAt", "updatedAt") if k in d}
        out["v"] = CHART_VERSION
        out.setdefault("edges", [])
        out["edges"] = [e for e in out["edges"] if isinstance(e, dict)]
        if not positioned:
            out["auto"] = True
        if isinstance(d.get("id"), str):
            out["_id"] = d["id"]
        return out
    return None


def charts_in(data) -> list[dict]:
    """Every chart found in a JSON value: one chart, a list, or {"charts": [...]}."""
    if isinstance(data, list):
        return [c for x in data for c in charts_in(x)]
    if isinstance(data, dict) and isinstance(data.get("charts"), list) and "nodes" not in data:
        return [c for x in data["charts"] for c in charts_in(x)]
    c = chart_from(data)
    return [c] if c else []


class PuzzlesModule(Module):
    id = "puzzles"
    title = "Puzzle Charts"
    data_version = 1
    web_dir = PUZZLES_WEB
    api_prefixes = ("puzzles",)

    @property
    def dir(self) -> Path:
        d = self.ctx.data_dir / "charts"
        d.mkdir(parents=True, exist_ok=True)
        return d

    # --- storage ---
    def _file(self, cid: str) -> Path:
        if not ID_RE.match(cid or ""):
            raise ValueError(f"bad chart id {cid!r}")
        return self.dir / f"{cid}.json"

    def _read(self, f: Path) -> dict | None:
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return d if isinstance(d, dict) else None

    def docs(self) -> list[tuple[str, dict]]:
        out = []
        for f in sorted(self.dir.glob("*.json")):
            d = self._read(f)
            if d is None or int(d.get("v", 1)) > CHART_VERSION:
                continue    # a damaged chart, or one from a newer Cassetto: left on disk, not shown
            out.append((f.stem, d))
        return out

    def problems(self) -> list[str]:
        out = []
        for f in sorted(self.dir.glob("*.json")):
            d = self._read(f)
            if d is None:
                out.append(f"{f.name} can't be read: it isn't shown. Fix or remove it.")
            elif int(d.get("v", 1)) > CHART_VERSION:
                out.append(f"{f.name} was saved by a newer Cassetto: it isn't shown.")
        return out

    def write(self, cid: str, doc: dict) -> None:
        if not isinstance(doc, dict) or not isinstance(doc.get("nodes"), list) or not isinstance(doc.get("edges", []), list):
            raise ValueError("a chart needs nodes and edges")
        doc = {**doc, "v": CHART_VERSION}
        doc.pop("_id", None)
        raw = json.dumps(doc, ensure_ascii=False, indent=1) + "\n"
        if len(raw) > MAX_CHART:
            raise ValueError("that chart is too big to save")
        f = self._file(cid)
        tmp = f.with_name(f.name + ".tmp")
        tmp.write_text(raw, encoding="utf-8")
        tmp.replace(f)

    def remove(self, cid: str) -> None:
        f = self._file(cid)
        if f.exists():
            trash = self.ctx.data_dir / ".trash" / time.strftime("%Y%m%d-%H%M%S")
            trash.mkdir(parents=True, exist_ok=True)
            shutil.move(str(f), str(trash / f.name))

    def import_charts(self, data) -> list[str]:
        found = charts_in(data)
        if not found:
            raise ValueError("No puzzle charts in that: expected the JSON the Puzzle Charts page copies, or chart documents.")
        have = {cid for cid, _ in self.docs()}
        ids = []
        now = int(time.time() * 1000)
        for c in found:
            cid = c.get("_id") if isinstance(c.get("_id"), str) and ID_RE.match(c["_id"]) and c["_id"] not in have else new_id()
            c.setdefault("createdAt", now)
            c["updatedAt"] = now
            c["rev"] = "import:" + secrets.token_hex(3)
            self.write(cid, c)
            have.add(cid)
            ids.append(cid)
        return ids

    # --- lifecycle ---
    def seed(self, source: dict) -> None:
        f = source.get("charts_file")
        if f:
            try:
                data = json.loads(Path(f).expanduser().read_text(encoding="utf-8"))
            except (OSError, ValueError) as e:
                raise ProjectError(f"Couldn't read the puzzle charts in {f}: {e}") from e
            self.import_charts(data)

    # --- what the others get ---
    def charts(self) -> dict:
        """The contract Plastico has always read (worlds/<id>.charts.json), now live."""
        out = []
        for cid, d in self.docs():
            nodes = [{k: (n.get(k) or "") for k in NODE_KEYS} for n in d.get("nodes", []) if isinstance(n, dict)]
            edges = [{"from": e.get("from"), "to": e.get("to")} for e in d.get("edges", []) if isinstance(e, dict)]
            out.append({"id": cid, "name": d.get("name") or "Untitled chart", "act": d.get("act", 1), "nodes": nodes,
                        "edges": edges, "updated": d.get("updatedAt", 0)})
        out.sort(key=lambda c: (c["act"] if isinstance(c["act"], int) else 99, c["name"].lower()))
        return {"synced": int(time.time() * 1000), "source": "cassetto", "live": True, "charts": out}

    def create_chart(self, name: str = "") -> str:
        """A new chart with just its end goal, as the page's New chart makes it. Returns its id."""
        cid = new_id()
        now = int(time.time() * 1000)
        self.write(cid, {"name": (str(name).strip() or "Untitled chart")[:200], "act": 1, "notes": "", "auto": True,
                         "nodes": [{"id": "n" + secrets.token_hex(4), "kind": "goal", "title": "The end goal", "scene": "", "who": "",
                                    "when": "", "gid": "", "status": "idea", "notes": "", "x": 0, "y": 0}],
                         "edges": [], "createdAt": now, "updatedAt": now, "rev": "create:" + secrets.token_hex(3)})
        self.ctx.core.settle(self.id, chart=cid, created=True)
        return cid

    def rename_scene(self, old: str, new: str) -> dict:
        if not old or not new or old == new:
            return {"steps": 0, "charts": 0}
        steps = charts = 0
        for cid, d in self.docs():
            n = 0
            for node in d.get("nodes", []):
                if isinstance(node, dict) and node.get("scene") == old:
                    node["scene"] = new
                    n += 1
            if n:
                d["updatedAt"] = int(time.time() * 1000)
                d["rev"] = "rename:" + secrets.token_hex(3)
                self.write(cid, d)
                steps += n
                charts += 1
        if charts:
            self.ctx.core.settle(self.id, reason="rename_scene", old=old, new=new)
        return {"steps": steps, "charts": charts}

    def references(self) -> dict:
        cat = self.ctx.optional("world.catalog")
        out = {"world": bool(cat), "missing_scenes": [], "missing_people": [], "missing_charts": []}
        if not cat:
            return out
        have = {cid for cid, _ in self.docs()}
        for s in cat.get("hierarchy", []):     # charts put with a scene, then deleted
            for cid in s.get("charts", []):
                if cid not in have:
                    out["missing_charts"].append({"scene": s["id"], "scene_name": s["name"], "chart": cid})
        scenes = {s for s, _ in cat["scenes"]}
        people = {p for p, _ in cat["people"]} | {"player"}
        for cid, d in self.docs():
            for n in d.get("nodes", []):
                if not isinstance(n, dict):
                    continue
                ref = {"chart": cid, "chart_name": d.get("name") or "Untitled chart", "step": n.get("id"), "title": n.get("title") or "Untitled step"}
                if n.get("scene") and n["scene"] not in scenes:
                    out["missing_scenes"].append({**ref, "scene": n["scene"]})
                if n.get("who") and n["who"] not in people:
                    out["missing_people"].append({**ref, "who": n["who"]})
        return out

    def provides(self) -> list[Interface]:
        return [
            Interface("puzzles.charts", self.charts,
                      "() -> {charts: [{id, name, act, nodes: [{id, kind, title, scene, who, when, gid, status}], edges: [{from, to}]}]}"),
            Interface("puzzles.create_chart", self.create_chart,
                      "(name) -> id: a new chart with just its end goal."),
            Interface("puzzles.rename_scene", self.rename_scene,
                      "(old, new) -> {steps, charts}: the steps placed in scene `old` move to `new`."),
            Interface("puzzles.references", self.references,
                      "() -> {missing_scenes, missing_people, missing_charts}: steps whose scene or person the world lacks, "
                      "and charts put with a scene that the project no longer has."),
        ]

    # --- HTTP ---
    def handle(self, h, method: str, parts: list[str], q: dict):
        rest = parts[1:]
        if rest == ["charts"] and method == "GET":
            return h._json({"docs": [{"id": cid, "data": d} for cid, d in self.docs()], "problems": self.problems()})
        if len(rest) == 2 and rest[0] == "charts":
            cid = rest[1]
            if method == "PUT":
                self.write(cid, h._jbody())
                self.ctx.core.settle(self.id, chart=cid)
                return h._json({"ok": True})
            if method == "DELETE":
                self.remove(cid)
                self.ctx.core.settle(self.id, chart=cid, deleted=True)
                return h._json({"ok": True})
            if method == "GET":
                f = self._file(cid)
                d = self._read(f) if f.exists() else None
                return h._json({"id": cid, "data": d}) if d else h._err(404, "no such chart")
        if rest == ["world"] and method == "GET":
            cat = self.ctx.optional("world.catalog")
            return h._json({"world": cat})
        if rest == ["import"] and method == "POST":
            b = h._jbody()
            if "text" in b:
                try:
                    data = json.loads(b["text"])
                except ValueError as e:
                    return h._err(400, f"That isn't JSON: {e}")
            elif b.get("path"):
                try:
                    data = json.loads(Path(b["path"]).expanduser().read_text(encoding="utf-8"))
                except (OSError, ValueError) as e:
                    return h._err(400, f"Couldn't read {b['path']}: {e}")
            else:
                return h._err(400, "Nothing to import.")
            ids = self.import_charts(data)
            self.ctx.core.settle(self.id, imported=ids)
            return h._json({"imported": ids})
        if rest == ["references"] and method == "GET":
            return h._json(self.references())
        return h._err(404, "no such API")

    def page(self, html: str) -> str:
        for a, b in PAGE_ASSETS:
            html = html.replace(a, b)
        html = FONTS_RE.sub('<link rel="stylesheet" href="/shared/fonts.css">', html)
        i = html.find("<script")
        return html[:i] + BRIDGE + html[i:] if i >= 0 else html + BRIDGE

    def fingerprint(self) -> str:
        if not self.ctx:
            return ""
        items = []
        for f in sorted(self.dir.glob("*.json")):
            try:
                st = f.stat()
            except OSError:
                continue
            items.append(f"{f.name}:{st.st_mtime_ns}:{st.st_size}")
        return "|".join(items)

    def summary(self) -> dict:
        docs = self.docs()
        refs = self.references()
        return {"charts": len(docs), "steps": sum(len(d.get("nodes", [])) for _, d in docs),
                "missing": len(refs["missing_scenes"]) + len(refs["missing_people"]) + len(refs["missing_charts"]),
                "problems": self.problems()}
