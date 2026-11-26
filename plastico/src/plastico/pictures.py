"""A picture of a scene at a time of day, put together from its .tscn the way Godot would draw it.

Every Sprite2D with a picture file is pasted at its place (positions and scales of its parents,
`centered`, `offset`, `flip_h`, sprite sheet frames, region), in drawing order (tree order, with
y-sort and z_index), showing the texture and the position its phase tags give it
(metadata/phase_tex, metadata/phase_pos, metadata/phases: core/phase_art.gd). Glows, shaders, the
player and close-up views are left out. Indoors the frame is the camera's 1920x1080; outdoors the
camera's limits (the whole painting). Results are cached as JPEGs keyed on the files' times.
"""
from __future__ import annotations

import hashlib
import io
import os
from pathlib import Path

from PIL import Image

from .godot import effective_phases, res_to_path
from .tscn import Ctor, Scene, Section, vec2

CACHE = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "plastico" / "pictures"
MAX_W = 1400
_NODE2D_SKIP_TYPES = {"CanvasLayer", "Control", "ColorRect", "Label", "TextureRect", "Panel"}


def _art_phase(root: Section, phase: str) -> str:
    drawn = root.get("metadata/art_phases") if root else None
    drawn = [str(x) for x in drawn] if isinstance(drawn, list) else []
    return phase if phase in drawn else "midnight"


def _texture_for(scene: Scene, n: Section, phase: str) -> str | None:
    tex = n.get("metadata/phase_tex")
    if isinstance(tex, dict) and phase in tex:
        return str(tex[phase])
    v = n.get("texture")
    if isinstance(v, Ctor) and v.name == "ExtResource" and v.args:
        return scene.ext_resources().get(str(v.args[0]))
    return None


def _visible(scene: Scene, n: Section, phase: str) -> bool:
    path = n.path
    while True:
        node = scene.node(path)
        if node is not None:
            if node.get("visible") is False:
                return False
            if node.attrs.get("instance"):
                return False
        if path in (".", ""):
            return True
        path = path.rsplit("/", 1)[0] if "/" in path else "."


def _offset_of(scene: Scene, n: Section, phase: str) -> tuple[float, float, float, float, float]:
    """The global position, scale and y of a node (sum of its parents' positions and scales)."""
    chain = []
    path = n.path
    while True:
        node = scene.node(path)
        if node is not None:
            chain.append(node)
        if path in (".", ""):
            break
        path = path.rsplit("/", 1)[0] if "/" in path else "."
    x = y = 0.0
    sx = sy = 1.0
    for node in reversed(chain):
        px, py = vec2(node.get("position"))
        pos = node.get("metadata/phase_pos")
        if isinstance(pos, dict) and phase in pos:
            px, py = vec2(pos[phase], (px, py))
        x += px * sx
        y += py * sy
        s = node.get("scale")
        if isinstance(s, Ctor):
            a, b = vec2(s, (1.0, 1.0))
            sx *= a
            sy *= b
    return x, y, sx, sy, y


def _frame(scene: Scene, kind: str) -> tuple[float, float, float, float]:
    cam = scene.node("Camera2D")
    if kind == "outside" and cam is not None:
        l, t = cam.get("limit_left"), cam.get("limit_top")
        r, b = cam.get("limit_right"), cam.get("limit_bottom")
        if all(isinstance(v, (int, float)) for v in (l, t, r, b)) and r > l and b > t:
            return float(l), float(t), float(r), float(b)
    if kind == "inside":
        cx, cy = vec2(cam.get("position"), (960.0, 540.0)) if cam is not None else (960.0, 540.0)
        return cx - 960, cy - 540, cx + 960, cy + 540
    return 0.0, 0.0, 3840.0, 2160.0


def _items(scene: Scene, phase: str):
    """(z, order, node) for every sprite drawn, in Godot's order."""
    nodes = scene.nodes()
    children: dict[str, list[Section]] = {}
    for s in nodes:
        if s.parent is not None:
            children.setdefault(s.parent, []).append(s)
    out = []
    counter = [0]

    def walk(path: str, z: int):
        node = scene.node(path)
        kids = list(children.get(path if path != "." else ".", []))
        if node is not None and node.get("y_sort_enabled") is True:
            kids.sort(key=lambda k: _offset_of(scene, k, phase)[4])
        for k in kids:
            if k.path.startswith("Views") or k.name in ("Views",):
                continue
            if k.type in _NODE2D_SKIP_TYPES or k.attrs.get("instance"):
                continue
            kz = z + int(k.get("z_index", 0) or 0) if k.get("z_as_relative", True) is not False else int(k.get("z_index", 0) or 0)
            if k.type == "Sprite2D":
                counter[0] += 1
                out.append((kz, counter[0], k))
            walk(k.path, kz)

    walk(".", 0)
    out.sort(key=lambda t: (t[0], t[1]))
    return out


def _sources(project: Path, scene: Scene, kind: str, phase: str):
    root = scene.root()
    ph = _art_phase(root, phase)
    for _, _, n in _items(scene, ph):
        tags = effective_phases(scene, n)
        if tags is not None and ph not in tags:
            continue
        if not _visible(scene, n, ph):
            continue
        res = _texture_for(scene, n, ph)
        if not res or not res.endswith((".png", ".jpg", ".jpeg", ".webp")):
            continue
        mat = n.get("material")
        if isinstance(mat, Ctor) and mat.name == "SubResource":
            continue   # glows (additive) and shaders: not part of the painting
        f = res_to_path(project, res)
        if f.exists():
            yield n, f


def cache_key(project: Path, scene_file: Path, kind: str, phase: str) -> str | None:
    if not scene_file.exists():
        return None
    scene = Scene.load(scene_file)
    h = hashlib.sha1()
    h.update(f"{scene_file}:{scene_file.stat().st_mtime_ns}:{kind}:{phase}:v3".encode())
    n = 0
    for _, f in _sources(project, scene, kind, phase):
        h.update(f"{f}:{f.stat().st_mtime_ns}".encode())
        n += 1
    return h.hexdigest() if n else None


def render(project: Path, scene_file: Path, kind: str, phase: str) -> bytes | None:
    """A JPEG of the scene, or None if it has no pictures yet."""
    key = cache_key(project, scene_file, kind, phase)
    if key is None:
        return None
    CACHE.mkdir(parents=True, exist_ok=True)
    cached = CACHE / f"{key}.jpg"
    if cached.exists():
        return cached.read_bytes()
    scene = Scene.load(scene_file)
    l, t, r, b = _frame(scene, kind)
    w, h = r - l, b - t
    k = min(1.0, MAX_W / w)
    canvas = Image.new("RGBA", (max(1, round(w * k)), max(1, round(h * k))), (24, 26, 30, 255))
    ph = _art_phase(scene.root(), phase)
    for n, f in _sources(project, scene, kind, phase):
        try:
            img = Image.open(f)
            img.load()
        except OSError:
            continue
        img = img.convert("RGBA")
        hf = int(n.get("hframes", 1) or 1)
        vf = int(n.get("vframes", 1) or 1)
        if hf > 1 or vf > 1:
            fw, fh = img.width // hf, img.height // vf
            fr = int(n.get("frame", 0) or 0)
            cx, cy = (fr % hf) * fw, (fr // hf) * fh
            img = img.crop((cx, cy, cx + fw, cy + fh))
        if n.get("region_enabled") is True:
            rr = n.get("region_rect")
            if isinstance(rr, Ctor) and len(rr.args) >= 4:
                rx, ry, rw, rh = (float(a) for a in rr.args[:4])
                img = img.crop((int(rx), int(ry), int(rx + rw), int(ry + rh)))
        if n.get("flip_h") is True:
            img = img.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        x, y, sx, sy, _ = _offset_of(scene, n, ph)
        ox, oy = vec2(n.get("offset"))
        sw, sh = img.width * abs(sx), img.height * abs(sy)
        left = x + ox * sx
        top = y + oy * sy
        if n.get("centered", True) is not False:
            left -= sw / 2
            top -= sh / 2
        dw, dh = max(1, round(sw * k)), max(1, round(sh * k))
        img = img.resize((dw, dh), Image.Resampling.BILINEAR if k < 1 else Image.Resampling.NEAREST)
        mod = n.get("modulate") or n.get("self_modulate")
        if isinstance(mod, Ctor) and mod.name == "Color" and len(mod.args) >= 4 and float(mod.args[3]) < 1:
            a = img.getchannel("A").point(lambda v: int(v * float(mod.args[3])))
            img.putalpha(a)
        _paste_clipped(canvas, img, round((left - l) * k), round((top - t) * k))
    buf = io.BytesIO()
    canvas.convert("RGB").save(buf, "JPEG", quality=84, optimize=True)
    data = buf.getvalue()
    tmp = cached.with_suffix(".tmp")
    tmp.write_bytes(data)
    tmp.replace(cached)
    return data


def _paste_clipped(canvas: Image.Image, img: Image.Image, x: int, y: int) -> None:
    """alpha_composite with the part of `img` that falls on the canvas (it may stick out on any side)."""
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(canvas.width, x + img.width), min(canvas.height, y + img.height)
    if x1 <= x0 or y1 <= y0:
        return
    canvas.alpha_composite(img.crop((x0 - x, y0 - y, x1 - x, y1 - y)), (x0, y0))


def thumbnail(data: bytes, width: int) -> bytes:
    img = Image.open(io.BytesIO(data))
    if img.width <= width:
        return data
    img = img.resize((width, round(img.height * width / img.width)), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=82)
    return buf.getvalue()


def normalize_upload(data: bytes) -> bytes:
    """A picture someone drops in for a scene that isn't drawn yet, as a JPEG no wider than MAX_W."""
    img = Image.open(io.BytesIO(data))
    img.load()
    if img.width > MAX_W:
        img = img.resize((MAX_W, round(img.height * MAX_W / img.width)), Image.Resampling.LANCZOS)
    bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
    bg.alpha_composite(img.convert("RGBA"))
    buf = io.BytesIO()
    bg.convert("RGB").save(buf, "JPEG", quality=86)
    return buf.getvalue()
