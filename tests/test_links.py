"""Plastico and Puzzle Charts as one model: which charts go with a scene, step counts, locks, and adding to the
world what a puzzle step names but the world doesn't have."""
from __future__ import annotations

import json

import pytest


def _world(core):
    from plastico import store
    return store.load("world", core.project.module_dir("plastico"))


def _save_world(core, w):
    from plastico import store
    store.save(w, root=core.project.module_dir("plastico"))


def _setup(core, home):
    """Two scenes in act 1, a lock, and two charts: one with steps in both scenes, one only pinned."""
    p = core.create_project(home / "links", "Links")
    pl = core.modules["plastico"]
    pl.add_scene("Pub", "1")
    pl.add_scene("Alley", "1")
    pl.add_person("Elda")
    w = _world(core)
    pub = next(s for s in w["scenes"] if s["name"] == "Pub")
    alley = next(s for s in w["scenes"] if s["name"] == "Alley")
    w["links"].append({"id": "l_pub_alley", "from": "pub", "to": "alley", "status": "ready",
                       "lock": {"needs": "alley_key", "type": "item", "where": "", "note": ""}, "open": [], "via": "", "notes": "", "delete": False})
    pinned = core.call("puzzles.create_chart", "Planned for the alley")
    alley["charts"] = [pinned]
    w["groups"] = [{"id": "time", "name": "Time of day", "acts": ["1"], "states": [{"id": "day", "name": "Day"}, {"id": "night", "name": "Night"}]}]
    _save_world(core, w)
    pz = core.modules["puzzles"]
    pz.import_charts({"chart": "The key", "act": 1, "steps": [
        {"id": "s1", "kind": "setup", "title": "The pub at night", "scene": "pub"},
        {"id": "s2", "kind": "action", "title": "Ask Elda", "scene": "pub", "who": "elda", "needs": ["s1"]},
        {"id": "s3", "kind": "item", "title": "The key", "scene": "pub", "game_id": "alley_key", "needs": ["s2"]},
        {"id": "s4", "kind": "action", "title": "Ask the stationmaster", "scene": "station", "who": "stationmaster (new)", "needs": ["s3"]},
        {"id": "s5", "kind": "action", "title": "Open the door", "scene": "alley", "who": "stationmaster (new)", "needs": ["s4"]},
        {"id": "g", "kind": "goal", "title": "Out", "scene": "alley", "needs": ["s5"]},
    ]})
    key = next(cid for cid, d in pz.docs() if d.get("name") == "The key")
    return p, pub, alley, pinned, key


def test_a_chart_goes_with_the_scenes_its_steps_are_in(core, home):
    _, pub, alley, pinned, key = _setup(core, home)
    cat = core.call("world.catalog")
    h = {s["id"]: s for s in cat["hierarchy"]}
    # the pub: 2 steps of "The key" (the scene setup isn't a step), nothing pinned
    assert h["pub"]["charts_from_steps"] == {key: 2} and h["pub"]["charts_pinned"] == [] and h["pub"]["charts"] == [key]
    assert h["pub"]["steps"] == 2
    # the alley: the pinned chart first, then the one with a step there (the end goal isn't a step)
    assert h["alley"]["charts"] == [pinned, key] and h["alley"]["charts_from_steps"] == {key: 1}
    assert cat["locks"] == [{"from": "pub", "to": "alley", "needs": "alley_key", "type": "item", "where": ""}]
    # every view counts the same steps: not the end goals, not the scene setups
    ch = {c["id"]: c for c in core.call("puzzles.charts")["charts"]}
    assert ch[key]["steps"] == 4 and ch[pinned]["steps"] == 0


def test_the_catalog_says_who_is_where_and_new_charts_take_an_act(core, home):
    _setup(core, home)
    w = _world(core)
    pub = next(s for s in w["scenes"] if s["id"] == "pub")
    pub["people"] = {"day": ["elda"]}
    _save_world(core, w)
    cat = core.call("world.catalog")
    assert cat["people_at"] == {"pub": {"day": ["elda"]}}
    h = {s["id"]: s for s in cat["hierarchy"]}
    assert h["pub"]["in_game"] is False and h["pub"]["status"] == "idea"
    cid = core.call("puzzles.create_chart", "In act two", 2)
    assert dict(core.modules["puzzles"].docs())[cid]["act"] == 2
    odd = core.call("puzzles.create_chart", "Odd", "x")     # not an act number: act 1
    assert dict(core.modules["puzzles"].docs())[odd]["act"] == 1


def test_who_is_where_follows_the_game_less_the_ones_taken_away():
    from cassetto.modules.plastico import PlasticoModule
    w = {"acts": [{"id": "1"}], "groups": [{"id": "time", "acts": ["1"], "states": [{"id": "day", "name": "Day"}, {"id": "night", "name": "Night"}]}], "scenes": [
        {"id": "pub", "act": "1", "people": {"night": ["elda"]}, "away": {"day": ["grondo"]}},
        {"id": "gone", "act": "1", "delete": True, "people": {"day": ["elda"]}}]}
    game = {"pub": {"people": {"day": ["grondo", "tamira"], "night": ["grondo"]}}}
    assert PlasticoModule._people_at(w, game) == {"pub": {"day": ["tamira"], "night": ["grondo", "elda"]}}


def test_adding_to_the_world_what_a_step_names(core, home):
    _, _, _, _, key = _setup(core, home)
    refs = core.call("puzzles.references")
    assert {m["who"] for m in refs["missing_people"]} == {"stationmaster (new)"}
    assert {m["scene"] for m in refs["missing_scenes"]} == {"station"}
    r = core.call("puzzles.add_to_world", "person", "stationmaster (new)")
    # they go where the steps have them: the alley, always (the step names no state; the station isn't in the world yet)
    assert r == {"id": "stationmaster", "name": "Stationmaster", "steps": 2, "charts": 1,
                 "placed": [{"scene": "alley", "phases": ["any"]}]}
    al = next(s for s in _world(core)["scenes"] if s["id"] == "alley")
    assert al["people"] == {"any": ["stationmaster"]}
    assert core.call("world.catalog")["people_at"]["alley"] == {"day": ["stationmaster"], "night": ["stationmaster"]}
    assert core.call("world.place_person", "stationmaster", "alley", ["day"]) == []      # already there, always
    assert core.call("world.place_person", "elda", "pub", ["night", "noon"]) == ["night"]  # unknown times are skipped
    with pytest.raises(ValueError):
        core.call("world.place_person", "nobody", "pub")
    r = core.call("puzzles.add_to_world", "scene", "station")
    assert r["id"] == "station" and r["name"] == "Station" and r["steps"] == 1
    w = _world(core)
    st = next(s for s in w["scenes"] if s["id"] == "station")
    assert st["act"] == "1" and st["status"] == "idea"
    assert not [s for s in w["scenes"] if s["id"] != "station" and s["x"] == st["x"] and s["z"] == st["z"]]
    assert {"id": "stationmaster", "name": "Stationmaster"} in w["people"]
    refs = core.call("puzzles.references")
    assert not refs["missing_people"] and not refs["missing_scenes"]
    doc = dict(core.modules["puzzles"].docs())[key]
    assert {n["id"]: n["who"] for n in doc["nodes"] if n["who"]} == {"s2": "elda", "s4": "stationmaster", "s5": "stationmaster"}
    # asking again finds the one already there instead of making a second
    assert core.call("world.add_person", "stationmaster") == "stationmaster"
    assert core.call("world.add_scene", "Station", "1") == "station"
    assert len([p for p in _world(core)["people"] if p["id"].startswith("stationmaster")]) == 1
    with pytest.raises(ValueError):
        core.call("world.add_person", "   ")


def test_groups_of_states_hold_for_one_act_or_several(core, home):
    """Groups of states: "Weather" holds for acts 1 and 2 (it rains on both), "Story" for act 2 only. One state
    of each group is on at a time; who is where follows them all (in a group: any state listed; across groups: all)."""
    _setup(core, home)
    w = _world(core)
    w["acts"].append({"id": "2", "name": "Downtown", "start": ""})
    w["groups"] += [{"id": "weather", "name": "Weather", "acts": ["1", "2"], "states": [{"id": "sun", "name": "Sun"}, {"id": "", "name": "Rain"}]},
                    {"id": "story", "name": "Story", "acts": ["2", "nope"], "states": [{"id": "", "name": "Before the fallout"},
                                                                                     {"id": "", "name": "After the fallout"}, {"id": "sun", "name": "Dupe"}]}]
    _save_world(core, w)
    w = _world(core)
    g = {x["id"]: x for x in w["groups"]}
    assert [s["id"] for s in g["weather"]["states"]] == ["sun", "rain"]                                     # ids from the names
    assert [s["id"] for s in g["story"]["states"]] == ["before_the_fallout", "after_the_fallout"]           # an id already used goes
    assert g["story"]["acts"] == ["2"]                                                                       # acts the world has
    cat = core.call("world.catalog")
    assert cat["states"]["1"] == [["day", "Day"], ["night", "Night"], ["sun", "Sun"], ["rain", "Rain"]]
    assert cat["states"]["2"] == [["sun", "Sun"], ["rain", "Rain"], ["before_the_fallout", "Before the fallout"], ["after_the_fallout", "After the fallout"]]
    assert [x["id"] for x in cat["groups"]] == ["time", "weather", "story"]
    # the wife is home before the fallout (any weather); the umbrella seller only when it rains, before the fallout
    house = core.call("world.add_scene", "House", "2")
    core.call("world.add_person", "Wife")
    core.call("world.add_person", "Seller")
    assert core.call("world.place_person", "wife", house, ["before_the_fallout", "day"]) == ["before_the_fallout"]   # "day" is act 1's
    core.call("world.place_person", "seller", house, ["rain", "before_the_fallout"])
    at = core.call("world.catalog")["people_at"][house]
    assert at == {"sun": ["wife"], "rain": ["wife", "seller"], "before_the_fallout": ["wife", "seller"]}
    from plastico import store
    gof = store.group_of(_world(core))
    seller = {"rain", "before_the_fallout"}
    assert store.present(seller, {"weather": "rain", "story": "before_the_fallout"}, gof)
    assert not store.present(seller, {"weather": "sun", "story": "before_the_fallout"}, gof)
    assert not store.present(seller, {"weather": "rain", "story": "after_the_fallout"}, gof)
    assert store.present({"any"}, {"weather": "sun"}, gof) and not store.present(set(), {}, gof)


def test_a_chart_is_active_in_some_states_of_its_act(core, home):
    core.create_project(home / "s", "S")
    pz = core.modules["puzzles"]
    cid = core.call("puzzles.create_chart", "The coffee machine", 1)
    assert core.call("puzzles.charts")["charts"][0]["states"] == []            # new: active in every state
    assert core.call("puzzles.set_states", cid, ["before", "before"]) == {"changed": True}
    assert core.call("puzzles.charts")["charts"][0]["states"] == ["before"]
    assert core.call("puzzles.set_states", cid, ["before"]) == {"changed": False}
    with pytest.raises(ValueError):
        core.call("puzzles.set_states", cid, "before")
    assert json.loads((pz.dir / f"{cid}.json").read_text())["v"] == 2
    core.call("puzzles.set_act", cid, 2)                                       # another act: its states start over
    assert core.call("puzzles.charts")["charts"][0]["states"] == []


def test_the_world_saves_keep_a_history(core, home):
    p = core.create_project(home / "h", "H")
    core.call("world.add_person", "Elda")
    core.call("world.add_scene", "Pub", "1")
    hist = p.path / "plastico" / ".history" / "world"
    assert len(list(hist.glob("*.json"))) >= 2
    assert json.loads((p.path / "plastico" / "world.json").read_text())["people"] == [{"id": "elda", "name": "Elda"}]
