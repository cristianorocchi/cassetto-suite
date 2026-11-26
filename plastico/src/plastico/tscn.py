"""Reads and edits Godot 4 text scenes (.tscn) without touching anything it doesn't change.

A scene is a list of sections ([gd_scene], [ext_resource], [sub_resource], [node], [connection]...).
Each keeps its exact text; edits replace or insert whole lines, so `Scene.text()` of an unedited
scene is the file byte for byte (tests/test_tscn.py checks that on every scene of the game).
Values are parsed into Python on demand by `parse_value` (enough of Godot's variant syntax for
what Plastico reads: strings, StringNames, numbers, bools, arrays, dictionaries, constructors).
"""
from __future__ import annotations

import random
import re
from dataclasses import dataclass, field
from pathlib import Path

_HEADER = re.compile(r"^\[(gd_scene|gd_resource|ext_resource|sub_resource|node|connection|editable|resource)[\s\]]")
_ATTR = re.compile(r'(\w+)=("(?:[^"\\]|\\.)*"|\w+\([^)]*\)|[^\s\]]+)')
_PROP = re.compile(r"^([A-Za-z_][\w/:.\-]*) = ")


def _scan(line: str, in_str: bool, depth: int) -> tuple[bool, int]:
    """Carries the string / bracket state of a value across one line."""
    i, n = 0, len(line)
    while i < n:
        c = line[i]
        if in_str:
            if c == "\\":
                i += 1
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c in "[({":
            depth += 1
        elif c in "])}":
            depth = max(0, depth - 1)
        i += 1
    return in_str, depth


@dataclass
class Prop:
    key: str
    start: int          # index of its first line in Section.body
    end: int            # index after its last line
    raw: str            # the value's text (may span lines)


@dataclass
class Section:
    kind: str
    head: str                       # the header line, newline included
    body: list[str] = field(default_factory=list)   # the lines after it, newlines included

    @property
    def attrs(self) -> dict[str, str]:
        inner = self.head.strip()[1:-1]
        return {k: v for k, v in _ATTR.findall(inner)}

    def attr(self, key: str, default: str | None = None) -> str | None:
        v = self.attrs.get(key)
        if v is None:
            return default
        return unquote(v) if v.startswith('"') else v

    def props(self) -> list[Prop]:
        out: list[Prop] = []
        in_str, depth = False, 0
        cur: Prop | None = None
        for i, line in enumerate(self.body):
            if not in_str and depth == 0:
                if cur is not None:
                    cur.end = i
                    out.append(cur)
                    cur = None
                m = _PROP.match(line)
                if m:
                    cur = Prop(m.group(1), i, i + 1, line[m.end():])
                    in_str, depth = _scan(line[m.end():], False, 0)
                continue
            # a continuation line of the current value
            if cur is not None:
                cur.raw += line
            in_str, depth = _scan(line, in_str, depth)
        if cur is not None:
            cur.end = len(self.body)
            out.append(cur)
        for p in out:
            p.raw = p.raw.rstrip("\n")
        return out

    def get_raw(self, key: str) -> str | None:
        for p in self.props():
            if p.key == key:
                return p.raw
        return None

    def get(self, key: str, default=None):
        raw = self.get_raw(key)
        if raw is None:
            return default
        try:
            return parse_value(raw)
        except ValueError:
            return default

    def set_raw(self, key: str, raw: str) -> None:
        """Sets a property to an already formatted value (replacing it if there)."""
        new = [f"{key} = {raw}\n"]
        for p in self.props():
            if p.key == key:
                self.body[p.start:p.end] = new
                return
        # after the last property, before the blank line(s) that end the section
        at = len(self.body)
        while at > 0 and self.body[at - 1].strip() == "":
            at -= 1
        self.body[at:at] = new

    def remove_prop(self, key: str) -> None:
        for p in self.props():
            if p.key == key:
                del self.body[p.start:p.end]
                return

    def text(self) -> str:
        return self.head + "".join(self.body)

    # --- nodes ---
    @property
    def name(self) -> str:
        return self.attr("name", "") or ""

    @property
    def parent(self) -> str | None:
        return self.attr("parent")

    @property
    def type(self) -> str:
        return self.attr("type", "") or ""

    @property
    def path(self) -> str:
        """The node's path from the root: "." for the root, "Hotspots/ExitLeft" for others."""
        p = self.parent
        if p is None:
            return "."
        return self.name if p == "." else f"{p}/{self.name}"


class Scene:
    def __init__(self, text: str, path: Path | None = None):
        self.path = path
        self.sections: list[Section] = []
        self.preamble = ""
        in_str, depth = False, 0
        cur: Section | None = None
        for line in text.splitlines(keepends=True):
            if not in_str and depth == 0:
                m = _HEADER.match(line)
                if m:
                    cur = Section(m.group(1), line)
                    self.sections.append(cur)
                    continue
            if cur is None:
                self.preamble += line
            else:
                cur.body.append(line)
                in_str, depth = _scan(line, in_str, depth)

    @classmethod
    def load(cls, path: Path) -> "Scene":
        return cls(Path(path).read_text(encoding="utf-8"), Path(path))

    def text(self) -> str:
        return self.preamble + "".join(s.text() for s in self.sections)

    def save(self, path: Path | None = None) -> None:
        target = Path(path or self.path)
        tmp = target.with_suffix(target.suffix + ".plastico-tmp")
        tmp.write_text(self.text(), encoding="utf-8")
        tmp.replace(target)

    # --- lookups ---
    def nodes(self) -> list[Section]:
        return [s for s in self.sections if s.kind == "node"]

    def root(self) -> Section | None:
        for s in self.nodes():
            if s.parent is None:
                return s
        return None

    def node(self, path: str) -> Section | None:
        for s in self.nodes():
            if s.path == path:
                return s
        return None

    def children(self, path: str) -> list[Section]:
        return [s for s in self.nodes() if s.parent == path]

    def subtree(self, path: str) -> list[Section]:
        """The node at `path` and everything under it."""
        out = []
        for s in self.nodes():
            p = s.path
            if p == path or p.startswith(path + "/"):
                out.append(s)
        return out

    def ext_resources(self) -> dict[str, str]:
        """ExtResource id -> res:// path."""
        out = {}
        for s in self.sections:
            if s.kind == "ext_resource":
                rid, rpath = s.attr("id"), s.attr("path")
                if rid and rpath:
                    out[rid] = rpath
        return out

    def ext_id_for(self, res_path: str) -> str | None:
        for rid, p in self.ext_resources().items():
            if p == res_path:
                return rid
        return None

    def ensure_ext_resource(self, res_type: str, res_path: str, prefer_id: str) -> str:
        """The id of the ExtResource for `res_path`, adding one if the scene has none."""
        rid = self.ext_id_for(res_path)
        if rid:
            return rid
        taken = set(self.ext_resources())
        rid, k = prefer_id, 2
        while rid in taken:
            rid, k = f"{prefer_id}{k}", k + 1
        sec = Section("ext_resource", f'[ext_resource type="{res_type}" path="{res_path}" id="{rid}"]\n')
        last = max((i for i, s in enumerate(self.sections) if s.kind == "ext_resource"), default=0)
        # an ext_resource is followed by the next one directly; the last one by a blank line
        if self.sections and self.sections[last].kind == "ext_resource":
            prev = self.sections[last]
            if prev.body and prev.body[-1].strip() == "":
                # move the blank line after the new one
                blank = prev.body.pop()
                sec.body.append(blank)
            self.sections.insert(last + 1, sec)
        else:
            sec.body.append("\n")
            self.sections.insert(1, sec)
        return rid

    def unique_ids(self) -> set[int]:
        out = set()
        for s in self.nodes():
            v = s.attrs.get("unique_id")
            if v and v.isdigit():
                out.add(int(v))
        return out

    def new_unique_id(self) -> int:
        taken = self.unique_ids()
        while True:
            n = random.randint(10_000_000, 2_147_483_000)
            if n not in taken:
                return n

    def insert_after_subtree(self, parent_path: str, new: list[Section]) -> None:
        """Adds sections as the last children of the node at `parent_path`."""
        idx = None
        for i, s in enumerate(self.sections):
            if s.kind != "node":
                continue
            p = s.path
            if parent_path == "." or p == parent_path or p.startswith(parent_path + "/"):
                idx = i
        if idx is None:
            raise KeyError(parent_path)
        # keep the blank line that separates sections
        prev = self.sections[idx]
        if not prev.body or prev.body[-1].strip() != "":
            prev.body.append("\n")
        for k, sec in enumerate(new):
            if not sec.body or sec.body[-1].strip() != "":
                sec.body.append("\n")
        self.sections[idx + 1:idx + 1] = new
        self._fix_last_blank()

    def remove_subtree(self, path: str) -> list[str]:
        """Removes a node, its children and the signal connections that name them. Returns their paths."""
        gone = {s.path for s in self.subtree(path)}
        keep = []
        for s in self.sections:
            if s.kind == "node" and s.path in gone:
                continue
            if s.kind == "connection":
                a, b = s.attr("from", ""), s.attr("to", "")
                if any(x in gone or any(x.startswith(g + "/") for g in gone) for x in (a, b)):
                    continue
            keep.append(s)
        self.sections = keep
        self._fix_last_blank()
        return sorted(gone)

    def _fix_last_blank(self) -> None:
        """Godot ends a scene with one section and no trailing blank line after it."""
        if not self.sections:
            return
        last = self.sections[-1]
        while len(last.body) > 0 and last.body[-1].strip() == "":
            last.body.pop()
        if last.body and not last.body[-1].endswith("\n"):
            last.body[-1] += "\n"


def make_node(name: str, type_: str, parent: str, unique_id: int, props: list[tuple[str, str]],
              extra_attrs: str = "") -> Section:
    head = f'[node name="{name}" type="{type_}" parent="{parent}"{extra_attrs} unique_id={unique_id}]\n'
    return Section("node", head, [f"{k} = {v}\n" for k, v in props])


# --- values ---

def quote(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def unquote(s: str) -> str:
    s = s[1:-1] if len(s) >= 2 and s[0] == '"' and s[-1] == '"' else s
    out, i = [], 0
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s):
            nxt = s[i + 1]
            out.append({"n": "\n", "t": "\t", '"': '"', "\\": "\\"}.get(nxt, nxt))
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def string_name(s: str) -> str:
    return "&" + quote(s)


class Ctor(tuple):
    """A constructor call in a value: Vector2(1, 2) -> Ctor(("Vector2", [1.0, 2.0]))."""

    @property
    def name(self) -> str:
        return self[0]

    @property
    def args(self) -> list:
        return self[1]


_TOKEN = re.compile(r'\s*(?:(&?"(?:[^"\\]|\\.)*")|(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)|([A-Za-z_]\w*)|(.))', re.S)


def parse_value(raw: str):
    toks = []
    pos = 0
    raw = raw.strip()
    while pos < len(raw):
        m = _TOKEN.match(raw, pos)
        if not m or m.end() == pos:
            break
        pos = m.end()
        s, num, ident, ch = m.groups()
        if s is not None:
            toks.append(("s", s))
        elif num is not None:
            toks.append(("n", num))
        elif ident is not None:
            toks.append(("i", ident))
        elif ch is not None and not ch.isspace():
            toks.append(("c", ch))
    i = 0

    def val():
        nonlocal i
        if i >= len(toks):
            raise ValueError("end of value")
        kind, t = toks[i]
        i += 1
        if kind == "s":
            return unquote(t[1:] if t.startswith("&") else t)
        if kind == "n":
            return float(t) if any(c in t for c in ".e") else int(t)
        if kind == "i":
            if t == "true":
                return True
            if t == "false":
                return False
            if t == "null":
                return None
            if i < len(toks) and toks[i] == ("c", "("):
                i += 1
                args = []
                while i < len(toks) and toks[i] != ("c", ")"):
                    args.append(val())
                    if i < len(toks) and toks[i] == ("c", ","):
                        i += 1
                i += 1
                return Ctor((t, args))
            if i < len(toks) and toks[i] == ("c", "["):   # typed array: Array[StringName]([...])
                depth = 0
                while i < len(toks):
                    if toks[i] == ("c", "["):
                        depth += 1
                    elif toks[i] == ("c", "]"):
                        depth -= 1
                        if depth == 0:
                            i += 1
                            break
                    i += 1
                return val()
            return t
        if t == "[":
            arr = []
            while i < len(toks) and toks[i] != ("c", "]"):
                arr.append(val())
                if i < len(toks) and toks[i] == ("c", ","):
                    i += 1
            i += 1
            return arr
        if t == "{":
            d = {}
            while i < len(toks) and toks[i] != ("c", "}"):
                k = val()
                if i < len(toks) and toks[i] == ("c", ":"):
                    i += 1
                d[k if not isinstance(k, list) else str(k)] = val()
                if i < len(toks) and toks[i] == ("c", ","):
                    i += 1
            i += 1
            return d
        if t == "(":   # a bare parenthesis (Ctor handles its own): read what is inside
            v = val()
            if i < len(toks) and toks[i] == ("c", ")"):
                i += 1
            return v
        raise ValueError(f"unexpected {t!r}")

    return val()


def vec2(v, default=(0.0, 0.0)) -> tuple[float, float]:
    if isinstance(v, Ctor) and v.name in ("Vector2", "Vector2i") and len(v.args) >= 2:
        return float(v.args[0]), float(v.args[1])
    return default


def points(v) -> list[tuple[float, float]]:
    if isinstance(v, Ctor) and v.name == "PackedVector2Array":
        a = [float(x) for x in v.args]
        return list(zip(a[0::2], a[1::2]))
    return []


def fmt_num(x: float) -> str:
    if float(x).is_integer():
        return str(int(x))
    return f"{x:.4f}".rstrip("0").rstrip(".")


def fmt_vec2(x: float, y: float) -> str:
    return f"Vector2({fmt_num(x)}, {fmt_num(y)})"


def fmt_points(pts) -> str:
    return "PackedVector2Array(" + ", ".join(f"{fmt_num(x)}, {fmt_num(y)}" for x, y in pts) + ")"
