"""Reading and writing Godot projects. Uses a real game as the sample when PLASTICO_SAMPLE_GAME
points at its folder (those tests are skipped otherwise); writes only to copies in a temporary folder.

    PLASTICO_SAMPLE_GAME=/path/to/game uv run --with pytest pytest
"""
from __future__ import annotations

import copy
import hashlib
import os
import shutil
from pathlib import Path

import pytest

from plastico import apply, godot, store
from plastico.tscn import Scene

GAME = Path(os.environ["PLASTICO_SAMPLE_GAME"]) if os.environ.get("PLASTICO_SAMPLE_GAME") else None
needs_game = pytest.mark.skipif(GAME is None or not (GAME / "project.godot").exists(),
                                reason="set PLASTICO_SAMPLE_GAME to a Godot game folder to run these")


def text_files(root: Path) -> dict[str, str]:
    return {str(p.relative_to(root)): hashlib.sha1(p.read_bytes()).hexdigest()
            for p in sorted(root.rglob("*")) if p.is_file() and p.suffix in (".tscn", ".gd", ".godot", ".uid")}


@pytest.fixture
def mini_game(tmp_path, monkeypatch):
    """The game's code and three of its scenes (text files only, no art), in a temp folder."""
    root = tmp_path / "game"
    root.mkdir()
    shutil.copy2(GAME / "project.godot", root)
    for d in ("autoload", "core"):
        shutil.copytree(GAME / d, root / d)
    for sid in ("city_square", "bank", "pub_alley"):
        for f in (GAME / "scenes" / sid).glob("*"):
            if f.suffix in (".tscn", ".gd"):
                (root / "scenes" / sid).mkdir(parents=True, exist_ok=True)
                shutil.copy2(f, root / "scenes" / sid / f.name)
    monkeypatch.setattr(apply, "BACKUPS", tmp_path / "backups")
    return root


def plan(game: dict) -> dict:
    w = store.normalize({"id": "t", "name": "T", "godot": "", "scenes": [], "links": []})
    store.reconcile(w, game)
    return w


@needs_game
def test_every_scene_file_reads_and_writes_back_unchanged():
    files = sorted(GAME.glob("**/*.tscn"))
    assert len(files) > 10
    for f in files:
        if ".godot" in f.parts:
            continue
        text = f.read_text(encoding="utf-8")
        assert Scene(text).text() == text, f


@needs_game
def test_scan_reads_the_real_game():
    g = godot.scan(GAME)
    assert g["start"] and g["start"] in g["scenes"]
    assert len([s for s in g["scenes"].values() if s.get("exists")]) >= 10
    assert all(e["from"] in g["scenes"] for e in g["exits"])
    assert not [p for p in g["problems"] if p.get("level") == "error"]


@needs_game
def test_build_new_scenes_and_ways_then_undo(mini_game):
    before = text_files(mini_game)
    game = godot.scan(mini_game)
    w = plan(game)
    w["scenes"] += [
        {"id": "fish_market", "name": "Fish market", "kind": "inside", "act": "1", "area": "", "x": 0, "z": 20, "floor": 0, "status": "ready"},
        {"id": "harbour", "name": "Harbour", "kind": "outside", "act": "1", "area": "", "x": 30, "z": 20, "floor": 0, "status": "ready"},
    ]
    for a, b in (("city_square", "fish_market"), ("fish_market", "city_square"), ("bank", "harbour"), ("harbour", "bank")):
        w["links"].append({"id": f"{a}>{b}", "from": a, "to": b, "status": "ready"})
    w = store.normalize(w)
    changes = apply.plan_changes(w, game)
    ids = [c["id"] for c in changes if not c.get("blocked")]
    assert {"scene+fish_market", "scene+harbour", "exit+city_square>fish_market", "exit+harbour>bank"} <= set(ids)

    report = apply.build(mini_game, w, game, ids, {})
    assert len(report["done"]) == len(ids)
    after = godot.scan(mini_game)
    assert after["scenes"]["fish_market"]["exists"] and after["scenes"]["fish_market"]["kind"] == "inside"
    assert after["scenes"]["harbour"]["kind"] == "outside"
    ways = {(e["from"], e["to"]) for e in after["exits"]}
    assert {("city_square", "fish_market"), ("fish_market", "city_square"), ("bank", "harbour"), ("harbour", "bank")} <= ways
    assert {"fish_market", "harbour"} <= set(godot.router_scenes(mini_game))
    # the spawn the new exit arrives at exists in the outdoor scene it leads to
    assert not [p for p in after["problems"] if p["scene"] in ("fish_market", "harbour", "city_square", "bank")]
    # what was written still reads back byte for byte
    for f in ("scenes/fish_market/fish_market.tscn", "scenes/city_square/city_square.tscn"):
        text = (mini_game / f).read_text(encoding="utf-8")
        assert Scene(text).text() == text
        assert not text.endswith("\n\n")

    # Godot would make a uid for the new script on import: undo removes it with the script
    (mini_game / "scenes/fish_market/fish_market.gd.uid").write_text("uid://b123\n")
    apply.undo_last("t")
    assert text_files(mini_game) == before
    assert not (mini_game / "scenes/fish_market").exists()


@needs_game
def test_delete_a_scene_and_a_way_then_undo(mini_game):
    game = godot.scan(mini_game)
    w = plan(game)
    before = text_files(mini_game)
    into_bank = [l for l in w["links"] if l["to"] == "bank"]
    assert into_bank
    for s in w["scenes"]:
        if s["id"] == "bank":
            s["delete"] = True
    changes = apply.plan_changes(w, game)
    c = next(c for c in changes if c["id"] == "scene-bank")
    report = apply.build(mini_game, w, game, [c["id"]], {})
    assert not (mini_game / "scenes/bank").exists()
    assert "bank" not in godot.router_scenes(mini_game)
    assert not [e for e in godot.scan(mini_game)["exits"] if e["to"] == "bank"]
    assert report["backup"]
    apply.undo_last("t")
    assert text_files(mini_game) == before


@needs_game
def test_build_refuses_what_it_cannot_do(mini_game):
    game = godot.scan(mini_game)
    w = plan(game)
    w["links"].append({"id": "x", "from": "city_square", "to": "nowhere_yet", "status": "ready"})
    w["scenes"].append({"id": "nowhere_yet", "name": "Nowhere", "kind": "inside", "act": "1", "area": "", "x": 0, "z": 0, "floor": 0, "status": "idea", "delete": True})
    w = store.normalize(w)
    with pytest.raises(apply.BuildError):
        apply.build(mini_game, w, game, [], {})
    with pytest.raises(apply.BuildError):
        apply.undo_last("t")   # nothing built yet


def test_worlds_save_with_a_revision(tmp_path):
    w = store.create("My game, act 2", "", root=tmp_path)
    assert w["id"] == "my-game-act-2" and w["rev"] == 1
    w2 = copy.deepcopy(w)
    w["name"] = "Renamed"
    store.save(w, 1, root=tmp_path)
    w2["name"] = "Stale"
    with pytest.raises(store.Conflict):
        store.save(w2, 1, root=tmp_path)
    assert store.load(w["id"], root=tmp_path)["name"] == "Renamed"
    store.remove(w["id"], root=tmp_path)
    assert not store.exists(w["id"], root=tmp_path)
