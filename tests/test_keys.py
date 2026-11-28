"""The user's keyboard shortcuts: kept in the config folder, checked, and served to the pages."""
from __future__ import annotations

import json
import urllib.request

import pytest


def test_shortcuts_are_kept_per_user_and_checked(home):
    from cassetto.core import settings
    from cassetto.core.project import ProjectError
    assert settings.load_keys() == {}                    # nothing changed yet: every default stands
    b = settings.save_keys({"plastico.fit": ["G", "G", "Ctrl+Shift+F"], "suite.tree": [], "later.thing": ["Alt+K"]})
    assert b == {"plastico.fit": ["G", "Ctrl+Shift+F"], "suite.tree": [], "later.thing": ["Alt+K"]}
    f = home / "config" / "keybindings.json"
    data = json.loads(f.read_text())
    assert data["format"] == "cassetto.keys" and data["version"] == 1
    assert settings.load_keys() == b                     # unknown ids survive, for a newer Cassetto
    for bad in ({"plastico.fit": "G"}, {"no dot": ["G"]}, {"plastico.fit": ["Ctrl+ G"]}, {"plastico.fit": ["A", "B", "C", "D", "E"]}, ["G"]):
        with pytest.raises(ValueError):
            settings.save_keys(bad)
    assert settings.load_keys() == b                     # a refused save changes nothing
    f.write_text("{ not json")
    assert settings.load_keys() == {}                    # a damaged file means the defaults, never a crash
    f.write_text(json.dumps({"format": "cassetto.keys", "version": 9, "bindings": {}}))
    with pytest.raises(ProjectError):
        settings.load_keys()
    with pytest.raises(ProjectError):
        settings.save_keys({"plastico.fit": ["G"]})      # never written over by an older Cassetto


def test_shortcuts_over_http_without_a_project(home):
    from cassetto.core.modules import Core
    from cassetto.core.server import serve_in_thread
    from cassetto.modules import all_modules
    core = Core(all_modules())
    srv = serve_in_thread(core, 0)
    try:
        def call(method, body=None, header=True):
            req = urllib.request.Request(f"{srv.url}api/core/settings/keys", method=method,
                                         data=json.dumps(body).encode() if body is not None else None,
                                         headers={"Content-Type": "application/json", **({"X-Cassetto": "1"} if header else {})})
            try:
                with urllib.request.urlopen(req) as r:
                    return r.status, json.loads(r.read())
            except urllib.error.HTTPError as e:
                return e.code, json.loads(e.read() or b"{}")
        st, d = call("GET")
        assert st == 200 and d["bindings"] == {} and d["file"].endswith("keybindings.json")
        st, d = call("PUT", {"bindings": {"suite.settings": ["Ctrl+Alt+S"]}})
        assert st == 200 and d["bindings"] == {"suite.settings": ["Ctrl+Alt+S"]}
        assert call("GET")[1]["bindings"] == {"suite.settings": ["Ctrl+Alt+S"]}
        assert call("PUT", {"bindings": {"suite.settings": "nope"}})[0] == 400
        assert call("PUT", {"bindings": {}}, header=False)[0] == 403       # another site can't change them
        # the pages get the shared key list next to the bridge
        for mid in ("plastico", "puzzles"):
            with urllib.request.urlopen(f"{srv.url}m/{mid}/") as r:
                html = r.read().decode()
            assert '<script src="/shared/keys.js"></script>' in html
    finally:
        core.close_project()
        srv.shutdown()
        srv.server_close()
