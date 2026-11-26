# PyInstaller recipe for the desktop app: one folder, `cassetto` inside it.
#   packaging/build.sh   (or: pyinstaller packaging/cassetto.spec)
# The pages are copied next to the code, in the same layout as the repository, so cassetto.paths finds
# them the same way in both.
from pathlib import Path

ROOT = Path(SPECPATH).resolve().parent

datas = [
    (str(ROOT / "web"), "web"),
    (str(ROOT / "plastico" / "web"), "plastico/web"),
    (str(ROOT / "puzzle-charts" / "index.html"), "puzzle-charts"),
    (str(ROOT / "puzzle-charts" / "cassetto-db.js"), "puzzle-charts"),
    (str(ROOT / "puzzle-charts" / "vendor"), "puzzle-charts/vendor"),
    (str(ROOT / "LICENSE"), "."),
]

a = Analysis(
    [str(ROOT / "packaging" / "cassetto_main.py")],
    pathex=[str(ROOT / "src"), str(ROOT / "plastico" / "src")],
    datas=datas,
    hiddenimports=["cassetto.modules.plastico", "cassetto.modules.puzzles", "webview.platforms.qt", "qtpy"],
    excludes=["tkinter", "matplotlib", "numpy", "PyQt5", "PySide2", "PySide6", "gi"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="cassetto", console=False, strip=False, upx=False)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="cassetto")
