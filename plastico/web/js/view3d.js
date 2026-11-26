// The 3D model: every scene a block on its floor (plates outside, rooms inside), every way a
// curve between them, labels and badges in HTML on top. Skeleton mode shows the structure only;
// Pictures mode lays each outdoor scene's picture on its plate and stands each indoor one's on
// its room like a postcard. Renders only when something changed.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { FLOOR_H, GRID, MAJOR, sizeOf, snapAxis, overlapping, descendantsOf } from './model.js';

const UP = new THREE.Vector3(0, 1, 0);

function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function colorOf(name) {
  const v = css(name);
  const m = v.match(/rgba?\(([^)]+)\)/);
  if (m) { const [r, g, b, a] = m[1].split(',').map((x) => parseFloat(x)); return { c: new THREE.Color(r / 255, g / 255, b / 255), a: a ?? 1 }; }
  return { c: new THREE.Color(v || '#888'), a: 1 };
}

// a scene's block: its footprint in whole grid cells (model.sizeOf), standing on its floor
export function sceneSize(S) { return sizeOf(S); }

export class View3D {
  constructor(stage, labels, cb) {
    this.stage = stage; this.labels = labels; this.cb = cb;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    stage.prepend(this.renderer.domElement);
    this.css2d = new CSS2DRenderer({ element: labels });
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.5, 4000);
    this.camera.position.set(0, 60, 42);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.14, screenSpacePanning: false, minDistance: 5, maxDistance: 600, maxPolarAngle: Math.PI * 0.48, zoomToCursor: true });
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.controls.addEventListener('change', () => { this.dirty = true; });
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8899aa, 2.2);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.6);
    this.sun.position.set(-30, 60, 40);
    this.scene.add(this.hemi, this.sun);
    this.gridG = new THREE.Group(); this.sceneG = new THREE.Group(); this.linkG = new THREE.Group(); this.fxG = new THREE.Group();
    this.scene.add(this.gridG, this.sceneG, this.linkG, this.fxG);
    this.objs = new Map(); this.pairObjs = new Map(); this.lineMats = new Set(); this.textures = new Map();
    this.raycaster = new THREE.Raycaster();
    this.top = false; this.dirty = true; this.anim = null; this.drag = null; this.token = null;
    this.data = null;
    this.readTheme();
    this.bindPointer();
    new ResizeObserver(() => this.resize()).observe(stage);
    this.resize();
    this.timer = new THREE.Timer(); this.timer.connect(document);
    this.renderer.setAnimationLoop(() => this.frame());
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { this.readTheme(); this.rebuild(); });
  }

  readTheme() {
    this.T = {
      paper: colorOf('--paper').c, ink: colorOf('--ink').c, ink2: colorOf('--ink-2').c, muted: colorOf('--muted').c,
      edge: colorOf('--edge').c, danger: colorOf('--danger').c, accent: colorOf('--accent').c, block: colorOf('--block').c,
      surface: colorOf('--surface').c, grid: colorOf('--grid'), gridMajor: colorOf('--grid-major'),
      areas: Array.from({ length: 8 }, (_, i) => colorOf(`--a${i}`).c),
      dark: matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light',
    };
    this.renderer.setClearColor(this.T.paper, 1);
    this.dirty = true;
  }

  resize() {
    const r = this.stage.getBoundingClientRect();
    const w = Math.max(1, r.width), h = Math.max(1, r.height);
    this.renderer.setSize(w, h);
    this.css2d.setSize(w, h);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    for (const m of this.lineMats) m.resolution.set(w, h);
    this.size = { w, h };
    this.dirty = true;
  }

  // --- building ---
  /** data: {M, ui, visible:Set, hl, pictureUrl(S), renderLabel(S, el), labelClasses(S)} */
  set(data) { this.data = data; this.rebuild(); }

  clearGroup(g) {
    for (const c of [...g.children]) {
      c.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { if (m !== this._pickMat) m.dispose(); this.lineMats.delete(m); });
        if (o.isCSS2DObject && o.element.parentNode) o.element.parentNode.removeChild(o.element);
      });
      g.remove(c);
    }
  }

  rebuild() {
    if (!this.data) return;
    this.clearGroup(this.sceneG); this.clearGroup(this.linkG); this.clearGroup(this.gridG);
    this.objs.clear(); this.pairObjs.clear();
    const { M, visible } = this.data;
    for (const S of M.scenes.values()) if (visible.has(S.id)) this.buildScene(S);
    this.buildLinks();
    this.buildGrid();
    this.applyHighlight();
    this.dirty = true;
  }

  areaColor(S) {
    const a = this.data.M.world.areas.find((x) => x.id === S.area);
    return a ? this.T.areas[(a.color ?? 0) % 8] : null;
  }

  buildScene(S) {
    const { ui } = this.data;
    const { w, d, h } = sceneSize(S);
    const y0 = S.floor * FLOOR_H;
    const g = new THREE.Group();
    g.position.set(S.x, y0, S.z);
    g.userData.sceneId = S.id;
    const area = this.areaColor(S);
    const base = this.T.block.clone();
    const tint = area ? base.clone().lerp(area, ui.mode === 'pictures' ? 0.32 : 0.22) : base.clone();
    const st = S.state;
    const faceOpacity = { game: 0.96, ready: 0.62, idea: 0.34, delete: 0.4 }[st] ?? 0.9;
    const sideMat = new THREE.MeshStandardMaterial({ color: st === 'delete' ? tint.clone().lerp(this.T.danger, 0.35) : tint, roughness: 0.92, metalness: 0, transparent: true, opacity: faceOpacity });
    const mats = [sideMat, sideMat, sideMat, sideMat, sideMat, sideMat];
    const geo = new THREE.BoxGeometry(w, h, d); geo.translate(0, h / 2, 0);
    const pic = ui.mode === 'pictures' ? this.data.pictureUrl(S) : null;
    let topMat = null;
    if (pic && S.kind === 'outside') {
      topMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: Math.max(faceOpacity, 0.75) });
      this.loadTexture(pic, (t) => { topMat.map = t; topMat.needsUpdate = true; this.dirty = true; });
      mats[2] = topMat;
    }
    const block = new THREE.Mesh(geo, mats);
    block.userData.sceneId = S.id;
    g.add(block);
    const edgeColor = st === 'delete' ? this.T.danger : st === 'game' ? this.T.ink : this.T.ink2;
    const dashed = st !== 'game';
    const eMat = dashed ? new THREE.LineDashedMaterial({ color: edgeColor, dashSize: 0.35, gapSize: 0.22, transparent: true })
      : new THREE.LineBasicMaterial({ color: edgeColor, transparent: true });
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), eMat);
    if (dashed) edges.computeLineDistances();
    g.add(edges);
    const el = document.createElement('div');
    el.className = 'lab';
    el.dataset.id = S.id;
    el.title = S.name || S.id;
    this.data.renderLabel(S, el);
    const lab = new CSS2DObject(el);
    lab.center.set(0.5, 1);
    lab.position.set(0, h + 0.3, 0);
    g.add(lab);
    let card = null, cardH = 0;
    if (pic && S.kind !== 'outside') {
      const cw = w * 1.12;
      const cMat = new THREE.SpriteMaterial({ color: 0xffffff, transparent: true, opacity: st === 'game' ? 1 : 0.7, sizeAttenuation: true });
      card = new THREE.Sprite(cMat);
      card.center.set(0.5, 0);
      cardH = cw * 9 / 16;
      card.scale.set(cw, cardH, 1);
      card.position.set(0, h + 0.12, 0);
      lab.position.y = h + 0.3 + cardH;
      card.userData.sceneId = S.id;
      this.loadTexture(pic, (t) => {
        cMat.map = t; cMat.needsUpdate = true;
        const img = t.image; if (img && img.width) { const ch = cw * img.height / img.width; card.scale.set(cw, ch, 1); lab.position.y = h + 0.3 + ch; }
        this.dirty = true;
      });
      g.add(card);
    }
    this.sceneG.add(g);
    const links = [...this.data.M.pairs.values()].filter((P) => P.a === S.id || P.b === S.id).length;
    const basePrio = (this.data.M.start === S.id ? 300 : 0) + ({ outside: 40, inside: 20, closeup: 0 }[S.kind] || 0) + links * 3 + ((this.data.M.steps.get(S.id) || []).length ? 5 : 0);
    const o = { g, block, edges, card, lab, el, S, size: { w, d, h }, mats: [sideMat, topMat, eMat, card && card.material].filter(Boolean), basePrio, prio: basePrio, lod: '', post: null };
    this.setPost(o, S.floor);
    this.objs.set(S.id, o);
  }

  // a post down to the ground and the footprint there, for scenes above or below it
  setPost(o, floor) {
    if (o.post) { o.g.remove(o.post); o.post.traverse((c) => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); }); o.post = null; }
    if (!floor) return;
    const { w, d, h } = o.size, y0 = floor * FLOOR_H;
    const post = new THREE.Group();
    const pMat = new THREE.LineDashedMaterial({ color: this.T.edge, dashSize: 0.3, gapSize: 0.25, transparent: true, opacity: 0.8 });
    const ys = floor > 0 ? [0, -y0] : [h, -y0];
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, ys[0], 0), new THREE.Vector3(0, ys[1], 0)]), pMat);
    line.computeLineDistances();
    const fp = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-w / 2, -y0 + 0.02, -d / 2), new THREE.Vector3(w / 2, -y0 + 0.02, -d / 2),
      new THREE.Vector3(w / 2, -y0 + 0.02, d / 2), new THREE.Vector3(-w / 2, -y0 + 0.02, d / 2)]), pMat.clone());
    fp.computeLineDistances();
    post.add(line, fp);
    o.post = post;
    o.g.add(post);
  }

  loadTexture(url, done) {
    let rec = this.textures.get(url);
    if (rec && rec.tex) { done(rec.tex); return; }
    if (rec) { rec.waiting.push(done); return; }
    rec = { tex: null, waiting: [done] };
    this.textures.set(url, rec);
    new THREE.TextureLoader().load(url, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      rec.tex = t;
      rec.waiting.forEach((f) => f(t)); rec.waiting = [];
    }, undefined, () => { this.textures.delete(url); });
  }
  forgetTextures() { for (const r of this.textures.values()) if (r.tex) r.tex.dispose(); this.textures.clear(); }

  anchor(o, toward) {
    const { w, d, h } = o.size;
    const c = o.g.position;
    const dx = toward.x - c.x, dz = toward.z - c.z;
    const len = Math.hypot(dx, dz);
    const y = c.y + (o.S.kind === 'outside' ? h : h * 0.55);
    if (len < 0.6) return new THREE.Vector3(c.x, toward.y > c.y ? c.y + h : c.y, c.z);
    const ux = dx / len, uz = dz / len;
    const t = Math.min(ux ? (w / 2) / Math.abs(ux) : Infinity, uz ? (d / 2) / Math.abs(uz) : Infinity);
    return new THREE.Vector3(c.x + ux * t, y, c.z + uz * t);
  }

  curveFor(a, b) {
    const A = this.anchor(a, b.g.position), B = this.anchor(b, a.g.position);
    const dist = A.distanceTo(B);
    const C = A.clone().add(B).multiplyScalar(0.5).add(new THREE.Vector3(0, 0.5 + dist * 0.12, 0));
    return new THREE.QuadraticBezierCurve3(A, C, B);
  }

  buildLinks() {
    const { M } = this.data;
    for (const P of M.pairs.values()) {
      const a = this.objs.get(P.a), b = this.objs.get(P.b);
      if (!a || !b) continue;
      this.buildPair(P, a, b);
    }
    // ways that lead nowhere yet
    const centre = this.centre();
    const per = new Map();
    for (const e of M.openEnds) {
      const o = this.objs.get(e.from);
      if (!o) continue;
      if ((M.out.get(e.from) || []).some((l) => l.via === e.hotspot && l.state !== 'delete')) continue;
      const i = per.get(e.from) || 0; per.set(e.from, i + 1);
      const c = o.g.position;
      let dir = new THREE.Vector3(c.x - centre.x, 0, c.z - centre.z);
      if (dir.lengthSq() < 0.01) dir.set(1, 0, 0);
      dir.normalize().applyAxisAngle(UP, (i % 2 ? -1 : 1) * 0.5 * Math.ceil(i / 2));
      const A = this.anchor(o, c.clone().add(dir.clone().multiplyScalar(10)));
      const B = A.clone().add(dir.clone().multiplyScalar(3.2)).add(new THREE.Vector3(0, 1.2, 0));
      const mat = this.lineMat(this.T.muted, true, 1.6);
      const geo = new LineGeometry(); geo.setPositions([A.x, A.y, A.z, B.x, B.y, B.z]);
      const line = new Line2(geo, mat); line.computeLineDistances();
      this.linkG.add(line);
      const el = document.createElement('div');
      el.className = 'badge nowhere';
      el.innerHTML = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M4.3 4.4a1.8 1.8 0 1 1 2.5 1.7c-.5.2-.8.6-.8 1.1v.4M6 9.4v.1"/></svg>`;
      el.append(document.createTextNode(e.name || e.hotspot));
      el.title = `${e.name || e.hotspot}: leads nowhere yet. Select ${o.S.name} to lead it somewhere.`;
      el.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); this.cb.onSelect({ type: 'scene', id: e.from }); });
      const badge = new CSS2DObject(el); badge.position.copy(B);
      this.linkG.add(badge);
    }
  }

  lineMat(color, dashed, width) {
    const m = new LineMaterial({ color, linewidth: width, dashed, dashSize: 0.55, gapSize: 0.38, transparent: true, worldUnits: false });
    m.resolution.set(this.size.w, this.size.h);
    this.lineMats.add(m);
    return m;
  }

  buildPair(P, a, b) {
    const curve = this.curveFor(a, b);
    const pts = curve.getPoints(36);
    const st = P.state;
    const color = st === 'delete' || st === 'mixed-delete' ? this.T.danger : st === 'game' || st === 'mixed' ? this.T.ink : this.T.ink2;
    const mat = this.lineMat(color, !(st === 'game' || st === 'mixed'), st === 'game' ? 2.4 : 2);
    const geo = new LineGeometry(); geo.setPositions(pts.flatMap((p) => [p.x, p.y, p.z]));
    const line = new Line2(geo, mat); line.computeLineDistances();
    const grp = new THREE.Group();
    grp.add(line);
    if (!this._pickMat) this._pickMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
    const pick = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.45, 6, false), this._pickMat);
    pick.userData.pairKey = P.key;
    grp.add(pick);
    const arrows = [];
    for (const L of P.links) {
      if (!P.oneWay) break;
      const forward = L.from === P.a;
      const t = 0.56;
      const p = curve.getPoint(forward ? t : 1 - t);
      const tan = curve.getTangent(forward ? t : 1 - t).normalize();
      if (!forward) tan.negate();
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.34, 1, 14), new THREE.MeshBasicMaterial({ color, transparent: true }));
      cone.position.copy(p); cone.quaternion.setFromUnitVectors(UP, tan);
      grp.add(cone); arrows.push(cone);
    }
    let badge = null;
    if (P.locked || P.timed) {
      const el = document.createElement('div');
      el.className = 'badge lock';
      const L = P.links.find((l) => l.lock);
      if (L) {
        el.innerHTML = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.5" y="5.3" width="7" height="5" rx="1"/><path d="M4 5.3V4a2 2 0 0 1 4 0v1.3"/></svg>`;
        el.append(document.createTextNode(L.lock.needs));
      }
      if (P.timed) el.insertAdjacentHTML('beforeend', `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="6" cy="6" r="4.3"/><path d="M6 3.6V6l1.6 1"/></svg>`);
      el.title = 'Select to see what the way needs';
      el.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); this.cb.onSelect({ type: 'pair', key: P.key }); });
      badge = new CSS2DObject(el);
      badge.position.copy(curve.getPoint(0.5)).add(new THREE.Vector3(0, 0.5, 0));
      grp.add(badge);
    }
    this.linkG.add(grp);
    this.pairObjs.set(P.key, { grp, line, mat, pick, arrows, badge, P, curve });
  }

  refreshPairsOf(id) {
    const { M } = this.data;
    for (const [k, po] of [...this.pairObjs]) {
      if (po.P.a !== id && po.P.b !== id) continue;
      this.clearGroup({ children: [po.grp], remove: () => {} });
      this.linkG.remove(po.grp);
      this.pairObjs.delete(k);
      const P = M.pairs.get(k);
      const a = this.objs.get(P.a), b = this.objs.get(P.b);
      if (a && b) this.buildPair(P, a, b);
    }
    this.applyHighlight();
  }

  centre() {
    const b = new THREE.Box3();
    for (const o of this.objs.values()) b.expandByPoint(o.g.position);
    return b.isEmpty() ? new THREE.Vector3() : b.getCenter(new THREE.Vector3());
  }

  buildGrid() {
    // The lines are on the same grid snapping uses (origin 0, step GRID): a block's edges land on them.
    // They sit a hair under y = 0 so the blocks' bases rest on the grid without flickering through it.
    const b = new THREE.Box3();
    for (const o of this.objs.values()) {
      const p = o.g.position, { w, d } = o.size;
      b.expandByPoint(new THREE.Vector3(p.x - w / 2, 0, p.z - d / 2)); b.expandByPoint(new THREE.Vector3(p.x + w / 2, 0, p.z + d / 2));
    }
    if (b.isEmpty()) b.set(new THREE.Vector3(-20, 0, -20), new THREE.Vector3(20, 0, 20));
    const pad = 16, step = GRID, M5 = MAJOR * GRID;
    const x0 = Math.floor((b.min.x - pad) / M5) * M5, x1 = Math.ceil((b.max.x + pad) / M5) * M5;
    const z0 = Math.floor((b.min.z - pad) / M5) * M5, z1 = Math.ceil((b.max.z + pad) / M5) * M5;
    const minor = [], major = [], Y = -0.01;
    const isMajor = (v) => Math.abs(Math.round(v / M5) * M5 - v) < 1e-6;
    for (let i = 0, x = x0; x <= x1 + 1e-6; x = x0 + (++i) * step) (isMajor(x) ? major : minor).push(x, Y, z0, x, Y, z1);
    for (let i = 0, z = z0; z <= z1 + 1e-6; z = z0 + (++i) * step) (isMajor(z) ? major : minor).push(x0, Y, z, x1, Y, z);
    const mk = (arr, col) => {
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: col.c, transparent: true, opacity: Math.min(1, col.a * 1.6), depthWrite: false }));
    };
    this.gridG.add(mk(minor, this.T.grid), mk(major, this.T.gridMajor));
  }

  // --- highlight (selection, route, play test) ---
  applyHighlight() {
    if (!this.data) return;
    const hl = this.data.hl || { scene: new Map(), pair: new Map() };
    for (const [id, o] of this.objs) {
      const st = hl.scene.get(id) || '';
      const dim = st === 'dim';
      const sel = st === 'sel';
      for (const m of o.mats) {
        if (m.userData.base === undefined) m.userData.base = m.opacity;
        m.opacity = m.userData.base * (dim ? 0.22 : 1);
      }
      const ec = o.S.state === 'delete' ? this.T.danger : sel || st === 'route' || st === 'here' ? this.T.accent : o.S.state === 'game' ? this.T.ink : this.T.ink2;
      o.edges.material.color.copy(ec);
      o.el.className = ['lab', ...this.data.labelClasses(o.S), st, o.lod].filter(Boolean).join(' ');
      o.prio = (st === 'sel' || st === 'here' || st === 'route' ? 1000 : st === 'avail' ? 200 : st === 'dim' ? -500 : 0) + o.basePrio;
    }
    for (const [k, po] of this.pairObjs) {
      const st = hl.pair.get(k) || '';
      const base = po.P.state === 'delete' || po.P.state === 'mixed-delete' ? this.T.danger : po.P.state === 'game' || po.P.state === 'mixed' ? this.T.ink : this.T.ink2;
      const c = st === 'sel' || st === 'route' ? this.T.accent : st === 'blocked' ? this.T.danger : base;
      po.mat.color.copy(c);
      po.mat.linewidth = st === 'sel' || st === 'route' ? 4 : po.P.state === 'game' ? 2.4 : 2;
      po.mat.opacity = st === 'dim' ? 0.18 : 1;
      for (const a of po.arrows) { a.material.color.copy(c); a.material.opacity = st === 'dim' ? 0.18 : 1; }
      if (po.badge) {
        po.badge.element.classList.toggle('dim', st === 'dim');
        po.badge.element.classList.toggle('blocked', st === 'blocked');
      }
    }
    this.dirty = true;
  }

  // --- camera ---
  boundsOf(ids) {
    const b = new THREE.Box3();
    for (const [id, o] of this.objs) {
      if (ids && !ids.includes(id)) continue;
      const { w, d, h } = o.size; const p = o.g.position;
      b.expandByPoint(new THREE.Vector3(p.x - w / 2, p.y, p.z - d / 2));
      b.expandByPoint(new THREE.Vector3(p.x + w / 2, p.y + h + 2, p.z + d / 2));
    }
    return b;
  }

  fit(ids, instant = false) {
    const b = this.boundsOf(ids);
    if (b.isEmpty()) b.set(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 4, 10));
    const c = b.getCenter(new THREE.Vector3());
    const sz = b.getSize(new THREE.Vector3());
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const aspect = this.camera.aspect;
    const span = Math.max(sz.z * (this.top ? 1 : 0.8) + sz.y * 0.5, sz.x / aspect) * 0.62 + 4;
    const dist = Math.max(12, span / Math.tan(fov / 2));
    const s = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    const phi = this.top ? 0.0001 : Math.min(Math.max(s.phi, 0.55), 1.05);
    const theta = this.top ? 0 : s.theta;
    this.moveCamera(c, new THREE.Spherical(dist, phi, theta), instant ? 0 : 450);
  }

  focus(id) {
    const o = this.objs.get(id);
    if (!o) return;
    const s = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    const t = o.g.position.clone().add(new THREE.Vector3(0, o.size.h / 2, 0));
    this.moveCamera(t, new THREE.Spherical(Math.min(s.radius, 40), this.top ? 0.0001 : s.phi, this.top ? 0 : s.theta), 450);
  }

  zoom(f) {
    const s = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    s.radius = THREE.MathUtils.clamp(s.radius * f, this.controls.minDistance, this.controls.maxDistance);
    this.moveCamera(this.controls.target.clone(), s, 220);
  }

  setTop(top) {
    if (this.top !== top) {
      // The map looks straight down through a long lens (narrow field, camera far back): nearly no
      // perspective, so a tall block's top doesn't spread past its base and the edges read on the grid.
      // The framing stays the same: the distance grows by as much as the field narrows.
      const fov = top ? 8 : 34;
      const k = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) / Math.tan(THREE.MathUtils.degToRad(fov / 2));
      const v = this.camera.position.clone().sub(this.controls.target).multiplyScalar(k);
      this.camera.fov = fov; this.camera.far = top ? 20000 : 4000; this.camera.updateProjectionMatrix();
      this.controls.minDistance = top ? 30 : 5; this.controls.maxDistance = top ? 4000 : 600;
      this.camera.position.copy(this.controls.target).add(v);
      this.controls.update();
    }
    this.top = top;
    const s = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    this.controls.enableRotate = !top;
    this.controls.mouseButtons.LEFT = top ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    this.controls.screenSpacePanning = top;
    const to = top ? new THREE.Spherical(s.radius, 0.0001, 0) : new THREE.Spherical(s.radius, 0.85, this.lastTheta ?? 0.35);
    if (top) this.lastTheta = s.theta;
    this.moveCamera(this.controls.target.clone(), to, 450);
  }

  moveCamera(target, sph, ms) {
    const fromT = this.controls.target.clone();
    const fromS = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(fromT));
    let dTheta = sph.theta - fromS.theta;
    while (dTheta > Math.PI) dTheta -= 2 * Math.PI;
    while (dTheta < -Math.PI) dTheta += 2 * Math.PI;
    const toS = new THREE.Spherical(sph.radius, sph.phi, fromS.theta + dTheta);
    if (!ms || matchMedia('(prefers-reduced-motion: reduce)').matches) { this.placeCamera(target, toS); return; }
    this.anim = { t0: performance.now(), ms, fromT, toT: target.clone(), fromS, toS };
    this.dirty = true;
  }

  cameraState() {
    const t = this.controls.target;
    const s = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(t));
    // the distance as the normal lens would need it (the map's long lens stands much further back)
    const k = this.top ? Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) / Math.tan(THREE.MathUtils.degToRad(17)) : 1;
    return { t: [t.x, t.y, t.z], r: s.radius * k, phi: s.phi, theta: s.theta, top: this.top };
  }
  restoreCamera(c) {
    if (!c || !Array.isArray(c.t) || !(c.r > 0)) throw new Error('no camera');
    this.placeCamera(new THREE.Vector3(...c.t), new THREE.Spherical(c.r, c.phi, c.theta));
  }

  placeCamera(target, s) {
    this.controls.target.copy(target);
    const v = new THREE.Vector3().setFromSpherical(s);
    this.camera.position.copy(target).add(v);
    this.camera.lookAt(target);
    this.controls.update();
    this.dirty = true;
  }

  // --- play test token ---
  setToken(id, path) {
    if (!id) { if (this.token) { this.fxG.remove(this.token.mesh); this.token = null; this.dirty = true; } return; }
    if (!this.token) {
      const mesh = new THREE.Group();
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.4, 20), new THREE.MeshStandardMaterial({ color: this.T.accent, roughness: 0.5 }));
      cone.rotation.x = Math.PI; cone.position.y = 0.7;
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.5, 20, 14), new THREE.MeshStandardMaterial({ color: this.T.accent, roughness: 0.5 }));
      ball.position.y = 1.6;
      mesh.add(cone, ball);
      this.fxG.add(mesh);
      this.token = { mesh, pts: [], t0: 0 };
    }
    // on the front corner of the block, so the label (centred on top) doesn't hide it
    const at = (sid) => { const o = this.objs.get(sid); return o ? o.g.position.clone().add(new THREE.Vector3(o.size.w / 2 - 0.9, o.size.h + 0.1, o.size.d / 2 - 0.9)) : null; };
    const pts = (path && path.length > 1 ? path : [id]).map(at).filter(Boolean);
    if (!pts.length) return;
    this.token.pts = pts; this.token.t0 = performance.now();
    if (pts.length === 1) this.token.mesh.position.copy(pts[0]);
    this.dirty = true;
  }

  // --- pointer ---
  ground(ev, y = 0) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const p = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(new THREE.Plane(UP, -y), p) ? p : null;
  }

  pick(ev) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const blocks = [];
    for (const o of this.objs.values()) { blocks.push(o.block); if (o.card) blocks.push(o.card); }
    const hitS = this.raycaster.intersectObjects(blocks, false)[0];
    if (hitS) return { type: 'scene', id: hitS.object.userData.sceneId };
    const picks = [...this.pairObjs.values()].map((p) => p.pick);
    const hitP = this.raycaster.intersectObjects(picks, false)[0];
    if (hitP) return { type: 'pair', key: hitP.object.userData.pairKey };
    return null;
  }

  sceneUnder(ev) {
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const lab = el && el.closest && el.closest('.lab');
    if (lab && lab.dataset.id) return lab.dataset.id;
    const h = this.pick(ev);
    return h && h.type === 'scene' ? h.id : null;
  }

  bindPointer() {
    const canvas = this.renderer.domElement;
    // before OrbitControls (capture on the parent): a press on a scene moves it instead of turning the view
    this.stage.addEventListener('pointerdown', (ev) => {
      if (ev.target !== canvas || ev.button !== 0) return;
      const hit = this.pick(ev);
      if (hit && hit.type === 'scene') { ev.stopPropagation(); this.startSceneDrag(hit.id, ev); }
      else if (hit && hit.type === 'pair') { ev.stopPropagation(); this.cb.onSelect(hit); }
      else this.downAt = { x: ev.clientX, y: ev.clientY, t: performance.now() };
    }, true);
    canvas.addEventListener('pointerup', (ev) => {
      if (!this.downAt || ev.button !== 0) return;
      const moved = Math.hypot(ev.clientX - this.downAt.x, ev.clientY - this.downAt.y);
      this.downAt = null;
      if (moved < 4) this.cb.onEmptyClick(ev);
    });
    canvas.addEventListener('dblclick', (ev) => {
      if (this.pick(ev)) return;
      const p = this.ground(ev, 0);
      if (p) this.cb.onAddAt(p.x, p.z);
    });
    canvas.addEventListener('pointermove', (ev) => {
      if (this.drag) return;
      const hit = ev.buttons ? null : this.pick(ev);
      this.stage.classList.toggle('picking', !!hit);
    });
    this.labels.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      canvas.dispatchEvent(new WheelEvent('wheel', ev));
    }, { passive: false });
    this.labels.addEventListener('pointerdown', (ev) => {
      const port = ev.target.closest('.port');
      const lab = ev.target.closest('.lab');
      if (!lab || ev.button !== 0) return;
      ev.preventDefault(); ev.stopPropagation();
      if (port) this.startConnect(lab.dataset.id, ev);
      else this.startSceneDrag(lab.dataset.id, ev);
    });
    this.labels.addEventListener('dblclick', (ev) => {
      const lab = ev.target.closest('.lab');
      if (lab) this.cb.onOpen(lab.dataset.id);
    });
  }

  startSceneDrag(id, ev) {
    const o = this.objs.get(id);
    if (!o) return;
    if (!this.cb.canDrag(id)) { this.cb.onSelect({ type: 'scene', id }); return; }
    const y = o.g.position.y;
    const p0 = this.ground(ev, y) || o.g.position.clone();
    // the scenes inside it move with it
    const kids = [...descendantsOf(this.data.M.world, id)].map((k) => this.objs.get(k)).filter(Boolean)
      .map((k) => ({ o: k, start: k.g.position.clone(), floor: k.S.floor || 0 }));
    this.drag = { id, o, y, floor: o.S.floor || 0, floor0: o.S.floor || 0, wheel: 0, last: ev, kids,
      off: o.g.position.clone().sub(p0), sx: ev.clientX, sy: ev.clientY, moved: false, start: o.g.position.clone() };
    this.controls.enabled = false;
    // while the scene is held, the wheel takes it up or down a floor (and doesn't zoom)
    const wheel = (e) => {
      const d = this.drag; if (!d) return;
      e.preventDefault(); e.stopPropagation();
      d.wheel += e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
      if (Math.abs(d.wheel) < 40) return;
      const step = d.wheel < 0 ? 1 : -1;   // wheel away from you: up a floor
      d.wheel = 0;
      const floor = Math.max(-9, Math.min(30, d.floor + step));
      if (floor === d.floor) return;
      d.floor = floor; d.y = floor * FLOOR_H; d.moved = true;
      this.stage.classList.add('dragging');
      const pos = d.o.g.position;
      pos.y = d.y;
      const p = this.ground(d.last, d.y);
      if (p) { d.off.x = pos.x - p.x; d.off.z = pos.z - p.z; }   // keep the scene under the pointer on its new floor
      d.o.S.floor = floor;
      this.setPost(d.o, floor);
      this.moveKids(d);
      this.showGhost(d);
      this.data.renderLabel(d.o.S, d.o.el);
      this.refreshPairsOf(d.id);
      if (this.cb.onFloorHint) this.cb.onFloorHint(floor);
      this.dirty = true;
    };
    const move = (e) => {
      const d = this.drag; if (!d) return;
      d.last = e;
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
      if (!d.moved) { d.moved = true; this.stage.classList.add('dragging'); }
      const p = this.ground(e, d.y); if (!p) return;
      let x = p.x + d.off.x, z = p.z + d.off.z;
      // snap the block's edges (not its centre) to the grid lines; Shift places it freely
      d.free = e.shiftKey;
      if (!e.shiftKey) { x = snapAxis(x, d.o.size.w); z = snapAxis(z, d.o.size.d); }
      d.o.g.position.set(x, d.y, z);
      d.o.S.x = x; d.o.S.z = z;
      this.moveKids(d);
      this.showGhost(d);
      this.refreshPairsOf(d.id);
      this.dirty = true;
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      window.removeEventListener('wheel', wheel, true);
      const d = this.drag; this.drag = null;
      this.controls.enabled = true;
      this.stage.classList.remove('dragging');
      this.showGhost(null);
      if (!d) return;
      if (d.moved) this.cb.onMoveScene(d.id, d.o.g.position.x, d.o.g.position.z, d.floor, { free: !!d.free });
      else this.cb.onSelect({ type: 'scene', id: d.id });
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    window.addEventListener('wheel', wheel, { capture: true, passive: false });
  }

  moveKids(d) {
    const dx = d.o.g.position.x - d.start.x, dz = d.o.g.position.z - d.start.z, df = d.floor - d.floor0;
    for (const k of d.kids) {
      const f = k.floor + df;
      k.o.g.position.set(k.start.x + dx, f * FLOOR_H, k.start.z + dz);
      if ((k.o.S.floor || 0) !== f) { k.o.S.floor = f; this.setPost(k.o, f); }
      this.refreshPairsOf(k.o.S.id);
    }
  }

  // while a scene is held: its footprint on the grid of its floor, red where it would overlap another
  showGhost(d) {
    if (this.ghost) { this.fxG.remove(this.ghost); this.ghost.geometry.dispose(); this.ghost.material.dispose(); this.ghost = null; }
    this.gridG.position.y = d ? d.floor * FLOOR_H : 0;
    if (!d) { this.dirty = true; return; }
    const { w, d: dd } = d.o.size, p = d.o.g.position, y = d.floor * FLOOR_H + 0.03;
    const skip = new Set([d.id, ...d.kids.map((k) => k.o.S.id)]);
    const others = [...this.data.M.scenes.values()].filter((q) => !skip.has(q.id)).map((q) => ({ ...q, x: (this.objs.get(q.id) || { g: { position: q } }).g.position.x, z: (this.objs.get(q.id) || { g: { position: q } }).g.position.z }));
    const bad = overlapping(others, p.x, p.z, w, dd, d.floor).length > 0;
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(p.x - w / 2, y, p.z - dd / 2), new THREE.Vector3(p.x + w / 2, y, p.z - dd / 2),
      new THREE.Vector3(p.x + w / 2, y, p.z + dd / 2), new THREE.Vector3(p.x - w / 2, y, p.z + dd / 2)]);
    this.ghost = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: bad ? this.T.danger : this.T.accent, transparent: true, opacity: 0.95, depthTest: false }));
    this.ghost.renderOrder = 10;
    this.fxG.add(this.ghost);
  }

  startConnect(id, ev) {
    const o = this.objs.get(id);
    if (!o || !this.cb.canConnect()) return;
    this.controls.enabled = false;
    this.stage.classList.add('connecting');
    const from = o.g.position.clone().add(new THREE.Vector3(0, o.size.h, 0));
    const mat = new THREE.LineDashedMaterial({ color: this.T.accent, dashSize: 0.5, gapSize: 0.3 });
    const geo = new THREE.BufferGeometry().setFromPoints([from, from.clone()]);
    const line = new THREE.Line(geo, mat);
    this.fxG.add(line);
    let target = null;
    const mark = (tid) => {
      if (target === tid) return;
      if (target && this.objs.get(target)) this.objs.get(target).el.classList.remove('drop');
      target = tid && tid !== id ? tid : null;
      if (target && this.objs.get(target)) this.objs.get(target).el.classList.add('drop');
    };
    const move = (e) => {
      const tid = this.sceneUnder(e);
      mark(tid);
      let to;
      if (target) { const t = this.objs.get(target); to = t.g.position.clone().add(new THREE.Vector3(0, t.size.h, 0)); }
      else to = this.ground(e, o.g.position.y) || from;
      geo.setFromPoints([from, to]); line.computeLineDistances();
      this.dirty = true;
    };
    const up = (e) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      this.controls.enabled = true;
      this.stage.classList.remove('connecting');
      this.fxG.remove(line); geo.dispose(); mat.dispose();
      const t = target; mark(null);
      this.dirty = true;
      if (e.type === 'pointercancel') return;
      if (t) this.cb.onConnect(id, t);
      else {
        const p = this.ground(e, o.g.position.y);
        if (p && p.distanceTo(o.g.position) > 4) this.cb.onConnectNew(id, p.x, p.z);
      }
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  }

  // --- loop ---
  frame() {
    this.timer.update();
    let moving = false;
    if (this.anim) {
      const a = this.anim;
      const k = Math.min(1, (performance.now() - a.t0) / a.ms);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const t = a.fromT.clone().lerp(a.toT, e);
      const s = new THREE.Spherical(
        a.fromS.radius + (a.toS.radius - a.fromS.radius) * e,
        a.fromS.phi + (a.toS.phi - a.fromS.phi) * e,
        a.fromS.theta + (a.toS.theta - a.fromS.theta) * e);
      this.placeCamera(t, s);
      if (k >= 1) this.anim = null;
      moving = true;
    }
    if (this.token) {
      const tk = this.token;
      if (tk.pts.length > 1) {
        const per = 520;
        const k = (performance.now() - tk.t0) / per;
        const i = Math.min(tk.pts.length - 1, Math.floor(k));
        if (i >= tk.pts.length - 1) { tk.mesh.position.copy(tk.pts[tk.pts.length - 1]); tk.pts = [tk.pts[tk.pts.length - 1]]; }
        else {
          const f = k - i;
          const p = tk.pts[i].clone().lerp(tk.pts[i + 1], f);
          p.y += Math.sin(f * Math.PI) * 2.5;
          tk.mesh.position.copy(p);
        }
        moving = true;
      }
      tk.mesh.children[1].position.y = 1.6 + Math.sin(performance.now() / 380) * 0.15;
      moving = true;
    }
    const changed = this.controls.update();
    if (changed || this.dirty || moving) {
      this.renderer.render(this.scene, this.camera);
      this.css2d.render(this.scene, this.camera);
      this.declutter();
      this.dirty = false;
    }
  }

  // Labels are HTML at a fixed size: where they would overlap, the more important one (selected,
  // the start, outdoor scenes, scenes with many ways) keeps its full card, the next shows only its
  // name, the rest shrink to a dot that opens on hover.
  declutter() {
    const W = this.size.w, H = this.size.h, v = new THREE.Vector3();
    const items = [];
    for (const o of this.objs.values()) {
      const el = o.el;
      if (!el.isConnected) continue;
      if (!o.sz) {
        el.classList.remove('compact', 'mini');
        const full = [el.offsetWidth, el.offsetHeight];
        el.classList.add('compact');
        const comp = [el.offsetWidth, el.offsetHeight];
        el.classList.remove('compact');
        if (o.lod) el.classList.add(o.lod);
        if (!full[0]) continue;
        o.sz = { full, comp };
      }
      o.lab.getWorldPosition(v).project(this.camera);
      if (v.z > 1 || v.z < -1) continue;
      items.push({ o, x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H });
    }
    items.sort((a, b) => b.o.prio - a.o.prio);
    const placed = [];
    const free = (r) => !placed.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1]);
    for (const it of items) {
      let lod = 'mini';
      for (const [name, [w, h]] of [['', it.o.sz.full], ['compact', it.o.sz.comp]]) {
        const r = [it.x - w / 2 - 3, it.y - h - 3, it.x + w / 2 + 3, it.y + 3];
        if (free(r) || (name === 'compact' && it.o.prio >= 1000)) { placed.push(r); lod = name; break; }
      }
      if (lod === 'mini') placed.push([it.x - 7, it.y - 14, it.x + 7, it.y]);
      if (it.o.lod !== lod) {
        it.o.el.classList.toggle('compact', lod === 'compact');
        it.o.el.classList.toggle('mini', lod === 'mini');
        it.o.lod = lod;
      }
    }
  }

  screenshot() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}
