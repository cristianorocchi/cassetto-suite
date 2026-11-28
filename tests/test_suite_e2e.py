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

    # 4. put the same chart with the harbour too: one chart, under its act and under the two scenes in the tree
    page.click("#tree .tn.scene >> text=Harbour")
    page.wait_for_function("document.querySelector('.tab[aria-selected=true]').textContent.includes('Plastico')")
    pl.wait_for_function("document.querySelector('#f-id') && document.querySelector('#f-id').value === 'harbour'")
    pl.select_option("#f-add-chart", cid)
    pl.wait_for_selector("#scene-charts >> text=Light the lamp")
    wait_saved(page)
    page.wait_for_function("[...document.querySelectorAll('#tree-body .tn.chart .nm')].filter(n => n.textContent === 'Light the lamp').length === 3")
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
    # in the tree: under its act, and under the lighthouse
    page.wait_for_function("[...document.querySelectorAll('#tree-body .tn.chart .nm')].filter(n => n.textContent === 'Light the lamp').length === 2")

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
    pick(page, pz, "#f-scene", "lighthouse")
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

    # 8. a scene the world doesn't have, typed in Where: it is added to the chart's act, so no link breaks
    page.click("#tree .tn.chart >> text=Light the lamp")
    pz.wait_for_selector(".node")
    pz.locator("body").press("f")
    pz.click(".node")
    pick(page, pz, "#f-scene", "cellar", expect="Add the scene “Cellar” to act 1")
    pz.wait_for_function("document.querySelector('#f-scene').textContent.trim() === 'Cellar'")
    wait_saved(page)
    cellar = next(s for s in world_on_disk(project)["scenes"] if s["id"] == "cellar")
    assert cellar["act"] == "1" and cellar["status"] == "idea"
    assert [n["scene"] for c in charts_on_disk(project) for n in c["nodes"] if n["scene"]] == ["cellar"]
    assert page.is_hidden("#btn-links")

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


def test_add_scene_inside_lists_only_the_act_on_screen(server, browser, home):
    core, srv = server()
    page, errors = open_shell(browser, srv.url)
    page.wait_for_selector("#welcome:not([hidden])")
    page.click("text=New project")
    page.fill(".modal-box input >> nth=0", "Two Acts")
    page.click(".modal-box >> text=Create")
    page.wait_for_selector("#welcome", state="hidden")
    project = home / "projects" / "Two Acts"
    pl = frame(page, "plastico")
    pl.wait_for_selector("#empty:not([hidden])")
    add_scene(pl, "Harbour")
    pl.press("#f-name", "Escape")
    add_scene(pl, "Lighthouse")
    pl.press("#f-name", "Escape")
    add_scene(pl, "Lamp room", inside="lighthouse")
    wait_saved(pl)
    page.close()

    # the lighthouse (and the lamp room inside it) move to a second act
    core.close_project()
    w = world_on_disk(project)
    w["acts"].append({"id": "2", "name": "", "start": ""})
    for s in w["scenes"]:
        if s["id"] in ("lighthouse", "lamp_room"):
            s["act"] = "2"
    (project / "plastico" / "world.json").write_text(json.dumps(w))
    core.open_project(project)

    page, errors = open_shell(browser, srv.url)
    pl = frame(page, "plastico")
    pl.wait_for_selector("#acts .filter >> text=Act 2")

    def parents(act=""):
        pl.click("#btn-add")
        pl.wait_for_selector("#f-new-parent")
        if act:     # the act chosen in the dialog
            pl.select_option("#f-new-act", act)
        ids = pl.eval_on_selector_all("#f-new-parent option", "os => os.map(o => o.value)")
        pl.click(".modal-foot >> text=Cancel")
        return ids

    pl.click("#acts .filter >> text=Act 2")
    assert parents() == ["lamp_room", "lighthouse"]
    pl.click("#acts .filter >> text=Act 1")
    assert parents() == ["harbour"]
    # every act on screen: still one act's scenes, the act chosen in the dialog
    pl.click("#acts .filter >> text=Every act")
    assert parents() == ["harbour"]
    assert parents(act="2") == ["lamp_room", "lighthouse"]
    assert not errors, errors


def test_export_and_import_a_project_from_the_menu(server, browser, home):
    core, srv = server()
    page, errors = open_shell(browser, srv.url)
    page.wait_for_selector("#welcome:not([hidden])")
    page.click("text=New project")
    page.fill(".modal-box input >> nth=0", "Ferry")
    page.click(".modal-box >> text=Create")
    page.wait_for_selector("#welcome", state="hidden")
    pl = frame(page, "plastico")
    pl.wait_for_selector("#empty:not([hidden])")
    add_scene(pl, "Dock")
    pl.press("#f-name", "Escape")

    # Export: the menu, a path, the file (the scene just added saved first)
    out = home / "Ferry export.cassetto"
    page.click("#btn-project")
    page.click("#menu-project >> text=Export the project…")
    page.fill("#f-export-path", str(out))
    page.click("#f-export-go")
    page.wait_for_selector("#toast >> text=Exported to")
    assert out.is_file()

    # Import it back from the welcome screen: a new folder next to the first, opened
    page.click("#btn-project")
    page.click("#menu-project >> text=Close the project")
    page.wait_for_selector("#welcome:not([hidden])")
    page.click("#welcome >> text=Import a project…")
    page.fill("#f-import-path", str(out))
    page.click("#f-import-go")
    page.wait_for_selector("#welcome", state="hidden")
    page.wait_for_function("document.querySelector('#proj-name').textContent === 'Ferry'")
    assert core.project.path == (home / "projects" / "Ferry 2").resolve()
    assert [s["id"] for s in world_on_disk(core.project.path)["scenes"]] == ["dock"]
    assert not errors, errors


def test_keyboard_shortcuts_are_set_in_the_settings(server, browser, home):
    """Settings › Keyboard shortcuts: record new keys, settle a clash, use them in a module, keep them."""
    core, srv = server()
    core.create_project(home / "projects" / "Keys", "Keys", {})
    page, errors = open_shell(browser, srv.url)
    pl = frame(page, "plastico")
    pl.wait_for_selector("#empty:not([hidden])")
    keys = lambda where, aid: where.evaluate(f"CassettoKeys.keys({json.dumps(aid)})")  # noqa: E731
    on_disk = lambda: json.loads((home / "config" / "keybindings.json").read_text())["bindings"]  # noqa: E731

    # Ctrl+, opens the settings, from the module page too; the shortcuts are listed by where they work
    pl.click("#stage", position={"x": 40, "y": 300})
    pl.press("body", "Control+,")
    page.wait_for_selector(".modal-box.settings .kb-row")
    assert page.text_content(".set-tab[aria-current=true]").startswith("Keyboard shortcuts")
    assert [h.strip() for h in page.eval_on_selector_all(".kb-sec-h h4", "hs => hs.map(h => h.textContent)")] == ["Everywhere", "Plastico", "Puzzle Charts"]
    shot(page, "20-settings-keys")

    # search by name, then by pressing the keys
    page.fill(".kb-search input", "scene add")
    assert page.eval_on_selector_all(".kb-row:not(.fixed) .kb-label", "ls => ls.map(l => l.textContent)") == ["Add a scene"]
    page.click(".kb-find")
    page.keyboard.press("Control+Z")
    assert page.input_value(".kb-search input") == "Ctrl+Z"
    assert page.eval_on_selector_all(".kb-row .kb-label", "ls => ls.map(l => l.textContent)") == ["Undo", "Undo"]

    # give "Add a scene" the key G instead of N
    page.fill(".kb-search input", "add a scene")
    page.click('.kb-row[data-id="plastico.add"] .kc-main')
    page.wait_for_selector(".keycap.rec")
    page.keyboard.down("Shift"); page.wait_for_timeout(50)
    assert "⇧" in page.text_content(".keycap.rec") or "Shift" in page.text_content(".keycap.rec")    # held keys show as they're pressed
    page.keyboard.up("Shift")
    page.keyboard.press("g")
    page.wait_for_selector('.kb-row[data-id="plastico.add"].changed')
    assert keys(page, "plastico.add") == ["G"] and keys(pl, "plastico.add") == ["G"]   # the module page has it at once
    page.wait_for_timeout(500)
    assert on_disk() == {"plastico.add": ["G"]}

    # a key that works everywhere needs Ctrl or Alt; Ctrl+B is the tree's: take it, after asking
    page.fill(".kb-search input", "next theme")
    page.click('.kb-row[data-id="suite.theme"] .kc-empty')
    page.keyboard.press("q")
    assert "need Ctrl or Alt" in page.text_content('.kb-row[data-id="suite.theme"] .kb-note.bad')
    page.keyboard.press("Control+b")
    page.wait_for_selector('.kb-row[data-id="suite.theme"] .kb-note.warn')
    assert "Show or hide the project tree" in page.text_content(".kb-note.warn")
    page.click(".kb-note.warn >> text=Use it here")
    page.wait_for_function("CassettoKeys.keys('suite.theme')[0] === 'Ctrl+B'")
    assert keys(page, "suite.tree") == []
    shot(page, "21-settings-moved")

    # Esc closes; the new keys work in Plastico, the old ones don't
    page.keyboard.press("Escape")
    page.wait_for_selector("#modal", state="hidden")
    pl.click("#stage", position={"x": 40, "y": 300})
    pl.press("body", "n")
    pl.wait_for_timeout(200)
    assert not pl.is_visible("#f-new-name")
    pl.press("body", "g")
    pl.wait_for_selector("#f-new-name")
    pl.press("#f-new-name", "Escape")
    assert pl.get_attribute("#btn-add", "title").endswith("(G)")
    assert page.eval_on_selector_all("#tabs kbd", "ks => ks.map(k => k.textContent)") == ["Ctrl+1", "Ctrl+2"]
    before = page.evaluate("CassettoTheme.get()")
    pl.press("body", "Control+b")                      # now the theme's, not the tree's
    page.wait_for_function(f"CassettoTheme.get() !== {json.dumps(before)}")
    assert page.is_visible("#tree")

    # kept: a new window reads them from the server
    page.reload()
    pl = frame(page, "plastico")
    page.wait_for_function("CassettoKeys.keys('plastico.add')[0] === 'G'")
    pl.wait_for_function("window.CassettoKeys && CassettoKeys.keys('plastico.add')[0] === 'G'")

    # Reset all asks once more, then puts every default back
    page.click("#btn-settings")
    page.wait_for_selector(".modal-box.settings .kb-row")
    assert page.text_content(".set-tab[data-pane=keys] .set-badge") == "3"
    page.click("text=Reset all")
    assert "Reset 3 changes?" in page.text_content(".set-foot")
    page.click("text=Reset 3 changes?")
    page.wait_for_function("CassettoKeys.changes() === 0")
    assert keys(page, "suite.tree") == ["Ctrl+B"] and keys(pl, "plastico.add") == ["N"]
    page.wait_for_timeout(500)
    assert on_disk() == {}
    page.click(".set-tab >> text=Appearance")
    page.wait_for_selector(".theme-card")
    shot(page, "22-settings-look")
    assert not errors, errors


def pick(page, fr, sel, text, expect=None):
    """Choose in one of Puzzle Charts' pick lists (Where, Who) by typing, as a person would."""
    fr.click(sel)
    fr.wait_for_selector(".pick-pop .pick-q")
    page.keyboard.type(text)
    if expect:
        fr.wait_for_selector(f".pick-pop .pick-opt.on:has-text('{expect}')")
    page.keyboard.press("Enter")
    fr.wait_for_selector(".pick-pop", state="detached")


def test_plastico_and_puzzle_charts_as_one(server, browser, home):
    """0.2: the act on screen, scene names, centred tabs, charts under the scenes their steps are in, one step
    count, adding to the world what a step names, the locks a step opens."""
    import sys
    sys.path.insert(0, str(Path(__file__).parent))
    from test_links import _setup
    core, srv = server()
    _, pub, alley, pinned, key = _setup(core, home)
    page, errors = open_shell(browser, srv.url)
    page.wait_for_selector("#tree:not([hidden]) .tn.chart")

    # a test build says so, and the module tabs sit in the middle of the bar
    assert page.is_visible("#brand-test") and page.title().endswith("(test)")
    mid = page.evaluate("(() => { const r = document.querySelector('#tabs').getBoundingClientRect(); return r.left + r.width / 2 - innerWidth / 2; })()")
    assert abs(mid) <= 2, mid

    # the tree: "The key" under the pub (2 steps there) and the alley; the pinned chart under the alley; none loose
    rows = tree_rows(page)
    names = [r[2] for r in rows]
    assert "Charts with no scene yet" not in names
    i_pub, i_alley = names.index("Pub"), names.index("Alley")
    assert rows[i_pub + 1][:1] == ["chart"] and rows[i_pub + 1][2] == "The key"
    assert page.text_content(f"#tree-body .tn[data-key='chart:pub:{key}'] .ct") == "2"
    under_alley = [r[2] for r in rows[i_alley + 1:i_alley + 3]]
    assert under_alley == ["Planned for the alley", "The key"]

    # Plastico, act 1 on screen: Add scene doesn't ask for the act again
    pl = frame(page, "plastico")
    pl.wait_for_selector("#loading", state="hidden")
    page.click("#tree-body .tn.act")
    pl.wait_for_function("[...document.querySelectorAll('.filter.on')].some(b => b.textContent.includes('Act 1'))")
    pl.click("#btn-add")
    pl.wait_for_selector("#f-new-name")
    assert pl.is_hidden("#f-new-act")
    assert "Straight in Act 1" in pl.text_content(".modal-box .choices")
    pl.fill("#f-new-name", "Cellar")
    pl.click("#f-new-go")
    pl.wait_for_function("document.querySelector('#f-name') && document.querySelector('#f-name').value === 'Cellar'")
    wait_saved(page)
    assert next(s for s in world_on_disk(core.project.path)["scenes"] if s["name"] == "Cellar")["act"] == "1"
    page.keyboard.press("Escape")

    # scene names: never on top of each other; off leaves a dot per scene
    pl.wait_for_timeout(600)
    boxes = pl.evaluate("""[...document.querySelectorAll('.lab:not(.mini) .lab-card, .badge')]
        .map(e => e.getBoundingClientRect()).filter(r => r.width).map(r => [r.left, r.top, r.right, r.bottom])""")
    for a in range(len(boxes)):
        for b in range(a + 1, len(boxes)):
            p, q = boxes[a], boxes[b]
            assert not (p[0] < q[2] - 1 and q[0] < p[2] - 1 and p[1] < q[3] - 1 and q[1] < p[3] - 1), (p, q)
    pl.click("#v-names")
    pl.wait_for_function("[...document.querySelectorAll('.lab:not(.sel)')].every(l => l.classList.contains('mini'))")
    assert pl.get_attribute("#v-names", "aria-pressed") == "false"
    pl.click("#v-names")
    pl.wait_for_function("[...document.querySelectorAll('.lab')].some(l => !l.classList.contains('mini'))")

    # the pub's panel: one list of its charts, each with the steps placed there
    page.click("#tree-body .tn.scene >> text=Pub")
    pl.wait_for_selector("#scene-charts-sec")
    sec = pl.text_content("#scene-charts-sec")
    assert "The key" in sec and "2 steps here, of 4" in sec and "Ask Elda" in sec

    # broken links: add the stationmaster to the world in one click; the steps follow
    page.wait_for_selector("#btn-links:not([hidden])")
    assert page.text_content("#btn-links").startswith("3 broken links")
    page.click("#btn-links")
    page.click("#menu-links .link-fix:has-text('stationmaster') >> text=Add to the world’s people")
    page.wait_for_function("document.querySelector('#btn-links').textContent.startsWith('1 broken link')")
    assert {"id": "stationmaster", "name": "Stationmaster"} in world_on_disk(core.project.path)["people"]
    # ... and goes where the steps have them, so Plastico shows them there
    alley_now = next(s for s in world_on_disk(core.project.path)["scenes"] if s["id"] == "alley")
    assert all("stationmaster" in ids for ids in alley_now["people"].values()) and alley_now["people"]

    # Puzzle Charts: Who shows the name, and the key's step says which lock it opens
    pl.click("#scene-charts-sec li.link >> text=Ask Elda")
    pz = frame(page, "puzzles")
    pz.wait_for_function("document.querySelector('#f-who') && document.querySelector('#f-who').textContent.trim() === 'Elda'")
    # Where offers the chart's act first, its scenes by name
    pz.click("#f-scene")
    assert pz.text_content(".pick-pop .pick-head").startswith("Act 1")
    opts = pz.locator(".pick-pop .pick-opt .po-label").all_inner_texts()
    assert opts[:4] == ["Any scene", "Alley", "Cellar", "Pub"], opts
    page.keyboard.press("Escape")
    pz.wait_for_selector(".pick-pop", state="detached")
    # the world doesn't put Elda in the Pub: the step says so, and puts her there in one click
    assert "doesn’t put Elda in Pub at any time" in pz.text_content("#f-not-there")
    pz.click("#f-put-there")
    pz.wait_for_selector("#f-not-there", state="detached")
    pub_now = next(s for s in world_on_disk(core.project.path)["scenes"] if s["id"] == "pub")
    assert pub_now["people"] == {"day": ["elda"], "night": ["elda"]}
    # ... and Who now lists her first, as someone in the Pub
    pz.click("#f-who")
    heads = pz.eval_on_selector_all(".pick-pop .pick-head", "hs => hs.map(h => h.textContent)")
    assert heads[0].startswith("In Pub"), heads
    page.keyboard.press("Escape")
    page.click("#tree-body .tn.scene >> text=Pub")
    pl.click("#scene-charts-sec li.link >> text=The key")
    pz.wait_for_selector("#f-opens")
    assert "Pub → Alley" in pz.text_content("#f-opens")
    # the station step: the scene is missing, and can be added from the step
    pz.evaluate("(() => { const n = [...document.querySelectorAll('#nodes > div')].find(e => e.textContent.includes('Ask the stationmaster')); n.dispatchEvent(new MouseEvent('pointerdown', {bubbles: true, button: 0})); n.dispatchEvent(new MouseEvent('pointerup', {bubbles: true, button: 0})); n.click(); })()")
    pz.wait_for_selector("#f-add-scene")
    pz.click("#f-add-scene")
    page.wait_for_function("document.querySelector('#btn-links').hidden")
    assert any(s["id"] == "station" for s in world_on_disk(core.project.path)["scenes"])
    # the new Station doesn't have the stationmaster: the step says where the world has him, and moves there
    pz.wait_for_selector("#f-not-there")
    assert "The world puts Stationmaster in Alley." in pz.text_content("#f-not-there")
    assert pz.text_content("#f-move-there") == "Move the step to Alley"
    pz.click("#f-move-there")
    pz.wait_for_selector("#f-not-there", state="detached")
    assert pz.text_content("#f-scene").strip() == "Alley"
    assert not errors, errors


def test_the_act_on_screen_is_the_same_in_every_module(server, browser, home):
    """An act picked in Plastico opens that act's chart in Puzzle Charts: a fresh one when it has none, saved
    with its first change. Opening a chart moves Plastico to its act. Both lists keep the acts apart."""
    core, srv = server()
    core.create_project(home / "acts", "Acts")
    from plastico import store
    root = core.project.path / "plastico"
    w = store.load("world", root)
    w["acts"] = [{"id": "1", "name": "Arrival", "start": ""}, {"id": "2", "name": "Keep the change", "start": ""}]
    w["scenes"] = [{"id": "pub", "name": "Pub", "kind": "inside", "act": "1", "x": 3, "z": 2}]
    store.save(w, root=root)
    core.call("puzzles.create_chart", "The key", 1)
    on_disk = lambda: sorted((c["name"], c["act"]) for c in charts_on_disk(core.project.path))  # noqa: E731
    page, errors = open_shell(browser, srv.url)
    pl = frame(page, "plastico")
    pl.wait_for_selector("#acts .filter >> text=Act 2")
    # the tree: the chart under its act, before the act's scenes
    page.wait_for_selector("#tree:not([hidden]) .tn.chart")
    names = [r[2] for r in tree_rows(page)]
    assert names[:3] == ["Act 1 · Arrival", "The key", "Pub"], names

    pl.click("#acts .filter >> text=Act 2")
    page.wait_for_selector("#tree-body .tn.act.cur >> text=Act 2")
    page.click("#tabs >> text=Puzzle Charts")
    pz = frame(page, "puzzles")
    pz.wait_for_function("document.querySelector('#f-chart-name') && document.querySelector('#f-chart-name').value === 'Act 2'")
    assert pz.eval_on_selector("#f-chart-act", "s => s.value") == "2"
    assert pz.eval_on_selector_all("#chart-list .act-num", "hs => hs.map(h => h.textContent)") == ["Act 1", "Act 2"]
    assert "saved with your first change" in pz.text_content("#chart-list .chart-item.on")
    assert on_disk() == [("The key", 1)]           # only looked at: nothing saved
    pz.fill("#f-chart-name", "The bank job")
    for _ in range(60):
        if on_disk() == [("The bank job", 2), ("The key", 1)]:
            break
        page.wait_for_timeout(100)
    assert on_disk() == [("The bank job", 2), ("The key", 1)]
    page.wait_for_function("[...document.querySelectorAll('#tree-body .tn')].some(r => r.textContent.startsWith('The bank job'))")
    names = [r[2] for r in tree_rows(page)]
    assert names[names.index("Act 2 · Keep the change") + 1] == "The bank job", names

    # a chart of act 1 opened here: Plastico shows act 1 too
    pz.click("#chart-list .chart-item >> text=The key")
    page.wait_for_selector("#tree-body .tn.act.cur >> text=Act 1")
    assert "Act 1" in pl.text_content("#acts .filter.on")
    # every act in Plastico stays every act when a chart opens
    page.click("#tabs >> text=Plastico")
    pl.click("#acts .filter >> text=Every act")
    page.click("#tabs >> text=Puzzle Charts")
    pz.click("#chart-list .chart-item >> text=The bank job")
    pz.wait_for_function("document.querySelector('#f-chart-name').value === 'The bank job'")
    assert "Every act" in pl.text_content("#acts .filter.on") and not page.query_selector("#tree-body .tn.act.cur")
    assert not errors, errors


def test_seen_from_above_every_picture_lies_on_its_block(server, browser, home):
    """Pictures mode: an indoor room's picture stands like a postcard; in Map view, or with the camera turned
    to look down, it lies on its room like an outdoor scene's on its plate, and stands again when tilted."""
    from PIL import Image
    from plastico import store
    core, srv = server()
    core.create_project(home / "pics", "Pics")
    root = core.project.path / "plastico"
    w = store.load("world", root)
    w["scenes"] = [{"id": "square", "name": "Square", "kind": "outside", "act": "1", "x": 6, "z": 3.5},
                   {"id": "pub", "name": "Pub", "kind": "inside", "act": "1", "x": 22, "z": 2}]
    store.save(w, root=root)
    files = store.files_dir("world", root)
    files.mkdir(parents=True, exist_ok=True)
    for sid, colour in (("square", (90, 120, 160)), ("pub", (160, 110, 70))):   # a sketch for each
        Image.new("RGB", (320, 180), colour).save(files / f"{sid}.jpg", "JPEG")
    page, errors = open_shell(browser, srv.url)
    pl = frame(page, "plastico")
    pl.wait_for_selector("#loading", state="hidden")
    pl.click("text=Pictures")
    how = """id => { const o = window.plastico.view.objs.get(id); return o ? (o.flat ? 'flat' : o.card ? 'card' : 'none') : 'gone'; }"""
    pl.wait_for_function(f"({how})('pub') === 'card'")
    assert pl.evaluate(f"({how})('square')") == "flat"
    pl.click("#z-top")                                        # the map: straight down
    pl.wait_for_function(f"({how})('pub') === 'flat'")
    pl.click("#z-top")                                        # tilted again: the postcard is back
    pl.wait_for_function(f"({how})('pub') === 'card'")
    pl.wait_for_function("!window.plastico.view.anim")      # the camera has settled
    turn = "phi => { const v = window.plastico.view; v.restoreCamera({ ...v.cameraState(), phi }); }"
    pl.evaluate(f"({turn})(0.2)")                              # turned by hand to look down
    pl.wait_for_function(f"({how})('pub') === 'flat'")
    pl.evaluate(f"({turn})(0.37)")                             # a little less steep: no flicker, still flat
    pl.wait_for_timeout(300)
    assert pl.evaluate(f"({how})('pub')") == "flat"
    pl.evaluate(f"({turn})(0.8)")
    pl.wait_for_function(f"({how})('pub') === 'card'")
    assert pl.evaluate(f"({how})('square')") == "flat"
    assert not errors, errors
