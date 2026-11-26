"""A project as one .cassetto file: export it, import it into a new folder, and refuse what isn't one."""
from __future__ import annotations

import json
import zipfile

import pytest

from test_suite import chart, world_with


def test_export_then_import_brings_back_the_whole_project(core, home):
    p = core.create_project(home / "projects" / "Lighthouse", "Lighthouse")
    world_with(core, ["harbour", "lighthouse"], ["keeper"])
    core.modules["puzzles"].write("c1", chart([("n1", "goal", "Light the lamp", "lighthouse", "")]))
    (p.path / "plastico" / "world.files").mkdir(exist_ok=True)
    (p.path / "plastico" / "world.files" / "sketch.png").write_bytes(b"\x89PNG fake")
    (home / "out").mkdir()
    out = core.export_project(home / "out")          # a folder: the file takes the project's name
    assert out == (home / "out" / "Lighthouse.cassetto").resolve()
    with zipfile.ZipFile(out) as z:
        names = z.namelist()
    assert "Lighthouse/cassetto.json" in names and "Lighthouse/.cassetto.lock" not in names
    assert "Lighthouse/plastico/world.files/sketch.png" in names

    core.close_project()
    q = core.import_project(out, home / "projects")   # a project by that name is there: a new folder
    assert q.path == (home / "projects" / "Lighthouse 2").resolve() and core.project is q
    assert q.name == "Lighthouse" and q.id == p.id
    assert (q.path / "plastico" / "world.files" / "sketch.png").read_bytes() == b"\x89PNG fake"
    assert [s["id"] for s in json.loads((q.path / "plastico" / "world.json").read_text())["scenes"]] == ["harbour", "lighthouse"]
    assert [c for c, _ in core.modules["puzzles"].docs()] == ["c1"]
    assert (q.path / ".cassetto.lock").read_text() == str(__import__("os").getpid())


def test_export_names_and_places(core, home):
    p = core.create_project(home / "projects" / "Town", "Town: Act/One")
    assert core.export_project(home / "x" / "mine").name == "mine.cassetto"
    assert core.export_project(home / "x").name == "Town- Act-One.cassetto"
    from cassetto.core.project import ProjectError
    with pytest.raises(ProjectError, match="outside the project"):
        core.export_project(p.path / "inside.cassetto")


def _zip(path, files):
    with zipfile.ZipFile(path, "w") as z:
        for name, data in files.items():
            z.writestr(name, data)
    return path


def test_import_refuses_what_isnt_a_project(core, home):
    from cassetto.core.project import ProjectError
    (home / "projects").mkdir()
    (home / "plain.cassetto").write_text("not a zip")
    with pytest.raises(ProjectError, match="isn't an exported Cassetto project"):
        core.import_project(home / "plain.cassetto", home / "projects")
    with pytest.raises(ProjectError, match="no Cassetto project"):
        core.import_project(_zip(home / "empty.cassetto", {"x/readme.txt": "hi"}), home / "projects")
    newer = {"format": "cassetto.project", "version": 99, "id": "a", "name": "N", "modules": {}}
    with pytest.raises(ProjectError, match="newer Cassetto"):
        core.import_project(_zip(home / "newer.cassetto", {"N/cassetto.json": json.dumps(newer)}), home / "projects")
    with pytest.raises(ProjectError, match="There's no file"):
        core.import_project(home / "missing.cassetto", home / "projects")
    assert list((home / "projects").iterdir()) == []       # nothing half unpacked left behind


def test_import_writes_nothing_outside_the_new_folder(core, home):
    m = {"format": "cassetto.project", "version": 1, "id": "abc", "name": "Evil", "modules": {}}
    src = _zip(home / "evil.cassetto", {"Evil/cassetto.json": json.dumps(m), "Evil/../../escaped.txt": "x",
                                        "Evil/.cassetto.lock": "1", "Evil/plastico/ok.txt": "fine"})
    q = core.import_project(src, home / "projects")
    assert q.path == (home / "projects" / "Evil").resolve()
    assert (q.path / "plastico" / "ok.txt").read_text() == "fine"
    assert not (home / "escaped.txt").exists() and not (home.parent / "escaped.txt").exists()
    assert (q.path / ".cassetto.lock").read_text() == str(__import__("os").getpid())


def test_import_and_export_through_the_api(core, home):
    import urllib.request
    from cassetto.core.server import serve_in_thread
    srv = serve_in_thread(core, 0)
    try:
        def post(path, body):
            req = urllib.request.Request(srv.url.rstrip("/") + path, data=json.dumps(body).encode(), method="POST",
                                         headers={"X-Cassetto": "1", "Content-Type": "application/json"})
            return json.loads(urllib.request.urlopen(req, timeout=10).read())
        core.create_project(home / "projects" / "Api", "Api")
        f = post("/api/core/project/export", {"path": str(home / "Api.cassetto")})["file"]
        st = post("/api/core/project/import", {"path": f})            # into the default projects folder
        assert st["project"]["path"] == str((home / "projects" / "Api 2").resolve())
    finally:
        srv.shutdown()
        srv.server_close()
