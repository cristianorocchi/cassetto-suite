"""The app's local web server: the page (web/) and a small JSON API. Listens on 127.0.0.1 only;
requests that change anything must carry the X-Plastico header (a page on another site can't)."""
from __future__ import annotations

import json
import mimetypes
import re
import threading
import traceback
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import WEB, WORLDS, apply, godot, pictures, smoke, store

PORT = 8766
_scan_lock = threading.Lock()
_world_locks: dict[str, threading.Lock] = {}


def _wlock(wid: str) -> threading.Lock:
    with _scan_lock:
        return _world_locks.setdefault(wid, threading.Lock())


def world_bundle(wid: str) -> dict:
    """The plan, the game as it is now, the puzzle charts and the changes waiting to be built."""
    with _wlock(wid):
        world = store.load(wid)
        game = None
        game_error = ""
        if world.get("godot"):
            proj = Path(world["godot"])
            if godot.is_godot_project(proj):
                try:
                    game = godot.scan(proj)
                except Exception as e:  # noqa: BLE001 - shown in the app
                    game_error = f"Couldn't read the Godot project: {e}"
            else:
                game_error = f"{proj} isn't a Godot project (no project.godot)."
        if game and store.reconcile(world, game):
            world = store.save(world)
    changes = apply.plan_changes(world, game)
    last = apply.last_backup(wid)
    return {"world": world, "game": game, "game_error": game_error, "charts": store.load_charts(wid),
            "changes": changes, "last_build": ({"time": last["time"], "report": last["report"]} if last else None),
            "uploads": sorted(p.stem for p in store.files_dir(wid).glob("*.jpg")) if store.files_dir(wid).exists() else []}


class Handler(BaseHTTPRequestHandler):
    server_version = "Plastico/0.1"

    def log_message(self, fmt, *args):  # quiet: only errors
        if args and isinstance(args[1], str) and args[1].startswith(("4", "5")):
            super().log_message(fmt, *args)

    # --- plumbing ---
    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, data, code: int = 200):
        self._send(code, json.dumps(data, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8",
                   {"Cache-Control": "no-store"})

    def _err(self, code: int, msg: str):
        self._json({"error": msg}, code)

    def _body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        if n > 40 * 1024 * 1024:
            raise ValueError("too big")
        return self.rfile.read(n) if n else b""

    def _jbody(self) -> dict:
        raw = self._body()
        return json.loads(raw.decode("utf-8")) if raw else {}

    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("127.0.0.1", "localhost")

    def _route(self, method: str):
        if not self._host_ok():
            return self._err(403, "local use only")
        url = urlparse(self.path)
        path = url.path
        q = parse_qs(url.query)
        if method != "GET" and self.headers.get("X-Plastico") != "1":
            return self._err(403, "missing X-Plastico header")
        try:
            if path.startswith("/api/"):
                return self._api(method, path[5:], q)
            if method != "GET":
                return self._err(405, "method not allowed")
            return self._static(path)
        except store.Conflict as c:
            return self._json({"error": "conflict", "world": c.world}, 409)
        except apply.BuildError as e:
            return self._err(400, str(e))
        except (ValueError, KeyError) as e:
            return self._err(400, str(e))
        except FileNotFoundError as e:
            return self._err(404, str(e))
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return self._err(500, f"{type(e).__name__}: {e}")

    def do_GET(self):
        self._route("GET")

    def do_HEAD(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_PUT(self):
        self._route("PUT")

    def do_DELETE(self):
        self._route("DELETE")

    # --- static files ---
    def _static(self, path: str):
        if path in ("/", ""):
            path = "/index.html"
        f = (WEB / path.lstrip("/")).resolve()
        if not f.is_relative_to(WEB.resolve()) or not f.is_file():
            return self._err(404, "not found")
        ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        if f.suffix == ".js":
            ctype = "text/javascript; charset=utf-8"
        cache = "public, max-age=86400" if "/vendor/" in str(f) else "no-cache"
        self._send(200, f.read_bytes(), ctype, {"Cache-Control": cache})

    # --- API ---
    def _api(self, method: str, path: str, q: dict):
        parts = [p for p in path.split("/") if p]
        if parts == ["worlds"] and method == "GET":
            return self._json({"worlds": store.list_worlds()})
        if parts == ["worlds"] and method == "POST":
            b = self._jbody()
            proj = (b.get("godot") or "").strip()
            if proj and not godot.is_godot_project(Path(proj)):
                return self._err(400, f"{proj} isn't a Godot project (no project.godot in it).")
            w = store.create(str(b.get("name") or "New world"), proj)
            return self._json(world_bundle(w["id"]))
        if parts == ["godot-projects"]:
            base = Path.home() / "Desktop" / "Projects"
            return self._json({"projects": godot.find_godot_projects(base)})
        if len(parts) >= 2 and parts[0] == "worlds":
            wid = parts[1]
            if not store.ID_RE.match(wid):
                return self._err(400, "bad world id")
            if not store.exists(wid):
                return self._err(404, "no such world")
            rest = parts[2:]
            if not rest:
                if method == "GET":
                    return self._json(world_bundle(wid))
                if method == "PUT":
                    b = self._jbody()
                    w = b.get("world") or {}
                    w["id"] = wid
                    proj = (w.get("godot") or "").strip()
                    if proj and not godot.is_godot_project(Path(proj)):
                        return self._err(400, f"{proj} isn't a Godot project.")
                    with _wlock(wid):
                        saved = store.save(w, b.get("rev"))
                    return self._json({"rev": saved["rev"], "updated": saved["updated"]})
                if method == "DELETE":
                    trash = store.remove(wid)
                    return self._json({"ok": True, "trash": str(trash)})
            if rest == ["build"] and method == "POST":
                b = self._jbody()
                bundle = world_bundle(wid)
                if not bundle["game"]:
                    return self._err(400, "This world isn't linked to a Godot project.")
                report = apply.build(Path(bundle["world"]["godot"]), bundle["world"], bundle["game"],
                                     list(b.get("ids") or []), dict(b.get("modes") or {}))
                out = world_bundle(wid)
                out["report"] = report
                return self._json(out)
            if rest == ["undo-build"] and method == "POST":
                res = apply.undo_last(wid)
                out = world_bundle(wid)
                out["undone"] = res
                return self._json(out)
            if rest == ["smoke"]:
                w = store.load(wid)
                if method == "POST":
                    if not w.get("godot"):
                        return self._err(400, "This world isn't linked to a Godot project.")
                    return self._json(smoke.start(Path(w["godot"])))
                return self._json(smoke.status())
            if len(rest) >= 2 and rest[0] == "pictures":
                return self._picture(method, wid, rest[1:], q)
        return self._err(404, "no such API")

    def _picture(self, method: str, wid: str, rest: list[str], q: dict):
        sid = rest[0]
        if not re.match(r"^[A-Za-z0-9_]+$", sid):
            return self._err(400, "bad scene id")
        up = store.files_dir(wid) / f"{sid}.jpg"
        if method == "PUT":
            data = pictures.normalize_upload(self._body())
            up.parent.mkdir(parents=True, exist_ok=True)
            up.write_bytes(data)
            return self._json({"ok": True})
        if method == "DELETE":
            up.unlink(missing_ok=True)
            return self._json({"ok": True})
        phase = re.sub(r"\.jpg$", "", rest[1]) if len(rest) > 1 else "midnight"
        width = int((q.get("w") or ["0"])[0] or 0)
        data = None
        w = store.load(wid)
        if w.get("godot") and godot.is_godot_project(Path(w["godot"])) and not up.exists():
            proj = Path(w["godot"])
            res = (godot.router_scenes(proj) or {}).get(sid) or f"res://scenes/{sid}/{sid}.tscn"
            f = godot.res_to_path(proj, res)
            if f.exists():
                from .tscn import Scene
                kind = godot.scene_kind(proj, Scene.load(f))
                data = pictures.render(proj, f, kind, phase)
        if data is None and up.exists():
            data = up.read_bytes()
        if data is None:
            return self._err(404, "no picture")
        if width:
            data = pictures.thumbnail(data, max(64, min(width, 2000)))
        return self._send(200, data, "image/jpeg", {"Cache-Control": "no-cache"})


def serve(port: int = PORT, open_browser: bool = True) -> None:
    WORLDS.mkdir(parents=True, exist_ok=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{port}/"
    print(f"Plastico is running at {url}  (Ctrl+C to stop)")
    if open_browser:
        threading.Timer(0.4, _open, args=(url,)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


def _open(url: str) -> None:
    import shutil
    import subprocess
    chrome = shutil.which("google-chrome") or shutil.which("chromium") or shutil.which("chromium-browser")
    try:
        if chrome:   # a window of its own, like a desktop app
            subprocess.Popen([chrome, f"--app={url}", "--new-window"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
        else:
            subprocess.Popen(["xdg-open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
    except OSError:
        print(f"Open {url} in your browser.")
