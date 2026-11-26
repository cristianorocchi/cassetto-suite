"""Starting Cassetto as a desktop app: the server in the background, the suite in a window of its own.

The window, best first:
  native   a webview window (pywebview, Qt WebEngine in the packaged app). The app ends when it closes.
  chrome   Chrome or Chromium as an app window with its own profile. The app ends when it closes.
  browser  a tab in the default browser. The app ends a little after the last tab stops checking in.
  none     no window: just the server (for development and tests).
"auto" tries them in that order.
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

from . import __version__
from .core import project as projects
from .core.modules import Core
from .core.server import PORT, Server, serve_in_thread
from .modules import all_modules
from .paths import SHELL_WEB, config_dir

BEAT_TIMEOUT = 45.0
FLUSH_TIMEOUT = 6.0     # flushAll gives up after 4 s itself


def log(msg: str) -> None:
    print(f"[cassetto] {msg}", flush=True)


def _probe(port: int) -> dict | None:
    """A Cassetto already running on this port, or None."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/core/state", timeout=0.6) as r:
            d = json.loads(r.read().decode("utf-8"))
            return d if isinstance(d, dict) and "app" in d else None
    except (OSError, ValueError):
        return None


def _post(port: int, path: str, body: dict) -> None:
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode(), method="POST",
                                 headers={"X-Cassetto": "1", "Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=10).read()


# --- windows ---

def _native_available() -> bool:
    try:
        import webview  # noqa: F401
    except Exception:  # noqa: BLE001
        return False
    return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY") or sys.platform in ("darwin", "win32"))


class _Api:
    """What the page can ask of the native window: the system's own file pickers."""

    def __init__(self):
        self.window = None

    def _dialog(self, kind: str, start: str = "", types=(), save_as: str = ""):
        import webview
        fd = getattr(webview, "FileDialog", None)
        k = {"folder": getattr(fd, "FOLDER", None) if fd else getattr(webview, "FOLDER_DIALOG", 20),
             "open": getattr(fd, "OPEN", None) if fd else getattr(webview, "OPEN_DIALOG", 10),
             "save": getattr(fd, "SAVE", None) if fd else getattr(webview, "SAVE_DIALOG", 30)}[kind]
        extra = {"save_filename": save_as} if kind == "save" else {}
        res = self.window.create_file_dialog(k, directory=start or str(Path.home()), file_types=tuple(types), **extra)
        if not res:
            return ""
        return res[0] if isinstance(res, (list, tuple)) else str(res)

    def pick_folder(self, start: str = ""):
        return self._dialog("folder", start)

    def pick_file(self, start: str = "", kind: str = "json"):
        if kind == "cassetto":
            return self._dialog("open", start, ("Cassetto projects (*.cassetto)", "All files (*.*)"))
        return self._dialog("open", start, ("JSON files (*.json)", "All files (*.*)"))

    def pick_save(self, start: str = "", name: str = ""):
        """Where to save an exported project: the system's own Save dialog."""
        return self._dialog("save", start, ("Cassetto projects (*.cassetto)", "All files (*.*)"), save_as=name)


def _run_native(url: str, core: Core | None = None) -> bool:
    import webview
    api = _Api()
    w = webview.create_window(f"Cassetto {__version__}", url, js_api=api, width=1440, height=920, min_size=(900, 600),
                              background_color="#E8EDF0", text_select=True)
    api.window = w

    # Closing runs on the GUI thread, and evaluate_js waits for the page's answer, which needs that same
    # thread: waiting there froze the window for good. So the first close is put off, the pages save from
    # another thread, and the window is then closed for real (or after FLUSH_TIMEOUT if a page hangs).
    flushed = threading.Event()

    def flush_then_close():
        def save():
            try:   # let the pages save what's still waiting
                w.evaluate_js("window.Cassetto ? window.Cassetto.flushAll() : true")
            except Exception:  # noqa: BLE001
                pass
        t = threading.Thread(target=save, daemon=True)
        t.start()
        t.join(FLUSH_TIMEOUT)
        flushed.set()
        try:
            w.destroy()
        except Exception:  # noqa: BLE001
            pass

    def closing():
        if flushed.is_set():
            return True
        if not getattr(closing, "started", False):
            closing.started = True
            threading.Thread(target=flush_then_close, daemon=True).start()
        return False
    w.events.closing += closing
    if core is not None:     # POST /api/core/quit closes it like its close button
        core.on_quit = w.destroy
    gui = os.environ.get("CASSETTO_WEBVIEW_GUI") or ("qt" if _has_qt() else None)
    if gui == "qt":
        # Qt's sandbox refuses to run as root, so it is off only then.
        flags = os.environ.get("QTWEBENGINE_CHROMIUM_FLAGS", "").split()
        if _root() and "--no-sandbox" not in flags:
            flags.append("--no-sandbox")
        os.environ["QTWEBENGINE_CHROMIUM_FLAGS"] = " ".join(flags)
    storage = config_dir() / "webview"
    storage.mkdir(parents=True, exist_ok=True)
    try:
        webview.start(gui=gui, private_mode=False, storage_path=str(storage))
    except Exception as e:  # noqa: BLE001
        log(f"The native window didn't open ({type(e).__name__}: {e}).")
        return False
    return True


def _has_qt() -> bool:
    try:
        import qtpy  # noqa: F401
        from PyQt6 import QtWebEngineWidgets  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


def _root() -> bool:
    return hasattr(os, "geteuid") and os.geteuid() == 0


def _chrome() -> str:
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"):
        p = shutil.which(name)
        if p:
            return p
    return ""


def _run_chrome(url: str, core: Core | None = None) -> bool:
    exe = _chrome()
    if not exe:
        return False
    profile = config_dir() / "chrome-profile"
    args = [exe, f"--app={url}", f"--user-data-dir={profile}", "--class=Cassetto", "--no-first-run",
            "--no-default-browser-check", "--window-size=1440,920"] + (["--no-sandbox"] if _root() else [])
    try:
        proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        return False
    if core is not None:
        core.on_quit = proc.terminate
    proc.wait()     # its own profile is its own browser: it ends when the window closes
    return True


def _run_browser(url: str, srv: Server | None) -> bool:
    if not webbrowser.open(url):
        return False
    log(f"Opened {url} in the browser. Cassetto stops a little after the tab is closed.")
    _wait_for_beats(srv)
    return True


def _wait_for_beats(srv: Server | None) -> None:
    if srv is None:
        return
    start = time.monotonic()
    while True:
        time.sleep(2)
        if srv.beats == 0:
            if time.monotonic() - start > 120:
                log("No page connected in two minutes: stopping.")
                return
            continue
        if time.monotonic() - srv.last_beat > BEAT_TIMEOUT:
            return


def open_window(url: str, mode: str, srv: Server | None, core: Core | None = None) -> str:
    order = {"auto": ["native", "chrome", "browser"], "native": ["native", "chrome", "browser"],
             "chrome": ["chrome", "browser"], "browser": ["browser"]}.get(mode, [mode])
    for m in order:
        if m == "native" and _native_available() and _run_native(url, core):
            return m
        if m == "chrome" and _run_chrome(url, core):
            return m
        if m == "browser" and _run_browser(url, srv):
            return m
    return ""


def run(project: str | None = None, window: str = "auto", port: int = PORT, reopen_last: bool = True) -> int:
    if not (SHELL_WEB / "shell" / "index.html").is_file():
        log(f"Can't find the app's pages in {SHELL_WEB}: the installation is incomplete.")
        return 1
    running = _probe(port)
    if running:     # another Cassetto is already serving: show it in a new window
        url = f"http://127.0.0.1:{port}/"
        if project:
            try:
                _post(port, "/api/core/project/open", {"path": str(Path(project).expanduser().resolve())})
            except OSError as e:
                log(f"Couldn't open {project} in the running Cassetto: {e}")
        if window == "none":
            log(f"Cassetto is already running at {url}")
            return 0
        open_window(url, window, None)
        return 0

    core = Core(all_modules())
    srv = serve_in_thread(core, port)

    def stop(*_):     # closed from outside (logout, kill): release the project before going
        try:
            core.close_project()
        finally:
            os._exit(0)
    for sig in (getattr(signal, "SIGTERM", None), getattr(signal, "SIGHUP", None)):
        if sig is not None:
            signal.signal(sig, stop)
    core.on_quit = lambda: os.kill(os.getpid(), signal.SIGTERM)    # no window of its own: just stop
    target = project
    if not target and reopen_last:
        last = next((r for r in projects.recent() if r.get("exists")), None)
        target = last["path"] if last else None
    if target:
        try:
            core.open_project(Path(target).expanduser())
        except projects.ProjectError as e:
            core.last_error = str(e)
            log(str(e))
    log(f"Cassetto {__version__} is running at {srv.url}")
    try:
        if window == "none":
            while True:
                time.sleep(3600)
        used = open_window(srv.url, window, srv, core)
        if not used:
            log(f"No window could be opened. Open {srv.url} in a browser; Ctrl+C stops Cassetto.")
            while True:
                time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        core.close_project()
        srv.shutdown()
        srv.server_close()
    return 0
