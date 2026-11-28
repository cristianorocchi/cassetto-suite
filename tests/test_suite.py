"""The suite's core and the link between the modules, without a browser."""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

from conftest import make_godot_game


def test_new_project_has_manifest_and_module_folders(core, home):
    p = core.create_project(home / "projects" / "Tiny", "Tiny")
    m = json.loads((p.path / "cassetto.json").read_text())
    assert m["format"] == "cassetto.project" and m["version"] == 1 and m["name"] == "Tiny"
    assert m["modules"] == {"plastico": {"version": 3}, "puzzles": {"version": 2}}
    assert (p.path / "plastico" / "world.json").is_file()
    assert (p.path / "puzzles" / "charts").is_dir()
    assert {i["name"] for i in core.interfaces()} == {"world.catalog", "world.add_person", "world.add_scene", "world.place_person",
                                                     "puzzles.charts", "puzzles.create_chart", "puzzles.set_act", "puzzles.set_states", "puzzles.rename_scene",
                                                     "puzzles.references", "puzzles.add_to_world"}


def test_refuses_newer_formats_and_damaged_files(core, home):
    from cassetto.core.project import ProjectError
    p = core.create_project(home / "p1", "P1")
    core.close_project()
    m = json.loads((p.path / "cassetto.json").read_text())
    m["version"] = 99
    (p.path / "cassetto.json").write_text(json.dumps(m))
    with pytest.raises(ProjectError, match="newer Cassetto"):
        core.open_project(p.path)
    m["version"] = 1
    m["modules"]["puzzles"]["version"] = 7
    (p.path / "cassetto.json").write_text(json.dumps(m))
    with pytest.raises(ProjectError, match="Puzzle Charts data was saved by a newer"):
        core.open_project(p.path)
    assert core.project is None and not core.interfaces()
    (p.path / "cassetto.json").write_text("{ not json")
    with pytest.raises(ProjectError, match="damaged"):
        core.open_project(p.path)
    with pytest.raises(ProjectError, match="isn't a Cassetto project"):
        core.open_project(home)


def test_one_app_per_project(core, home):
    from cassetto.core.project import ProjectError
    p = core.create_project(home / "p", "P")
    assert (p.path / ".cassetto.lock").read_text() == str(__import__("os").getpid())
    core.close_project()
    assert not (p.path / ".cassetto.lock").exists()
    other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)", "cassetto"])   # another Cassetto
    try:
        (p.path / ".cassetto.lock").write_text(str(other.pid))
        with pytest.raises(ProjectError, match="already open"):
            core.open_project(p.path)
    finally:
        other.kill()
        other.wait()
    (p.path / ".cassetto.lock").write_text("1")      # left by a Cassetto that crashed: pid 1 is something else now
    assert core.open_project(p.path).name == "P"


def test_failed_start_leaves_nothing_behind(core, home):
    from cassetto.core.project import ProjectError
    with pytest.raises(ProjectError, match="isn't a Godot project"):
        core.create_project(home / "bad", "Bad", {"plastico": {"godot": str(home / "nowhere")}})
    assert not (home / "bad").exists() and core.project is None


def world_with(core, scenes, people=()):
    from plastico import store
    root = core.modules["plastico"].ctx.data_dir
    w = store.load("world", root)
    w["scenes"] = [{"id": s, "name": s.title()} for s in scenes]
    w["people"] = [{"id": p, "name": p.title()} for p in people]
    store.save(w, root=root)


def chart(nodes, edges=(), name="Lighthouse"):
    return {"v": 1, "name": name, "act": 1, "notes": "", "auto": True,
            "nodes": [{"id": i, "kind": k, "title": t, "scene": s, "who": "", "when": "", "gid": g, "status": "idea", "notes": "", "x": 0, "y": 0}
                      for i, k, t, s, g in nodes],
            "edges": [{"from": a, "to": b} for a, b in edges]}


def test_plastico_reads_the_charts_live_and_puzzles_reads_the_world(core, home):
    core.create_project(home / "p", "P")
    world_with(core, ["harbour", "lighthouse"], ["keeper"])
    puz = core.modules["puzzles"]
    puz.write("c1", chart([("n1", "item", "Get the key", "harbour", "lighthouse_key"), ("n2", "goal", "Light the lamp", "lighthouse", "")], [("n1", "n2")]))
    # Plastico's bundle (what its page shows) has the chart, with the step in its scene
    from plastico import server as pserver
    b = pserver.world_bundle("world")
    assert b["charts"]["live"] and [c["name"] for c in b["charts"]["charts"]] == ["Lighthouse"]
    assert b["charts"]["charts"][0]["nodes"][0]["scene"] == "harbour"
    # Puzzle Charts' scene pickers come from the world
    cat = core.call("world.catalog")
    assert cat["scenes"] == [["harbour", "Harbour"], ["lighthouse", "Lighthouse"]] and cat["people"] == [["keeper", "Keeper"]]


def test_renaming_a_scene_moves_its_steps_and_missing_scenes_are_reported(core, home):
    core.create_project(home / "p", "P")
    world_with(core, ["harbour"])
    puz = core.modules["puzzles"]
    puz.write("c1", chart([("n1", "action", "Ask about the key", "harbour", ""), ("n2", "action", "Climb", "tower", "")]))
    refs = core.call("puzzles.references")
    assert [(m["step"], m["scene"]) for m in refs["missing_scenes"]] == [("n2", "tower")]
    seq = core.events.seq
    assert core.call("puzzles.rename_scene", "harbour", "old_harbour") == {"steps": 1, "charts": 1}
    d = json.loads((puz.dir / "c1.json").read_text())
    assert d["nodes"][0]["scene"] == "old_harbour" and d["nodes"][1]["scene"] == "tower"
    assert any(e["type"] == "puzzles.changed" and e["source"] == "puzzles" for e in core.events.since(seq))


def test_a_chart_moves_to_another_act(core, home):
    core.create_project(home / "p", "P")
    cid = core.call("puzzles.create_chart", "The key", 1)
    puz = core.modules["puzzles"]
    seq = core.events.seq
    assert core.call("puzzles.set_act", cid, 2) == {"changed": True}
    assert json.loads((puz.dir / f"{cid}.json").read_text())["act"] == 2
    assert any(e["type"] == "puzzles.changed" for e in core.events.since(seq))
    assert core.call("puzzles.set_act", cid, "2") == {"changed": False}
    for bad in (0, 100, "two"):
        with pytest.raises(ValueError):
            core.call("puzzles.set_act", cid, bad)
    with pytest.raises(ValueError):
        core.call("puzzles.set_act", "nochart", 1)


def test_outside_edits_are_announced(core, home):
    p = core.create_project(home / "p", "P")
    seq = core.events.seq
    time.sleep(0.01)
    (p.path / "puzzles" / "charts" / "x.json").write_text(json.dumps(chart([("a", "goal", "Done", "", "")])))
    assert core.check_changes() == ["puzzles"]
    ev = core.events.since(seq)[-1]
    assert ev["type"] == "puzzles.changed" and ev["source"] == "disk"
    assert core.check_changes() == []


def test_import_every_shape_charts_travel_in(core, home):
    core.create_project(home / "p", "P")
    puz = core.modules["puzzles"]
    export = {"chart": "From the page", "act": 2, "notes": "", "steps": [
        {"id": "a", "kind": "item", "title": "Key", "scene": "x", "who": "", "when": "", "game_id": "key", "status": "idea", "notes": "", "needs": []},
        {"id": "b", "kind": "goal", "title": "Open", "scene": "x", "who": "", "when": "", "game_id": "", "status": "idea", "notes": "", "needs": ["a"]}]}
    synced = {"synced": 1, "source": "x", "charts": [{"id": "abc", "name": "Synced", "act": 1, "nodes": [{"id": "n", "kind": "goal", "title": "G"}], "edges": []}]}
    ids = puz.import_charts(export) + puz.import_charts(synced) + puz.import_charts([chart([("q", "goal", "Q", "", "")], name="Doc")])
    docs = dict(puz.docs())
    assert len(ids) == 3 and "abc" in docs
    a = docs[ids[0]]
    assert a["name"] == "From the page" and a["act"] == 2 and a["edges"] == [{"from": "a", "to": "b"}] and a["nodes"][0]["gid"] == "key"
    assert docs["abc"]["auto"] is True
    with pytest.raises(ValueError):
        puz.import_charts({"something": "else"})


def test_a_damaged_chart_is_reported_not_lost(core, home):
    p = core.create_project(home / "p", "P")
    (p.path / "puzzles" / "charts" / "bad.json").write_text("{oops")
    puz = core.modules["puzzles"]
    assert puz.docs() == [] and "bad.json can't be read" in puz.problems()[0]
    assert (p.path / "puzzles" / "charts" / "bad.json").exists()


def test_start_from_a_standalone_plastico_world_with_its_charts(core, home):
    old = home / "old-plastico" / "worlds"
    old.mkdir(parents=True)
    (old / "town.json").write_text(json.dumps({"v": 1, "id": "town", "name": "Town", "scenes": [{"id": "inn", "name": "Inn"}], "links": []}))
    (old / "town.charts.json").write_text(json.dumps({"synced": 1, "source": "x", "charts": [
        {"id": "k1", "name": "Inn puzzle", "act": 1, "nodes": [{"id": "n", "kind": "goal", "title": "Sleep", "scene": "inn"}], "edges": []}]}))
    p = core.create_project(home / "projects" / "Town", "Town", {"plastico": {"world_file": str(old / "town.json")},
                                                                "puzzles": {"charts_file": str(old / "town.charts.json")}})
    assert core.call("world.catalog")["scenes"] == [["inn", "Inn"]]
    assert core.call("puzzles.charts")["charts"][0]["nodes"][0]["scene"] == "inn"
    assert json.loads((p.path / "plastico" / "world.json").read_text())["name"] == "Town"


def test_linked_godot_game_is_read_and_reported(core, home):
    from cassetto.integrations import godot as link
    game = make_godot_game(home / "game")
    core.create_project(home / "p", "P", {"plastico": {"godot": str(game)}})
    from plastico import server as pserver
    b = pserver.world_bundle("world")      # what Plastico's page asks for: the game read now, merged in
    assert b["game_error"] == "" and set(b["game"]["scenes"]) == {"square", "shop"}
    assert {(e["from"], e["to"]) for e in b["game"]["exits"]} == {("square", "shop"), ("shop", "square")}
    assert b["game"]["scenes"]["shop"]["people"]["night"] == ["shopkeeper"]
    cat = core.call("world.catalog")
    # the game's phases are a group of states of every act
    assert {s for s, _ in cat["scenes"]} == {"square", "shop"} and cat["states"] == {"1": [["day", "Day"], ["night", "Night"]]}
    assert cat["groups"] == [{"id": "game", "name": "Phase of the game", "acts": ["1"], "states": [["day", "Day"], ["night", "Night"]], "game": True}]
    st = link.status(cat["godot"])
    assert st["found"] and st["name"] == "Tiny Game"
    assert {c["state"] for c in st["capabilities"]} == {"works", "planned"}
    assert link.status(str(home / "gone"))["found"] is False and link.status("")["linked"] is False


def test_new_project_lists_the_godot_games_found(home):
    """"Start from a Godot game" offers the games in ~/Desktop/Projects and one folder down."""
    from cassetto.integrations import godot as link
    base = home / "Projects"
    make_godot_game(base / "tiny")
    make_godot_game(base / "jams" / "jam1")
    (base / "notes").mkdir()
    games = link.find_games(base)
    assert [g["name"] for g in games] == ["Tiny Game", "Tiny Game"]
    assert {Path(g["path"]).name for g in games} == {"tiny", "jam1"}
    assert link.find_games(home / "nowhere") == []


def test_rename_project_renames_the_world(core, home):
    core.create_project(home / "p", "P")
    core.rename_project("Better name")
    assert core.call("world.catalog")["world"] == "Better name"
    core.close_project()
    p = core.open_project(home / "p")
    assert p.name == "Better name"


def test_a_version_1_world_comes_up_to_date_on_the_grid(core, home):
    """Projects made before grid sizes, parents and chart associations open unchanged in meaning."""
    from plastico import store
    p = core.create_project(home / "old", "Old")
    core.close_project()
    v1 = {"v": 1, "id": "world", "name": "Old", "scenes": [
        {"id": "square", "name": "Square", "kind": "outside", "x": 0.5, "z": 0, "floor": 0},
        {"id": "shop", "name": "Shop", "kind": "inside", "x": 12.5, "z": -3.5, "floor": 0},
        {"id": "desk", "name": "Desk", "kind": "closeup", "x": 3.0, "z": 9.0, "floor": 1}], "links": []}
    (p.path / "plastico" / "world.json").write_text(json.dumps(v1))
    m = json.loads((p.path / "cassetto.json").read_text())
    m["modules"]["plastico"]["version"] = 1
    (p.path / "cassetto.json").write_text(json.dumps(m))
    core.open_project(p.path)
    assert json.loads((p.path / "cassetto.json").read_text())["modules"]["plastico"]["version"] == 3
    w = store.load("world", p.path / "plastico")
    assert w["v"] == 3 and json.loads((p.path / "plastico" / "world.json").read_text())["v"] == 3
    for s in w["scenes"]:
        assert isinstance(s["w"], int) and isinstance(s["d"], int) and s["parent"] == "" and s["charts"] == []
        for c, size in ((s["x"], s["w"]), (s["z"], s["d"])):      # both edges on grid lines
            assert (c - size / 2) == int(c - size / 2) and (c + size / 2) == int(c + size / 2)
    sizes = {s["id"]: (s["w"], s["d"]) for s in w["scenes"]}
    assert sizes == {"square": (12, 7), "shop": (6, 4), "desk": (3, 2)}
    by = {s["id"]: s for s in w["scenes"]}
    assert abs(by["shop"]["x"] - 12.5) <= 0.5 and abs(by["shop"]["z"] + 3.5) <= 0.5   # moved by under a cell


def test_a_version_2_world_turns_its_times_of_day_into_a_group_of_every_act(core, home):
    """The times of day become a group of states every act has, so who is where at each time stays where it was."""
    from plastico import store
    p = core.create_project(home / "old2", "Old2")
    core.close_project()
    v2 = {"v": 2, "id": "world", "name": "Old2", "phases": ["morning", "night"],
          "acts": [{"id": "1", "name": "", "start": ""}, {"id": "2", "name": "Later", "start": ""}],
          "people": [{"id": "elda", "name": "Elda"}],
          "scenes": [{"id": "pub", "name": "Pub", "kind": "inside", "act": "1", "x": 3, "z": 2, "w": 6, "d": 4,
                      "people": {"night": ["elda"]}, "open": ["night"]}], "links": []}
    (p.path / "plastico" / "world.json").write_text(json.dumps(v2))
    m = json.loads((p.path / "cassetto.json").read_text())
    m["modules"]["plastico"]["version"] = 2
    (p.path / "cassetto.json").write_text(json.dumps(m))
    core.open_project(p.path)
    on_disk = json.loads((p.path / "plastico" / "world.json").read_text())
    assert on_disk["v"] == 3 and "phases" not in on_disk
    assert on_disk["groups"] == [{"id": "time", "name": "Time of day", "acts": ["1", "2"],
                                  "states": [{"id": "morning", "name": "Morning"}, {"id": "night", "name": "Night"}]}]
    pub = on_disk["scenes"][0]
    assert pub["people"] == {"night": ["elda"]} and pub["open"] == ["night"]
    assert core.call("world.catalog")["people_at"] == {"pub": {"night": ["elda"]}}
    assert list((p.path / "plastico" / ".history" / "world").glob("*.json"))      # the version 2 file is kept
    assert store.act_states(store.load("world", p.path / "plastico"), "2") == ["morning", "night"]


def test_parents_and_chart_associations_are_kept_and_checked(core, home):
    from plastico import store
    p = core.create_project(home / "p", "P")
    root = p.path / "plastico"
    cid = core.call("puzzles.create_chart", "Lighthouse")
    w = store.load("world", root)
    w["acts"].append({"id": "2", "name": "Night", "start": ""})
    w["scenes"] = [
        {"id": "lighthouse", "name": "Lighthouse", "act": "2", "charts": [cid, cid, "gone"]},
        {"id": "lamp_room", "name": "Lamp room", "act": "1", "parent": "lighthouse", "charts": [cid]},
        {"id": "lamp", "name": "Lamp", "parent": "lamp_room"},
        {"id": "a", "name": "A", "parent": "b"}, {"id": "b", "name": "B", "parent": "a"},     # a loop
        {"id": "orphan", "name": "Orphan", "parent": "nowhere"},
    ]
    store.save(w, root=root)
    core.close_project()
    core.open_project(p.path)            # reopened: everything as saved
    w = store.load("world", root)
    by = {s["id"]: s for s in w["scenes"]}
    assert by["lighthouse"]["charts"] == [cid, "gone"] and by["lamp_room"]["charts"] == [cid]
    assert by["lamp_room"]["parent"] == "lighthouse" and by["lamp"]["parent"] == "lamp_room"
    assert by["lamp_room"]["act"] == "2" and by["lamp"]["act"] == "2"      # children are in their parent's act
    assert by["orphan"]["parent"] == "" and "" in (by["a"]["parent"], by["b"]["parent"])
    cat = core.call("world.catalog")
    h = {s["id"]: s for s in cat["hierarchy"]}
    assert h["lamp"]["parent"] == "lamp_room" and h["lighthouse"]["charts"] == [cid, "gone"]
    refs = core.call("puzzles.references")
    assert refs["missing_charts"] == [{"scene": "lighthouse", "scene_name": "Lighthouse", "chart": "gone"}]
    # the chart is one: listed once in the project, whatever the scenes that point at it
    assert [c["id"] for c in core.call("puzzles.charts")["charts"]] == [cid]
