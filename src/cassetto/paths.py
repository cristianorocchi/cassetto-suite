"""Where Cassetto finds its own files (from a source checkout or from a packaged build) and keeps the
user's settings. Nothing here knows about projects."""
from __future__ import annotations

import os
import sys
from pathlib import Path


def _base() -> Path:
    """The folder that holds web/, plastico/ and puzzle-charts/: the checkout, or the unpacked bundle."""
    frozen = getattr(sys, "_MEIPASS", None)
    if frozen:
        return Path(frozen)
    return Path(__file__).resolve().parents[2]


BASE = _base()
SHELL_WEB = BASE / "web"                       # the suite's own pages and shared assets
PLASTICO_WEB = BASE / "plastico" / "web"       # module pages, served as they are in their repos
PUZZLES_WEB = BASE / "puzzle-charts"


def config_dir() -> Path:
    """Settings that belong to the user, not to a project (recent projects, window size)."""
    root = os.environ.get("CASSETTO_CONFIG") or os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    d = Path(root) / "cassetto" if not os.environ.get("CASSETTO_CONFIG") else Path(root)
    d.mkdir(parents=True, exist_ok=True)
    return d


def default_projects_dir() -> Path:
    """Where new projects go unless the user picks another folder."""
    return Path(os.environ.get("CASSETTO_PROJECTS") or (Path.home() / "Cassetto"))
