// Plastico's page: worlds list, the 3D model, the inspector, and the dialogs (Godot build, settings).
import { View3D } from './view3d.js';
import * as model from './model.js';

const { KINDS, STATE_LABEL, firstName } = model;
const $ = (s) => document.querySelector(s);
// Inside Cassetto (the suite), the project's world and its puzzle charts come through the shell.
const CS = window.cassetto && window.cassetto.embedded ? window.cassetto : null;
if (CS) document.documentElement.classList.add('in-cassetto');
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function btn(label, cls, onClick, title) { const b = el('button', cls || 'btn', label); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); if (title) b.title = title; return b; }
function svgIcon(d, opts = '') { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 16 16'); s.innerHTML = `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${opts}/>`; return s; }
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* storage off */ } }

const ICON = {
  two: 'M2 8h12M5 5 2 8l3 3M11 5l3 3-3 3',
  to: 'M2 8h11M10 5l3 3-3 3',
  from: 'M14 8H3M6 5 3 8l3 3',
  lock: 'M4.5 7.5h7v5.5h-7zM6 7.5V6a2 2 0 0 1 4 0v1.5',
  warn: 'M8 2.5 14 13H2zM8 6.5v3M8 11.3v.1',
  err: 'M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4',
  info: 'M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM8 7.2v4M8 4.9v.1',
  person: 'M8 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 14c.5-3 2.5-4.5 5-4.5s4.5 1.5 5 4.5',
  step: 'M8 1.5 14.5 8 8 14.5 1.5 8z',
  close: 'M4 4l8 8M12 4l-8 8',
  nowhere: 'M3 8h6M11 8h.5M13.5 8h.5',
};
const STEP_GLYPH = {
  setup: 'M1 2h10v8H1zm1.4 1.4v5.2h7.2V3.4z', subgoal: 'M6 1a5 5 0 1 0 0 10A5 5 0 0 0 6 1zm0 1.6a3.4 3.4 0 1 1 0 6.8 3.4 3.4 0 0 1 0-6.8z',
  goal: 'M2.5 1h1.3v.6h6.9L8.8 4.4l1.9 2.8H3.8V11.5H2.5z', action: 'M3 1.8 10.4 6 3 10.2z', item: 'M6 .9 11.1 6 6 11.1.9 6z',
  combo: 'M4.9 1h2.2v3.9H11v2.2H7.1V11H4.9V7.1H1V4.9h3.9z', phase: 'M6 .9a5.1 5.1 0 1 0 0 10.2A5.1 5.1 0 0 0 6 .9zm0 1.5v7.2a3.6 3.6 0 0 1 0-7.2z',
};
function stepGlyph(kind) { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 12 12'); s.setAttribute('class', 'g'); s.innerHTML = `<path d="${STEP_GLYPH[kind] || STEP_GLYPH.action}" fill="currentColor" fill-rule="evenodd"/>`; return s; }

/* ------------------------------------------------------------------ state */
const S = {
  worlds: [], wid: null, bundle: null, world: null, M: null, rev: 0,
  sel: null, ui: { mode: 'skeleton', phase: '', act: 'all', area: '', top: false, people: true, steps: true, names: true },
  route: null, play: null,
  undo: [], redo: [], lastEdit: null,
  saveTimer: 0, saving: false, saveAgain: false, dirty: false,
  pictureVersion: 0,
};

/* ------------------------------------------------------------------ api */
async function api(method, path, body, raw) {
  const opt = { method, headers: { 'X-Plastico': '1' } };
  if (raw) { opt.body = raw; opt.headers['Content-Type'] = 'application/octet-stream'; }
  else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(path, opt);
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  if (!r.ok) { const e = new Error((data && data.error) || `HTTP ${r.status}`); e.status = r.status; e.body = data; throw e; }
  return data;
}

let toastTimer = 0;
function toast(msg, action) {
  const t = $('#toast'); t.textContent = msg;
  if (action) { const b = btn(action.label, '', () => { t.hidden = true; action.run(); }); t.append(b); }
  t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, action ? 7000 : 3800);
}
function setStatus(s, text) {
  const st = $('#status');
  st.dataset.s = s === 'saved' ? 'ok' : s === 'err' ? 'err' : 'busy';
  $('#status-text').textContent = text || { saved: 'Saved', busy: 'Saving', dirty: 'Saving', err: 'Not saved', loading: 'Loading' }[s] || s;
  st.title = s === 'err' ? 'Couldn’t save: is Plastico still running? It will try again.' : '';
  if (CS) CS.status(s === 'saved' ? 'saved' : s === 'err' ? 'err' : 'busy', $('#status-text').textContent);
}

/* ------------------------------------------------------------------ view */
let view;
try {
  view = new View3D($('#stage'), $('#labels'), {
    onSelect: (sel) => pick(sel),
    onEmptyClick: () => { if (S.route || S.play) return; select(null); },
    onAddAt: (x, z) => { if (S.route || S.play) return; openAddScene({ x, z }); },
    onMoveScene: (id, x, z, floor, o) => moveScene(id, x, z, floor, o),
    onFloorHint: (f) => toast(f === 0 ? 'Street level' : f > 0 ? `Floor ${f}` : `${-f} below the street`),
    onConnect: (a, b) => connect(a, b),
    onConnectNew: (a, x, z) => connectNew(a, x, z),
    onOpen: (id) => view.focus(id),
    canDrag: () => !S.route && !S.play,
    canConnect: () => !S.route && !S.play,
  });
} catch (e) {
  // no WebGL here (no usable graphics driver, or it is switched off): say so instead of hanging on "Loading"
  const msg = 'Plastico can’t draw its 3D view in this window: WebGL isn’t available (' + e.message + '). Check the graphics driver. If only Cassetto’s own window has the problem, start it in Chrome instead: cassetto --window chrome (or set CASSETTO_WINDOW=chrome).';
  $('#loading').textContent = msg;
  if (CS) CS.error(msg);
  throw e;
}

const round = (v) => Math.round(v * 100) / 100;

function derive() {
  S.M = model.derive(S.world, S.bundle && S.bundle.game, S.bundle && S.bundle.charts, (S.bundle && S.bundle.uploads) || []);
  if (S.sel && S.sel.type === 'scene' && !S.M.scenes.has(S.sel.id)) S.sel = null;
  if (S.sel && S.sel.type === 'pair' && !S.M.pairs.has(S.sel.key)) S.sel = null;
  if (!S.M.phases.includes(S.ui.phase)) S.ui.phase = S.M.phases.includes('midnight') ? 'midnight' : (S.M.phases[0] || '');
}

function visibleIds() {
  const out = new Set();
  for (const s of S.M.scenes.values()) if (S.ui.act === 'all' || s.act === S.ui.act) out.add(s.id);
  return out;
}

function actStarts() {
  const m = new Map();
  for (const a of S.world.acts) if (a.start) m.set(a.start, a.id);
  if (S.M.start && !m.has(S.M.start)) m.set(S.M.start, (S.M.scenes.get(S.M.start) || {}).act || '1');
  return m;
}

function pictureUrl(s) {
  if (!s.hasPicture) return null;
  const v = (S.bundle.game ? S.bundle.game.scanned_at : 0) + S.pictureVersion;
  return `/api/worlds/${S.wid}/pictures/${encodeURIComponent(s.id)}/${S.ui.phase || 'midnight'}.jpg?w=1024&v=${v}`;
}

function renderLabel(s, elx) {
  elx.textContent = '';
  const starts = actStarts();
  if (starts.has(s.id)) elx.append(el('span', 'start-tag', S.world.acts.length > 1 ? `Start · act ${starts.get(s.id)}` : 'Start'));
  const card = el('div', 'lab-card');
  if (s.state !== 'game') card.append(el('span', 'lab-chip' + (s.state === 'delete' ? ' delete' : ''), STATE_LABEL[s.state]));
  else if (S.ui.phase && !model.sceneOpenAt(s, S.ui.phase)) card.append(el('span', 'lab-chip closed', `Closed at ${S.ui.phase}`));
  card.append(el('div', 'lab-name', s.name || s.id));
  const meta = el('div', 'lab-meta');
  const steps = (S.M.steps.get(s.id) || []).filter(({ node }) => node.kind !== 'goal' && node.kind !== 'setup');
  if (S.ui.steps && steps.length) { const sp = el('span'); sp.append(svgIcon(ICON.step), document.createTextNode(`${steps.length} step${steps.length > 1 ? 's' : ''}`)); meta.append(sp); }
  if (s.floor) meta.append(el('span', '', s.floor > 0 ? `floor ${s.floor}` : `${-s.floor} below`));
  if (s.parent) { const P = S.M.scenes.get(s.parent); if (P) meta.append(el('span', 'in', `in ${P.name || P.id}`)); }
  if ((s.charts || []).length) meta.append(el('span', '', `${s.charts.length} chart${s.charts.length > 1 ? 's' : ''}`));
  if (meta.childNodes.length) card.append(meta);
  if (S.ui.people && S.M.phases.length) {
    const ppl = model.peopleAt(S.M, s, S.ui.phase);
    if (ppl.length) {
      const names = ppl.map((p) => p.name);
      card.append(el('div', 'lab-people', names.length > 4 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ')));
    }
  }
  const port = el('div', 'port'); port.title = 'Drag onto another scene to join them, or onto the ground for a new scene';
  card.append(port);
  elx.append(card);
}
function labelClasses(s) {
  const c = [];
  if (actStarts().has(s.id)) c.push('start');
  if (S.route || S.play) c.push('nolink');
  return c;
}

function computeHl() {
  const hl = { scene: new Map(), pair: new Map() };
  const M = S.M;
  if (S.play) {
    const reach = model.bfs(model.adjacency(M, { phase: S.ui.phase || null, keys: S.play.keys, builtOnly: S.play.builtOnly }), S.play.at);
    for (const s of M.scenes.values()) hl.scene.set(s.id, s.id === S.play.at ? 'here' : reach.dist.has(s.id) ? 'avail' : 'dim');
    for (const P of M.pairs.values()) {
      const usable = P.links.some((l) => reach.dist.has(l.from) && model.linkOpenAt(l, S.ui.phase || null) && (!l.lock || S.play.keys.has(l.lock.needs)) && l.state !== 'delete' && (!S.play.builtOnly || l.state === 'game'));
      const blocked = P.links.some((l) => l.lock && !S.play.keys.has(l.lock.needs) && reach.dist.has(l.from));
      hl.pair.set(P.key, blocked ? 'blocked' : usable ? '' : 'dim');
    }
    return hl;
  }
  if (S.route && S.route.path) {
    const on = new Set(S.route.path.scenes);
    const pk = new Set(S.route.path.links.map((l) => model.pairKey(l.from, l.to)));
    for (const s of M.scenes.values()) hl.scene.set(s.id, on.has(s.id) ? 'route' : 'dim');
    for (const P of M.pairs.values()) hl.pair.set(P.key, pk.has(P.key) ? 'route' : 'dim');
    return hl;
  }
  if (S.route) { if (S.route.from) hl.scene.set(S.route.from, 'route'); return hl; }
  if (S.sel && S.sel.type === 'scene') {
    const id = S.sel.id; const near = new Set([id]);
    for (const P of M.pairs.values()) { if (P.a === id) near.add(P.b); if (P.b === id) near.add(P.a); }
    for (const s of M.scenes.values()) hl.scene.set(s.id, s.id === id ? 'sel' : near.has(s.id) ? '' : 'dim');
    for (const P of M.pairs.values()) hl.pair.set(P.key, P.a === id || P.b === id ? '' : 'dim');
  } else if (S.sel && S.sel.type === 'pair') {
    const P = M.pairs.get(S.sel.key);
    for (const s of M.scenes.values()) hl.scene.set(s.id, s.id === P.a || s.id === P.b ? 'sel' : 'dim');
    for (const Q of M.pairs.values()) hl.pair.set(Q.key, Q.key === P.key ? 'sel' : 'dim');
  } else if (S.ui.area) {
    for (const s of M.scenes.values()) hl.scene.set(s.id, s.area === S.ui.area ? '' : 'dim');
    for (const P of M.pairs.values()) { const a = M.scenes.get(P.a), b = M.scenes.get(P.b); hl.pair.set(P.key, a.area === S.ui.area || b.area === S.ui.area ? '' : 'dim'); }
  }
  return hl;
}

function renderView() {
  if (!S.M) return;
  view.set({ M: S.M, ui: S.ui, visible: visibleIds(), hl: computeHl(), pictureUrl, renderLabel, labelClasses });
  updateEmpty();
}
function refreshHighlight() { if (!view.data) return; view.data.hl = computeHl(); view.applyHighlight(); }

/* ------------------------------------------------------------------ editing */
function edit(fn, opts = {}) {
  const { coalesce = null, insp = true, view: rebuild = true } = opts;
  const now = Date.now();
  if (!(coalesce && S.lastEdit && S.lastEdit.key === coalesce && now - S.lastEdit.t < 1500)) {
    S.undo.push(JSON.stringify(S.world)); if (S.undo.length > 150) S.undo.shift(); S.redo = [];
  }
  S.lastEdit = coalesce ? { key: coalesce, t: now } : null;
  fn(S.world);
  derive();
  if (rebuild) renderView(); else refreshHighlight();
  renderSide(); renderHeader();
  if (insp) renderInspector();
  scheduleSave();
}
function undo() {
  if (!S.undo.length) return;
  S.redo.push(JSON.stringify(S.world)); S.world = JSON.parse(S.undo.pop()); S.world.rev = S.rev; S.lastEdit = null;
  derive(); renderAll(); scheduleSave();
}
function redo() {
  if (!S.redo.length) return;
  S.undo.push(JSON.stringify(S.world)); S.world = JSON.parse(S.redo.pop()); S.world.rev = S.rev; S.lastEdit = null;
  derive(); renderAll(); scheduleSave();
}
function scheduleSave() { S.dirty = true; setStatus('dirty'); clearTimeout(S.saveTimer); S.saveTimer = setTimeout(save, 450); }
async function save() {
  if (!S.wid) return;
  if (S.saving) { S.saveAgain = true; return; }
  S.saving = true; S.dirty = false; setStatus('busy');
  const wid = S.wid;
  try {
    const r = await api('PUT', `/api/worlds/${wid}`, { world: S.world, rev: S.rev });
    if (wid === S.wid) { S.rev = r.rev; S.world.rev = r.rev; }
    if (!S.dirty) setStatus('saved');
  } catch (e) {
    if (e.status === 409 && e.body && e.body.world) {
      toast('This world was changed somewhere else (Claude, or another window): it has been reloaded.');
      await loadWorld(wid, { keepView: true });
    } else { setStatus('err'); S.dirty = true; clearTimeout(S.saveTimer); S.saveTimer = setTimeout(save, 4000); }
  } finally {
    S.saving = false;
    if (S.saveAgain) { S.saveAgain = false; save(); }
  }
}
async function flushSave() {
  clearTimeout(S.saveTimer);
  if (S.dirty || S.saving) { await save(); while (S.saving) await new Promise((r) => setTimeout(r, 60)); }
}

function newSceneId(name, w = S.world) {
  const base = (name || 'place').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'place';
  const ids = new Set(w.scenes.map((s) => s.id));
  let id = base, k = 2;
  while (ids.has(id)) id = `${base}_${k++}`;
  return id;
}
// A new scene goes in an act, or inside another scene (its parent): then it sits just below its parent on
// the map, in the parent's act. Its block starts at the size of an inside scene; Kind and Size are in its panel.
function addScene(opts = {}) {
  const name = (opts.name || '').trim() || 'New place';
  const parent = opts.parent ? S.world.scenes.find((q) => q.id === opts.parent) : null;
  const kind = opts.kind || 'inside';
  const { w: cw, d: cd } = model.sizeOf({ kind });
  let id = '';
  edit((w) => {
    id = newSceneId(name, w);
    const act = parent ? (model.ancestorsOf(w, parent.id).pop() || parent).act : opts.act && w.acts.some((a) => a.id === opts.act) ? opts.act : w.acts[0].id;
    let x, z, floor;
    if (parent) { ({ x, z } = model.childSpot(w, parent, cw, cd)); floor = parent.floor || 0; }
    else {
      floor = opts.floor ?? 0;
      const t = opts.x != null ? { x: opts.x, z: opts.z } : view.controls.target;
      ({ x, z } = model.freeSpot(w.scenes, t.x, t.z, cw, cd, floor));
    }
    w.scenes.push({ id, name, kind, act, area: parent ? parent.area : '', x, z, w: cw, d: cd, floor,
      status: 'idea', open: [], people: {}, notes: '', delete: false, autoId: true, parent: parent ? parent.id : '', charts: [] });
    const A = w.acts.find((a) => a.id === act);
    if (A && !A.start && !w.godot && !w.scenes.some((q) => q.id !== id && q.act === act)) A.start = id;
    if (opts.from) addLinkPair(w, opts.from, id);
  });
  select({ type: 'scene', id }, { focusName: true });
  if (parent) view.focus(parent.id);
  return id;
}
function sceneLabel(q) { return q.name || q.id; }
function containerText(act, parentId) {
  const w = S.world;
  if (parentId) {
    const P = w.scenes.find((q) => q.id === parentId); if (!P) return '';
    const chain = [P, ...model.ancestorsOf(w, P.id)].reverse();
    const A = w.acts.find((a) => a.id === chain[0].act);
    return [`Act ${A ? A.id : '?'}${A && A.name ? ' · ' + A.name : ''}`, ...chain.map(sceneLabel)].join(' › ');
  }
  const A = w.acts.find((a) => a.id === act);
  return A ? `Act ${A.id}${A.name ? ' · ' + A.name : ''}` : '';
}
// The Add scene dialog: a name, and where the scene goes, shown in full before it is made.
function openAddScene(at = {}) {
  if (!S.world || S.route || S.play) return;
  const w = S.world;
  const selScene = S.sel && S.sel.type === 'scene' ? w.scenes.find((q) => q.id === S.sel.id) : null;
  openModal((box) => {
    modalHead(box, 'Add a scene', S.ui.act !== 'all' && w.acts.some((a) => a.id === S.ui.act) ? `In ${containerText(S.ui.act, '')}: straight in the act, or inside one of its scenes.` : 'Choose where it goes: in an act, or inside a scene that is already there.');
    const body = el('div', 'modal-body'); box.append(body);
    const name = el('input'); name.id = 'f-new-name'; name.placeholder = 'New place'; body.append(field('Name', name));
    const where = el('div', 'choices');
    const choice = (value, label, control) => {
      const l = el('label', 'choice'); const r = el('input'); r.type = 'radio'; r.name = 'where'; r.value = value;
      const d = el('div'); d.append(el('b', '', label), control); l.append(r, d); where.append(l); return r;
    };
    const actSel = el('select'); actSel.id = 'f-new-act';
    for (const a of w.acts) { const o = el('option', '', `Act ${a.id}${a.name ? ' · ' + a.name : ''}`); o.value = a.id; actSel.append(o); }
    // a scene inside another is in its outermost parent's act
    const actOf = (q) => (model.ancestorsOf(w, q.id).pop() || q).act;
    // the act you are in: the one on screen, else the selected scene's, else the first
    const shown = S.ui.act !== 'all' && w.acts.some((a) => a.id === S.ui.act) ? S.ui.act : '';
    actSel.value = shown || (selScene ? actOf(selScene) : w.acts[0].id);
    const parSel = el('select'); parSel.id = 'f-new-parent';
    // with one act on screen the scene goes in that act: no need to ask again
    const rAct = shown ? choice('act', `Straight in ${containerText(shown, '')}`, actSel) : choice('act', 'In an act', actSel);
    if (shown) actSel.hidden = true;
    const rPar = choice('parent', 'Inside a scene', parSel);
    // "Inside a scene" lists only the scenes of that act, and follows the act chosen above
    const fillParents = () => {
      const live = w.scenes.filter((q) => !q.delete && actOf(q) === actSel.value)
        .sort((a, b) => sceneLabel(a).localeCompare(sceneLabel(b)));
      parSel.textContent = '';
      for (const q of live) { const o = el('option', '', `${sceneLabel(q)}  (${containerText(q.act, q.parent) || 'act ' + q.act})`); o.value = q.id; parSel.append(o); }
      if (selScene && live.includes(selScene)) parSel.value = selScene.id;
      rPar.disabled = parSel.disabled = !live.length;
      if (!live.length) { parSel.append(el('option', '', 'No scenes in this act yet')); parSel.value = ''; if (rPar.checked) rAct.checked = true; }
    };
    fillParents();
    actSel.addEventListener('change', fillParents);
    rAct.checked = true;
    body.append(field('Where it goes', where));
    const preview = el('div', 'alert info'); preview.id = 'f-new-where'; body.append(preview);
    const draw = () => {
      const inside = rPar.checked;
      preview.textContent = '';
      preview.append(el('b', '', 'It goes in: '), document.createTextNode(`${inside ? containerText(null, parSel.value) : containerText(actSel.value, '')} › ${name.value.trim() || 'New place'}`));
      if (inside) preview.append(el('div', 'note', 'On the map it sits just below that scene, and moves with it.'));
    };
    for (const e of [actSel, parSel]) e.addEventListener('change', () => { (e === actSel ? rAct : rPar).checked = true; draw(); });
    for (const r of [rAct, rPar]) r.addEventListener('change', draw);
    name.addEventListener('input', draw);
    draw();
    const foot = el('div', 'modal-foot'); const r = el('div', 'r');
    const go = btn('Add scene', 'btn primary', () => {
      closeModal();
      addScene(rPar.checked ? { name: name.value, parent: parSel.value } : { name: name.value, act: actSel.value, x: at.x, z: at.z, floor: at.floor });
    }); go.id = 'f-new-go';
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
    r.append(btn('Cancel', 'btn', closeModal), go); foot.append(el('div', 'l'), r); box.append(foot);
    setTimeout(() => name.focus(), 0);
  }, true);
}
// A scene moved by hand: what is inside it moves along, and where the group would land on another block
// it slides to the nearest free place on the grid (unless placed freely with Shift).
function moveScene(id, x, z, floor, o = {}) {
  const old = S.world.scenes.find((q) => q.id === id); if (!old) return;
  const group = [old, ...[...model.descendantsOf(S.world, id)].map((k) => S.world.scenes.find((q) => q.id === k))].filter(Boolean);
  const df = (floor ?? old.floor ?? 0) - (old.floor || 0);
  let dx = x - old.x, dz = z - old.z;
  if (!o.free) {
    const f = model.freeShift(S.world.scenes, group, dx, dz, df);
    if (f.dx !== dx || f.dz !== dz) toast('It would have overlapped another scene: moved to the nearest free place.');
    dx = f.dx; dz = f.dz;
  }
  edit((w) => {
    for (const g of group) { const s = w.scenes.find((q) => q.id === g.id); s.x = round(s.x + dx); s.z = round(s.z + dz); s.floor = (s.floor || 0) + df; }
  }, { insp: df !== 0 });
}
function addLinkPair(w, a, b) {
  for (const [f, t] of [[a, b], [b, a]]) {
    const l = w.links.find((q) => q.from === f && q.to === t);
    if (l) { l.delete = false; continue; }
    w.links.push({ id: `l_${f}_${t}_${Math.random().toString(36).slice(2, 6)}`, from: f, to: t, status: 'idea', lock: null, open: [], via: '', notes: '', delete: false });
  }
}
function connect(a, b) {
  if (a === b) return;
  const had = S.M.pairs.get(model.pairKey(a, b));
  if (had && had.ab && had.ba && had.links.every((l) => !l.delete)) { select({ type: 'pair', key: had.key }); toast('They are already joined both ways.'); return; }
  edit((w) => addLinkPair(w, a, b));
  select({ type: 'pair', key: model.pairKey(a, b) });
}
function connectNew(a, x, z) {
  // dropped on empty ground: a new scene there, joined to this one, in the same container
  const src = S.world.scenes.find((q) => q.id === a);
  addScene({ act: src.act, x, z, floor: src.floor, from: a });
  if (src.parent) edit((w) => { const n = w.scenes[w.scenes.length - 1]; n.parent = src.parent; });
}
function deleteScene(id) {
  const s = S.M.scenes.get(id);
  if (!s) return;
  if (s.inGame) {
    if (S.M.start === id) { toast('That’s where the game starts: make another scene the start first.'); return; }
    edit((w) => { w.scenes.find((q) => q.id === id).delete = true; });
    toast(`${s.name} is marked to delete. Nothing changes in the game until you build it from the Godot button.`);
  } else {
    edit((w) => {
      const gone = w.scenes.find((q) => q.id === id);
      for (const c of w.scenes) if (c.parent === id) c.parent = gone.parent || '';   // the scenes inside it stay, one level up
      w.scenes = w.scenes.filter((q) => q.id !== id);
      w.links = w.links.filter((l) => l.from !== id && l.to !== id);
      for (const a of w.acts) if (a.start === id) a.start = '';
    });
    select(null);
  }
}
function keepScene(id) { edit((w) => { w.scenes.find((q) => q.id === id).delete = false; for (const l of w.links) if (l.from === id || l.to === id) l.delete = false; }); }
function deletePair(key) {
  const P = S.M.pairs.get(key);
  if (!P) return;
  edit((w) => {
    for (const L of P.links) {
      if (L.inGame) w.links.find((q) => q.id === L.id).delete = true;
      else w.links = w.links.filter((q) => q.id !== L.id);
    }
  });
  if (!S.M.pairs.has(key)) select(null);
}
function setDirections(P, dir) {
  edit((w) => {
    const want = { both: [[P.a, P.b], [P.b, P.a]], ab: [[P.a, P.b]], ba: [[P.b, P.a]] }[dir];
    for (const [f, t] of [[P.a, P.b], [P.b, P.a]]) {
      const keep = want.some(([x, y]) => x === f && y === t);
      const l = w.links.find((q) => q.from === f && q.to === t);
      const inGame = S.M.links.get(l && l.id) && S.M.links.get(l.id).inGame;
      if (keep) { if (l) l.delete = false; else w.links.push({ id: `l_${f}_${t}_${Math.random().toString(36).slice(2, 6)}`, from: f, to: t, status: 'idea', lock: null, open: [], via: '', notes: '', delete: false }); }
      else if (l) { if (inGame) l.delete = true; else w.links = w.links.filter((q) => q !== l); }
    }
  });
}

/* ------------------------------------------------------------------ selection and modes */
function pick(sel) {
  if (sel && sel.type === 'scene' && S.route) return routePick(sel.id);
  if (sel && sel.type === 'scene' && S.play) return playMove(sel.id);
  if (S.route || S.play) return;
  select(sel);
}
function select(sel, opts = {}) {
  S.sel = sel;
  if (CS && CS.selected) CS.selected(sel && sel.type === 'scene' ? { module: 'plastico', scene: sel.id } : null);
  refreshHighlight();
  renderInspector();
  if (opts.focusName) { const i = $('#f-name'); if (i) { i.focus(); i.select(); } }
  if (window.matchMedia('(max-width: 719px)').matches) $('#insp').hidden = !sel;
}

function startRoute() {
  if (S.play) stopPlay();
  S.route = { from: S.sel && S.sel.type === 'scene' ? S.sel.id : null, to: null, path: null, locks: false, time: false };
  S.sel = null;
  renderView(); renderBanner(); renderHeader(); renderInspector();
}
function routePick(id) {
  const R = S.route;
  if (!R.from || (R.from && R.to)) { R.from = id; R.to = null; R.path = null; }
  else { R.to = id; computeRoute(); }
  refreshHighlight(); renderBanner();
}
function computeRoute() {
  const R = S.route;
  if (!R.from || !R.to) return;
  R.path = model.route(S.M, R.from, R.to, { phase: R.time ? S.ui.phase || null : null, keys: R.locks ? new Set() : null });
  R.none = !R.path;
}
function stopRoute() { S.route = null; renderView(); renderBanner(); renderHeader(); }

function startPlay() {
  if (S.route) stopRoute();
  const actStart = S.ui.act !== 'all' ? (S.world.acts.find((a) => a.id === S.ui.act) || {}).start : '';
  const at = (S.sel && S.sel.type === 'scene' && S.sel.id) || actStart || S.M.start || [...S.M.scenes.keys()][0];
  if (!at) { toast('Add a scene first.'); return; }
  S.play = { at, keys: new Set(), builtOnly: false, steps: 0, startAt: at };
  S.sel = null;
  renderView(); renderBanner(); renderHeader(); renderInspector();
  view.setToken(at);
}
function playMove(id) {
  const P = S.play;
  if (id === P.at) return;
  const path = model.route(S.M, P.at, id, { phase: S.ui.phase || null, keys: P.keys, builtOnly: P.builtOnly });
  if (!path) { toast(`Can’t get to ${S.M.scenes.get(id).name} from here yet.`); return; }
  P.steps += path.links.length; P.at = id;
  view.setToken(id, path.scenes);
  refreshHighlight(); renderBanner();
}
function stopPlay() { S.play = null; view.setToken(null); renderView(); renderBanner(); renderHeader(); }

function renderBanner() {
  const b = $('#banner'); b.textContent = ''; b.className = 'stage-ui banner';
  if (S.route) {
    const R = S.route;
    const nm = (id) => (S.M.scenes.get(id) || {}).name || id;
    if (!R.from) b.append(el('b', '', 'Route:'), el('span', 'msg', 'click the scene to start from'));
    else if (!R.to) b.append(el('b', '', `From ${nm(R.from)}`), el('span', 'msg', 'now click where to go'));
    else if (R.path) {
      b.classList.add('good');
      const n = R.path.links.length;
      b.append(el('b', '', `${nm(R.from)} → ${nm(R.to)}: ${n} scene change${n === 1 ? '' : 's'}`), el('span', 'msg', R.path.scenes.map(nm).join(' → ')));
    } else b.append(el('b', '', `No way from ${nm(R.from)} to ${nm(R.to)}`), el('span', 'msg', R.locks ? 'with every lock closed' : ''));
    const lk = el('label'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = R.locks;
    cb.addEventListener('change', () => { R.locks = cb.checked; computeRoute(); refreshHighlight(); renderBanner(); });
    lk.append(cb, document.createTextNode('Locks closed'));
    b.append(lk);
    if (S.M.phases.length) {
      const tk = el('label'); const c2 = el('input'); c2.type = 'checkbox'; c2.checked = R.time;
      c2.addEventListener('change', () => { R.time = c2.checked; computeRoute(); refreshHighlight(); renderBanner(); });
      tk.append(c2, document.createTextNode(`Only what’s open at ${S.ui.phase}`));
      b.append(tk);
    }
    b.append(btn('Done', 'btn small', stopRoute));
    b.hidden = false; return;
  }
  if (S.play) {
    const P = S.play;
    const here = S.M.scenes.get(P.at);
    b.append(el('b', '', `In ${here ? here.name : '?'}`), el('span', 'msg', `${P.steps} scene change${P.steps === 1 ? '' : 's'} so far${S.M.phases.length ? ` · ${S.ui.phase}` : ''}. Click a lit scene to walk there.`));
    const keys = model.lockKeys(S.M);
    if (keys.length) {
      const k = el('div', 'keys');
      for (const K of keys) {
        const kb = btn('', '', () => { if (P.keys.has(K.needs)) P.keys.delete(K.needs); else P.keys.add(K.needs); refreshHighlight(); renderBanner(); }, `${K.type === 'flag' ? 'Flag' : 'Item'}${K.where ? `, got in ${(S.M.scenes.get(K.where) || {}).name}` : ''}: toggle to say the player has it`);
        kb.setAttribute('aria-pressed', P.keys.has(K.needs));
        kb.append(svgIcon(ICON.lock), document.createTextNode(K.needs));
        k.append(kb);
      }
      b.append(k);
    }
    const lk = el('label'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = P.builtOnly;
    cb.addEventListener('change', () => { P.builtOnly = cb.checked; refreshHighlight(); });
    lk.append(cb, document.createTextNode('Only what’s in the game'));
    b.append(lk, btn('Restart', 'btn small', () => { P.at = P.startAt; P.steps = 0; P.keys.clear(); view.setToken(P.at); refreshHighlight(); renderBanner(); }), btn('Stop', 'btn small', stopPlay));
    b.hidden = false; return;
  }
  b.hidden = true;
}

/* ------------------------------------------------------------------ header and side */
function pendingCount() {
  const M = S.M; if (!M || !S.bundle || !S.bundle.game) return 0;
  let n = 0;
  for (const s of M.scenes.values()) if ((s.delete && s.inGame) || (!s.delete && !s.inGame)) n++;
  for (const l of M.links.values()) if ((l.delete && l.inGame) || (!l.delete && !l.inGame && l.state !== 'delete')) n++;
  return n;
}
function renderHeader() {
  $('#cur-name').textContent = S.world ? S.world.name : '';
  $('#btn-undo').disabled = !S.undo.length; $('#btn-redo').disabled = !S.redo.length;
  $('#btn-route').setAttribute('aria-pressed', !!S.route); $('#btn-play').setAttribute('aria-pressed', !!S.play);
  const n = pendingCount(); const c = $('#godot-count'); c.hidden = !n; c.textContent = n;
  $('#btn-godot').disabled = !S.world;
  $('#btn-godot').title = S.world && S.world.godot ? `${n ? `${n} difference${n > 1 ? 's' : ''} between the plan and the game. ` : 'The plan and the game match. '}Open to build them in Godot.` : 'Link this world to a Godot project (World settings) to build it there.';
  for (const id of ['btn-add', 'btn-route', 'btn-play']) $(`#${id}`).disabled = !S.world;
  document.title = S.world ? `${S.world.name} · Plastico` : 'Plastico';
}
function renderSide() {
  const wl = $('#world-list'); wl.textContent = '';
  if (!S.worlds.length) wl.append(el('p', 'none', 'No worlds yet.'));
  for (const w of S.worlds) {
    const b = el('button', 'list-item' + (w.id === S.wid ? ' on' : '')); b.type = 'button';
    const cnt = w.id === S.wid && S.world ? S.world.scenes.length : w.scenes;
    b.append(el('span', 'li-name', w.id === S.wid && S.world ? S.world.name : w.name), el('span', 'li-meta', `${cnt} scene${cnt === 1 ? '' : 's'}${w.godot ? ' · Godot' : ''}`));
    b.addEventListener('click', () => { if (w.id !== S.wid) loadWorld(w.id); closeDrawer(); });
    wl.append(b);
  }
  const acts = $('#acts'); acts.textContent = '';
  $('#sec-acts').hidden = !S.world;
  $('#sec-areas').hidden = !S.world;
  if (!S.world) return;
  const all = el('button', 'filter' + (S.ui.act === 'all' ? ' on' : '')); all.type = 'button';
  all.append(el('span'), el('span', 'nm', 'Every act'), el('span', 'n', String(S.world.scenes.length)));
  all.addEventListener('click', () => { showAct('all'); renderSide(); renderView(); view.fit(); if (!S.sel) renderInspector(); });
  acts.append(all);
  for (const a of S.world.acts) {
    const n = S.world.scenes.filter((s) => s.act === a.id).length;
    const b = el('button', 'filter' + (S.ui.act === a.id ? ' on' : '')); b.type = 'button';
    const nmx = el('span', 'nm'); nmx.append(document.createTextNode(`Act ${a.id}`)); if (a.name) nmx.append(el('span', 'sub', a.name));
    b.append(el('span'), nmx, el('span', 'n', String(n)));
    b.addEventListener('click', () => { showAct(a.id); renderSide(); renderView(); view.fit(); if (!S.sel) renderInspector(); });
    acts.append(b);
  }
  const ar = $('#areas'); ar.textContent = '';
  if (!S.world.areas.length) ar.append(el('p', 'none', 'Group scenes into areas (a district, a building) to colour them.'));
  for (const a of S.world.areas) {
    const n = S.world.scenes.filter((s) => s.area === a.id).length;
    const b = el('button', 'filter' + (S.ui.area === a.id ? ' on' : '')); b.type = 'button';
    const sw = el('span', 'sw'); sw.style.background = `var(--a${(a.color ?? 0) % 8})`;
    b.append(sw, el('span', 'nm', a.name || 'Unnamed area'), el('span', 'n', String(n)));
    b.title = 'Click to pick out its scenes';
    b.addEventListener('click', () => { S.ui.area = S.ui.area === a.id ? '' : a.id; S.sel = null; renderSide(); refreshHighlight(); renderInspector(); });
    ar.append(b);
  }
}
function renderKey() {
  const k = $('#key'); k.textContent = '';
  const row = (svg, b, t) => { const li = el('li'); li.innerHTML = svg; const d = el('div'); d.append(el('b', '', b), document.createTextNode(' ' + t)); li.append(d); k.append(li); };
  row('<svg viewBox="0 0 26 14"><rect x="3" y="2" width="20" height="10" rx="1" fill="none" stroke="var(--ink)" stroke-width="1.5"/></svg>', 'In the game', 'solid outline');
  row('<svg viewBox="0 0 26 14"><rect x="3" y="2" width="20" height="10" rx="1" fill="none" stroke="var(--ink-2)" stroke-width="1.5" stroke-dasharray="3 2"/></svg>', 'Planned', 'dashed: ready to build, or an idea');
  row('<svg viewBox="0 0 26 14"><rect x="3" y="2" width="20" height="10" rx="1" fill="none" stroke="var(--danger)" stroke-width="1.5" stroke-dasharray="3 2"/></svg>', 'To delete', 'goes when you build');
  row('<svg viewBox="0 0 26 14"><path d="M2 7h22" stroke="var(--ink)" stroke-width="2"/></svg>', 'Two-way', 'a way in and a way back');
  row('<svg viewBox="0 0 26 14"><path d="M2 7h18" stroke="var(--ink)" stroke-width="2"/><path d="M18 3l6 4-6 4z" fill="var(--ink)"/></svg>', 'One-way', 'no way back along it');
  row('<svg viewBox="0 0 26 14"><rect x="8" y="6" width="10" height="7" rx="1.5" fill="none" stroke="var(--ink)" stroke-width="1.4"/><path d="M10 6V4.5a3 3 0 0 1 6 0V6" fill="none" stroke="var(--ink)" stroke-width="1.4"/></svg>', 'Locked', 'needs an item or a flag');
}

function renderPhases() {
  const p = $('#phases'); p.textContent = '';
  p.hidden = !S.M || !S.M.phases.length;
  if (!S.M) return;
  S.M.phases.forEach((ph, i) => {
    const k = window.CassettoKeys ? window.CassettoKeys.label(`plastico.phase${i + 1}`) : String(i + 1);
    const b = btn(cap(ph), '', () => setPhase(ph), `Show the world at ${ph}${k ? ` (${k})` : ''}`);
    b.setAttribute('aria-pressed', S.ui.phase === ph);
    p.append(b);
  });
}
function setPhase(ph) {
  S.ui.phase = ph; renderPhases(); renderView(); renderInspector();
  if (S.route) { computeRoute(); renderBanner(); refreshHighlight(); }
  if (S.play) renderBanner();
}
function setMode(mode) {
  S.ui.mode = mode; lsSet('plastico:mode', mode);
  $('#v-skeleton').setAttribute('aria-pressed', mode === 'skeleton'); $('#v-pictures').setAttribute('aria-pressed', mode === 'pictures');
  renderView();
}

function updateEmpty() {
  const e = $('#empty'); e.textContent = '';
  $('#loading').hidden = true;
  if (!S.worlds.length && !S.world) {
    e.append(el('h2', '', 'Make your first world'),
      el('p', '', 'A world is one game, or one part of a game, seen as a model: its scenes as blocks, the ways between them as paths.'),
      el('p', '', 'Link it to a Godot project and Plastico reads the scenes and their exits from there; or start empty and sketch.'));
    const r = el('div', 'row'); r.append(btn('New world', 'btn primary', openNewWorld)); e.append(r);
    e.hidden = false; return;
  }
  if (S.world && !S.world.scenes.length) {
    e.append(el('h2', '', 'An empty world'), el('p', '', 'Double-click the ground to add a scene, or use Add scene. Drag a scene’s dot onto another to join them.'),
      el('p', '', S.world.godot ? 'The linked Godot project has no scenes Plastico recognises yet.' : 'To bring in a game’s scenes, link its Godot project in World settings.'));
    const r = el('div', 'row'); r.append(btn('Add a scene', 'btn primary', () => openAddScene()), btn('World settings', 'btn', openSettings)); e.append(r);
    e.hidden = false; return;
  }
  e.hidden = true;
}

/* ------------------------------------------------------------------ inspector */
function field(label, input, help) {
  const f = el('div', 'f'); const l = el('label', '', label);
  if (input.id) l.htmlFor = input.id;
  f.append(l, input);
  if (help) f.append(el('span', 'help', help));
  return f;
}
function seg(options, value, onPick, disabled) {
  const s = el('div', 'seg plain');
  for (const [v, label, title] of options) {
    const b = btn(label, '', () => onPick(v), title); b.setAttribute('aria-pressed', v === value); b.disabled = !!disabled; s.append(b);
  }
  return s;
}
function armed(label, armedLabel, onFire) {
  const b = btn(label, 'btn danger small');
  let t = 0;
  b.addEventListener('click', () => {
    if (b.classList.contains('armed')) { clearTimeout(t); onFire(); return; }
    b.classList.add('armed'); b.textContent = armedLabel;
    t = setTimeout(() => { b.classList.remove('armed'); b.textContent = label; }, 3000);
  });
  return b;
}
function section(title, count) {
  const s = el('section', 'sec'); const h = el('h3'); h.append(el('span', '', title)); if (count != null) h.append(el('em', '', String(count))); s.append(h); return s;
}
function closeBtn() { const b = btn('', 'btn icon small', () => select(null), 'Close (Esc)'); b.append(svgIcon(ICON.close)); b.setAttribute('aria-label', 'Close'); return b; }

function renderInspector() {
  const box = $('#insp'); box.textContent = '';
  if (!S.world) { box.append(el('p', 'none', 'Pick a world, or make a new one.')); return; }
  if (S.sel && S.sel.type === 'scene') return sceneInspector(box, S.M.scenes.get(S.sel.id));
  if (S.sel && S.sel.type === 'pair') return pairInspector(box, S.M.pairs.get(S.sel.key));
  worldInspector(box);
}

function worldInspector(box) {
  const M = S.M, w = S.world, b = S.bundle;
  const head = el('div', 'insp-head'); const h = el('h2', '', w.name);
  h.append(el('span', 'sub', w.godot ? `Linked to ${w.godot.replace(/^\/home\/[^/]+/, '~')}` : 'Not linked to a Godot project'));
  head.append(h, btn('Settings', 'btn small', openSettings)); box.append(head);
  const st = model.stats(M);
  const stats = el('div', 'stats');
  const stat = (n, t) => { const d = el('div', 'stat'); d.append(el('b', '', String(n)), el('span', '', t)); stats.append(d); };
  stat(st.scenes, w.godot ? `scenes, ${st.inGame} in the game` : 'scenes');
  stat(st.ways, w.godot ? `ways, ${st.waysInGame} in the game` : 'ways between them');
  stat(w.acts.length, w.acts.length === 1 ? 'act' : 'acts');
  stat(st.steps, 'puzzle steps placed');
  box.append(stats);
  if (b.game_error) { const a = el('div', 'alert bad'); a.textContent = b.game_error; box.append(a); }
  if (b.game) {
    const g = section('Godot');
    const when = new Date(b.game.scanned_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const n = pendingCount();
    g.append(el('p', 'note', `Read at ${when}: ${Object.keys(b.game.scenes).length} scenes, ${b.game.exits.filter((e) => e.to).length} exits. ${n ? `${n} difference${n > 1 ? 's' : ''} with the plan.` : 'The plan matches the game.'}`));
    if (b.game.editor_open) g.append(el('p', 'note warn', 'Godot has the project open: Plastico reads it, but builds only when Godot is closed.'));
    const r = el('div', 'chips'); r.append(btn('Read it again', 'btn small', () => refresh(true)), btn(n ? `Build in Godot (${n})` : 'Godot changes', 'btn small' + (n ? ' primary' : ''), openGodot));
    g.append(r); box.append(g);
  }
  const issues = model.checks(M);
  const sec = section('Checks', issues.length || null);
  if (!issues.length) sec.append(el('p', 'ok none', 'Nothing to report: every scene can be reached and left.'));
  const ul = el('ul', 'issues');
  for (const it of issues) {
    const li = el('li'); const bt = el('button', `issue ${it.level}`); bt.type = 'button';
    bt.append(svgIcon(it.level === 'error' ? ICON.err : it.level === 'warn' ? ICON.warn : ICON.info));
    const t = el('span'); t.append(el('b', '', /[.?!]$/.test(it.head) ? it.head + ' ' : it.head + '. '), document.createTextNode(it.text)); bt.append(t);
    bt.addEventListener('click', () => {
      if (it.links.length) { const L = M.links.get(it.links[0]); if (L) { select({ type: 'pair', key: model.pairKey(L.from, L.to) }); view.focus(L.from); return; } }
      if (it.scenes.length) { select({ type: 'scene', id: it.scenes[0] }); view.fit(it.scenes); }
    });
    li.append(bt);
    if (it.fix && it.fix.place) {      // "Not there then": put them there, at that time, or go to the step
      const { who, scene, when } = it.fix.place;
      const nmw = firstName((M.people.get(who) || {}).name) || who, sc = M.scenes.get(scene);
      const fixes = el('div', 'fixes');
      const f = btn(`Put ${nmw} in ${sc ? sc.name : scene}${when ? ` (${when})` : ''}`, 'btn small fix', () => edit((w) => {
        const s = w.scenes.find((q) => q.id === scene); if (!s) return;
        for (const ph of when ? [when] : w.phases || []) {
          s.people = s.people || {}; s.people[ph] = s.people[ph] || [];
          if (s.away && s.away[ph]) s.away[ph] = s.away[ph].filter((q) => q !== who);
          if (!s.people[ph].includes(who)) s.people[ph].push(who);
        }
      }), when ? `Adds ${nmw} to People here in ${sc ? sc.name : scene} at ${when}` : `Adds ${nmw} to People here in ${sc ? sc.name : scene} at every time of day`);
      fixes.append(f);
      const refs = it.fix.steps || [];
      if (CS && refs.length) {
        fixes.append(btn(refs.length > 1 ? `Open the first of the ${refs.length} steps` : 'Open the step', 'btn small fix',
          () => CS.navigate('puzzles', { chart: refs[0].chart, step: refs[0].step }), 'Opens it in Puzzle Charts, where it can move to another scene'));
      }
      li.append(fixes);
    }
    ul.append(li);
  }
  sec.append(ul); box.append(sec);
  const ch = section('Puzzle charts');
  if (CS) {
    const c = (b.charts && b.charts.charts) || [];
    const n = c.reduce((k, x) => k + chartSteps(x), 0);
    const placed = c.reduce((k, x) => k + x.nodes.filter((q) => q.scene && (q.kind !== 'goal' && q.kind !== 'setup')).length, 0);
    if (S.ui.act === 'all' || !c.length) ch.append(el('p', 'note', c.length ? `${c.length} chart${c.length === 1 ? '' : 's'}, ${n} steps (${placed} placed in a scene), live from Puzzle Charts in this project. Select a scene to see its steps; locks find their keys in them.`
      : 'No puzzle charts in this project yet. Steps you place in a scene show up on its panel, and locks find their keys in them.'));
    // the act on screen (or every act): its charts, and its scenes no puzzle step happens in yet
    const act = S.ui.act !== 'all' ? S.ui.act : '';
    const mine = c.filter((x) => !act || String(x.act) === act);
    const actScenes = [...M.scenes.values()].filter((s) => !s.delete && (!act || s.act === act));
    if (act) ch.querySelector('h3').firstChild.textContent = `Puzzle charts of act ${act}`;
    const ul = el('ul', 'links charts'); ul.id = 'act-charts';
    for (const x of mine) {
      const placed = new Set(x.nodes.filter((q) => q.scene && q.kind !== 'goal' && q.kind !== 'setup' && M.scenes.has(q.scene)).map((q) => q.scene));
      const li = el('li', 'chart-here'); const head = el('div', 'chart-head');
      const go = el('button', 'go'); go.type = 'button';
      go.append(stepGlyph('goal'), el('span', 't', x.name), el('span', 's', `${act ? '' : `act ${x.act} · `}${plural(chartSteps(x), 'step')} · in ${plural(placed.size, 'scene')}${act ? ` of ${actScenes.length}` : ''}`));
      go.title = `Open “${x.name}” in Puzzle Charts`;
      go.addEventListener('click', () => CS.navigate('puzzles', { chart: x.id }));
      head.append(go); li.append(head); ul.append(li);
    }
    if (mine.length) ch.append(ul);
    else if (act && c.length) ch.append(el('p', 'none', `No chart is in act ${act} yet. A chart’s act is set on its panel in Puzzle Charts.`));
    const used = new Set(c.flatMap((x) => x.nodes.filter((q) => q.scene && q.kind !== 'goal' && q.kind !== 'setup').map((q) => q.scene)));
    const idle = actScenes.filter((s) => !used.has(s.id)).sort((p, q) => p.name.localeCompare(q.name));
    if (idle.length && c.length) {
      const p = el('p', 'note'); p.id = 'act-idle';
      p.append(document.createTextNode(`No puzzle step yet in ${idle.length} of the ${actScenes.length} scenes${act ? ` of act ${act}` : ''}: `));
      idle.slice(0, 12).forEach((s, i) => { if (i) p.append(document.createTextNode(', ')); const a = el('button', 'inline-link', s.name); a.type = 'button'; a.addEventListener('click', () => { select({ type: 'scene', id: s.id }); view.focus(s.id); }); p.append(a); });
      if (idle.length > 12) p.append(document.createTextNode('…'));
      ch.append(p);
    }
    ch.append(btn('Open Puzzle Charts', 'btn small', () => CS.navigate('puzzles')));
  } else if (b.charts && b.charts.charts) {
    const c = b.charts;
    const n = c.charts.reduce((k, x) => k + chartSteps(x), 0);
    const placed = c.charts.reduce((k, x) => k + x.nodes.filter((q) => q.scene && (q.kind !== 'goal' && q.kind !== 'setup')).length, 0);
    ch.append(el('p', 'note', `${c.charts.length} charts, ${n} steps (${placed} placed in a scene), copied ${new Date(c.synced).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}. Select a scene to see its steps; locks find their keys in them.`));
    ch.append(el('p', 'none', 'To bring in later changes, ask Claude: “sync Plastico with my puzzle charts”.'));
    if (c.source) { const a = el('a', 'btn small', 'Open the puzzle charts'); a.href = c.source; a.target = '_blank'; a.rel = 'noopener'; ch.append(a); }
  } else ch.append(el('p', 'none', 'No puzzle charts with this world. Ask Claude to “sync Plastico with my puzzle charts” to see each scene’s steps here.'));
  box.append(ch);
  const k = section('Keys');
  const KS = window.CassettoKeys;
  if (KS) {
    const ks = [['plastico.add', 'add a scene'], ['plastico.delete', 'remove the selection'], ['plastico.route', 'route'], ['plastico.play', 'play test'],
      ['plastico.mode', 'skeleton/pictures'], ['plastico.top', 'map view'], ['plastico.fit', 'fit'], ['plastico.undo', 'undo']]
      .filter(([id]) => KS.label(id)).map(([id, what]) => `${KS.label(id)} ${what}`);
    const t1 = KS.label('plastico.phase1'), tn = KS.label(`plastico.phase${Math.max(1, Math.min(9, (S.M && S.M.phases.length) || 4))}`);
    if (t1) ks.push(`${t1}${tn && tn !== t1 ? '–' + tn : ''} time of day`);
    k.append(el('p', 'none', ks.join(' · ') || 'No keys are set for Plastico.'));
    if (CS && CS.settings) k.append(btn('Change the keys…', 'btn small', () => CS.settings('keys')));
  } else k.append(el('p', 'none', 'N add a scene · Delete remove the selection · R route · P play test · S skeleton/pictures · T map view · F fit · 1–4 time of day · Ctrl+Z undo'));
  box.append(k);
}

function sceneInspector(box, s) {
  const M = S.M, w = S.world;
  const ws = () => w.scenes.find((q) => q.id === s.id);
  const head = el('div', 'insp-head'); const h = el('h2', '', s.name);
  h.append(el('span', 'sub', `${STATE_LABEL[s.state]} · ${KINDS[s.kind].label}${s.floor ? ` · ${s.floor > 0 ? 'floor ' + s.floor : -s.floor + ' below the street'}` : ''}`));
  head.append(h, closeBtn()); box.append(head);
  if (s.state === 'delete') {
    const a = el('div', 'alert bad'); a.append(el('b', '', 'Marked to delete. '), document.createTextNode('It leaves the game (folder moved to Plastico’s backups) when you build. '));
    a.append(btn('Keep it', 'btn small', () => keepScene(s.id))); box.append(a);
  }
  // picture
  const url = pictureUrl(s);
  if (url) {
    const p = el('div', 'pic'); const img = el('img'); img.alt = `${s.name} at ${S.ui.phase || 'midnight'}`; img.src = url.replace('w=1024', 'w=640'); p.append(img); box.append(p);
  }
  if (!s.inGame) {
    const dz = el('div', 'drop-zone', url ? 'Drop another picture here, or click to choose one' : 'Drop a sketch or a picture here (or click) to see it in Pictures mode');
    dz.addEventListener('click', () => { const f = $('#file-pick'); f.onchange = () => { if (f.files[0]) uploadPicture(s.id, f.files[0]); f.value = ''; }; f.click(); });
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('over'));
    dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) uploadPicture(s.id, f); });
    box.append(dz);
    if (url) box.append(btn('Remove the picture', 'btn small', () => removePicture(s.id)));
  }
  const name = el('input'); name.id = 'f-name'; name.value = s.name; name.maxLength = 80;
  name.addEventListener('input', () => edit((x) => {
    const sc = x.scenes.find((q) => q.id === s.id); sc.name = name.value;
  }, { coalesce: 'name:' + s.id, insp: false }));
  name.addEventListener('change', () => {
    // a scene not in the game yet follows its name with its id, until the id is set by hand
    const sc = ws(); if (!sc || s.inGame || !sc.autoId) return;
    const id = newSceneId(sc.name, { scenes: w.scenes.filter((q) => q.id !== s.id) });
    if (id !== sc.id) renameScene(sc.id, id, true);
  });
  box.append(field('Name', name));
  const idIn = el('input', 'mono'); idIn.id = 'f-id'; idIn.value = s.id; idIn.disabled = s.inGame; idIn.spellcheck = false;
  idIn.addEventListener('change', () => {
    const v = idIn.value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    if (!v || v === s.id) { idIn.value = s.id; return; }
    if (w.scenes.some((q) => q.id === v)) { toast(`There is already a scene called ${v}.`); idIn.value = s.id; return; }
    renameScene(s.id, v, false);
  });
  box.append(field('Id', idIn, s.inGame ? `In the game: ${s.g.res.replace('res://', '')}` : 'Its folder and name in Godot: scenes/<id>/'));
  if (!s.inGame) box.append(field('Kind', seg(Object.entries(KINDS).map(([k, v]) => [k, v.label, v.long]), s.kind, (v) => edit((x) => {
    const sc = ws(), was = model.sizeOf(sc), def = model.sizeOf({ kind: sc.kind });
    sc.kind = v;
    if (was.w === def.w && was.d === def.d) { const n = model.sizeOf({ kind: v }); resizeIn(x, sc, n.w, n.d); }   // still the old kind's size: take the new one's
  }))));
  box.append(sizeField(s, ws));
  box.append(parentField(s));
  const r2 = el('div', 'row2');
  const actSel = el('select'); actSel.id = 'f-act';
  for (const a of w.acts) { const o = el('option', '', `Act ${a.id}${a.name ? ' · ' + a.name : ''}`); o.value = a.id; actSel.append(o); }
  actSel.value = s.act;
  actSel.disabled = !!s.parent; if (s.parent) actSel.title = 'A scene inside another is in its act';
  actSel.addEventListener('change', () => edit((x) => { ws().act = actSel.value; for (const k of model.descendantsOf(x, s.id)) x.scenes.find((q) => q.id === k).act = actSel.value; }));
  const areaSel = el('select'); areaSel.id = 'f-area';
  { const o = el('option', '', 'No area'); o.value = ''; areaSel.append(o); }
  for (const a of w.areas) { const o = el('option', '', a.name || 'Unnamed area'); o.value = a.id; areaSel.append(o); }
  { const o = el('option', '', 'New area…'); o.value = '__new'; areaSel.append(o); }
  areaSel.value = s.area;
  areaSel.addEventListener('change', () => {
    if (areaSel.value === '__new') {
      const nm = window.prompt ? null : null; // no browser dialogs: make one and let the user name it in settings
      const id = 'area_' + Math.random().toString(36).slice(2, 7);
      edit((x) => { x.areas.push({ id, name: 'New area', color: x.areas.length % 8 }); ws().area = id; });
      toast('Added “New area”: rename it in World settings.', { label: 'Open settings', run: openSettings });
      return nm;
    }
    edit((x) => { ws().area = areaSel.value; });
  });
  r2.append(field('Act', actSel), field('Area', areaSel)); box.append(r2);
  const fl = el('div', 'stepper'); const flIn = el('input'); flIn.id = 'f-floor'; flIn.type = 'number'; flIn.step = '1'; flIn.value = s.floor;
  const setFloor = (v) => edit((x) => { ws().floor = Math.max(-9, Math.min(30, v | 0)); });
  fl.append(btn('−', '', () => setFloor(s.floor - 1), 'One floor down'), flIn, btn('+', '', () => setFloor(s.floor + 1), 'One floor up'));
  flIn.addEventListener('change', () => setFloor(parseInt(flIn.value, 10) || 0));
  box.append(field('Floor', fl, '0 is street level; 1 the floor above; −1 below the street (a cellar, a harbour down the steps).'));
  if (!s.inGame && s.state !== 'delete') {
    box.append(field('Status', seg([['idea', 'Idea', 'Just thinking about it'], ['ready', 'Ready to build', 'Ticked by default in the Godot build list']], s.status, (v) => edit((x) => { ws().status = v; }))));
  }
  // start
  const starts = actStarts();
  const act = w.acts.find((a) => a.id === s.act);
  if (!starts.has(s.id) && act && !(S.bundle.game && act.id === w.acts[0].id && S.M.start)) {
    box.append(btn(`Make it where act ${act.id} starts`, 'btn small', () => edit((x) => { x.acts.find((a) => a.id === act.id).start = s.id; })));
  }
  // time of day
  if (M.phases.length) {
    const sec = section('Open at');
    sec.append(chipsToggle(M.phases, s.open, (list) => edit((x) => { ws().open = list; })));
    sec.append(el('span', 'none', s.open.length ? 'Closed at the other times.' : 'Always open. Pick times to say it is only open then.'));
    box.append(sec);
  }
  // people
  box.append(peopleSection(s, ws));
  // ways
  const pairs = [...M.pairs.values()].filter((P) => P.a === s.id || P.b === s.id);
  const ways = section('Ways', pairs.length);
  const ul = el('ul', 'links');
  for (const P of pairs) {
    const other = P.a === s.id ? P.b : P.a;
    const out = P.links.some((l) => l.from === s.id), inn = P.links.some((l) => l.to === s.id);
    const li = el('li'); const go = el('button', 'go'); go.type = 'button';
    go.append(svgIcon(out && inn ? ICON.two : out ? ICON.to : ICON.from), el('span', 't', (M.scenes.get(other) || {}).name || other));
    if (P.locked) go.append(svgIcon(ICON.lock));
    go.append(el('span', 's', P.state === 'game' ? '' : P.state === 'mixed' ? 'partly built' : P.state.includes('delete') ? 'to delete' : P.state === 'ready' ? 'ready' : 'idea'));
    go.addEventListener('click', () => select({ type: 'pair', key: P.key }));
    const x = btn('×', 'x', () => deletePair(P.key), 'Remove this way'); x.setAttribute('aria-label', 'Remove this way');
    li.append(go, x); ul.append(li);
  }
  if (!pairs.length) ways.append(el('p', 'none', 'No ways yet. Drag this scene’s dot onto another, or pick one below.'));
  ways.append(ul);
  const join = el('select'); join.id = 'f-join';
  { const o = el('option', '', 'Join to…'); o.value = ''; join.append(o); }
  const joined = new Set(pairs.map((P) => (P.a === s.id ? P.b : P.a)));
  for (const q of [...M.scenes.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (q.id === s.id || joined.has(q.id)) continue;
    const o = el('option', '', q.name); o.value = q.id; join.append(o);
  }
  join.addEventListener('change', () => { if (join.value) connect(s.id, join.value); });
  ways.append(field('Add a way', join));
  box.append(ways);
  // open ends from the game
  const ends = M.openEnds.filter((e) => e.from === s.id);
  if (ends.length) {
    const sec = section('Leads nowhere yet', ends.length);
    for (const e of ends) {
      const planned = (M.out.get(s.id) || []).find((l) => l.via === e.hotspot);
      const sel = el('select');
      { const o = el('option', '', planned ? `Leads to ${(M.scenes.get(planned.to) || {}).name}` : 'Lead it to…'); o.value = ''; sel.append(o); }
      for (const q of [...M.scenes.values()].sort((a, b) => a.name.localeCompare(b.name))) { if (q.id !== s.id) { const o = el('option', '', q.name); o.value = q.id; sel.append(o); } }
      sel.addEventListener('change', () => {
        if (!sel.value) return;
        edit((x) => {
          const old = x.links.find((l) => l.via === e.hotspot && l.from === s.id); if (old) old.via = '';
          let l = x.links.find((q) => q.from === s.id && q.to === sel.value);
          if (!l) { l = { id: `l_${s.id}_${sel.value}_${Math.random().toString(36).slice(2, 6)}`, from: s.id, to: sel.value, status: 'ready', lock: null, open: [], via: '', notes: '', delete: false }; x.links.push(l); }
          l.via = e.hotspot;
        });
      });
      sec.append(field(`${e.name || e.hotspot}`, sel, `Hotspot ${e.hotspot}: building sets its target to the scene you pick.`));
    }
    box.append(sec);
  }
  // the puzzle charts here: the ones with steps in this scene, and the ones pinned to it
  box.append(chartsSection(s, ws));
  const notes = el('textarea'); notes.id = 'f-notes'; notes.value = s.notes; notes.placeholder = 'What happens here, what it is for, what is still open…';
  notes.addEventListener('input', () => edit((x) => { ws().notes = notes.value; }, { coalesce: 'notes:' + s.id, insp: false, view: false }));
  box.append(field('Notes', notes));
  const foot = el('div', 'foot');
  foot.append(btn('Focus', 'btn small', () => view.focus(s.id), 'Bring the camera to it'));
  foot.append(btn('Route from here', 'btn small', () => { select({ type: 'scene', id: s.id }); startRoute(); }));
  foot.append(btn('Play from here', 'btn small', () => { S.sel = { type: 'scene', id: s.id }; startPlay(); }));
  if (s.state !== 'delete') foot.append(armed(s.inGame ? 'Delete…' : 'Delete', s.inGame ? 'Mark to delete from the game' : 'Click again to delete', () => deleteScene(s.id)));
  box.append(foot);
}

// --- a scene's block: whole grid cells; the corner nearest the origin stays put, so the edges stay on the grid
function resizeIn(w, sc, nw, nd) {
  const old = model.sizeOf(sc);
  const x0 = sc.x - old.w / 2, z0 = sc.z - old.d / 2;
  sc.w = nw; sc.d = nd;
  sc.x = model.snapAxis(x0 + nw / 2, nw); sc.z = model.snapAxis(z0 + nd / 2, nd);
}
function sizeField(s, ws) {
  const { w: sw, d: sd } = model.sizeOf(s);
  const wrap = el('div', 'row2');
  const stepper = (label, value, set) => {
    const st = el('div', 'stepper'); const inp = el('input'); inp.type = 'number'; inp.min = '1'; inp.max = String(model.MAX_CELLS); inp.step = '1'; inp.value = value;
    inp.id = label === 'Width' ? 'f-w' : 'f-d';
    st.append(btn('−', '', () => set(value - 1), `Narrower by one cell`), inp, btn('+', '', () => set(value + 1), `Wider by one cell`));
    inp.addEventListener('change', () => set(parseInt(inp.value, 10) || value));
    return field(label, st);
  };
  const apply = (nw, nd) => {
    nw = Math.max(1, Math.min(model.MAX_CELLS, nw | 0)); nd = Math.max(1, Math.min(model.MAX_CELLS, nd | 0));
    if (nw === sw && nd === sd) return;
    const tmp = { ...s, w: nw, d: nd }; resizeIn(null, tmp, nw, nd);
    const hit = model.overlapping(S.world.scenes, tmp.x, tmp.z, nw, nd, s.floor || 0, new Set([s.id]));
    if (hit.length) { toast(`It would overlap ${hit.map(sceneLabel).join(', ')}: move one of them first.`); renderInspector(); return; }
    edit((x) => resizeIn(x, ws(), nw, nd));
  };
  wrap.append(stepper('Width', sw, (v) => apply(v, sd)), stepper('Depth', sd, (v) => apply(sw, v)));
  const f = el('div', 'f'); f.append(wrap, el('span', 'help', `${sw} × ${sd} cells on the grid. Its left and back edges stay where they are.`));
  return f;
}
// --- the scene it sits in (its parent), and the scenes inside it
function parentField(s) {
  const w = S.world;
  const box = el('div', 'stack');
  const sel = el('select'); sel.id = 'f-parent';
  { const o = el('option', '', 'Nothing: straight in its act'); o.value = ''; sel.append(o); }
  const below = model.descendantsOf(w, s.id);
  for (const q of w.scenes.filter((q) => q.id !== s.id && !below.has(q.id) && !q.delete).sort((a, b) => sceneLabel(a).localeCompare(sceneLabel(b)))) {
    const o = el('option', '', sceneLabel(q)); o.value = q.id; sel.append(o);
  }
  sel.value = s.parent || '';
  sel.addEventListener('change', () => setParent(s.id, sel.value));
  box.append(field('Inside', sel, s.parent ? `In ${containerText(null, s.parent)}. It moves with it on the map.` : 'Put it inside another scene to group it there (a room in a building, a close-up in a room).'));
  const kids = model.childrenOf(w, s.id);
  if (kids.length) {
    const ul = el('ul', 'links kids');
    for (const k of kids) {
      const li = el('li'); const go = el('button', 'go'); go.type = 'button';
      go.append(el('span', 't', sceneLabel(k))); go.addEventListener('click', () => { select({ type: 'scene', id: k.id }); view.focus(k.id); });
      li.append(go); ul.append(li);
    }
    box.append(field(`Scenes inside (${kids.length})`, ul));
  }
  return box;
}
function setParent(id, parent, focus = true) {
  const w = S.world;
  if (parent && (parent === id || model.descendantsOf(w, id).has(parent))) return;
  const sc = w.scenes.find((q) => q.id === id); if (!sc) return;
  const P = parent ? w.scenes.find((q) => q.id === parent) : null;
  const group = [sc, ...[...model.descendantsOf(w, id)].map((k) => w.scenes.find((q) => q.id === k))];
  let dx = 0, dz = 0, df = 0;
  if (P) {   // it goes to sit just below its new parent, with what is inside it
    const { w: cw, d: cd } = model.sizeOf(sc);
    const spot = model.childSpot({ ...w, scenes: w.scenes.filter((q) => !group.includes(q)) }, P, cw, cd);
    df = (P.floor || 0) - (sc.floor || 0);
    const f = model.freeShift(w.scenes, group, spot.x - sc.x, spot.z - sc.z, df);
    dx = f.dx; dz = f.dz;
  }
  edit((x) => {
    const act = P ? (model.ancestorsOf(x, P.id).pop() || P).act : null;
    for (const g of group) {
      const q = x.scenes.find((t) => t.id === g.id);
      q.x = round(q.x + dx); q.z = round(q.z + dz); q.floor = (q.floor || 0) + df;
      if (act) q.act = act;
    }
    x.scenes.find((q) => q.id === id).parent = parent || '';
  });
  if (P && focus) view.focus(id);
}
// What the suite's project tree asks when something is dragged in it (one undoable edit each). Returns
// a line saying what changed, or '' when nothing did; throws with the reason when it can't be done.
//   {kind: 'scene', id, parent}       the scene goes inside another, with the scenes inside it
//   {kind: 'scene', id, act}          the scene goes straight into an act (out of the scene it was in)
//   {kind: 'pin', chart, scene, from} the chart is pinned to a scene (and unpinned from `from`, if it was)
//   {kind: 'unpin', chart, from}      the chart is unpinned from a scene
function treeMove(m) {
  const w = S.world;
  const find = (id) => w.scenes.find((q) => q.id === id);
  const name = (id) => { const q = find(id); return q ? sceneLabel(q) : id; };
  if (m.kind === 'scene') {
    const sc = find(m.id); if (!sc) throw new Error(`There’s no scene ${m.id} in this world.`);
    if (m.parent) {
      if (!find(m.parent)) throw new Error(`There’s no scene ${m.parent} in this world.`);
      if (m.parent === m.id || model.descendantsOf(w, m.id).has(m.parent)) throw new Error('A scene can’t go inside itself, or inside a scene that is in it.');
      if (sc.parent === m.parent) return '';
      setParent(m.id, m.parent, false);
      return `${name(m.id)} is inside ${name(m.parent)} now.`;
    }
    if (!w.acts.some((a) => a.id === m.act)) throw new Error(`There’s no act ${m.act} in this world.`);
    if (!sc.parent && sc.act === m.act) return '';
    edit((x) => {
      const q = x.scenes.find((t) => t.id === m.id); q.parent = ''; q.act = m.act;
      for (const k of model.descendantsOf(x, m.id)) x.scenes.find((t) => t.id === k).act = m.act;
    });
    return `${name(m.id)} is straight in act ${m.act} now.`;
  }
  if (m.kind === 'pin' || m.kind === 'unpin') {
    if (m.scene && !find(m.scene)) throw new Error(`There’s no scene ${m.scene} in this world.`);
    const from = m.from && m.from !== m.scene ? find(m.from) : null;
    const pinnedFrom = !!(from && (from.charts || []).includes(m.chart));
    const to = m.kind === 'pin' ? find(m.scene) : null;
    const pinnedTo = !!(to && (to.charts || []).includes(m.chart));
    if (!pinnedFrom && (!to || pinnedTo)) return '';
    edit((x) => {
      if (to && !pinnedTo) { const t = x.scenes.find((q) => q.id === to.id); t.charts = [...(t.charts || []), m.chart]; }
      if (pinnedFrom) { const f = x.scenes.find((q) => q.id === from.id); f.charts = (f.charts || []).filter((c) => c !== m.chart); }
    });
    return to ? `Pinned to ${name(to.id)}${pinnedFrom ? `, not to ${name(from.id)} any more` : ''}.` : `Unpinned from ${name(from.id)}.`;
  }
  throw new Error('Plastico doesn’t know that move.');
}
// --- the puzzle charts of a scene. A chart is here when one of its steps is placed here (as Puzzle Charts
// says, nothing to keep in step); a chart can also be pinned here by hand, before it has steps here.
function projectCharts() { return (S.bundle.charts && S.bundle.charts.charts) || []; }
/** The steps of a chart as every view counts them: not the end goals, not the scene setups. */
function chartSteps(c) { return typeof c.steps === 'number' ? c.steps : c.nodes.filter((n) => n.kind !== 'goal' && n.kind !== 'setup').length; }
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function chartsSection(s, ws) {
  const M = S.M;
  const pinned = s.charts || [];
  const here = M.steps.get(s.id) || [];
  const byChart = new Map();
  for (const st of here) { if (!byChart.has(st.chart.id)) byChart.set(st.chart.id, []); byChart.get(st.chart.id).push(st.node); }
  const ids = [...byChart.keys(), ...pinned.filter((cid) => !byChart.has(cid))];
  const sec = section('Puzzle charts here', ids.length);
  sec.id = 'scene-charts-sec';
  const ul = el('ul', 'links charts'); ul.id = 'scene-charts';
  for (const cid of ids) {
    const c = M.chartById.get(cid);
    const nodes = byChart.get(cid) || [];
    const li = el('li', 'chart-here'); li.dataset.chart = cid;
    const head = el('div', 'chart-head');
    const go = el('button', 'go'); go.type = 'button';
    if (c) {
      const n = nodes.filter((q) => q.kind !== 'goal' && q.kind !== 'setup').length;
      go.append(stepGlyph('goal'), el('span', 't', c.name),
        el('span', 's', nodes.length ? `act ${c.act} · ${plural(n, 'step')} here, of ${chartSteps(c)}` : `act ${c.act} · pinned here, no steps here yet`));
      go.title = CS ? `Open “${c.name}” in Puzzle Charts` : c.name;
      go.addEventListener('click', () => { if (CS) CS.navigate('puzzles', { chart: cid, scene: s.id }); else toast('Open the Puzzle Charts page to see it.'); });
    } else {
      go.classList.add('missing'); go.append(el('span', 't', 'A chart that isn’t in the project any more'), el('span', 's', cid));
      go.title = 'It was deleted from Puzzle Charts: take it off this scene.';
    }
    head.append(go);
    if (pinned.includes(cid)) {
      const x = btn('×', 'x', () => edit((w) => { const sc = ws(); sc.charts = (sc.charts || []).filter((q) => q !== cid); }),
        nodes.length ? 'Unpin it (it stays here while it has steps here)' : 'Take it off this scene (the chart stays in the project)');
      x.setAttribute('aria-label', 'Unpin the chart from this scene');
      head.append(x);
    }
    li.append(head);
    if (c && nodes.length) {
      const list = el('ul', 'steps');
      for (const node of nodes) {
        const st = el('li'); st.append(stepGlyph(node.kind));
        const extra = [node.who && firstName((M.people.get(node.who) || {}).name) || node.who, node.when].filter(Boolean).join(' · ');
        st.append(el('span', '', node.title || 'Untitled step'), el('small', '', extra || (node.status === 'built' ? 'in game' : '')));
        if (CS) {
          st.classList.add('link'); st.tabIndex = 0; st.title = `Open “${node.title || 'Untitled step'}” in Puzzle Charts`;
          const open = () => CS.navigate('puzzles', { chart: cid, step: node.id });
          st.addEventListener('click', open); st.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
        }
        list.append(st);
      }
      li.append(list);
    }
    ul.append(li);
  }
  if (!ids.length) sec.append(el('p', 'none', 'No puzzle steps happen here yet. In Puzzle Charts, a step’s “Where” puts it here; or pin a chart planned for this scene.'));
  sec.append(ul);
  const all = projectCharts();
  const free = all.filter((c) => !ids.includes(c.id));
  const pick = el('select'); pick.id = 'f-add-chart';
  { const o = el('option', '', free.length ? 'Pin a chart planned for this scene…' : all.length ? 'Every chart is already here' : 'No charts in the project yet'); o.value = ''; pick.append(o); }
  for (const c of free) { const o = el('option', '', `${c.name} · act ${c.act} · ${plural(chartSteps(c), 'step')}`); o.value = c.id; pick.append(o); }
  pick.disabled = !free.length;
  pick.addEventListener('change', () => { if (!pick.value) return; const cid = pick.value; edit((w) => { const sc = ws(); sc.charts = [...(sc.charts || []).filter((q) => q !== cid), cid]; }); });
  sec.append(field('Pin', pick));
  if (CS) {
    sec.append(btn('New chart for this scene', 'btn small', async () => {
      try {
        const cid = await CS.call('puzzles.create_chart', s.name || s.id, Number(s.act) || 1);
        edit((w) => { const sc = ws(); sc.charts = [...(sc.charts || []), cid]; });
        await flushSave();
        CS.navigate('puzzles', { chart: cid });
      } catch (e) { toast(`Couldn’t make the chart: ${e.message}`); }
    }, 'Makes an empty chart in Puzzle Charts, pins it to this scene, and opens it'));
  }
  return sec;
}

function renameScene(from, to, auto) {
  if (S.sel && S.sel.id === from) S.sel = { type: 'scene', id: to };
  edit((x) => {
    const sc = x.scenes.find((q) => q.id === from); if (!sc) return;
    sc.id = to; if (!auto) sc.autoId = false;
    for (const l of x.links) { if (l.from === from) l.from = to; if (l.to === from) l.to = to; }
    for (const a of x.acts) if (a.start === from) a.start = to;
    for (const c of x.scenes) if (c.parent === from) c.parent = to;
  });
  renderInspector(); refreshHighlight();
  if (CS) {
    S.renames = (S.renames || Promise.resolve()).then(() => CS.call('puzzles.rename_scene', from, to)).then((r) => {
      if (r && r.steps) toast(`Moved ${r.steps} puzzle step${r.steps === 1 ? '' : 's'} to the scene’s new id (${to}).`);
    }, (e) => toast(`The puzzle steps in ${from} still point at it: ${e.message}`));
  }
}

function chipsToggle(all, on, change) {
  const c = el('div', 'chips');
  for (const p of all) {
    const b = el('button', 'chip', cap(p)); b.type = 'button'; b.setAttribute('aria-pressed', on.includes(p));
    b.addEventListener('click', () => { const next = on.includes(p) ? on.filter((x) => x !== p) : all.filter((x) => x === p || on.includes(x)); change(next); });
    c.append(b);
  }
  return c;
}

function peopleSection(s, ws) {
  const M = S.M;
  const sec = section('People here');
  const phases = M.phases.length ? M.phases : [''];
  const grid = el('div', 'ppl');
  for (const ph of phases) {
    if (ph) grid.append(el('span', 'ph' + (ph === S.ui.phase ? ' now' : ''), cap(ph)));
    const row = el('div', 'chips');
    const game = new Set((s.g && s.g.people && (ph ? s.g.people[ph] : Object.values(s.g.people).flat())) || []);
    const away = model.awayAt(s, ph);
    const setAway = (id, gone) => edit((w) => {
      const sc = ws(); sc.away = sc.away || {}; const k = ph || 'any';
      const list = new Set(sc.away[k] || []); if (gone) list.add(id); else list.delete(id);
      if (list.size) sc.away[k] = [...list]; else delete sc.away[k];
    });
    for (const id of game) {
      const name = firstName((M.people.get(id) || {}).name) || id;
      const c = el('span', 'chip game' + (away.has(id) ? ' away' : ''), name);
      if (away.has(id)) {
        c.title = 'In the game here, but the plan takes them out: change it in Godot';
        c.append(btn('↺', 'x', () => setAway(id, false), `Keep ${name} here`));
      } else {
        c.title = 'In the game at this time';
        c.append(btn('×', 'x', () => setAway(id, true), `Take ${name} out of here (in the plan; you then change it in Godot)`));
      }
      row.append(c);
    }
    const plan = (s.people && s.people[ph || 'any']) || [];
    for (const id of plan) {
      if (game.has(id)) continue;
      const c = el('span', 'chip', firstName((M.people.get(id) || {}).name) || id); c.title = 'Planned';
      const x = btn('×', 'x', () => edit((w) => { const sc = ws(); sc.people[ph || 'any'] = (sc.people[ph || 'any'] || []).filter((q) => q !== id); }), 'Take them out of here');
      c.append(x); row.append(c);
    }
    const add = el('select', 'add-person');
    { const o = el('option', '', '+ person'); o.value = ''; add.append(o); }
    for (const p of S.world.people) { if (game.has(p.id) || plan.includes(p.id)) continue; const o = el('option', '', firstName(p.name)); o.value = p.id; add.append(o); }
    { const o = el('option', '', 'Someone new…'); o.value = '__new'; add.append(o); }
    add.addEventListener('change', () => {
      let id = add.value; if (!id) return;
      edit((w) => {
        if (id === '__new') { id = 'person_' + Math.random().toString(36).slice(2, 6); w.people.push({ id, name: 'New person' }); toast('Added “New person”: name them in World settings.', { label: 'Open settings', run: openSettings }); }
        const sc = w.scenes.find((q) => q.id === s.id);
        const k = ph || 'any';
        sc.people[k] = [...new Set([...(sc.people[k] || []), id])];
      });
    });
    row.append(add);
    grid.append(row);
  }
  sec.append(grid);
  sec.append(el('span', 'none', s.inGame ? 'Grey chips come from the game (talk hotspots and characters drawn in the scene); add the ones you plan. × takes someone out; for a grey chip that is a plan to change in Godot, and ↺ undoes it.' : 'Who you plan to put here, at each time of day. × takes someone out.'));
  return sec;
}

function pairInspector(box, P) {
  const M = S.M;
  const A = M.scenes.get(P.a), B = M.scenes.get(P.b);
  const head = el('div', 'insp-head'); const h = el('h2', '', `${A.name} ${P.oneWay ? (P.ab ? '→' : '←') : '⇄'} ${B.name}`);
  h.append(el('span', 'sub', P.state === 'game' ? 'In the game' : P.state === 'mixed' ? 'Partly in the game' : P.state.includes('delete') ? 'To delete when you build' : P.state === 'ready' ? 'Ready to build' : 'An idea'));
  head.append(h, closeBtn()); box.append(head);
  const dir = P.ab && P.ba ? 'both' : P.ab ? 'ab' : 'ba';
  const live = (L) => L && L.state !== 'delete';
  const liveDir = live(P.ab) && live(P.ba) ? 'both' : live(P.ab) ? 'ab' : live(P.ba) ? 'ba' : dir;
  box.append(field('Directions', seg([['both', 'Both ways', 'In and back'], ['ab', `${firstName(A.name)} → ${firstName(B.name)}`, 'Only this way'], ['ba', `${firstName(B.name)} → ${firstName(A.name)}`, 'Only this way']], liveDir, (v) => setDirections(P, v))));
  for (const L of P.links) box.append(directionBox(L));
  const foot = el('div', 'foot');
  foot.append(btn(`Go to ${firstName(A.name)}`, 'btn small', () => select({ type: 'scene', id: A.id })), btn(`Go to ${firstName(B.name)}`, 'btn small', () => select({ type: 'scene', id: B.id })));
  if (P.state !== 'delete') foot.append(armed('Remove the way', P.links.some((l) => l.inGame) ? 'Mark to remove from the game' : 'Click again to remove', () => deletePair(P.key)));
  box.append(foot);
}

function directionBox(L) {
  const M = S.M;
  const wl = () => S.world.links.find((q) => q.id === L.id);
  const d = el('div', 'dir');
  const top = el('div', 'dir-top');
  top.append(el('b', '', `${M.scenes.get(L.from).name} → ${M.scenes.get(L.to).name}`), el('span', `state ${L.state}`, STATE_LABEL[L.state]));
  d.append(top);
  if (L.inGame) {
    for (const e of L.exits) d.append(el('p', 'none', e.via === 'exit' ? `Exit ${e.hotspot}${e.name ? ` (“${e.name}”)` : ''}${e.view ? ` in the close-up ${e.view}` : ''}, arriving at ${e.spawn}.` : `Made in code: ${e.file}, line ${e.line}.`));
  } else if (L.state !== 'delete') {
    d.append(seg([['idea', 'Idea'], ['ready', 'Ready to build']], L.status, (v) => edit((x) => { wl().status = v; })));
    if (L.via) d.append(el('p', 'none', `Building leads the existing exit ${L.via} here.`));
  }
  if (L.state === 'delete' && L.inGame) d.append(btn('Keep it', 'btn small', () => edit((x) => { wl().delete = false; })));
  // lock
  const lockOn = !!L.lock;
  const lc = el('label', 'check'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = lockOn;
  cb.addEventListener('change', () => edit((x) => { wl().lock = cb.checked ? { needs: 'key', type: 'item', where: '', note: '' } : null; }));
  lc.append(cb, el('span', '', 'Locked: the player needs something to get through'));
  d.append(lc);
  if (lockOn) {
    const row = el('div', 'lockrow');
    const needs = el('input', 'mono'); needs.value = L.lock.needs; needs.setAttribute('list', 'dl-keys'); needs.placeholder = 'room_key';
    needs.addEventListener('change', () => edit((x) => { wl().lock.needs = needs.value.trim() || 'key'; }));
    const type = el('select'); for (const [v, t] of [['item', 'Item'], ['flag', 'Flag']]) { const o = el('option', '', t); o.value = v; type.append(o); }
    type.value = L.lock.type || 'item';
    type.addEventListener('change', () => edit((x) => { wl().lock.type = type.value; }));
    row.append(needs, type);
    d.append(field('Needs', row, 'An item id (items/<id>.tres) or a story flag. The play test lets you toggle it.'));
    const where = el('select');
    const src = model.keySource(M, L.lock.needs);
    { const o = el('option', '', src ? `From the chart: ${(M.scenes.get(src.scene) || {}).name || src.scene}` : 'Not said'); o.value = ''; where.append(o); }
    for (const q of [...M.scenes.values()].sort((a, b) => a.name.localeCompare(b.name))) { const o = el('option', '', q.name); o.value = q.id; where.append(o); }
    where.value = L.lock.where || '';
    where.addEventListener('change', () => edit((x) => { wl().lock.where = where.value; }));
    d.append(field('Got in', where, src ? `The chart “${src.chart}” gives it at the step “${src.step}”.` : 'Where the player gets it. Plastico warns if it is only reachable through this lock.'));
    const note = el('input'); note.value = L.lock.note || ''; note.placeholder = 'How it opens';
    note.addEventListener('input', () => edit((x) => { wl().lock.note = note.value; }, { coalesce: 'lock:' + L.id, insp: false, view: false }));
    d.append(field('Note', note));
    keyList();
  }
  if (M.phases.length) {
    if (L.gamePhases) d.append(el('p', 'none', `In the game it is only there at ${L.gamePhases.join(', ')}.`));
    d.append(field('Open at', chipsToggle(M.phases, L.open || [], (list) => edit((x) => { wl().open = list; })), (L.open || []).length ? 'Closed at the other times.' : 'Always open.'));
  }
  const notes = el('input'); notes.value = L.notes || ''; notes.placeholder = 'A door, stairs, a ladder, a fade…';
  notes.addEventListener('input', () => edit((x) => { wl().notes = notes.value; }, { coalesce: 'lnotes:' + L.id, insp: false, view: false }));
  d.append(field('Notes', notes));
  return d;
}
function keyList() {
  let dl = $('#dl-keys');
  if (!dl) { dl = el('datalist'); dl.id = 'dl-keys'; document.body.append(dl); }
  dl.textContent = '';
  const seen = new Set();
  for (const c of (S.bundle.charts && S.bundle.charts.charts) || []) for (const n of c.nodes) if (n.gid && !seen.has(n.gid)) { seen.add(n.gid); const o = el('option'); o.value = n.gid; o.label = `${n.title} (${c.name})`; dl.append(o); }
}

/* ------------------------------------------------------------------ pictures */
async function uploadPicture(id, file) {
  try {
    await api('PUT', `/api/worlds/${S.wid}/pictures/${encodeURIComponent(id)}`, undefined, await file.arrayBuffer());
    if (!S.bundle.uploads.includes(id)) S.bundle.uploads.push(id);
    S.pictureVersion++; derive(); renderView(); renderInspector();
    if (S.ui.mode !== 'pictures') toast('Picture added. Switch to Pictures to see it on the model.', { label: 'Pictures', run: () => setMode('pictures') });
  } catch (e) { toast(`Couldn’t use that picture: ${e.message}`); }
}
async function removePicture(id) {
  await api('DELETE', `/api/worlds/${S.wid}/pictures/${encodeURIComponent(id)}`);
  S.bundle.uploads = S.bundle.uploads.filter((x) => x !== id); S.pictureVersion++; derive(); renderView(); renderInspector();
}

/* ------------------------------------------------------------------ dialogs */
function openModal(build, narrow) {
  const m = $('#modal'), box = $('#modal-box');
  box.className = 'modal-box' + (narrow ? ' narrow' : '');
  box.textContent = '';
  build(box);
  m.hidden = false;
  const f = box.querySelector('input,select,button.primary'); if (f) setTimeout(() => f.focus(), 30);
}
function closeModal() { $('#modal').hidden = true; S.smokePoll && clearInterval(S.smokePoll); }
function modalHead(box, title, sub) {
  const h = el('div', 'modal-head'); const t = el('div'); t.append(el('h2', '', title)); if (sub) t.append(el('p', '', sub));
  const x = btn('', 'btn icon small', closeModal, 'Close'); x.append(svgIcon(ICON.close)); x.setAttribute('aria-label', 'Close');
  h.append(t, x); box.append(h);
}

async function openGodot() {
  if (!S.world.godot) { openSettings(); toast('Link a Godot project first, here in World settings.'); return; }
  await flushSave();
  await refresh(false);
  openModal((box) => godotDialog(box));
}

function godotDialog(box, report) {
  const b = S.bundle, g = b.game;
  modalHead(box, 'Build in Godot', `The differences between this plan and ${g ? g.name : 'the game'}. Tick what to build; the rest stays a plan.`);
  const body = el('div', 'modal-body'); box.append(body);
  if (!g) { body.append(el('div', 'alert bad', b.game_error || 'This world isn’t linked to a Godot project.')); return; }
  if (report) {
    const a = el('div', 'alert good');
    a.append(el('b', '', `Built: ${report.done.length} change${report.done.length === 1 ? '' : 's'}. `), document.createTextNode('The files Plastico touched are backed up, so the whole build can be undone.'));
    const ul = el('ul'); for (const f of report.files) { const li = el('li'); li.append(el('code', '', f)); ul.append(li); } a.append(ul);
    body.append(a);
    if (report.references && report.references.length) {
      const r = el('div', 'alert bad');
      r.append(el('b', '', 'Still mentioned elsewhere: '), document.createTextNode('these lines name a deleted scene. Fix them by hand or ask Claude, or the game may break.'));
      const ul2 = el('ul'); for (const x of report.references.slice(0, 30)) { const li = el('li'); li.append(el('code', '', `${x.file}:${x.line}`), document.createTextNode(` ${x.text}`)); ul2.append(li); } r.append(ul2);
      body.append(r);
    }
    body.append(el('p', 'note', 'New exits are grey stand-ins in the middle of the picture: open the scenes in Godot and move them where they belong. Then run the game’s test.'));
  }
  if (g.editor_open) body.append(el('div', 'alert bad', 'Godot has this project open. Close it (editor and game) before building: Godot would write its own copy of the scenes over the changes.'));
  const changes = b.changes || [];
  if (!changes.length) body.append(el('p', 'note', 'Nothing to build: the plan and the game match.'));
  const chosen = new Map(), modes = {};
  const groups = [['create_scene', 'New scenes'], ['add_exit', 'New ways'], ['remove_exit', 'Ways to remove'], ['delete_scene', 'Scenes to delete'], ['manual', 'Change by hand']];
  const wrap = el('div', 'changes');
  for (const [op, title] of groups) {
    const list = changes.filter((c) => c.op === op);
    if (!list.length) continue;
    const sec = el('div'); sec.append(el('h4', '', `${title} · ${list.length}`));
    const col = el('div', 'listed');
    for (const c of list) {
      const row = el('label', 'change' + (c.blocked || op === 'manual' ? ' off' : ''));
      const cb = el('input'); cb.type = 'checkbox';
      cb.disabled = !!c.blocked || op === 'manual';
      cb.checked = !cb.disabled && c.ready;
      chosen.set(c.id, cb);
      const t = el('span'); t.append(document.createTextNode(c.text));
      if (!c.ready && !cb.disabled) t.append(el('span', 'files', 'An idea: tick it to build it anyway.'));
      if (c.blocked) t.append(el('span', 'why', `Can’t yet: ${c.blocked}.`));
      if (c.files && c.files.length) t.append(el('span', 'files', c.files.join('  ·  ')));
      if (op === 'remove_exit' || op === 'delete_scene') {
        const sel = el('select');
        for (const [v, txt] of [['remove', 'Remove the exit hotspots'], ['nowhere', 'Keep the hotspots, leading nowhere']]) { const o = el('option', '', txt); o.value = v; sel.append(o); }
        sel.addEventListener('change', () => { modes[c.id] = sel.value; });
        sel.addEventListener('click', (e) => e.preventDefault());
        t.append(sel);
      }
      row.append(cb, t); col.append(row);
      cb.addEventListener('change', () => upd());
    }
    sec.append(col); wrap.append(sec);
  }
  body.append(wrap);
  const smoke = el('div'); smoke.id = 'smoke-out'; body.append(smoke);
  const foot = el('div', 'modal-foot'); const l = el('div', 'l'), r = el('div', 'r');
  if (b.last_build) l.append(btn('Undo the last build', 'btn small', undoBuild, `Built ${new Date(b.last_build.time).toLocaleString()}`));
  if (g.has_smoke_test) l.append(btn('Test the game', 'btn small', () => runSmoke(smoke), 'Runs tests/smoke_test.tscn headless (about a minute)'));
  const go = btn('Build', 'btn primary', async () => {
    const ids = [...chosen].filter(([, cb]) => cb.checked).map(([id]) => id);
    go.disabled = true; go.textContent = 'Building…';
    try {
      const res = await api('POST', `/api/worlds/${S.wid}/build`, { ids, modes });
      applyBundle(res, { keepView: true });
      box.textContent = ''; godotDialog(box, res.report);
    } catch (e) { go.disabled = false; upd(); const a = el('div', 'alert bad', e.message); body.prepend(a); }
  });
  r.append(btn('Close', 'btn', closeModal), go);
  foot.append(l, r); box.append(foot);
  function upd() { const n = [...chosen.values()].filter((cb) => cb.checked).length; go.textContent = n ? `Build ${n} change${n > 1 ? 's' : ''}` : 'Build'; go.disabled = !n || g.editor_open; }
  upd();
}

async function undoBuild() {
  try {
    const res = await api('POST', `/api/worlds/${S.wid}/undo-build`);
    applyBundle(res, { keepView: true });
    toast(`Undone: ${res.undone.restored.length} file${res.undone.restored.length === 1 ? '' : 's'} put back.`);
    $('#modal-box').textContent = ''; godotDialog($('#modal-box'));
  } catch (e) { toast(e.message); }
}

async function runSmoke(out) {
  out.textContent = '';
  try {
    const st = await api('POST', `/api/worlds/${S.wid}/smoke`);
    if (st.error) { out.append(el('div', 'alert bad', st.error)); return; }
  } catch (e) { out.append(el('div', 'alert bad', e.message)); return; }
  const a = el('div', 'alert', 'Testing the game: importing, then running the smoke test…'); out.append(a);
  clearInterval(S.smokePoll);
  S.smokePoll = setInterval(async () => {
    const st = await api('GET', `/api/worlds/${S.wid}/smoke`).catch(() => null);
    if (!st) return;
    if (st.running) { a.textContent = `Testing the game: ${st.step || 'running'}…`; return; }
    clearInterval(S.smokePoll);
    out.textContent = '';
    if (st.error) { out.append(el('div', 'alert bad', st.error)); return; }
    const res = el('div', 'alert ' + (st.passed ? 'good' : 'bad'));
    res.append(el('b', '', st.passed ? `The game passes: ${st.checks} checks, 0 failed.` : `The test found problems${st.checks != null ? `: ${st.failed} of ${st.checks} checks failed` : ''}${st.errors.length ? `, ${st.errors.length} errors` : ''}.`));
    if (!st.passed) {
      const undrawn = st.fails.map((f) => (f.match(/^FAIL: (\w+) is drawn for/) || [])[1]);
      if (st.timed_out) res.append(document.createTextNode(' It didn’t finish within 4 minutes: something it waits for never happened, often because a way it walks now leads somewhere else.'));
      else if (st.fails.length && !st.errors.length && undrawn.every(Boolean)) {
        res.append(document.createTextNode(` The only failures are pictures: ${[...new Set(undrawn)].join(', ')} ${new Set(undrawn).size > 1 ? 'have' : 'has'} no art for every time of day yet. Expected for new stand-in scenes; it passes once they are drawn.`));
      } else res.append(document.createTextNode(' Changes to the ways often break checks written for the old ones: ask Claude to update the test or fix the scenes.'));
      const log = el('div', 'log', [...st.fails, ...st.errors].slice(0, 60).join('\n') || st.log_tail.join('\n'));
      out.append(res, log); return;
    }
    out.append(res);
  }, 1500);
}

async function openSettings() {
  const w = JSON.parse(JSON.stringify(S.world));
  let projects = [];
  try { projects = (await api('GET', '/api/godot-projects')).projects; } catch { /* offline */ }
  openModal((box) => {
    modalHead(box, 'World settings', 'Saved when you press Save; Undo goes back.');
    const body = el('div', 'modal-body'); box.append(body);
    const name = el('input'); name.value = w.name; if (!CS) body.append(field('Name', name));
    const proj = el('select');
    { const o = el('option', '', 'Not linked: a plan only'); o.value = ''; proj.append(o); }
    for (const p of projects) { const o = el('option', '', `${p.name} (${p.path.replace(/^\/home\/[^/]+/, '~')})`); o.value = p.path; proj.append(o); }
    if (w.godot && !projects.some((p) => p.path === w.godot)) { const o = el('option', '', w.godot); o.value = w.godot; proj.append(o); }
    { const o = el('option', '', 'Another folder…'); o.value = '__other'; proj.append(o); }
    proj.value = w.godot || '';
    const other = el('input', 'mono'); other.placeholder = '/home/you/Projects/my-game'; other.hidden = true;
    proj.addEventListener('change', () => { other.hidden = proj.value !== '__other'; });
    const pf = field('Godot project', proj, 'Linked, Plastico reads its scenes and exits (a new scene in the game shows up here by itself) and can build the plan there.'); pf.append(other); body.append(pf);
    const linked = !!w.godot;
    let phasesIn = null, startSel = null;
    if (!linked) {
      phasesIn = el('input'); phasesIn.value = (w.phases || []).join(', '); phasesIn.placeholder = 'morning, day, sunset, night';
      body.append(field('Times of day', phasesIn, 'Leave empty if time doesn’t matter in this game.'));
    } else body.append(el('p', 'none', `Times of day and the start come from the game: ${w.phases.join(', ') || 'none'}; starts in ${(S.M.scenes.get(w.start) || {}).name || '?'}.`));
    // acts
    const acts = el('div', 'listed'); const actsF = field('Acts', acts, 'An act can be its own island: give it a start scene and Plastico checks it on its own.');
    const drawActs = () => {
      acts.textContent = '';
      w.acts.forEach((a, i) => {
        const row = el('div', 'row'); row.style.gridTemplateColumns = '54px 1fr 150px 30px';
        row.append(el('span', 'mono', `Act ${a.id}`));
        const n = el('input'); n.value = a.name; n.placeholder = 'Title'; n.addEventListener('input', () => { a.name = n.value; });
        const st = el('select'); { const o = el('option', '', 'Start: none'); o.value = ''; st.append(o); }
        for (const s of w.scenes.filter((q) => q.act === a.id)) { const o = el('option', '', s.name); o.value = s.id; st.append(o); }
        st.value = a.start || ''; st.addEventListener('change', () => { a.start = st.value; });
        const x = btn('×', 'btn icon small', () => { if (w.acts.length === 1) return; const to = w.acts[i === 0 ? 1 : 0].id; for (const s of w.scenes) if (s.act === a.id) s.act = to; w.acts.splice(i, 1); drawActs(); }, 'Remove the act (its scenes move to another)');
        x.disabled = w.acts.length === 1;
        row.append(n, st, x); acts.append(row);
      });
      acts.append(btn('Add an act', 'btn small', () => { const n = Math.max(0, ...w.acts.map((a) => parseInt(a.id, 10) || 0)) + 1; w.acts.push({ id: String(n), name: '', start: '' }); drawActs(); }));
    };
    drawActs(); body.append(actsF);
    // areas
    const areas = el('div', 'listed'); const areasF = field('Areas', areas, 'Parts of the world (a district, a building): they colour its scenes.');
    const drawAreas = () => {
      areas.textContent = '';
      w.areas.forEach((a, i) => {
        const row = el('div', 'row'); row.style.gridTemplateColumns = '1fr auto 30px';
        const n = el('input'); n.value = a.name; n.addEventListener('input', () => { a.name = n.value; });
        const cs = el('div', 'colors');
        for (let c = 0; c < 8; c++) { const b = btn('', '', () => { a.color = c; drawAreas(); }, `Colour ${c + 1}`); b.style.background = `var(--a${c})`; b.setAttribute('aria-pressed', (a.color ?? 0) === c); cs.append(b); }
        const x = btn('×', 'btn icon small', () => { for (const s of w.scenes) if (s.area === a.id) s.area = ''; w.areas.splice(i, 1); drawAreas(); }, 'Remove the area');
        row.append(n, cs, x); areas.append(row);
      });
      areas.append(btn('Add an area', 'btn small', () => { w.areas.push({ id: 'area_' + Math.random().toString(36).slice(2, 7), name: 'New area', color: w.areas.length % 8 }); drawAreas(); }));
    };
    drawAreas(); body.append(areasF);
    // people
    const ppl = el('div', 'listed'); const pplF = field('People', ppl, 'Who can be placed in scenes. Ids match the game’s characters/<id>/ folders.');
    const drawPeople = () => {
      ppl.textContent = '';
      w.people.forEach((p, i) => {
        const row = el('div', 'row'); row.style.gridTemplateColumns = '130px 1fr 30px';
        const id = el('input', 'mono'); id.value = p.id; id.addEventListener('change', () => {
          const v = id.value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_'); if (!v || w.people.some((q) => q !== p && q.id === v)) { id.value = p.id; return; }
          for (const s of w.scenes) for (const g of [s.people, s.away]) for (const k of Object.keys(g || {})) g[k] = g[k].map((q) => (q === p.id ? v : q));
          p.id = v;
        });
        const n = el('input'); n.value = p.name; n.addEventListener('input', () => { p.name = n.value; });
        const x = btn('×', 'btn icon small', () => { for (const s of w.scenes) for (const g of [s.people, s.away]) for (const k of Object.keys(g || {})) g[k] = g[k].filter((q) => q !== p.id); w.people.splice(i, 1); drawPeople(); }, 'Remove');
        row.append(id, n, x); ppl.append(row);
      });
      ppl.append(btn('Add a person', 'btn small', () => { w.people.push({ id: 'person_' + Math.random().toString(36).slice(2, 6), name: '' }); drawPeople(); }));
    };
    drawPeople(); body.append(pplF);
    const foot = el('div', 'modal-foot'); const l = el('div', 'l'), r = el('div', 'r');
    if (!CS) l.append(armed('Delete this world', 'Click again: it goes to Plastico’s trash', async () => {
      await api('DELETE', `/api/worlds/${S.wid}`); closeModal(); lsSet('plastico:last', ''); await boot();
    }));
    r.append(btn('Cancel', 'btn', closeModal), btn('Save', 'btn primary', async () => {
      const godot = proj.value === '__other' ? other.value.trim() : proj.value;
      const relink = godot !== S.world.godot;
      edit((x) => {
        x.name = name.value.trim() || x.name; x.godot = godot;
        if (phasesIn) x.phases = phasesIn.value.split(',').map((q) => q.trim().toLowerCase()).filter(Boolean);
        x.acts = w.acts; x.areas = w.areas; x.people = w.people;
        for (const s of x.scenes) { const ws = w.scenes.find((q) => q.id === s.id); if (ws) { s.act = ws.act; s.area = ws.area; s.people = ws.people; s.away = ws.away; } }
      });
      closeModal();
      if (relink) { await flushSave(); await loadWorld(S.wid, { keepView: false }); }
      S.worlds = (await api('GET', '/api/worlds')).worlds; renderSide();
    }));
    foot.append(l, r); box.append(foot);
    void startSel;
  });
}

async function openNewWorld() {
  let projects = [];
  try { projects = (await api('GET', '/api/godot-projects')).projects; } catch { /* offline */ }
  openModal((box) => {
    modalHead(box, 'New world', 'A new game, or a part of one you want to plan apart from the rest.');
    const body = el('div', 'modal-body'); box.append(body);
    const name = el('input'); name.placeholder = 'My game, act 2'; body.append(field('Name', name));
    const proj = el('select');
    { const o = el('option', '', 'Start empty: a plan only'); o.value = ''; proj.append(o); }
    for (const p of projects) { const o = el('option', '', `Read the scenes of ${p.name}`); o.value = p.path; proj.append(o); }
    body.append(field('Start from', proj, 'Linked to a Godot project, the world shows its scenes and exits and can build into it. You can link it later.'));
    const foot = el('div', 'modal-foot'); const r = el('div', 'r');
    const go = btn('Create', 'btn primary', async () => {
      go.disabled = true;
      try {
        const res = await api('POST', '/api/worlds', { name: name.value.trim() || 'New world', godot: proj.value });
        closeModal();
        S.worlds = (await api('GET', '/api/worlds')).worlds;
        applyBundle(res, { fit: true });
      } catch (e) { go.disabled = false; toast(e.message); }
    });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
    r.append(btn('Cancel', 'btn', closeModal), go); foot.append(el('div', 'l'), r); box.append(foot);
  }, true);
}

/* ------------------------------------------------------------------ the act on screen */
// One act for the whole suite: the act shown here is the act of the chart Puzzle Charts opens, and the
// other way round. `announce`: tell the other modules (not when following them).
function showAct(a, announce = true) {
  if (a !== 'all' && !(S.world && S.world.acts.some((x) => x.id === a))) a = 'all';
  S.ui.act = a;
  if (announce && CS && CS.setAct) CS.setAct(a);
}
const onScreen = () => { try { return !window.frameElement || !window.frameElement.hidden; } catch { return true; } };

/* ------------------------------------------------------------------ loading */
function applyBundle(b, opts = {}) {
  const changedWorld = S.wid !== b.world.id;
  S.bundle = b; S.wid = b.world.id; S.world = JSON.parse(JSON.stringify(b.world)); S.rev = b.world.rev;
  if (changedWorld) { S.undo = []; S.redo = []; S.sel = null; S.route = null; S.play = null; view.setToken(null); view.forgetTextures(); S.ui.act = 'all'; S.ui.area = ''; showAct(CS && CS.act ? CS.act() : 'all', false); }
  lsSet('plastico:last', S.wid);
  derive();
  renderAll();
  setStatus('saved');
  if (opts.fit || changedWorld) {
    const cam = lsGet(`plastico:cam:${S.wid}`);
    if (cam && !opts.fit) { try { view.restoreCamera(JSON.parse(cam)); } catch { view.fit(null, true); } }
    else view.fit(null, true);
  }
}
async function loadWorld(id, opts = {}) {
  $('#loading').hidden = false;
  try {
    const b = await api('GET', `/api/worlds/${id}`);
    applyBundle(b, opts.keepView ? {} : { fit: false });
  } catch (e) {
    toast(`Couldn’t open that world: ${e.message}`);
  } finally { $('#loading').hidden = true; }
}
async function refresh(say) {
  if (!S.wid) return;
  if (S.dirty || S.saving) await flushSave();
  try {
    const b = await api('GET', `/api/worlds/${S.wid}`);
    const before = JSON.stringify([S.bundle.game && S.bundle.game.exits, S.bundle.game && Object.keys(S.bundle.game.scenes), S.rev, chartKey(S.bundle.charts)]);
    const after = JSON.stringify([b.game && b.game.exits, b.game && Object.keys(b.game.scenes), b.world.rev, chartKey(b.charts)]);
    if (before !== after || say) { const sel = S.sel; applyBundle(b, {}); S.sel = sel; derive(); renderInspector(); refreshHighlight(); }
    else { S.bundle.changes = b.changes; S.bundle.last_build = b.last_build; S.bundle.game = b.game; }
    if (say) toast(b.game ? `Read ${b.game.name} again: ${Object.keys(b.game.scenes).length} scenes, ${b.game.exits.filter((e) => e.to).length} exits.` : 'Reloaded.');
  } catch (e) { if (say) toast(e.message); }
}
function chartKey(c) { return c && c.charts ? c.charts.map((x) => [x.id, x.name, x.nodes, x.edges]) : null; }
function renderAll() { renderHeader(); renderSide(); renderPhases(); renderView(); renderInspector(); renderBanner(); }

async function boot() {
  setStatus('loading');
  try { S.worlds = (await api('GET', '/api/worlds')).worlds; }
  catch { setStatus('err', 'Offline'); $('#loading').textContent = 'Plastico’s server isn’t running. Start it from the desktop icon.'; return; }
  const last = lsGet('plastico:last');
  const id = S.worlds.some((w) => w.id === last) ? last : S.worlds[0] && S.worlds[0].id;
  if (id) await loadWorld(id);
  else { S.world = null; S.wid = null; S.M = null; renderHeader(); renderSide(); renderInspector(); updateEmpty(); setStatus('saved', 'Ready'); view.set({ M: model.derive({ scenes: [], links: [], people: [], acts: [{ id: '1' }], areas: [], phases: [] }, null, null), ui: S.ui, visible: new Set(), hl: null, pictureUrl, renderLabel, labelClasses }); }
}

/* ------------------------------------------------------------------ wiring */
function closeDrawer() { $('#app').classList.remove('drawer-open'); $('#scrim').hidden = true; }
function menu(btnEl, menuEl, fill) {
  btnEl.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menuEl.hidden;
    document.querySelectorAll('.menu').forEach((m) => { m.hidden = true; });
    if (open) { if (fill) fill(menuEl); menuEl.hidden = false; btnEl.setAttribute('aria-expanded', 'true'); }
  });
}
document.addEventListener('click', () => { document.querySelectorAll('.menu').forEach((m) => { m.hidden = true; }); document.querySelectorAll('[aria-expanded]').forEach((b) => b.setAttribute('aria-expanded', 'false')); });

$('#btn-add').addEventListener('click', () => openAddScene());
menu($('#btn-more'), $('#menu-more'));
$('#menu-more').addEventListener('click', (e) => {
  const a = e.target.closest('[data-act]'); if (!a) return;
  ({
    settings: openSettings,
    tidy: () => { const ids = [...visibleIds()]; const pos = model.tidy(S.M, ids); edit((w) => { for (const s of w.scenes) if (pos.has(s.id)) Object.assign(s, pos.get(s.id)); }); view.fit(); },
    fit: () => view.fit(),
    refresh: () => refresh(true),
    'copy-json': async () => { const t = JSON.stringify(S.world, null, 1); try { await navigator.clipboard.writeText(t); toast('The plan is on the clipboard as JSON.'); } catch { toast('Copying wasn’t allowed here.'); } },
    screenshot: () => { const a2 = el('a'); a2.href = view.screenshot(); a2.download = `${S.wid || 'world'}.png`; a2.click(); },
  }[a.dataset.act] || (() => {}))();
});
document.querySelectorAll('.side-sec [data-act="settings"]').forEach((b) => b.addEventListener('click', openSettings));
$('#btn-new-world').addEventListener('click', openNewWorld);
$('#btn-route').addEventListener('click', () => (S.route ? stopRoute() : startRoute()));
$('#btn-play').addEventListener('click', () => (S.play ? stopPlay() : startPlay()));
$('#btn-undo').addEventListener('click', undo);
$('#btn-redo').addEventListener('click', redo);
$('#btn-godot').addEventListener('click', openGodot);
$('#btn-drawer').addEventListener('click', () => { $('#app').classList.add('drawer-open'); $('#scrim').hidden = false; });
$('#scrim').addEventListener('click', closeDrawer);
$('#v-skeleton').addEventListener('click', () => setMode('skeleton'));
$('#v-pictures').addEventListener('click', () => setMode('pictures'));
$('#v-people').addEventListener('click', () => togglePeople());
$('#v-steps').addEventListener('click', () => toggleSteps());
$('#v-names').addEventListener('click', () => toggleNames());
$('#z-in').addEventListener('click', () => view.zoom(0.75));
$('#z-out').addEventListener('click', () => view.zoom(1.33));
$('#z-fit').addEventListener('click', () => view.fit());
$('#z-top').addEventListener('click', () => toggleTop());
$('#modal').addEventListener('pointerdown', (e) => { if (e.target.id === 'modal') closeModal(); });
function toggleTop() { S.ui.top = !S.ui.top; $('#z-top').setAttribute('aria-pressed', S.ui.top); view.setTop(S.ui.top); }

// The keys are the suite's (web/shared/keys.js), which the person can change in Cassetto's settings.
// On its own, Plastico has no such list and keeps the keys it always had.
const KEYS = window.CassettoKeys || null;
function defaultAction(e) {
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && !e.altKey && k === 'z') return e.shiftKey ? 'plastico.redo' : 'plastico.undo';
  if (mod && !e.altKey && k === 'y') return 'plastico.redo';
  if (mod || e.altKey) return null;
  if (e.key === 'Delete' || e.key === 'Backspace') return 'plastico.delete';
  if (/^[1-9]$/.test(k)) return `plastico.phase${k}`;
  return { f: 'plastico.fit', t: 'plastico.top', s: 'plastico.mode', n: 'plastico.add', r: 'plastico.route', p: 'plastico.play', '=': 'plastico.zoomIn', '-': 'plastico.zoomOut' }[k] || null;
}
const togglePeople = () => { S.ui.people = !S.ui.people; $('#v-people').setAttribute('aria-pressed', S.ui.people); renderView(); };
const toggleSteps = () => { S.ui.steps = !S.ui.steps; $('#v-steps').setAttribute('aria-pressed', S.ui.steps); renderView(); };
// the scene names: off leaves a dot per scene (its name opens on hover) and the selected scene's name
const setNames = (on) => { S.ui.names = on; lsSet('plastico:names', on ? 'on' : 'off'); $('#v-names').setAttribute('aria-pressed', on); view.dirty = true; };
const toggleNames = () => setNames(!S.ui.names);
const ACTIONS = {
  'plastico.undo': () => undo(),
  'plastico.redo': () => redo(),
  'plastico.delete': () => {
    if (S.sel && S.sel.type === 'scene') deleteScene(S.sel.id);
    else if (S.sel && S.sel.type === 'pair') deletePair(S.sel.key);
  },
  'plastico.fit': () => view.fit(),
  'plastico.top': () => toggleTop(),
  'plastico.mode': () => setMode(S.ui.mode === 'skeleton' ? 'pictures' : 'skeleton'),
  'plastico.add': () => openAddScene(),
  'plastico.route': () => (S.route ? stopRoute() : startRoute()),
  'plastico.play': () => (S.play ? stopPlay() : startPlay()),
  'plastico.zoomIn': () => view.zoom(0.75),
  'plastico.zoomOut': () => view.zoom(1.33),
  'plastico.people': togglePeople,
  'plastico.steps': toggleSteps,
  'plastico.names': toggleNames,
};
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  if (e.key === 'Escape') {
    if (!$('#modal').hidden) { closeModal(); return; }
    if (typing) { e.target.blur(); return; }
    if (S.route) stopRoute(); else if (S.play) stopPlay(); else select(null);
    return;
  }
  if (!$('#modal').hidden || typing || e.defaultPrevented) return;
  const id = KEYS ? KEYS.find(e, 'plastico') : defaultAction(e);
  if (!id) return;
  const ph = /^plastico\.phase(\d)$/.exec(id);
  if (id !== 'plastico.undo' && id !== 'plastico.redo' && !S.world) return;
  e.preventDefault();
  if (ph) { if (S.M && S.M.phases[+ph[1] - 1]) setPhase(S.M.phases[+ph[1] - 1]); return; }
  if (ACTIONS[id]) ACTIONS[id]();
});
if (KEYS) KEYS.onChange(() => { renderPhases(); if (!S.sel) renderInspector(); });
window.addEventListener('focus', () => { if ($('#modal').hidden && !S.dirty && !S.saving) refresh(false); });
if (CS) {
  const quiet = () => $('#modal').hidden && !S.dirty && !S.saving;
  CS.on('puzzles.changed', () => { if (quiet()) refresh(false); });
  CS.on('world.changed', (ev) => { if ((ev.source !== 'plastico' || (ev.data && ev.data.by === 'suite')) && quiet()) refresh(false); });
  CS.on('activate', () => {
    if (S.fitOnShow) { S.fitOnShow = false; requestAnimationFrame(() => view.fit()); }
    if (quiet()) refresh(false);
  });
  // another module shows another act (a chart of that act opened in Puzzle Charts): show it here too
  CS.on('act', (ev) => {
    const a = ev && ev.act;
    if (!S.world || !a || a === S.ui.act || (a !== 'all' && !S.world.acts.some((x) => x.id === a))) return;
    showAct(a, false); renderSide(); renderView(); if (!S.sel) renderInspector();
    if (onScreen()) view.fit(); else S.fitOnShow = true;   // a hidden page has no size to fit to
  });
  CS.register({
    flush: () => flushSave(),
    move: async (m) => {
      for (let i = 0; i < 50 && !S.world; i++) await new Promise((r) => setTimeout(r, 100));
      if (!S.world) throw new Error('Plastico hasn’t loaded the world yet.');
      const said = treeMove(m);
      if (said) await flushSave();
      return said;
    },
    navigate: async (t) => {
      if (!t) return;
      for (let i = 0; i < 50 && !S.world; i++) await new Promise((r) => setTimeout(r, 100));
      if (t.act && S.world && !t.scene) {
        showAct(t.act); select(null); renderSide(); renderView(); view.fit(); return;
      }
      if (!t.scene) return;
      if (S.ui.act !== 'all') { const sc = S.M && S.M.scenes.get(t.scene); if (sc && sc.act !== S.ui.act) { showAct(sc.act); renderSide(); renderView(); } }
      if (S.M && S.M.scenes.has(t.scene)) { select({ type: 'scene', id: t.scene }); view.focus(t.scene); }
      else toast(`There’s no scene ${t.scene} in this world.`);
    },
  });
}
let camTimer = 0;
view.controls.addEventListener('change', () => {
  clearTimeout(camTimer);
  camTimer = setTimeout(() => {
    if (!S.wid) return;
    lsSet(`plastico:cam:${S.wid}`, JSON.stringify(view.cameraState()));
  }, 400);
});

renderKey();
setMode(lsGet('plastico:mode') === 'pictures' ? 'pictures' : 'skeleton');
setNames(lsGet('plastico:names') !== 'off');
window.plastico = { S, view, model };
boot();
