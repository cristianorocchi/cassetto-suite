"""Cassetto's local web server: the shell, the module pages, the core API and each module's API.

    /                      the shell (web/shell/)
    /shared/...            what every page shares: the bridge to the shell, the theme, the keys, fonts
    /m/<module>/...        a module's page and files, as the module serves them
    /api/core/...          the project, the events, the interfaces (this file)
    /api/<prefix>/...      a module's own API (the prefixes it claims)

Listens on 127.0.0.1 only. Requests that change anything carry an X-Cassetto header (X-Plastico for
Plastico's page, as it always has), which a page on another site can't send.
"""
from __future__ import annotations

import json
import mimetypes
import os
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from .. import __version__
from ..integrations import godot as godot_link
from ..paths import BASE, SHELL_WEB, default_projects_dir
from . import project as projects
from . import settings
from .modules import Core, MissingInterface, NoProject

PORT = 8767
MAX_BODY = 40 * 1024 * 1024


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, core: Core):
        super().__init__(addr, Handler)
        self.core = core
        self.last_beat = 0.0
        self.beats = 0

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server_address[1]}/"


class Handler(BaseHTTPRequestHandler):
    server_version = f"Cassetto/{__version__}"
    protocol_version = "HTTP/1.1"

    # --- the request protocol modules answer through (also Plastico's) ---
    def log_message(self, fmt, *args):
        if len(args) > 1 and isinstance(args[1], str) and args[1].startswith("5"):
            super().log_message(fmt, *args)

    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
        self.status = code
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

    def _err(self, status: int, msg: str, **extra):
        self._json({"error": msg, **extra}, status)

    def _body(self) -> bytes:
        if getattr(self, "_raw", None) is not None:
            return self._raw
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise ValueError("too big")
        self._raw = self.rfile.read(n) if n else b""
        return self._raw

    def _jbody(self) -> dict:
        raw = self._body()
        try:
            d = json.loads(raw.decode("utf-8")) if raw else {}
        except ValueError as e:
            raise ValueError(f"bad JSON: {e}") from e
        return d if isinstance(d, dict) else {}

    @property
    def core(self) -> Core:
        return self.server.core  # type: ignore[attr-defined]

    # --- routing ---
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

    def _route(self, method: str):
        self._raw = None
        self.status = 0
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
        if host not in ("127.0.0.1", "localhost"):
            return self._err(403, "local use only")
        url = urlparse(self.path)
        path = unquote(url.path)
        q = parse_qs(url.query)
        if method != "GET" and not (self.headers.get("X-Cassetto") == "1" or self.headers.get("X-Plastico") == "1"):
            return self._err(403, "missing X-Cassetto header")
        try:
            if path.startswith("/api/core/"):
                return self._core_api(method, [p for p in path[10:].split("/") if p], q)
            if path.startswith("/api/"):
                return self._module_api(method, [p for p in path[5:].split("/") if p], q)
            if method != "GET":
                return self._err(405, "method not allowed")
            return self._static(path)
        except projects.ProjectError as e:
            return self._err(400, str(e), code="project")
        except NoProject as e:
            return self._err(409, str(e), code="no_project")
        except MissingInterface as e:
            return self._err(404, str(e), code="missing_interface")
        except (ValueError, KeyError) as e:
            return self._err(400, str(e))
        except BrokenPipeError:
            return None
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return self._err(500, f"{type(e).__name__}: {e}")
        finally:
            # a request that carries a body nobody read would poison the next one on this connection
            if self._raw is None and method != "GET":
                try:
                    self._body()
                except Exception:  # noqa: BLE001
                    self.close_connection = True

    # --- files ---
    def _file(self, root: Path, rel: str, page=None):
        rel = rel.lstrip("/") or "index.html"
        f = (root / rel).resolve()
        if not f.is_relative_to(root.resolve()) or not f.is_file():
            return self._err(404, "not found")
        ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        if f.suffix in (".js", ".mjs"):
            ctype = "text/javascript; charset=utf-8"
        elif f.suffix == ".html":
            ctype = "text/html; charset=utf-8"
        elif f.suffix == ".css":
            ctype = "text/css; charset=utf-8"
        cache = "public, max-age=86400" if "/vendor/" in f.as_posix() or f.suffix == ".woff2" else "no-cache"
        data = f.read_bytes()
        if page and f.suffix == ".html":
            data = page(data.decode("utf-8")).encode("utf-8")
        return self._send(200, data, ctype, {"Cache-Control": cache})

    def _static(self, path: str):
        if path in ("/", "/index.html"):
            return self._file(SHELL_WEB / "shell", "index.html")
        for prefix, root in (("/shell/", SHELL_WEB / "shell"), ("/shared/", SHELL_WEB / "shared")):
            if path.startswith(prefix):
                return self._file(root, path[len(prefix):])
        if path.startswith("/m/"):
            mid, _, rel = path[3:].partition("/")
            m = self.core.modules.get(mid)
            if not m or not m.web_dir:
                return self._err(404, "no such module")
            if not rel and not path.endswith("/"):
                self.send_response(301)
                self.send_header("Location", f"/m/{mid}/")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return None
            return self._file(m.web_dir, rel, m.page)
        if path == "/favicon.ico":
            return self._file(SHELL_WEB / "shell", "icon.svg")
        return self._err(404, "not found")

    # --- a module's API ---
    def _module_api(self, method: str, parts: list[str], q: dict):
        if not parts:
            return self._err(404, "no such API")
        m = next((m for m in self.core.modules.values() if parts[0] in m.api_prefixes), None)
        if m is None:
            return self._err(404, "no such API")
        if self.core.project is None or m.ctx is None:
            raise NoProject()
        try:
            return m.handle(self, method, parts, q)
        finally:
            self.core.settle(m.id)

    # --- the core's API ---
    def _core_api(self, method: str, parts: list[str], q: dict):
        core = self.core
        one = lambda k, d="": (q.get(k) or [d])[0]  # noqa: E731
        if parts == ["state"]:
            return self._json({**core.state(), "app": {"version": __version__, "base": str(BASE),
                                                       "projects_dir": str(default_projects_dir()),
                                                       "downloads_dir": str(_downloads_dir()),
                                                       "pages_seen": self.server.beats}})  # type: ignore[attr-defined]
        if parts == ["events"]:
            after = int(one("after", "0") or 0)
            wait = min(25.0, max(0.0, float(one("wait", "20") or 0)))
            return self._json(core.events.wait(after, wait))
        if parts == ["heartbeat"] and method == "POST":
            self.server.last_beat = time.monotonic()  # type: ignore[attr-defined]
            self.server.beats += 1  # type: ignore[attr-defined]
            return self._json({"ok": True})
        if parts == ["settings", "keys"]:     # the user's keyboard shortcuts, the same in every project
            if method == "PUT":
                settings.save_keys(self._jbody().get("bindings"))
            elif method != "GET":
                return self._err(405, "method not allowed")
            return self._json({"bindings": settings.load_keys(), "file": str(settings.keys_path())})
        if parts == ["recent"]:
            if method == "DELETE":
                projects.forget(self._jbody().get("path", ""))
            return self._json({"recent": projects.recent()})
        if parts == ["project", "open"] and method == "POST":
            core.open_project(Path(self._jbody()["path"]).expanduser())
            return self._json(core.state())
        if parts == ["project", "new"] and method == "POST":
            b = self._jbody()
            name = str(b.get("name") or "").strip()
            if not name:
                raise projects.ProjectError("A project needs a name.")
            folder = Path(b.get("path") or (default_projects_dir() / _safe_name(name))).expanduser()
            start = b.get("start") or {}
            wf = (start.get("plastico") or {}).get("world_file")
            if wf and "puzzles" not in start:     # a standalone Plastico keeps the synced charts next to the world
                charts = Path(wf).expanduser().with_suffix(".charts.json")
                if charts.is_file():
                    start["puzzles"] = {"charts_file": str(charts)}
            core.create_project(folder, name, start)
            return self._json(core.state())
        if parts == ["quit"] and method == "POST":     # close the app as if its window was closed (the pages save first)
            quit_ = getattr(core, "on_quit", None)
            if quit_ is None:
                return self._err(409, "This Cassetto has no window to close.")
            threading.Thread(target=quit_, daemon=True).start()
            return self._json({"ok": True})
        if parts == ["project", "close"] and method == "POST":
            core.close_project()
            return self._json(core.state())
        if parts == ["project", "export"] and method == "POST":
            dest = str(self._jbody().get("path") or "").strip()
            if not dest:
                raise projects.ProjectError("Choose where to save the exported project.")
            return self._json({"file": str(core.export_project(Path(dest)))})
        if parts == ["project", "import"] and method == "POST":
            b = self._jbody()
            src = str(b.get("path") or "").strip()
            if not src:
                raise projects.ProjectError("Choose the .cassetto file to import.")
            core.import_project(Path(src), Path(b.get("into") or default_projects_dir()))
            return self._json(core.state())
        if parts == ["project", "rename"] and method == "POST":
            core.rename_project(str(self._jbody().get("name", "")))
            return self._json(core.state())
        if parts == ["godot"]:
            cat = core.optional("world.catalog") or {}
            return self._json(godot_link.status(cat.get("godot", "")))
        if len(parts) == 2 and parts[0] == "call" and method == "POST":
            b = self._jbody()
            args = b.get("args") or []
            if not isinstance(args, list):
                raise ValueError("args must be a list")
            return self._json({"result": core.call(parts[1], *args, caller=str(b.get("caller") or "page"))})
        if parts == ["fs"]:
            return self._json(_list_dir(one("path") or str(Path.home())))
        if parts == ["godot-games"]:
            return self._json({"games": godot_link.find_games()})
        if parts == ["plastico-worlds"]:
            return self._json({"worlds": _old_worlds(one("path"))})
        return self._err(404, "no such API")


def _downloads_dir() -> Path:
    """Where an exported project goes unless the user picks another place: Downloads, else home."""
    for d in (os.environ.get("XDG_DOWNLOAD_DIR", ""), str(Path.home() / "Downloads"), str(Path.home() / "Scaricati")):
        if d and Path(d).expanduser().is_dir():
            return Path(d).expanduser()
    return Path.home()


def _safe_name(name: str) -> str:
    keep = "".join(c if c.isalnum() or c in " -_." else "-" for c in name).strip(" .")
    return keep[:80] or "Project"


def _list_dir(path: str) -> dict:
    """Folders in `path`, for the shell's folder picker. Hidden folders are left out."""
    p = Path(path).expanduser()
    if not p.is_dir():
        raise ValueError(f"{p} isn't a folder")
    p = p.resolve()
    dirs = []
    try:
        for d in sorted(p.iterdir(), key=lambda x: x.name.lower()):
            if d.name.startswith(".") or not d.is_dir():
                continue
            dirs.append({"name": d.name, "path": str(d), "project": projects.is_project(d),
                         "godot": (d / "project.godot").is_file()})
    except PermissionError:
        pass
    files, exported = [], []
    try:
        files = [{"name": f.name, "path": str(f)} for f in sorted(p.glob("*.json")) if f.is_file()][:200]
        exported = [{"name": f.name, "path": str(f)} for f in sorted(p.glob("*" + projects.EXPORT_SUFFIX)) if f.is_file()][:200]
    except PermissionError:
        pass
    return {"path": str(p), "parent": str(p.parent) if p.parent != p else "", "home": str(Path.home()),
            "dirs": dirs[:500], "json": files, "cassetto": exported, "project": projects.is_project(p), "godot": (p / "project.godot").is_file()}


def _old_worlds(extra: str = "") -> list[dict]:
    """Worlds of a standalone Plastico (its worlds/ folder), to start a project from."""
    places = [BASE / "plastico" / "worlds"]
    if extra:
        places.insert(0, Path(extra).expanduser())
    out, seen = [], set()
    for d in places:
        if not d.is_dir():
            continue
        for f in sorted(d.glob("*.json")):
            if f.name.endswith(".charts.json") or f in seen:
                continue
            seen.add(f)
            try:
                w = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if not isinstance(w, dict) or not isinstance(w.get("scenes"), list):
                continue
            charts = f.with_suffix(".charts.json")
            out.append({"file": str(f), "name": w.get("name", f.stem), "scenes": len(w["scenes"]),
                        "godot": w.get("godot", ""), "charts": str(charts) if charts.exists() else ""})
    return out


def make_server(core: Core, port: int = PORT) -> Server:
    """Binds the port asked for, or any free one if it's taken."""
    try:
        return Server(("127.0.0.1", port), core)
    except OSError:
        return Server(("127.0.0.1", 0), core)


def serve_in_thread(core: Core, port: int = PORT) -> Server:
    srv = make_server(core, port)
    threading.Thread(target=srv.serve_forever, name="cassetto-http", daemon=True).start()
    return srv
