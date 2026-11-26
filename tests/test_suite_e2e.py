"""The suite in a real browser: the shell, both modules, the link between them, saving and reopening.

Needs Playwright and Chrome (or Playwright's Chromium); skipped otherwise.
    uv run --group dev pytest tests/test_suite_e2e.py
Screenshots go to $CASSETTO_SHOTS when it is set.
"""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import pytest

pw = pytest.importorskip("playwright.sync_api")

CHROME = shutil.which("google-chrome") or shutil.which("chromium") or ""
SHOTS = os.environ.get("CASSETTO_SHOTS", "")


def shot(page, name):
    if SHOTS:
        Path(SHOTS).mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(Path(SHOTS) / f"{name}.png"))


@pytest.fixture
def server(home):
    from cassetto.core.modules import Core
    from cassetto.core.server import serve_in_thread
    from cassetto.modules import all_modules
    started = []

    def start():
        core = Core(all_modules())
        srv = serve_in_thread(core, 0)
        started.append((core, srv))
        return core, srv
    yield start
    for core, srv in started:
        core.close_project()
        srv.shutdown()
        srv.server_close()


@pytest.fixture
def browser():
    with pw.sync_playwright() as p:
        try:
            b = p.chromium.launch(executable_path=CHROME or None, args=[
                "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--no-proxy-server"])
        except Exception as e:  # noqa: BLE001
            pytest.skip(f"no browser for Playwright: {e}")
        yield b
        b.close()


def open_shell(browser, url):
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(url)
    return page, errors


def frame(page, mid):
    page.wait_for_function(f"!!document.querySelector('iframe[src=\"/m/{mid}/\"]')")
    for _ in range(100):
        f = next((f for f in page.frames if f.url.endswith(f"/m/{mid}/")), None)
        if f:
            return f
        page.wait_for_timeout(100)
    raise AssertionError(f"no frame for {mid}")


def charts_on_disk(project: Path) -> list[dict]:
    return [json.loads(f.read_text()) for f in sorted((project / "puzzles" / "charts").glob("*.json"))]


def world_on_disk(project: Path) -> dict:
    return json.loads((project / "plastico" / "world.json").read_text())


def on_grid(s: dict) -> bool:
    return all(float(c - n / 2).is_integer() and float(c + n / 2).is_integer() for c, n in ((s["x"], s["w"]), (s["z"], s["d"])))


def wait_saved(page):
    page.wait_for_function("document.querySelector('#status-text').textContent === 'Saved'")
    page.wait_for_timeout(700)


def add_scene(pl, name, inside=""):
    """Plastico's Add scene dialog: a name, and an act or a scene to put it in."""
    pl.click("#btn-add")
    pl.wait_for_selector("#f-new-name")
    pl.fill("#f-new-name", name)
    if inside:
        pl.select_option("#f-new-parent", inside)
        assert pl.eval_on_selector("input[name=where][value=parent]", "e => e.checked")
    text = pl.text_content("#f-new-where")
    pl.click("#f-new-go")
    pl.wait_for_function(f"document.querySelector('#f-name') && document.querySelector('#f-name').value === {json.dumps(name)}")
    pl.press("#f-name", "Tab")          # the name sets the id
    return text


def tree_rows(page):
    return page.eval_on_selector_all("#tree-body .tn", "rs => rs.map(r => [r.className.split(' ')[1], parseInt(r.style.paddingLeft), r.querySelector('.nm').textContent])")


def test_the_suite_end_to_end(server, browser, home):
    core, srv = server()
    page, errors = open_shell(browser, srv.url)

    # 1. no project yet: the welcome screen; make one
    page.wait_for_selector("#welcome:not([hidden])")
    shot(page, "01-welcome")
    page.click("text=New project")
    page.fill(".modal-box input >> nth=0", "Lighthouse Island")
    page.click(".modal-box >> text=Create")
    page.wait_for_selector("#welcome", state="hidden")
    project = home / "projects" / "Lighthouse Island"
    assert (project / "cassetto.json").is_file()
    page.wait_for_selector("#tree:not([hidden]) .tn.act")

    # 2. scenes through the Add scene dialog: two in act 1, one inside the lighthouse
    pl = frame(page, "plastico")
    pl.wait_for_selector("#empty:not([hidden])")
    assert "Outside" not in pl.text_content("#btn-add")
    t = add_scene(pl, "Harbour")
    assert "It goes in: Act 1 › Harbour" in t
    pl.wait_for_function("document.querySelector('#f-id').value === 'harbour'")
    pl.press("#f-name", "Escape")
    add_scene(pl, "Lighthouse")
    pl.wait_for_function("document.querySelector('#f-id').value === 'lighthouse'")
    t = add_scene(pl, "Lamp room", inside="lighthouse")
    assert "Act 1 › Lighthouse › Lamp room" in t
    pl.wait_for_function("document.querySelector('#f-id').value === 'lamp_room'")
    wait_saved(page)
    w = world_on_disk(project)
    by = {s["id"]: s for s in w["scenes"]}
    assert w["v"] == 2 and by["lamp_room"]["parent"] == "lighthouse" and by["lamp_room"]["act"] == "1"
    assert all(on_grid(s) for s in w["scenes"])
    lh, lr = by["lighthouse"], by["lamp_room"]
    assert lr["z"] > lh["z"]          # below its parent on the map (touching it when that edge is free: tests/model.test.mjs)
    # the tree: Act 1 › Harbour, Lighthouse › Lamp room (nested one level deeper)
    page.wait_for_function("[...document.querySelectorAll('#tree-body .tn .nm')].some(n => n.textContent === 'Lamp room')")
    rows = tree_rows(page)
    depth = {name: pad for _, pad, name in rows}
    assert depth["Lamp room"] > depth["Lighthouse"] > depth["Act 1"]
    shot(page, "02-scenes-and-tree")

    # 3. a new chart from the lighthouse's panel: made in Puzzle Charts, put with the scene, opened there
    page.click("#tree .tn.scene >> text=Lighthouse")
    pl.wait_for_function("document.querySelector('#f-id') && document.querySelector('#f-id').value === 'lighthouse'")
    pl.click("text=New chart for this scene")
    page.wait_for_function("document.querySelector('.tab[aria-selected=true]').textContent.includes('Puzzle Charts')")
    pz = frame(page, "puzzles")
    pz.wait_for_function("document.querySelector('#f-chart-name') && document.querySelector('#f-chart-name').value === 'Lighthouse'")
    pz.fill("#f-chart-name", "Light the lamp")
    pz.wait_for_selector(".linkrow.scenes >> text=Lighthouse")          # the chart knows its scene
    wait_saved(page)
    ch = charts_on_disk(project)
    assert len(ch) == 1 and ch[0]["name"] == "Light the lamp"
    cid = next(f.stem for f in (project / "puzzles" / "charts").glob("*.json"))
    assert {s["id"]: s for s in world_on_disk(project)["scenes"]}["lighthouse"]["charts"] == [cid]

    # 4. put the same chart with the harbour too: one chart, two entries in the tree
    page.click("#tree .tn.scene >> text=Harbour")
    page.wait_for_function("document.querySelector('.tab[aria-selected=true]').textContent.includes('Plastico')")
    pl.wait_for_function("document.querySelector('#f-id') && document.querySelector('#f-id').value === 'harbour'")
    pl.select_option("#f-add-chart", cid)
    pl.wait_for_selector("#scene-charts >> text=Light the lamp")
    wait_saved(page)
    page.wait_for_function("[...document.querySelectorAll('#tree-body .tn.chart .nm')].filter(n => n.textContent === 'Light the lamp').length === 2")
    assert len(charts_on_disk(project)) == 1
    shot(page, "03-one-chart-two-scenes")
    # a chart entry in the tree opens that chart
    page.click("#tree-body .tn.chart >> nth=0")
    page.wait_for_function("document.querySelector('.tab[aria-selected=true]').textContent.includes('Puzzle Charts')")
    pz.wait_for_function("document.querySelector('#f-chart-name').value === 'Light the lamp'")
    # and from a scene's panel too
    page.click("#tree .tn.scene >> text=Harbour")
    pl.wait_for_selector("#scene-charts >> text=Light the lamp")
    pl.click("#scene-charts .go")
    page.wait_for_function("document.querySelector('.tab[aria-selected=true]').textContent.includes('Puzzle Charts')")

    # 5. take it off the harbour: the chart stays in the project and with the lighthouse
    page.click("#tree .tn.scene >> text=Harbour")
    pl.wait_for_function("document.querySelector('#f-id').value === 'harbour'")
    pl.click("#scene-charts .x")
    pl.wait_for_selector("#scene-charts li", state="detached")
    wait_saved(page)
    by = {s["id"]: s for s in world_on_disk(project)["scenes"]}
    assert by["harbour"]["charts"] == [] and by["lighthouse"]["charts"] == [cid] and len(charts_on_disk(project)) == 1
    page.wait_for_function("[...document.querySelectorAll('#tree-body .tn.chart .nm')].filter(n => n.textContent === 'Light the lamp').length === 1")

    # 6. resizing keeps the edges on the grid and refuses to cover a neighbour
    page.click("#tree .tn.scene >> text=Harbour")
    pl.wait_for_function("document.querySelector('#f-id').value === 'harbour'")
    pl.fill("#f-w", "9")
    pl.press("#f-w", "Tab")
    wait_saved(page)
    by = {s["id"]: s for s in world_on_disk(project)["scenes"]}
    assert by["harbour"]["w"] == 9 and on_grid(by["harbour"])
    # dragging a scene: it lands with its edges on the grid lines, nothing overlapped
    lab = pl.locator(".lab[data-id='harbour'] .lab-name")
    box = lab.bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.mouse.down()
    page.mouse.move(box["x"] + 60, box["y"] + 90, steps=8)
    page.mouse.move(box["x"] + 137, box["y"] + 151, steps=8)
    page.mouse.up()
    wait_saved(page)
    w = world_on_disk(project)
    by = {s["id"]: s for s in w["scenes"]}
    assert (by["harbour"]["x"], by["harbour"]["z"]) != (12.0, 0.0) and all(on_grid(s) for s in w["scenes"])
    from cassetto import paths  # noqa: F401  (the model's overlap rule, from Python: footprints share no area)
    boxes = [(s["x"] - s["w"] / 2, s["x"] + s["w"] / 2, s["z"] - s["d"] / 2, s["z"] + s["d"] / 2) for s in w["scenes"] if s["floor"] == 0]
    for i, a in enumerate(boxes):
        for b in boxes[i + 1:]:
            assert not (a[0] < b[1] and b[0] < a[1] and a[2] < b[3] and b[2] < a[3]), (a, b)

    # 7. a step placed in the lighthouse follows its renaming; the tree follows too
    page.click("#tree .tn.chart >> text=Light the lamp")
    pz.wait_for_selector(".node")
    pz.locator("body").press("f")          # fit the chart to the screen
    pz.click(".node")
    pz.wait_for_selector("#f-scene")
    pz.fill("#f-scene", "lighthouse")
    wait_saved(page)
    page.click("#tree .tn.scene >> text=Lighthouse")
    pl.wait_for_function("document.querySelector('#f-id').value === 'lighthouse'")
    pl.fill("#f-name", "Old lighthouse")
    pl.press("#f-name", "Tab")
    pl.wait_for_function("document.querySelector('#f-id').value === 'old_lighthouse'")
    page.wait_for_selector("#tree .tn.scene >> text=Old lighthouse")
    for _ in range(50):
        if all(n["scene"] == "old_lighthouse" for c in charts_on_disk(project) for n in c["nodes"] if n["scene"]):
            break
        page.wait_for_timeout(100)
    assert [n["scene"] for c in charts_on_disk(project) for n in c["nodes"] if n["scene"]] == ["old_lighthouse"]
    wait_saved(page)
    by = {s["id"]: s for s in world_on_disk(project)["scenes"]}
    assert by["lamp_room"]["parent"] == "old_lighthouse" and by["old_lighthouse"]["charts"] == [cid]

    # 8. a step in a scene the world doesn't have: Puzzle Charts warns, the shell counts it
    page.click("#tree .tn.chart >> text=Light the lamp")
    pz.wait_for_selector(".node")
    pz.locator("body").press("f")
    pz.click(".node")
    pz.fill("#f-scene", "cellar")
    pz.wait_for_selector("text=No scene “cellar” in the world yet")
    page.wait_for_selector("#btn-links:not([hidden])")
    assert "1 broken link" in page.text_content("#btn-links")
    pz.fill("#f-scene", "harbour")
    page.wait_for_selector("#btn-links", state="hidden")

    # 9. keyboard: modules and the tree
    page.keyboard.press("Control+1")
    page.wait_for_function("document.querySelector('.tab[aria-selected=true]').textContent.includes('Plastico')")
    page.keyboard.press("Control+b")
    page.wait_for_selector("#tree", state="hidden")
    page.keyboard.press("Control+b")
    page.wait_for_selector("#tree:not([hidden])")

    # 10. close, then reopen from the recent list: the same tree, associations and all
    wait_saved(page)
    before = tree_rows(page)
    page.click("#btn-project")
    page.click("text=Close the project")
    page.wait_for_selector("#welcome:not([hidden])")
    page.click(".recent >> text=Lighthouse Island")
    page.wait_for_selector("#welcome", state="hidden")
    page.wait_for_function("[...document.querySelectorAll('#tree-body .tn .nm')].some(n => n.textContent === 'Lamp room')")
    page.wait_for_timeout(500)
    assert tree_rows(page) == before
    assert not [e for e in errors if "favicon" not in e], errors
    page.close()

    # 11. a new app (a fresh core and server) opens the same project from disk
    core.close_project()
    core2, srv2 = server()
    core2.open_project(project)
    page2, errors2 = open_shell(browser, srv2.url)
    page2.wait_for_selector("#welcome", state="hidden")
    page2.wait_for_function("[...document.querySelectorAll('#tree-body .tn .nm')].some(n => n.textContent === 'Lamp room')")
    assert tree_rows(page2) == before
    page2.click("#tree .tn.scene >> text=Old lighthouse")
    pl2 = frame(page2, "plastico")
    pl2.wait_for_selector("#scene-charts >> text=Light the lamp")
    shot(page2, "04-reopened")
    assert not [e for e in errors2 if "favicon" not in e], errors2


def test_shell_reports_a_project_it_cannot_open(server, browser, home):
    core, srv = server()
    bad = home / "broken"
    bad.mkdir()
    (bad / "cassetto.json").write_text('{"format": "cassetto.project", "version": 42}')
    page, _ = open_shell(browser, srv.url)
    page.wait_for_selector("#welcome:not([hidden])")
    page.click("text=Open a project…")
    page.fill(".picker-path input", str(bad))
    page.press(".picker-path input", "Enter")
    page.click("text=Open this project")
    page.wait_for_selector(".toast.bad >> text=newer Cassetto")
    assert core.project is None


def test_a_new_chart_from_a_scene_is_the_one_that_opens(server, browser, home):
    """Puzzle Charts already showing another chart: "New chart for this scene" must open the new one,
    every time, even though Puzzle Charts hears about it after it is asked to show it."""
    core, srv = server()
    core.create_project(home / "p", "P")
    from plastico import store
    root = core.project.path / "plastico"
    w = store.load("world", root)
    w["scenes"] = [{"id": f"room_{i}", "name": f"Room {i}", "kind": "inside", "x": 3 + 7 * i, "z": 2} for i in range(4)]
    store.save(w, root=root)
    old = core.call("puzzles.create_chart", "An old chart")
    page, errors = open_shell(browser, srv.url)
    page.wait_for_selector("#tree:not([hidden]) .tn.chart")
    page.click("#tree .tn.chart >> text=An old chart")          # Puzzle Charts loaded, showing the old chart
    pz = frame(page, "puzzles")
    pz.wait_for_function("document.querySelector('#f-chart-name') && document.querySelector('#f-chart-name').value === 'An old chart'")
    pl = frame(page, "plastico")
    for i in range(4):
        page.click(f"#tree .tn.scene >> text=Room {i}")
        pl.wait_for_function(f"document.querySelector('#f-id') && document.querySelector('#f-id').value === 'room_{i}'")
        pl.click("text=New chart for this scene")
        page.wait_for_function("document.querySelector('.tab[aria-selected=true]').textContent.includes('Puzzle Charts')")
        pz.wait_for_function(f"document.querySelector('#f-chart-name') && document.querySelector('#f-chart-name').value === 'Room {i}'", timeout=8000)
        cid = {s["id"]: s for s in store.load("world", root)["scenes"]}[f"room_{i}"]["charts"]
        assert len(cid) == 1 and cid[0] != old
    assert not pz.is_visible("text=That chart isn’t in this project any more")
    assert not [e for e in errors if "favicon" not in e], errors
