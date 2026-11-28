"""plastico app | scan | charts-import | charts-export"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from . import godot, server, store

CHARTS_URL = "https://claude.ai/artifact/T62KN3FMTfufKVH5MLvWfU"


def _charts_from(path: Path) -> list[dict]:
    """Chart documents from a folder of JSON files (ArtifactData's out_dir) or one JSON file."""
    files = sorted(path.rglob("*.json")) if path.is_dir() else [path]
    out = []
    for f in files:
        d = json.loads(f.read_text(encoding="utf-8"))
        if isinstance(d, dict) and "data" in d and isinstance(d["data"], dict) and "nodes" in d["data"]:
            d = d["data"]
        if not (isinstance(d, dict) and isinstance(d.get("nodes"), list)):
            continue
        nodes = [{k: n.get(k, "") for k in ("id", "kind", "title", "scene", "who", "when", "gid", "status")}
                 for n in d["nodes"] if isinstance(n, dict)]
        edges = [{"from": e.get("from"), "to": e.get("to")} for e in d.get("edges", []) if isinstance(e, dict)]
        out.append({"id": f.stem, "name": d.get("name", f.stem), "act": d.get("act", 1), "nodes": nodes, "edges": edges,
                    "updated": d.get("updatedAt", 0)})
    out.sort(key=lambda c: (c["act"], c["name"].lower()))
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="plastico", description="A 3D model of a game's world, linked to Godot.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("app", help="start the app (and open its window)")
    a.add_argument("--port", type=int, default=server.PORT)
    a.add_argument("--no-browser", action="store_true")
    s = sub.add_parser("scan", help="print what a Godot project's scenes and exits look like to Plastico")
    s.add_argument("project")
    ci = sub.add_parser("charts-import", help="store the puzzle charts (JSON files from the charts page) with a world")
    ci.add_argument("world")
    ci.add_argument("path", help="a folder of chart JSON files, or one file")
    ci.add_argument("--source", default=CHARTS_URL)
    ce = sub.add_parser("charts-export", help="print the world's scenes and people for the charts page")
    ce.add_argument("world")
    args = ap.parse_args(argv)

    if args.cmd == "app":
        server.serve(args.port, not args.no_browser)
        return 0
    if args.cmd == "scan":
        g = godot.scan(Path(args.project))
        print(f"{g['name']}: {len(g['scenes'])} scenes, {len(g['exits'])} ways, starts at {g['start'] or '?'}, "
              f"phases {', '.join(g['phases']) or 'none'} ({g['scan_ms']} ms)")
        for e in g["exits"]:
            print(f"  {e['from']:>16} -> {e['to'] or '(nowhere yet)':<16} {e['via']:<6} {e.get('hotspot') or e.get('file', '')}")
        for p in g["problems"]:
            print(f"  {p['level'].upper()}: {p['text']}")
        return 0
    if args.cmd == "charts-import":
        if not store.exists(args.world):
            print(f"No world {args.world!r}.", file=sys.stderr)
            return 1
        charts = _charts_from(Path(args.path))
        store.save_charts(args.world, {"synced": int(time.time() * 1000), "source": args.source, "charts": charts})
        print(f"Stored {len(charts)} charts ({sum(len(c['nodes']) for c in charts)} steps) with {args.world}.")
        return 0
    if args.cmd == "charts-export":
        w = store.load(args.world)
        doc = {
            "world": w["name"], "updated": int(time.time() * 1000),
            "scenes": [[s["id"], s["name"]] for s in w["scenes"] if not s.get("delete")],
            "people": [[p["id"], p["name"]] for p in w["people"]],
            "acts": [[a["id"], a.get("name", "")] for a in w["acts"]],
            "groups": [{"id": g["id"], "name": g["name"], "acts": g["acts"], "states": [[s["id"], s["name"]] for s in g["states"]]}
                       for g in w["groups"]],
            "states": {a["id"]: [[s["id"], s["name"]] for g in store.groups_of(w, a["id"]) for s in g["states"]] for a in w["acts"]},
        }
        print(json.dumps(doc, ensure_ascii=False, indent=1))
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
