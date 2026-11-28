/* The suite's keyboard shortcuts, the same in the shell and in every module page.
 *
 * Every shortcut is an action with an id ("plastico.fit"), the place it works in (its scope: "suite"
 * works everywhere, a module's id works in that module's page) and its default keys. A person can
 * give an action other keys, more than one, or none. Only what differs from the defaults is kept:
 *
 *   ~/.config/cassetto/keybindings.json   {"format": "cassetto.keys", "version": 1, "bindings": {id: [chord, ...]}}
 *
 * through /api/core/settings/keys, with a copy in localStorage so a page starts with the right keys
 * before the server answers. A page that isn't in Cassetto (Plastico or Puzzle Charts on their own)
 * keeps the defaults and whatever its own localStorage holds.
 *
 * A chord is a string like "Ctrl+Shift+Z": the modifiers in the order Ctrl, Alt, Shift, then one key.
 * Ctrl also means ⌘ on a Mac. Letters are upper case, digits come from the key's place (Shift+1 is
 * "Shift+1" on every layout), other characters are what the key types ("?", ",", "="), named keys are
 * "Delete", "Backspace", "Enter", "Space", "Up", "F2"...
 *
 *   CassettoKeys.find(event, scope)      the action this key press means in that scope, or null
 *   CassettoKeys.keys(id) / label(id)    an action's chords now / the first one, as shown ("Ctrl+Z")
 *   CassettoKeys.actions()               every action, with its keys now
 *   CassettoKeys.set(id, chords)         give an action these keys (kept, and sent to every page)
 *   CassettoKeys.reset(id) / resetAll()  back to the defaults
 *   CassettoKeys.conflicts(chord, id)    the actions that already use a chord where `id` works
 *   CassettoKeys.onChange(fn)            called after any change; returns an unsubscribe
 *   CassettoKeys.decorate(root)          puts the keys in the titles of [data-keys="<id>"] elements
 */
(function () {
  'use strict';
  const LS = 'cassetto:keys';
  const API = '/api/core/settings/keys';
  const MAC = /Mac|iPhone|iPad/.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');

  /* ------------------------------------------------------------------ the actions */
  // [id, label, defaults, more]: more = {sub, group}
  const SCOPES = [
    { id: 'suite', title: 'Everywhere', sub: 'Work in every module, and win over a module’s own keys' },
    { id: 'plastico', title: 'Plastico', sub: 'The world in 3D' },
    { id: 'puzzles', title: 'Puzzle Charts', sub: 'Puzzle dependency charts' },
  ];
  const A = [];
  const add = (scope, group, list) => { for (const [id, label, keys, sub] of list) A.push({ id, scope, group, label, sub: sub || '', defaults: keys }); };
  add('suite', 'Cassetto', [
    ['suite.settings', 'Open settings', ['Ctrl+,']],
    ['suite.shortcuts', 'Show the keyboard shortcuts', ['Ctrl+/']],
    ['suite.tree', 'Show or hide the project tree', ['Ctrl+B']],
    ['suite.theme', 'Switch to the next theme', [], 'System, light, dark, black'],
  ]);
  add('suite', 'Modules', [
    ['suite.go.plastico', 'Go to Plastico', ['Ctrl+1']],
    ['suite.go.puzzles', 'Go to Puzzle Charts', ['Ctrl+2']],
    ['suite.next', 'Go to the next module', []],
    ['suite.prev', 'Go to the previous module', []],
  ]);
  add('suite', 'Project', [
    ['suite.new', 'New project…', []],
    ['suite.open', 'Open a project…', ['Ctrl+O']],
    ['suite.rename', 'Rename the project…', []],
    ['suite.export', 'Export the project…', [], 'The whole project in one .cassetto file'],
    ['suite.info', 'About this project', []],
  ]);
  add('plastico', 'Edit', [
    ['plastico.undo', 'Undo', ['Ctrl+Z']],
    ['plastico.redo', 'Redo', ['Ctrl+Shift+Z', 'Ctrl+Y']],
    ['plastico.add', 'Add a scene', ['N']],
    ['plastico.delete', 'Remove the selection', ['Delete', 'Backspace'], 'A scene, or a way between two scenes'],
  ]);
  add('plastico', 'Tools', [
    ['plastico.route', 'Find a route', ['R'], 'The shortest way between two scenes'],
    ['plastico.play', 'Play test', ['P'], 'Walk the world as the player would'],
  ]);
  add('plastico', 'View', [
    ['plastico.mode', 'Skeleton or pictures', ['S']],
    ['plastico.top', 'Map view', ['T'], 'Look straight down'],
    ['plastico.fit', 'Fit the world to the screen', ['F']],
    ['plastico.zoomIn', 'Zoom in', ['=']],
    ['plastico.zoomOut', 'Zoom out', ['-']],
    ['plastico.names', 'Show or hide scene names', []],
    ['plastico.people', 'Show or hide people', []],
    ['plastico.steps', 'Show or hide puzzle steps', []],
  ]);
  add('plastico', 'States', Array.from({ length: 9 }, (_, i) => [`plastico.phase${i + 1}`, `State ${i + 1}`, [String(i + 1)], i === 0 ? 'Of the act on screen, in the order the act lists them' : '']));
  add('puzzles', 'Edit', [
    ['puzzles.undo', 'Undo', ['Ctrl+Z']],
    ['puzzles.redo', 'Redo', ['Ctrl+Shift+Z', 'Ctrl+Y']],
    ['puzzles.add', 'Add a step', ['N'], 'Opens the list of kinds'],
    ['puzzles.delete', 'Delete the selection', ['Delete', 'Backspace'], 'A step, or a link between two'],
    ['puzzles.arrange', 'Auto-arrange on or off', []],
    ['puzzles.new', 'New chart', []],
  ]);
  add('puzzles', 'Tools', [
    ['puzzles.play', 'Play test', ['P'], 'Walk through the chart as the player would'],
    ['puzzles.info', 'Chart details', []],
  ]);
  add('puzzles', 'View', [
    ['puzzles.fit', 'Fit the chart to the screen', ['F']],
    ['puzzles.zoomIn', 'Zoom in', ['=']],
    ['puzzles.zoomOut', 'Zoom out', ['-']],
  ]);
  // keys that do one thing everywhere and can't be changed, listed so nobody looks for them
  const FIXED = [
    { scope: 'suite', keys: ['Escape'], label: 'Close, cancel, or let go of the selection' },
    { scope: 'suite', keys: ['Tab', 'Shift+Tab'], label: 'Move between buttons and fields' },
    { scope: 'plastico', keys: ['Shift'], label: 'Hold while dragging a scene to place it off the grid' },
    { scope: 'puzzles', keys: ['Shift'], label: 'Hold while dragging a step to place it freely' },
  ];
  // Plain keys the suite keeps for moving around: they can't start an action on their own.
  const RESERVED = new Set(['Escape', 'Tab', 'Shift+Tab', 'Enter', 'Space']);
  // What a browser window may keep for itself whatever the page asks (the native window doesn't).
  const BROWSER = new Set(['Ctrl+W', 'Ctrl+T', 'Ctrl+N', 'Ctrl+Q', 'Ctrl+Shift+W', 'Ctrl+Shift+T', 'Ctrl+Shift+N', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'F11']);

  const byId = new Map(A.map((a) => [a.id, a]));
  const scopeOf = (id) => (byId.get(id) || {}).scope;

  /* ------------------------------------------------------------------ chords */
  const NAMED = {
    ' ': 'Space', Spacebar: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Esc: 'Escape', Del: 'Delete', '+': 'Plus', OS: 'Meta',
  };
  const MODS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS', 'Hyper', 'Super', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'FnLock']);
  // The key of a key press, as chords name it, and whether Shift is part of that name already.
  function keyOf(e) {
    if (!e.key || MODS.has(e.key) || e.key === 'Unidentified' || e.key === 'Dead' || e.key === 'Process') return null;
    const c = e.code || '';
    let m = /^(?:Digit|Numpad)(\d)$/.exec(c);
    if (m) return { k: m[1], shifted: false };
    if (NAMED[e.key]) return { k: NAMED[e.key], shifted: false };
    if (e.key.length === 1) {
      if (/\p{L}/u.test(e.key)) {     // a letter; on a non-Latin layout, the Latin letter in the same place
        m = /^Key([A-Z])$/.exec(c);
        return { k: /[a-z]/i.test(e.key) || !m ? e.key.toUpperCase() : m[1], shifted: false };
      }
      return { k: e.key, shifted: true };     // "?" already says Shift on the layouts that need it
    }
    return { k: e.key[0].toUpperCase() + e.key.slice(1), shifted: false };
  }
  function chord(e) {
    const k = keyOf(e); if (!k) return null;
    const p = [];
    if (e.ctrlKey || e.metaKey) p.push('Ctrl');
    if (e.altKey) p.push('Alt');
    if (e.shiftKey && !k.shifted) p.push('Shift');
    p.push(k.k);
    return p.join('+');
  }
  // the modifiers held right now, for a recorder to show while it waits for the key
  function held(e) {
    const p = [];
    if (e.ctrlKey || e.metaKey || e.key === 'Control' || e.key === 'Meta') p.push('Ctrl');
    if (e.altKey || e.key === 'Alt') p.push('Alt');
    if (e.shiftKey || e.key === 'Shift') p.push('Shift');
    return p;
  }
  const parts = (c) => (c === 'Plus' ? ['Plus'] : String(c).split('+').map((x) => x || 'Plus'));
  const hasMod = (c) => /^(Ctrl|Alt)\+/.test(c) || /^F\d{1,2}$/.test(c);
  const SHOW = MAC
    ? { Ctrl: '⌘', Alt: '⌥', Shift: '⇧', Backspace: '⌫', Delete: '⌦', Enter: '↩', Escape: 'Esc', Up: '↑', Down: '↓', Left: '←', Right: '→', Plus: '+', Tab: '⇥' }
    : { Up: '↑', Down: '↓', Left: '←', Right: '→', Plus: '+', Escape: 'Esc' };
  const show = (part) => SHOW[part] || part;
  const text = (c) => (c ? parts(c).map(show).join(MAC ? '' : '+') : '');

  /* ------------------------------------------------------------------ what the person chose */
  let over = {};                      // id -> [chords], only where it differs from the defaults
  const subs = new Set();
  const clean = (o) => {
    const out = {};
    if (!o || typeof o !== 'object') return out;
    for (const [id, v] of Object.entries(o)) if (Array.isArray(v)) out[id] = [...new Set(v.filter((c) => typeof c === 'string' && c))].slice(0, 4);
    return out;
  };
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const keys = (id) => { const a = byId.get(id); return over[id] ? over[id].slice() : a ? a.defaults.slice() : []; };
  const changed = (id) => !!over[id] && byId.has(id) && !same(over[id], byId.get(id).defaults);

  // a chord -> action ids, per scope; rebuilt on every change
  let index = new Map();
  function reindex() {
    index = new Map();
    for (const a of A) for (const c of keys(a.id)) {
      const k = `${a.scope}|${c}`; if (!index.has(k)) index.set(k, []); index.get(k).push(a.id);
    }
  }
  function adopt(o, quiet) {
    const next = clean(o);
    if (JSON.stringify(next) === JSON.stringify(over)) return false;
    over = next; reindex();
    if (!quiet) notify();
    return true;
  }
  function notify() {
    decorate(document);
    for (const fn of [...subs]) { try { fn(); } catch (e) { console.error(e); } }
  }
  function readLocal() { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch (e) { return {}; } }
  function writeLocal() { try { localStorage.setItem(LS, JSON.stringify(over)); } catch (e) { /* storage off */ } }

  let saveTimer = 0, saving = Promise.resolve();
  const failSubs = new Set();
  function persist() {
    writeLocal();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistNow, 250);
  }
  function persistNow() {
    saveTimer = 0;
    const body = JSON.stringify({ bindings: over });
    saving = fetch(API, { method: 'PUT', headers: { 'X-Cassetto': '1', 'Content-Type': 'application/json' }, body, keepalive: true })
      .then((r) => { if (!r.ok && r.status !== 404) throw new Error(`The shortcuts weren’t saved (HTTP ${r.status}).`); })
      .catch((e) => { for (const fn of failSubs) { try { fn(e); } catch (x) { /* */ } } });
  }
  function commit(next) {
    over = next; reindex(); persist();
    pushToFrames();
    notify();
  }
  // the shell hands every change straight to its module pages; pages elsewhere hear the storage event
  function pushToFrames() {
    for (const f of document.querySelectorAll('iframe')) {
      try { if (f.contentWindow && f.contentWindow.CassettoKeys) f.contentWindow.CassettoKeys.adopt(over); } catch (e) { /* another origin */ }
    }
  }
  function set(id, list) {
    const a = byId.get(id); if (!a) return;
    const want = [...new Set((list || []).filter(Boolean))].slice(0, 4);
    const next = { ...over };
    if (same(want, a.defaults)) delete next[id]; else next[id] = want;
    commit(next);
  }
  function reset(id) { const next = { ...over }; delete next[id]; commit(next); }
  function resetAll() { commit({}); }

  // Where an action works, which others its keys would collide with: the suite's keys are read before
  // any module's, so a suite action collides with every module and a module action with the suite.
  function overlaps(sa, sb) { return sa === sb || sa === 'suite' || sb === 'suite'; }
  function conflicts(c, id) {
    const s = scopeOf(id);
    return A.filter((a) => a.id !== id && overlaps(s, a.scope) && keys(a.id).includes(c)).map((a) => a.id);
  }
  function problem(c, id) {
    if (RESERVED.has(c)) return `${text(c)} is kept for moving around Cassetto. Use it with Ctrl or Alt.`;
    if (scopeOf(id) === 'suite' && !hasMod(c)) return `Keys that work everywhere need Ctrl or Alt (or an F key), so typing in a field never sets them off.`;
    return '';
  }

  function find(e, scope) {
    const c = chord(e); if (!c) return null;
    const l = index.get(`${scope}|${c}`);
    return l ? l[0] : null;
  }

  // titles that name their keys: data-keys="id" (or "id1 id2"); the title's trailing "(...)" is replaced
  function decorate(root) {
    if (!root || !root.querySelectorAll) return;
    for (const n of root.querySelectorAll('[data-keys]')) {
      if (n.dataset.keysBase == null) n.dataset.keysBase = (n.getAttribute('title') || '').replace(/\s*\([^()]*\)\s*$/, '');
      const ks = n.dataset.keys.split(/\s+/).map((id) => label(id)).filter(Boolean);
      const base = n.dataset.keysBase;
      if (base || ks.length) n.setAttribute('title', ks.length ? `${base} (${ks.join(', ')})` : base);
      for (const s of n.querySelectorAll('[data-keys-text]')) { s.textContent = ks[0] ? `${s.dataset.keysText}${ks[0]}` : ''; s.hidden = !ks[0]; }
    }
  }
  const label = (id) => text(keys(id)[0] || '');

  /* ------------------------------------------------------------------ start */
  let parentKeys = null;
  try { if (window.parent !== window && window.parent.CassettoKeys) parentKeys = window.parent.CassettoKeys; } catch (e) { parentKeys = null; }
  adopt(parentKeys ? parentKeys.overrides() : readLocal(), true);
  reindex();
  window.addEventListener('storage', (e) => { if (e.key === LS) adopt(readLocal()); });
  if (!parentKeys) {       // the top page asks the server, whose file wins over this browser's copy
    fetch(API, { headers: { 'X-Cassetto': '1' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && d.bindings && adopt(d.bindings)) { writeLocal(); pushToFrames(); } })
      .catch(() => { /* on its own, or offline: the local copy stands */ });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => decorate(document));
  else decorate(document);

  window.CassettoKeys = {
    mac: MAC, scopes: SCOPES, fixed: FIXED,
    actions: () => A.map((a) => ({ ...a, keys: keys(a.id), changed: changed(a.id) })),
    action: (id) => (byId.has(id) ? { ...byId.get(id), keys: keys(id), changed: changed(id) } : null),
    define(list) {      // actions only the running suite knows of, such as "Go to" a module added later
      let n = 0;
      for (const a of list || []) if (a && a.id && !byId.has(a.id)) { const x = { group: '', sub: '', defaults: [], ...a }; A.push(x); byId.set(x.id, x); n++; }
      if (n) { reindex(); notify(); }
    },
    keys, label, text, parts, show, chord, held, hasMod, find, changed,
    set, reset, resetAll, conflicts, problem,
    browserKeeps: (c) => BROWSER.has(c),
    changes: () => Object.keys(over).filter((id) => changed(id)).length,
    overrides: () => JSON.parse(JSON.stringify(over)),
    adopt: (o) => adopt(o),
    flush: () => { if (saveTimer) { clearTimeout(saveTimer); persistNow(); } return saving; },
    onChange(fn) { subs.add(fn); return () => subs.delete(fn); },
    onSaveError(fn) { failSubs.add(fn); return () => failSubs.delete(fn); },
    decorate,
  };
})();
