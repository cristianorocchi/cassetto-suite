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


def test_the_suite_end_to_end(server, browser, home):
    core, srv = server()
    page, errors = open_shell(browser, srv.url)

    # 1. no project yet: the welcome screen; make one
    page.wait_for_selector("#welcome:not([hidden])")
    shot(page, "01-welcome")
    page.click("text=New project")
    page.fill(".modal-box input >> nth=0", "Lighthouse Island")
    shot(page, "02-new-project")
    page.click(".modal-box >> text=Create")
    page.wait_for_selector("#welcome", state="hidden")
    project = home / "projects" / "Lighthouse Island"
    assert (project / "cassetto.json").is_file()
    assert page.text_content("#proj-name") == "Lighthouse Island"

    # 2. Plastico: two scenes, named in its own panel
    pl = frame(page, "plastico")
    pl.wait_for_selector("#empty:not([hidden]) .btn.primary")
    pl.click("#empty .btn.primary")      # "Add a scene"
    pl.fill("#f-name", "Harbour")
    pl.press("#f-name", "Tab")
    pl.wait_for_function("document.querySelector('#f-id') && document.querySelector('#f-id').value === 'harbour'")
    pl.press("#f-name", "Escape")
    pl.locator("body").press("n")
    pl.wait_for_function("document.querySelector('#f-id') && document.querySelector('#f-id').value !== 'harbour'")
    pl.fill("#f-name", "Lighthouse")
    pl.press("#f-name", "Tab")
    pl.wait_for_function("document.querySelector('#f-id').value === 'lighthouse'")
    page.wait_for_function("document.querySelector('#status-text').textContent === 'Saved'")
    world = json.loads((project / "plastico" / "world.json").read_text())
    assert sorted(s["id"] for s in world["scenes"]) == ["harbour", "lighthouse"]
    shot(page, "03-plastico")

    # 3. from the Lighthouse's panel, plan a puzzle step there: Puzzle Charts opens with it
    pl.click("text=Add a puzzle step here")
    pz = frame(page, "puzzles")
    page.wait_for_function("document.querySelector('.tab[aria-selected=true]').textContent.includes('Puzzle Charts')")
    pz.wait_for_selector("#f-title")
    pz.wait_for_function("document.querySelector('#f-scene') && document.querySelector('#f-scene').value === 'lighthouse'")
    pz.fill("#f-title", "Light the lamp")
    # the scene picker lists the world's scenes (from Plastico, through the core)
    assert pz.eval_on_selector_all("#dl-scenes option", "os => os.map(o => o.value)") == ["harbour", "lighthouse"]
    page.wait_for_function("document.querySelector('#status-text').textContent === 'Saved'")
    page.wait_for_timeout(900)
    shot(page, "04-puzzle-step")
    ch = charts_on_disk(project)
    assert len(ch) == 1 and any(n["title"] == "Light the lamp" and n["scene"] == "lighthouse" for n in ch[0]["nodes"])

    # 4. back in Plastico the step is listed in its scene, and opens in Puzzle Charts again
    pz.click("text=Show Lighthouse in Plastico")
    page.wait_for_function("document.querySelector('.tab[aria-selected=true]').textContent.includes('Plastico')")
    pl.wait_for_selector(".steps li.link >> text=Light the lamp")
    shot(page, "05-step-in-plastico")

    # 5. renaming the scene in Plastico moves the step with it
    pl.fill("#f-name", "Old lighthouse")
    pl.press("#f-name", "Tab")
    pl.wait_for_function("document.querySelector('#f-id').value === 'old_lighthouse'")
    for _ in range(50):
        if any(n["scene"] == "old_lighthouse" for c in charts_on_disk(project) for n in c["nodes"]):
            break
        page.wait_for_timeout(100)
    assert [n["scene"] for c in charts_on_disk(project) for n in c["nodes"] if n["title"] == "Light the lamp"] == ["old_lighthouse"]
    pl.wait_for_selector(".steps li.link >> text=Light the lamp")
    pl.click(".steps li.link >> text=Light the lamp")
    pz.wait_for_function("document.querySelector('#f-scene') && document.querySelector('#f-scene').value === 'old_lighthouse'")

    # 6. a step in a scene the world doesn't have: Puzzle Charts warns, the shell counts it
    pz.fill("#f-scene", "cellar")
    pz.wait_for_selector("text=No scene “cellar” in the world yet")
    page.wait_for_selector("#btn-links:not([hidden])")
    assert "1 broken link" in page.text_content("#btn-links")
    pz.press("#f-scene", "Escape")
    pz.locator("body").press("Escape")         # nothing selected: the chart's checks
    pz.wait_for_selector(".issues >> text=Place not in the world")
    shot(page, "06-broken-link")
    page.click("#btn-links")
    page.wait_for_selector("#menu-links >> text=is in cellar")
    page.click("#menu-links >> text=is in cellar")
    pz.fill("#f-scene", "harbour")
    page.wait_for_selector("#btn-links", state="hidden")

    # 7. switch with the keyboard
    page.keyboard.press("Control+1")
    page.wait_for_function("document.querySelector('.tab[aria-selected=true]').textContent.includes('Plastico')")
    page.keyboard.press("Control+2")
    page.wait_for_function("document.querySelector('.tab[aria-selected=true]').textContent.includes('Puzzle Charts')")

    # 8. close, then reopen from the recent list: everything is still there
    page.wait_for_function("document.querySelector('#status-text').textContent === 'Saved'")
    page.click("#btn-project")
    page.click("text=Close the project")
    page.wait_for_selector("#welcome:not([hidden])")
    page.click(".recent >> text=Lighthouse Island")
    page.wait_for_selector("#welcome", state="hidden")
    assert "Puzzle Charts" in page.text_content(".tab[aria-selected=true]")   # back where we were
    page.click(".tab >> text=Plastico")
    pl = frame(page, "plastico")
    pl.wait_for_function("document.querySelector('#insp') && document.querySelector('#insp').textContent.includes('1 chart')")
    assert not [e for e in errors if "favicon" not in e], errors
    page.close()

    # 9. a new app (a fresh core and server) opens the same project from disk
    core.close_project()
    core2, srv2 = server()
    core2.open_project(project)
    page2, errors2 = open_shell(browser, srv2.url)
    pz2 = None
    page2.wait_for_selector("#welcome", state="hidden")
    page2.click(".tab >> text=Puzzle Charts")
    pz2 = frame(page2, "puzzles")
    pz2.wait_for_selector(".node >> text=Light the lamp")
    pl2 = frame(page2, "plastico")
    page2.click(".tab >> text=Plastico")
    pl2.wait_for_function("document.querySelector('#insp').textContent.includes('2') && document.querySelector('#insp').textContent.includes('1 chart')")
    shot(page2, "07-reopened")
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
