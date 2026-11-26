"""cassetto [PROJECT] | new | info | import-charts"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from . import __version__
from .core import project as projects
from .core.modules import Core
from .core.server import PORT
from .modules import all_modules


def _headless(path: str) -> Core:
    core = Core(all_modules())
    core.open_project(Path(path).expanduser())
    core._stop_watch()
    return core


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    commands = {"new", "info", "import-charts", "app"}
    if not argv or argv[0] not in commands and argv[0] not in ("-h", "--help", "--version"):
        argv = ["app", *argv]
    ap = argparse.ArgumentParser(prog="cassetto", description="Cassetto: design the structure of narrative games.")
    ap.add_argument("--version", action="version", version=f"cassetto {__version__}")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("app", help="start the app (the default)")
    a.add_argument("project", nargs="?", help="a project folder to open")
    a.add_argument("--window", choices=["auto", "native", "chrome", "browser", "none"],
                   default=os.environ.get("CASSETTO_WINDOW") or "auto",
                   help="where to show the app (default auto: native window, else Chrome/Chromium, else the browser; "
                        "CASSETTO_WINDOW sets it for good)")
    a.add_argument("--port", type=int, default=PORT)
    a.add_argument("--fresh", action="store_true", help="don't reopen the last project")
    n = sub.add_parser("new", help="make a project")
    n.add_argument("path")
    n.add_argument("--name", default="")
    n.add_argument("--godot", default="", help="a Godot project to link the world to")
    n.add_argument("--from-world", default="", help="a Plastico world (worlds/<id>.json) to start from")
    i = sub.add_parser("info", help="what is in a project")
    i.add_argument("path")
    ic = sub.add_parser("import-charts", help="add puzzle charts (the JSON the Puzzle Charts page copies) to a project")
    ic.add_argument("project")
    ic.add_argument("file")
    args = ap.parse_args(argv)

    try:
        if args.cmd == "app":
            from .app import run
            return run(args.project, args.window, args.port, reopen_last=not args.fresh)
        if args.cmd == "new":
            core = Core(all_modules())
            start: dict = {}
            if args.godot:
                start["plastico"] = {"godot": args.godot}
            if args.from_world:
                start["plastico"] = {**start.get("plastico", {}), "world_file": args.from_world}
                charts = Path(args.from_world).with_suffix(".charts.json")
                if charts.exists():
                    start["puzzles"] = {"charts_file": str(charts)}
            p = core.create_project(Path(args.path), args.name or Path(args.path).name, start)
            core.close_project()
            print(f"Made {p.name} in {p.path}")
            return 0
        if args.cmd == "info":
            core = _headless(args.path)
            st = core.state()
            st["references"] = core.optional("puzzles.references")
            core.close_project()
            print(json.dumps(st, ensure_ascii=False, indent=1))
            return 0
        if args.cmd == "import-charts":
            core = _headless(args.project)
            data = json.loads(Path(args.file).read_text(encoding="utf-8"))
            ids = core.modules["puzzles"].import_charts(data)
            core.close_project()
            print(f"Imported {len(ids)} chart{'s' if len(ids) != 1 else ''}.")
            return 0
    except projects.ProjectError as e:
        print(f"cassetto: {e}", file=sys.stderr)
        return 1
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
