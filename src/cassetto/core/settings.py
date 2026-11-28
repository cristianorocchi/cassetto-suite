"""The user's own settings that follow them from project to project, kept in Cassetto's config folder.

    keybindings.json   {"format": "cassetto.keys", "version": 1, "bindings": {"<action id>": ["Ctrl+B", ...]}}

Only the keyboard shortcuts that differ from the defaults are kept (the defaults live in
web/shared/keys.js). An empty list means the action has no keys. Ids this Cassetto doesn't know are
kept as they are, so a newer Cassetto's choices survive a run of an older one.
"""
from __future__ import annotations

import json
import re

from ..paths import config_dir
from .project import ProjectError, _write_json

KEYS_FILE = "keybindings.json"
KEYS_FORMAT = "cassetto.keys"
KEYS_VERSION = 1
MAX_ACTIONS = 500
MAX_PER_ACTION = 4
_ID = re.compile(r"^[a-z][a-z0-9_-]*(\.[A-Za-z0-9_-]+)+$")
_CHORD = re.compile(r"^((Ctrl|Alt|Shift)\+){0,3}[^\s]{1,16}$")


def keys_path():
    return config_dir() / KEYS_FILE


def clean_bindings(data) -> dict[str, list[str]]:
    """The bindings in `data`, checked: action ids to lists of chords. Anything else is refused."""
    if not isinstance(data, dict):
        raise ValueError("bindings must be an object of action ids to lists of keys")
    if len(data) > MAX_ACTIONS:
        raise ValueError("too many shortcuts")
    out: dict[str, list[str]] = {}
    for aid, chords in data.items():
        if not isinstance(aid, str) or not _ID.match(aid):
            raise ValueError(f"not an action id: {aid!r}")
        if not isinstance(chords, list) or len(chords) > MAX_PER_ACTION:
            raise ValueError(f"{aid}: a list of at most {MAX_PER_ACTION} keys")
        seen: list[str] = []
        for c in chords:
            if not isinstance(c, str) or not _CHORD.match(c):
                raise ValueError(f"{aid}: not a key: {c!r}")
            if c not in seen:
                seen.append(c)
        out[aid] = seen
    return out


def load_keys() -> dict[str, list[str]]:
    """The keyboard shortcuts the user changed. A missing or damaged file means none."""
    f = keys_path()
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict) or data.get("format") != KEYS_FORMAT:
        return {}
    if int(data.get("version") or 0) > KEYS_VERSION:
        raise ProjectError("The keyboard shortcuts were saved by a newer Cassetto. Update Cassetto to change them here.")
    try:
        return clean_bindings(data.get("bindings") or {})
    except ValueError:
        return {}


def save_keys(bindings) -> dict[str, list[str]]:
    b = clean_bindings(bindings)
    load_keys()      # refuses to write over a newer Cassetto's file
    _write_json(keys_path(), {"format": KEYS_FORMAT, "version": KEYS_VERSION, "bindings": b})
    return b
