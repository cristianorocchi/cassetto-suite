from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT / "src", ROOT / "plastico" / "src"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))


@pytest.fixture
def home(tmp_path, monkeypatch):
    """Settings and new projects go to a temporary folder, never the real ~/.config or ~/Cassetto."""
    monkeypatch.setenv("CASSETTO_CONFIG", str(tmp_path / "config"))
    monkeypatch.setenv("CASSETTO_PROJECTS", str(tmp_path / "projects"))
    return tmp_path


@pytest.fixture
def core(home):
    from cassetto.core.modules import Core
    from cassetto.modules import all_modules
    c = Core(all_modules())
    yield c
    c.close_project()


def make_godot_game(root: Path) -> Path:
    """A tiny game on the SceneRouter framework Plastico reads: a square outside, a shop inside, a way
    between them, a shopkeeper in the shop and two times of day."""
    root.mkdir(parents=True)
    (root / "project.godot").write_text('[application]\nconfig/name="Tiny Game"\nrun/main_scene="res://scenes/square/square.tscn"\n')
    (root / "autoload").mkdir()
    (root / "autoload" / "scene_router.gd").write_text(
        'extends Node\n\nconst SCENES := {\n\t&"square": "res://scenes/square/square.tscn",\n\t&"shop": "res://scenes/shop/shop.tscn",\n}\n')
    (root / "autoload" / "game_state.gd").write_text('extends Node\n\nconst PHASES: Array[StringName] = [&"day", &"night"]\n')
    (root / "core").mkdir()
    (root / "core" / "hotspot.gd").write_text("extends Area2D\n")
    (root / "core" / "interior_location.gd").write_text("class_name InteriorLocation\nextends Node2D\n")
    (root / "core" / "exterior_location.gd").write_text("class_name ExteriorLocation\nextends Node2D\n")
    (root / "characters" / "shopkeeper").mkdir(parents=True)
    for sid, base, target, extra in (
            ("square", "ExteriorLocation", "shop", ""),
            ("shop", "InteriorLocation", "square",
             '[node name="Characters" type="Node2D" parent="."]\n\n[node name="Shopkeeper" type="Sprite2D" parent="Characters"]\n\n')):
        d = root / "scenes" / sid
        d.mkdir(parents=True)
        (d / f"{sid}.gd").write_text(f"extends {base}\n")
        (d / f"{sid}.tscn").write_text(
            f'[gd_scene load_steps=3 format=3]\n\n'
            f'[ext_resource type="Script" path="res://scenes/{sid}/{sid}.gd" id="1_s"]\n'
            f'[ext_resource type="Script" path="res://core/hotspot.gd" id="2_h"]\n\n'
            f'[node name="{sid.title()}" type="Node2D"]\nscript = ExtResource("1_s")\n\n'
            f'[node name="Hotspots" type="Node2D" parent="."]\n\n'
            f'[node name="To{target.title()}" type="Area2D" parent="Hotspots"]\nscript = ExtResource("2_h")\n'
            f'id = "to_{target}"\naction = "exit"\ntarget_scene = "{target}"\n\n{extra}')
    return root
