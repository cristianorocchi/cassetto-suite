"""Leaves out of the packaged app the parts of Qt the window never loads (about 60% of its size):
Qt libraries that nothing we ship links to, QML modules, and Qt's translations except the web
engine's English and Italian. Run after PyInstaller on dist/cassetto/."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

internal = Path(sys.argv[1] if len(sys.argv) > 1 else "dist/cassetto/_internal").resolve()
qt = internal / "PyQt6" / "Qt6"
if not qt.is_dir():
    sys.exit(0)
lib = qt / "lib"
roots = [p for p in (internal / "PyQt6").glob("*.so")] + list((qt / "plugins").rglob("*.so")) + list((qt / "libexec").glob("*"))
env = {**os.environ, "LD_LIBRARY_PATH": f"{lib}:{internal}"}
need: set[str] = set()
for r in roots:
    out = subprocess.run(["ldd", str(r)], capture_output=True, text=True, env=env).stdout
    for line in out.splitlines():
        if "=>" in line:
            target = line.split("=>")[1].strip().split(" ")[0]
            if target.startswith(str(lib)):
                need.add(Path(target).name)
before = sum(f.stat().st_size for f in qt.rglob("*") if f.is_file())
for f in lib.iterdir():
    if f.is_file() and f.name.startswith("lib") and f.name not in need:
        f.unlink()
shutil.rmtree(qt / "qml", ignore_errors=True)
tr = qt / "translations"
for f in tr.rglob("*"):
    if f.is_file() and not (f.parent.name == "qtwebengine_locales" and f.name in ("en-US.pak", "it.pak")):
        f.unlink()
after = sum(f.stat().st_size for f in qt.rglob("*") if f.is_file())
print(f"Qt in the bundle: {before / 2**20:.0f} MB -> {after / 2**20:.0f} MB ({len(need)} libraries kept)")
