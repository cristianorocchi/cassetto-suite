"""Plastico: a 3D model of a game's world (scenes and the ways between them), linked to a Godot project."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]      # the app's folder (web/, worlds/, backups/)
WEB = ROOT / "web"
WORLDS = ROOT / "worlds"
BACKUPS = ROOT / "backups"
