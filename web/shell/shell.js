/* The Cassetto shell: the open project, the module tabs, the save status, and the link every module
 * page gets (window.Cassetto.connect, used by /shared/cassetto-bridge.js). */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- helpers */
  const $ = (s) => document.querySelector(s);
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function btn(label, cls, onClick, title) { const b = el('button', cls || 'btn', label); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); if (title) b.title = title; return b; }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const home = (p) => (p || '').replace(/^\/home\/[^/]+/, '~').replace(/^\/Users\/[^/]+/, '~');
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage off */ } }

  async function api(method, path, body) {
    const opt = { method, headers: { 'X-Cassetto': '1' } };
    if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
    const r = await fetch(path, opt);
    let data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    if (!r.ok) { const e = new Error((data && data.error) || `HTTP ${r.status}`); e.status = r.status; e.code = data && data.code; throw e; }
    return data;
  }

  const ICONS = {
    plastico: 'M2 5.5 8 2.5l6 3v5l-6 3-6-3z M2 5.5l6 3 6-3M8 8.5v5',
    puzzles: 'M2.5 3h4v3h-4z M9.5 3h4v3h-4z M6 11h4v3H6z M4.5 6v2.5h7V6 M8 8.5V11',
  };
  function icon(d) { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 16 16'); s.innerHTML = `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>`; return s; }
  const K = window.CassettoKeys;
  const FOLDER = 'M1.5 4.5a1 1 0 0 1 1-1h3.2l1.5 1.5h6.3a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z';
  const FILE = 'M4 1.5h5l3 3v10H4z M9 1.5v3h3';

  /* ---------------------------------------------------------------- state */
  const S = {
    state: null, active: null, seq: 0,
    frames: new Map(),        // module id -> iframe
    links: new Map(),         // module id -> {subs, hooks}
    statuses: new Map(),      // module id -> {state, text}
    pendingNav: new Map(),    // module id -> target waiting for the page to register
    down: false, godot: null, refsTimer: 0,
    tree: null, treeSel: null, treeTimer: 0, collapsed: new Set(), treeOn: lsGet('cassetto:tree') !== 'off',
    act: 'all',               // the act on screen in every module (see setAct)
  };
  const modules = () => (S.state ? S.state.modules : []);
  const project = () => (S.state ? S.state.project : null);
  const titleOf = (id) => (modules().find((m) => m.id === id) || {}).title || id;

  let toastTimer = 0;
  function toast(msg, kind, action) {
    const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (kind === 'bad' ? ' bad' : '');
    if (action) t.append(btn(action.label, '', () => { t.hidden = true; action.run(); }));
    t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'bad' ? 9000 : 4200);
  }

  /* ---------------------------------------------------------------- the link each module page gets */
  function emitTo(id, type, ev) {
    const l = S.links.get(id); if (!l) return;
    for (const key of [type, '*']) for (const fn of l.subs.get(key) || []) { try { fn(ev); } catch (e) { console.error(e); } }
  }
  function deliverNav(id) {
    const l = S.links.get(id), t = S.pendingNav.get(id);
    if (!l || !t || !l.hooks.navigate) return;
    S.pendingNav.delete(id);
    try { l.hooks.navigate(t); } catch (e) { console.error(e); }
  }
  window.Cassetto = {
    isShell: true,
    connect(id, win) {
      const link = { subs: new Map(), hooks: {} };
      S.links.set(id, link);
      win.addEventListener('keydown', (e) => { if (shortcut(e)) { e.preventDefault(); e.stopPropagation(); } }, true);
      return {
        embedded: true, module: id,
        project, api,
        call: (name, ...args) => api('POST', `/api/core/call/${name}`, { args, caller: id }).then((r) => r.result),
        on(type, fn) { if (!link.subs.has(type)) link.subs.set(type, new Set()); link.subs.get(type).add(fn); return () => link.subs.get(type).delete(fn); },
        register(h) { link.hooks = h || {}; deliverNav(id); },
        navigate: (mod, target) => show(mod, target),
        status(state, text) { S.statuses.set(id, { state, text: text || '' }); renderStatus(); },
        selected(t) { if (id === S.active || !t) treeSelect(t, true); },
        act: () => S.act,
        setAct: (a, follow) => setAct(a, id, follow),
        error: (msg) => toast(msg, 'bad'),
        settings: (pane) => openSettings(pane || 'keys'),
      };
    },
    flushAll,
  };
  // The act on screen, one for the whole suite: Plastico's act and the act of the chart open in Puzzle
  // Charts ("all": every act). A module that changes it tells the others ("act" event). `follow` is for a
  // chart being opened: it moves the act along, but doesn't narrow "every act" down to one.
  function setAct(a, from, follow) {
    a = a == null || a === '' || a === 'all' ? 'all' : String(a);
    if (a === S.act || (follow && S.act === 'all')) return;
    S.act = a;
    if (project()) lsSet(`cassetto:act:${project().id}`, a);
    for (const id of S.links.keys()) if (id !== from) emitTo(id, 'act', { act: a });
    renderTree();
  }
  async function flushAll() {
    const jobs = [];
    for (const [, l] of S.links) if (l.hooks.flush) { try { jobs.push(Promise.resolve(l.hooks.flush())); } catch (e) { /* page gone */ } }
    jobs.push(K.flush());
    await Promise.race([Promise.allSettled(jobs), sleep(4000)]);
    return true;
  }

  /* ---------------------------------------------------------------- modules on screen */
  function frameFor(id) {
    let f = S.frames.get(id);
    if (!f) {
      f = el('iframe'); f.title = titleOf(id); f.src = `/m/${id}/`; f.hidden = true;
      f.addEventListener('load', () => setTimeout(() => deliverNav(id), 0));
      $('#frames').append(f); S.frames.set(id, f);
    }
    return f;
  }
  function show(id, target) {
    if (!project() || !modules().some((m) => m.id === id)) return;
    const prev = S.active;
    S.active = id; lsSet('cassetto:module', id);
    const f = frameFor(id);
    for (const [mid, fr] of S.frames) fr.hidden = mid !== id;
    renderTabs();
    if (prev && prev !== id) emitTo(prev, 'deactivate', {});
    emitTo(id, 'activate', {});
    if (target) { S.pendingNav.set(id, target); deliverNav(id); }
    try { f.contentWindow && f.contentWindow.focus(); } catch (e) { /* not ready */ }
  }
  function resetFrames() {
    for (const f of S.frames.values()) f.remove();
    S.frames.clear(); S.links.clear(); S.statuses.clear(); S.active = null;
  }
  // The keys that work everywhere (scope "suite"), read before the module page under them gets the key.
  const typingIn = (t) => !!(t && t.closest && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
  const modalOpen = () => !$('#modal').hidden;
  function cycleModule(step) {
    const ms = modules(); if (!project() || !ms.length) return false;
    const i = ms.findIndex((m) => m.id === S.active);
    show(ms[(i + step + ms.length) % ms.length].id); return true;
  }
  const SUITE = {
    'suite.settings': () => { if (S.settings) closeModal(); else openSettings(); },
    'suite.shortcuts': () => openSettings('keys'),
    'suite.tree': () => toggleTree(),
    'suite.theme': () => { const t = window.CassettoTheme.themes; setTheme(t[(t.indexOf(window.CassettoTheme.get()) + 1) % t.length]); toast(`Theme: ${THEMES[window.CassettoTheme.get()][0]}.`); },
    'suite.next': () => cycleModule(1),
    'suite.prev': () => cycleModule(-1),
    'suite.new': () => openNew(),
    'suite.open': () => openPicker(),
    'suite.rename': () => (project() ? openRename() : false),
    'suite.export': () => (project() ? openExport() : false),
    'suite.info': () => (project() ? openInfo() : false),
  };
  // these open a dialog of their own: not over another one, which would lose what was typed there
  const DIALOGS = new Set(['suite.new', 'suite.open', 'suite.rename', 'suite.export', 'suite.info']);
  function shortcut(e) {
    if (S.recording || e.defaultPrevented) return false;
    const id = K.find(e, 'suite'); if (!id) return false;
    if (!K.hasMod(K.chord(e)) && typingIn(e.target)) return false;
    if (id.startsWith('suite.go.')) {
      const mid = id.slice(9);
      if (!project() || !modules().some((m) => m.id === mid)) return false;
      if (S.settings) closeModal();
      show(mid); return true;
    }
    const run = SUITE[id]; if (!run) return false;
    if (DIALOGS.has(id) && modalOpen()) return true;
    closeMenus();
    return run() !== false;
  }
  document.addEventListener('keydown', (e) => { if (shortcut(e)) e.preventDefault(); if (e.key === 'Escape') { closeMenus(); } });
  K.onChange(() => { renderTabs(); if (S.settings) S.settings.render(); });
  K.onSaveError((e) => toast(e.message, 'bad'));

  /* ---------------------------------------------------------------- rendering */
  function renderTabs() {
    const t = $('#tabs'); t.textContent = '';
    modules().forEach((m, i) => {
      const b = el('button', 'tab'); b.type = 'button'; b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(S.active === m.id)); b.disabled = !project();
      b.append(icon(ICONS[m.id] || ICONS.plastico), document.createTextNode(m.title));
      if ((S.statuses.get(m.id) || {}).state === 'err') b.append(el('span', 'bad'));
      const k = K.label(`suite.go.${m.id}`);
      if (k && lsGet('cassetto:tabkeys') !== 'off') b.append(el('kbd', '', k));
      b.title = k ? `${m.title} (${k})` : m.title;
      b.addEventListener('click', () => show(m.id));
      t.append(b);
    });
  }
  function renderStatus() {
    const st = $('#status'), tx = $('#status-text');
    if (S.down) { st.dataset.s = 'err'; tx.textContent = 'Not connected'; st.title = 'Cassetto’s server isn’t answering. It will keep trying.'; renderTabs(); return; }
    const all = [...S.statuses.entries()];
    const bad = all.filter(([, s]) => s.state === 'err'), busy = all.filter(([, s]) => s.state === 'busy' || s.state === 'dirty');
    if (bad.length) { st.dataset.s = 'err'; tx.textContent = `Not saved: ${bad.map(([id]) => titleOf(id)).join(', ')}`; }
    else if (busy.length) { st.dataset.s = 'busy'; tx.textContent = 'Saving'; }
    else { st.dataset.s = 'ok'; tx.textContent = project() ? 'Saved' : 'Ready'; }
    st.title = all.map(([id, s]) => `${titleOf(id)}: ${s.text || s.state}`).join('\n');
    renderTabs();
  }
  // a development build (0.2.0.dev1) is a test version: it says so in the bar, the title and Settings
  function appVersion() { return (S.state && S.state.app && S.state.app.version) || ''; }
  function isTest() { return /\.dev\d*$/.test(appVersion()); }
  function versionLabel() { const v = appVersion(); const m = /^(\d+\.\d+)(?:\.\d+)?\.dev\d*$/.exec(v); return m ? `${m[1]} test` : v; }
  function renderHead() {
    const p = project();
    $('#proj-name').textContent = p ? p.name : 'No project';
    const test = isTest();
    $('#brand-test').hidden = !test;
    document.title = (p ? `${p.name} · Cassetto` : 'Cassetto') + (test ? ' (test)' : '');
    const puz = modules().find((m) => m.id === 'puzzles');
    const missing = p && puz && puz.summary ? puz.summary.missing || 0 : 0;
    const lb = $('#btn-links'); lb.hidden = !missing; lb.className = 'chip warn';
    lb.textContent = ''; lb.append(el('span', 'd'), document.createTextNode(`${missing} broken link${missing === 1 ? '' : 's'}`));
    lb.title = 'Puzzle steps placed in scenes or with people the world doesn’t have';
    const g = $('#btn-godot'), gs = S.godot;
    g.hidden = !p || !gs || !gs.linked;
    if (gs && gs.linked) {
      g.className = 'chip' + (gs.found ? '' : ' bad'); g.textContent = '';
      g.append(el('span', 'd'), document.createTextNode(gs.found ? `Godot: ${gs.name}` : 'Godot project missing'));
      g.title = gs.found ? `Linked to ${home(gs.path)}${gs.editor_open ? ' (open in Godot now)' : ''}` : gs.problem || '';
    }
    renderTabs(); renderStatus();
  }
  async function renderWelcome() {
    const w = $('#welcome'); w.hidden = !!project(); $('#frames').hidden = !project();
    if (project()) return;
    const err = $('#welcome-error'); err.hidden = !(S.state && S.state.error); err.textContent = (S.state && S.state.error) || '';
    const ul = $('#recent'); ul.textContent = '';
    let rec = [];
    try { rec = (await api('GET', '/api/core/recent')).recent; } catch (e) { /* offline */ }
    if (!rec.length) ul.append(el('li', 'none', 'Nothing yet. Make a project, or open one you already have.'));
    for (const r of rec) {
      const li = el('li', r.exists ? '' : 'gone');
      const b = btn('', 'open', () => r.exists ? openProject(r.path) : toast(`${home(r.path)} isn’t there any more.`, 'bad'));
      b.append(el('b', '', r.name), el('small', '', home(r.path)));
      const x = btn('×', 'x', async () => { await api('DELETE', '/api/core/recent', { path: r.path }); renderWelcome(); }, 'Take it off the list (the project stays where it is)');
      li.append(b, x); ul.append(li);
    }
  }

  /* ---------------------------------------------------------------- the project */
  // one at a time: the project can change from this page and from the core's events at once
  let loading = Promise.resolve();
  function loadState() { loading = loading.then(readState, readState); return loading; }
  async function readState() {
    const before = project() && project().path;
    S.state = await api('GET', '/api/core/state');
    S.seq = Math.max(S.seq, S.state.seq);
    K.define(modules().map((m) => ({ id: `suite.go.${m.id}`, scope: 'suite', group: 'Modules', label: `Go to ${m.title}`, defaults: [] })));
    const now = project() && project().path;
    if (before !== now) {
      resetFrames();
      S.godot = null;
      S.act = (now && lsGet(`cassetto:act:${project().id}`)) || 'all';   // before the pages load: they read it
      if (now) {
        const want = new URLSearchParams(location.hash.slice(1));
        const first = want.get('module') || lsGet('cassetto:module');
        let target = null; try { target = want.get('target') ? JSON.parse(want.get('target')) : null; } catch (e) { target = null; }
        if (location.hash) history.replaceState(null, '', location.pathname);
        show(modules().some((m) => m.id === first) ? first : modules()[0].id, target);
        loadGodot();
        try { S.collapsed = new Set(JSON.parse(lsGet(`cassetto:tree:${project().id}`) || '[]')); } catch (e) { S.collapsed = new Set(); }
        S.treeSel = null; loadTree(true);
      } else { S.tree = null; renderTree(); }
    }
    renderHead(); renderWelcome();
  }
  async function loadGodot() { try { S.godot = await api('GET', '/api/core/godot'); } catch (e) { S.godot = null; } renderHead(); }
  function refreshSoon() {
    clearTimeout(S.refsTimer);
    S.refsTimer = setTimeout(async () => { try { const st = await api('GET', '/api/core/state'); if (S.state && st.project && project() && st.project.path === project().path) { S.state = st; renderHead(); } } catch (e) { /* offline */ } }, 400);
  }
  async function withLoading(fn) {
    $('#loading').hidden = false;
    try { return await fn(); } finally { $('#loading').hidden = true; }
  }
  // Runs fn while the project changes under this page; no tree load starts until the new state is read.
  async function switching(fn) {
    S.switching = (S.switching || 0) + 1; clearTimeout(S.treeTimer);
    try { return await fn(); } finally { S.switching -= 1; }
  }
  async function openProject(path) {
    closeMenus();
    if (project() && project().path === path) return;
    await flushAll();
    await switching(async () => {
      try { await withLoading(() => api('POST', '/api/core/project/open', { path })); await loadState(); toast(`Opened ${project().name}.`); }
      catch (e) { toast(e.message, 'bad'); await loadState(); }
    });
  }
  async function closeProject() {
    closeMenus(); await flushAll();
    await switching(async () => {
      try { await api('POST', '/api/core/project/close'); } catch (e) { toast(e.message, 'bad'); }
      await loadState();
    });
  }

  /* ---------------------------------------------------------------- events from the core */
  async function poll() {
    for (;;) {
      try {
        const r = await api('GET', `/api/core/events?after=${S.seq}&wait=20`);
        if (S.down) { S.down = false; renderStatus(); await loadState(); }
        if (r.reset) await loadState();
        S.seq = r.seq;
        for (const ev of r.events) handle(ev);
      } catch (e) {
        if (!S.down) { S.down = true; renderStatus(); }
        await sleep(2500);
      }
    }
  }
  function handle(ev) {
    if (ev.type === 'project.opened' || ev.type === 'project.closed') { loadState(); }
    else if (ev.type === 'project.renamed') { if (S.state && S.state.project) S.state.project.name = ev.data.name; renderHead(); loadTreeSoon(); }
    else if (ev.type === 'world.changed') { refreshSoon(); loadGodot(); loadTreeSoon(); }
    else if (ev.type.endsWith('.changed')) { refreshSoon(); loadTreeSoon(); }
    for (const id of S.links.keys()) emitTo(id, ev.type, ev);
  }
  setInterval(() => { api('POST', '/api/core/heartbeat').catch(() => {}); }, 10000);
  api('POST', '/api/core/heartbeat').catch(() => {});
  window.addEventListener('pagehide', () => { flushAll(); });

  /* ---------------------------------------------------------------- the project tree */
  // Acts › scenes › scenes inside them › the charts put with each scene. It shows what the modules hold:
  // the world's structure from Plastico (world.catalog) and the chart names from Puzzle Charts
  // (puzzles.charts). A chart put with several scenes appears under each, every entry pointing at the one chart.
  const TW = '<svg viewBox="0 0 10 10"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const IC = {
    act: 'M2.5 2.5h11v11h-11z M2.5 6h11',
    scene: 'M2 5.5 8 2.5l6 3v5l-6 3-6-3z M2 5.5l6 3 6-3M8 8.5v5',
    sceneIn: 'M3 4h10v8H3z M6 7h4v3H6z',
    chart: ICONS.puzzles,
    group: 'M2 4.5h12M2 8h12M2 11.5h8',
  };
  // While the project is being closed, opened or replaced, the server may already have no project while
  // this page still shows the old one: a tree load then would only get 409s. readState loads it after.
  async function loadTree(force = false) {
    if (S.switching && !force) return;
    if (!project()) { S.tree = null; renderTree(); return; }
    try {
      const [cat, ch] = await Promise.all([
        api('POST', '/api/core/call/world.catalog', { args: [], caller: 'shell' }).then((r) => r.result),
        api('POST', '/api/core/call/puzzles.charts', { args: [], caller: 'shell' }).then((r) => r.result).catch(() => ({ charts: [] })),
      ]);
      S.tree = { cat, charts: new Map((ch.charts || []).map((c) => [c.id, c])) };
    } catch (e) { S.tree = { error: e.message }; }
    renderTree();
  }
  function loadTreeSoon() { clearTimeout(S.treeTimer); S.treeTimer = setTimeout(loadTree, 250); }
  function saveCollapsed() { if (project()) lsSet(`cassetto:tree:${project().id}`, JSON.stringify([...S.collapsed])); }
  function toggleTree() { S.treeOn = !S.treeOn; lsSet('cassetto:tree', S.treeOn ? 'on' : 'off'); renderTree(); }
  $('#btn-tree').addEventListener('click', toggleTree);
  $('#tree-collapse').addEventListener('click', () => {
    if (!S.tree || !S.tree.cat) return;
    for (const a of S.tree.cat.acts) S.collapsed.add(`act:${a[0]}`);
    for (const sc of S.tree.cat.hierarchy || []) S.collapsed.add(`scene:${sc.id}`);
    S.collapsed.add('group:loose'); saveCollapsed(); renderTree();
  });
  function treeSelect(t, fromModule) {
    S.treeSel = t && (t.scene || t.chart) ? { scene: t.scene || null, chart: t.chart || null } : null;
    if (fromModule && S.treeSel && S.treeSel.scene && S.tree && S.tree.cat) {   // open the way down to it
      const all = new Map((S.tree.cat.hierarchy || []).map((q) => [q.id, q]));
      let cur = all.get(S.treeSel.scene), guard = 0, opened = false;
      if (cur && S.collapsed.delete(`act:${cur.act}`)) opened = true;
      while (cur && cur.parent && all.has(cur.parent) && guard++ < 100) { cur = all.get(cur.parent); if (S.collapsed.delete(`scene:${cur.id}`)) opened = true; if (S.collapsed.delete(`act:${cur.act}`)) opened = true; }
      if (opened) saveCollapsed();
    }
    renderTree();
    const on = document.querySelector('#tree-body .tn.sel'); if (on && fromModule) on.scrollIntoView({ block: 'nearest' });
  }
  function treeNode(key, cls, icon, name, count, depth, kids, open, onPick, title) {
    const li = el('li'); li.setAttribute('role', 'none');
    const row = el('div', 'tn ' + cls); row.setAttribute('role', 'treeitem'); row.tabIndex = 0; row.dataset.key = key;
    row.style.paddingLeft = `${4 + depth * 14}px`;
    const tw = el('span', 'tw'); if (kids) { tw.innerHTML = TW; row.setAttribute('aria-expanded', String(open)); }
    const toggle = (e) => { e.stopPropagation(); if (S.collapsed.has(key)) S.collapsed.delete(key); else S.collapsed.add(key); saveCollapsed(); renderTree(); };
    if (kids) tw.addEventListener('click', toggle);
    row.append(tw, icon ? iconEl(icon) : el('span', 'ic'), el('span', 'nm', name));
    if (count != null) row.append(el('span', 'ct', String(count)));
    if (title) row.title = title;
    row.addEventListener('click', () => onPick && onPick());
    row.addEventListener('dblclick', (e) => { if (kids) toggle(e); });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (onPick) onPick(); }
      else if (e.key === 'ArrowRight' && kids && !open) toggle(e);
      else if (e.key === 'ArrowLeft' && kids && open) toggle(e);
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const rows = [...document.querySelectorAll('#tree-body .tn')]; const i = rows.indexOf(row);
        const next = rows[i + (e.key === 'ArrowDown' ? 1 : -1)]; if (next) next.focus();
      }
    });
    li.append(row);
    if (kids && open) { const ul = el('ul'); ul.setAttribute('role', 'group'); kids.forEach((k) => ul.append(k)); li.append(ul); }
    return li;
  }
  function iconEl(d) { const s = icon(d); s.setAttribute('class', 'ic'); return s; }
  function renderTree() {
    const box = $('#tree'), body = $('#tree-body');
    $('#btn-tree').setAttribute('aria-pressed', String(S.treeOn));
    $('#btn-tree').hidden = !project();
    box.hidden = !project() || !S.treeOn;
    if (box.hidden) return;
    const keep = document.activeElement && body.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    body.textContent = '';
    if (!S.tree) { body.append(el('div', 'tree-empty', 'Loading…')); return; }
    if (S.tree.error) { body.append(el('div', 'tree-empty', `Couldn’t read the project: ${S.tree.error}`)); return; }
    const { cat, charts } = S.tree;
    const scenes = cat.hierarchy || [];
    const byParent = new Map();
    const ids = new Set(scenes.map((q) => q.id));
    for (const q of scenes) { const p = q.parent && ids.has(q.parent) ? q.parent : ''; if (!byParent.has(p)) byParent.set(p, []); byParent.get(p).push(q); }
    for (const l of byParent.values()) l.sort((a, b) => a.name.localeCompare(b.name));
    const sel = S.treeSel || {};
    // the steps of a chart, counted as everywhere else (not the end goals, not the scene setups)
    const stepsOf = (c) => (typeof c.steps === 'number' ? c.steps : c.nodes.filter((n) => n.kind !== 'goal' && n.kind !== 'setup').length);
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    // a chart under a scene: it has steps placed there (the number shown), or it is pinned there in Plastico
    const chartLeaf = (q, cid, depth) => {
      const c = charts.get(cid);
      const here = (q.charts_from_steps || {})[cid] || 0;
      const n = treeNode(`chart:${q.id}:${cid}`, 'chart' + (c ? '' : ' missing') + (sel.chart === cid ? ' sel' : ''), IC.chart,
        c ? c.name : 'Missing chart', c ? (here || null) : null, depth, null, false,
        () => { if (!c) { toast('That chart isn’t in the project any more: take it off the scene in Plastico.', 'bad'); return; } treeSelect({ chart: cid }); show('puzzles', { chart: cid }); },
        c ? `${c.name} · act ${c.act} · ${here ? `${plural(here, 'step')} in ${q.name}, of ${stepsOf(c)}` : `pinned to ${q.name}, no steps there yet`}` : `Chart ${cid} was deleted`);
      return n;
    };
    const sceneNode = (q, depth) => {
      const key = `scene:${q.id}`;
      const kidsScenes = byParent.get(q.id) || [];
      const kids = [...kidsScenes.map((k) => sceneNode(k, depth + 1)), ...q.charts.map((cid) => chartLeaf(q, cid, depth + 1))];
      return treeNode(key, 'scene' + (q.delete ? ' gone' : '') + (sel.scene === q.id && !sel.chart ? ' sel' : ''), q.parent ? IC.sceneIn : IC.scene, q.name || q.id,
        null, depth, kids.length ? kids : null, !S.collapsed.has(key),
        () => { treeSelect({ scene: q.id }); show('plastico', { scene: q.id }); },
        `${q.name} (${q.id})${q.delete ? ' · marked to delete' : ''}`);
    };
    // a chart under its act: every chart once, in the act it is for, with all its steps
    const inScenes = new Map();
    for (const q of scenes) for (const cid of Object.keys(q.charts_from_steps || {})) inScenes.set(cid, (inScenes.get(cid) || 0) + 1);
    const actChart = (c, depth, keyAt) => treeNode(`chart:${keyAt}:${c.id}`, 'chart' + (sel.chart === c.id ? ' sel' : ''), IC.chart, c.name, stepsOf(c), depth, null, false,
      () => { treeSelect({ chart: c.id }); show('puzzles', { chart: c.id }); },
      `${c.name} · act ${c.act} · ${plural(stepsOf(c), 'step')}${inScenes.get(c.id) ? `, in ${plural(inScenes.get(c.id), 'scene')}` : ', none placed in a scene yet'}`);
    const byName = (a, b) => a.name.localeCompare(b.name);
    const root = el('ul'); root.setAttribute('role', 'group');
    for (const [aid, aname] of cat.acts) {
      const key = `act:${aid}`;
      const top = (byParent.get('') || []).filter((q) => q.act === aid);
      const count = scenes.filter((q) => q.act === aid).length;
      const own = [...charts.values()].filter((c) => String(c.act) === aid).sort(byName);
      const kids = [...own.map((c) => actChart(c, 1, `act${aid}`)), ...top.map((q) => sceneNode(q, 1))];
      root.append(treeNode(key, 'act' + (S.act === aid ? ' cur' : ''), IC.act, `Act ${aid}${aname ? ' · ' + aname : ''}`, count, 0, kids.length ? kids : null,
        !S.collapsed.has(key), () => { treeSelect(null); show('plastico', { act: aid }); },
        `${plural(count, 'scene')} and ${plural(own.length, 'puzzle chart')} · show this act in Plastico${S.act === aid ? ' (it is on screen now)' : ''}`));
    }
    // charts for an act the world doesn't have (deleted, or never made in Plastico)
    const actIds = new Set(cat.acts.map((a) => a[0]));
    const loose = [...charts.values()].filter((c) => !actIds.has(String(c.act))).sort(byName);
    if (loose.length) {
      root.append(treeNode('group:loose', 'group', IC.group, 'Charts in an act the world doesn’t have', loose.length, 0,
        loose.map((c) => actChart(c, 1, '')), !S.collapsed.has('group:loose'), null));
    }
    if (!scenes.length && !charts.size) body.append(el('div', 'tree-empty', 'Nothing here yet: add a scene in Plastico, or a chart in Puzzle Charts.'));
    body.append(root);
    if (keep) { const f = body.querySelector(`.tn[data-key="${CSS.escape(keep)}"]`); if (f) f.focus(); }
  }

  /* ---------------------------------------------------------------- menus */
  function closeMenus() { document.querySelectorAll('.menu').forEach((m) => { m.hidden = true; }); document.querySelectorAll('[aria-haspopup]').forEach((b) => b.setAttribute('aria-expanded', 'false')); }
  function menu(button, box, fill) {
    button.addEventListener('click', async (e) => {
      e.stopPropagation();
      const open = box.hidden; closeMenus();
      if (!open) return;
      box.textContent = ''; await fill(box); box.hidden = false; button.setAttribute('aria-expanded', 'true');
    });
    box.addEventListener('click', (e) => e.stopPropagation());
  }
  document.addEventListener('click', closeMenus);
  const mi = (label, sub, run) => { const b = el('button', 'mi'); b.type = 'button'; b.append(document.createTextNode(label)); if (sub) b.append(el('small', '', sub)); b.addEventListener('click', () => { closeMenus(); run(); }); return b; };
  menu($('#btn-project'), $('#menu-project'), async (box) => {
    box.append(mi('New project…', 'A world and its puzzles, in a folder of their own', openNew));
    box.append(mi('Open a project…', 'A folder with a cassetto.json in it', openPicker));
    box.append(mi('Import a project…', 'From a .cassetto file exported by Cassetto', openImportProject));
    let rec = [];
    try { rec = (await api('GET', '/api/core/recent')).recent.filter((r) => r.exists && (!project() || r.path !== project().path)).slice(0, 5); } catch (e) { /* offline */ }
    if (rec.length) { box.append(el('div', 'mi-head', 'Recent')); for (const r of rec) box.append(mi(r.name, home(r.path), () => openProject(r.path))); }
    if (project()) {
      box.append(el('div', 'mi-sep'));
      box.append(mi('Rename…', project().name, openRename));
      box.append(mi('Export the project…', 'The whole project in one .cassetto file, to keep or send', openExport));
      box.append(mi('Import puzzle charts…', 'From the Puzzle Charts page’s “Copy as JSON”, or a file', openImport));
      box.append(mi('About this project', 'Its folder, format, modules and the link to Godot', openInfo));
      box.append(el('div', 'mi-sep'));
      box.append(mi('Close the project', '', closeProject));
    }
  });
  menu($('#btn-links'), $('#menu-links'), async (box) => {
    box.append(el('div', 'mi-head', 'Puzzle steps that name what the world doesn’t have'));
    let r = null;
    try { r = await api('GET', '/api/puzzles/references'); } catch (e) { box.append(el('div', 'mi-note', e.message)); return; }
    // one group per missing name: add it to the world in one click (every step naming it follows), or open a step
    const groups = new Map();
    for (const m of r.missing_scenes) { const k = `scene|${m.scene}`; if (!groups.has(k)) groups.set(k, { kind: 'scene', value: m.scene, steps: [] }); groups.get(k).steps.push(m); }
    for (const m of r.missing_people) { const k = `person|${m.who}`; if (!groups.has(k)) groups.set(k, { kind: 'person', value: m.who, steps: [] }); groups.get(k).steps.push(m); }
    for (const g of groups.values()) {
      const row = el('div', 'link-fix');
      const head = el('div', 'link-fix-head');
      head.append(el('b', '', g.kind === 'person' ? `Nobody called “${g.value}”` : `No scene “${g.value}”`),
        el('small', '', `${g.steps.length} step${g.steps.length === 1 ? '' : 's'} ${g.kind === 'person' ? 'with them' : 'there'}`));
      const add = el('button', 'btn small primary', g.kind === 'person' ? 'Add to the world’s people' : 'Add the scene to the world');
      add.type = 'button';
      add.title = g.kind === 'person' ? 'Adds this person in Plastico and points these steps at them' : 'Adds this scene (an idea) in Plastico and points these steps at it';
      add.addEventListener('click', async () => {
        add.disabled = true;
        try {
          const res = await api('POST', '/api/core/call/puzzles.add_to_world', { args: [g.kind, g.value], caller: 'shell' }).then((x) => x.result);
          const at = (res.placed || []).map((p) => p.scene);
          toast(`${res.name} is in the world now${at.length ? `, in ${at.join(', ')} as the steps say` : ''}: ${res.steps} step${res.steps === 1 ? '' : 's'} point${res.steps === 1 ? 's' : ''} at ${g.kind === 'person' ? 'them' : 'it'}.`);
          closeMenus(); refreshSoon(); loadTreeSoon();
        } catch (e) { add.disabled = false; toast(`Couldn’t add it: ${e.message}`, 'bad'); }
      });
      head.append(add);
      row.append(head);
      for (const m of g.steps) row.append(mi(`“${m.title}”`, m.chart_name, () => show('puzzles', { chart: m.chart, step: m.step })));
      box.append(row);
    }
    box.append(el('div', 'mi-note', 'Add what is missing to the world, or open a step to change it in Puzzle Charts.'));
  });
  const THEMES = { system: ['System', 'Light or dark, as the system is'], light: ['Light', ''], dark: ['Dark', ''], oled: ['Black', 'Dark on true black, for OLED screens'] };
  function setTheme(t) {
    window.CassettoTheme.set(t);
    for (const f of S.frames.values()) { try { f.contentWindow.CassettoTheme.apply(t); } catch (e) { /* not loaded yet */ } }
    renderTheme();
  }
  function renderTheme() { $('#theme-name').textContent = THEMES[window.CassettoTheme.get()][0]; }
  window.addEventListener('storage', (e) => { if (e.key === 'cassetto:theme') renderTheme(); });
  menu($('#btn-theme'), $('#menu-theme'), (box) => {
    box.append(el('div', 'mi-head', 'Theme'));
    const cur = window.CassettoTheme.get();
    for (const [t, [label, sub]] of Object.entries(THEMES)) {
      const b = mi(label, sub, () => setTheme(t));
      if (t === cur) { b.classList.add('on'); b.setAttribute('aria-current', 'true'); }
      box.append(b);
    }
  });
  renderTheme();
  $('#btn-godot').addEventListener('click', () => openInfo());
  $('#btn-settings').addEventListener('click', (e) => { e.stopPropagation(); closeMenus(); openSettings(); });
  document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => ({ new: openNew, open: openPicker, import: openImportProject })[b.dataset.act]()));

  /* ---------------------------------------------------------------- dialogs */
  function openModal(build, cls) {
    if (S.settings) S.settings.close();
    const box = $('#modal-box'); box.textContent = ''; box.className = 'modal-box' + (cls ? ` ${cls}` : '');
    build(box);
    $('#modal').hidden = false;
    const f = box.querySelector('input:not([type=radio]),textarea,select'); if (f) setTimeout(() => f.focus(), 0);
  }
  function closeModal() { if (S.settings) S.settings.close(); $('#modal').hidden = true; }
  $('#modal').addEventListener('mousedown', (e) => { if (e.target === $('#modal')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) { if (S.settings && S.settings.escape()) return; closeModal(); } });
  function head(box, title, sub) { const h = el('div', 'modal-head'); h.append(el('h2', '', title)); if (sub) h.append(el('p', '', sub)); box.append(h); }
  function field(label, control, help) { const f = el('label', 'f'); f.append(el('span', '', label), control); if (help) f.append(el('span', 'help', help)); return f; }
  function foot(box, left, right) { const f = el('div', 'modal-foot'); const l = el('div', 'l'), r = el('div', 'r'); (left || []).forEach((x) => l.append(x)); (right || []).forEach((x) => r.append(x)); f.append(l, r); box.append(f); }

  // a folder (or JSON file) picker: the system's own in the desktop window, else one drawn here
  const native = () => window.pywebview && window.pywebview.api && window.pywebview.api.pick_folder;
  function pathInput(value, kind, onPick) {
    const wrap = el('div');
    const row = el('div', 'row'); const inp = el('input', 'mono'); inp.value = value || ''; inp.spellcheck = false;
    const holder = el('div');
    const choose = btn('Choose…', 'btn', async () => {
      if (kind === 'save') {     // a file to write: the folder is chosen, the name stays
        const v = inp.value.trim(), cut = v.lastIndexOf('/');
        const dir = cut > 0 ? v.slice(0, cut) : '', fname = cut >= 0 ? v.slice(cut + 1) : v;
        const set = (path) => { inp.value = path; if (onPick) onPick(path); inp.dispatchEvent(new Event('input')); };
        if (native() && window.pywebview.api.pick_save) {
          try { const p = await window.pywebview.api.pick_save(dir, fname); if (p) set(p); return; } catch (e) { /* fall back to ours */ }
        }
        if (holder.firstChild) { holder.textContent = ''; return; }
        holder.append(picker(dir || '~', 'folder', (d) => { holder.textContent = ''; set(`${d.replace(/\/$/, '')}/${fname}`); }));
        return;
      }
      if (native()) {
        try { const p = await (kind === 'file' || kind === 'cassetto' ? window.pywebview.api.pick_file(inp.value, kind === 'cassetto' ? 'cassetto' : 'json') : window.pywebview.api.pick_folder(inp.value)); if (p) { inp.value = p; if (onPick) onPick(p); inp.dispatchEvent(new Event('input')); } return; }
        catch (e) { /* fall back to ours */ }
      }
      if (holder.firstChild) { holder.textContent = ''; return; }
      holder.append(picker(inp.value || (S.state && S.state.app.projects_dir) || '', kind, (p) => { inp.value = p; holder.textContent = ''; if (onPick) onPick(p); inp.dispatchEvent(new Event('input')); }));
    });
    row.append(inp, choose); wrap.append(row, holder);
    wrap.input = inp;
    return wrap;
  }
  function picker(start, kind, onPick) {
    const box = el('div', 'picker');
    const top = el('div', 'picker-path'); const where = el('input'); where.spellcheck = false;
    const up = btn('Up', 'btn small'); const files = kind === 'file' || kind === 'cassetto';
    const pickHere = btn(files ? 'Open' : 'Use this folder', 'btn small primary');
    top.append(up, where, pickHere);
    const list = el('div', 'picker-list');
    box.append(top, list);
    let cur = null, asked = 0, typed = 0;
    where.addEventListener('input', () => { typed += 1; });
    // Only the folder asked for last is shown. A folder that isn't there falls back to its parent as the
    // same request, so the fallback neither outruns a newer one nor overwrites a path typed meanwhile.
    async function go(path, mine = ++asked, typedBefore = typed) {
      let d;
      try { d = await api('GET', `/api/core/fs?path=${encodeURIComponent(path)}`); if (mine !== asked) return; }
      catch (e) {
        if (mine !== asked) return;
        const parent = path.replace(/\/[^/]*\/?$/, '') || '/';
        if (parent !== path) return go(parent, mine, typedBefore);
        list.textContent = ''; list.append(el('div', 'empty', e.message)); return;
      }
      cur = d;
      if (typed === typedBefore) where.value = d.path;     // a path typed meanwhile stays, for Enter to go to
      up.disabled = !d.parent; pickHere.hidden = files;
      list.textContent = '';
      for (const x of d.dirs) {
        const b = el('button'); b.type = 'button'; b.append(icon(FOLDER), document.createTextNode(x.name));
        if (x.project) b.append(el('span', 'tag p', 'Cassetto project')); else if (x.godot) b.append(el('span', 'tag', 'Godot project'));
        b.addEventListener('click', () => go(x.path));
        b.addEventListener('dblclick', () => { if (kind === 'project' && x.project) onPick(x.path); });
        list.append(b);
      }
      if (files) for (const x of (kind === 'cassetto' ? d.cassetto || [] : d.json)) { const b = el('button'); b.type = 'button'; b.append(icon(FILE), document.createTextNode(x.name)); b.addEventListener('click', () => onPick(x.path)); list.append(b); }
      if (!list.firstChild) list.append(el('div', 'empty', kind === 'file' ? 'No folders or JSON files here.' : kind === 'cassetto' ? 'No folders or .cassetto files here.' : 'No folders here.'));
      if (kind === 'project' && d.project) { pickHere.textContent = 'Open this project'; pickHere.hidden = false; }
      else if (kind === 'project') pickHere.hidden = true;
    }
    up.addEventListener('click', () => cur && cur.parent && go(cur.parent));
    where.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(where.value); } });
    pickHere.addEventListener('click', () => cur && onPick(cur.path));
    go(start || '~');
    return box;
  }

  async function openNew() {
    let worlds = [], games = [];
    try { worlds = (await api('GET', '/api/core/plastico-worlds')).worlds; } catch (e) { /* none */ }
    try { games = (await api('GET', '/api/core/godot-games')).games; } catch (e) { /* none */ }
    const base = (S.state && S.state.app.projects_dir) || '~/Cassetto';
    openModal((box) => {
      head(box, 'New project', 'A folder for one game: its world (Plastico) and its puzzles (Puzzle Charts).');
      const body = el('div', 'modal-body'); box.append(body);
      const name = el('input'); name.placeholder = 'My game';
      body.append(field('Name', name));
      let edited = false;
      const where = pathInput(`${base}/`, 'folder');
      where.input.addEventListener('input', () => { edited = true; });
      name.addEventListener('input', () => { if (!edited) where.input.value = `${base}/${name.value.trim().replace(/[^\w .-]+/g, '-')}`; });
      body.append(field('Folder', where, 'A new, empty folder. It is made if it isn’t there.'));
      const choices = el('div', 'choices');
      const radio = (value, title, sub, more) => {
        const l = el('label', 'choice'); const r = el('input'); r.type = 'radio'; r.name = 'start'; r.value = value; if (value === 'empty') r.checked = true;
        const d = el('div'); d.append(el('b', '', title), el('small', '', sub)); if (more) { more.classList.add('more'); d.append(more); }
        l.append(r, d); choices.append(l); return r;
      };
      radio('empty', 'An empty plan', 'Sketch the world and its puzzles first. You can link a Godot game later.');
      // the games found in ~/Desktop/Projects, to pick from; "Another folder…" for one somewhere else
      const gs = el('select');
      for (const g of games) { const o = el('option', '', `${g.name} · ${home(g.path)}`); o.value = g.path; gs.append(o); }
      const otherGame = el('option', '', 'Another folder…'); otherGame.value = ''; gs.append(otherGame);
      gs.hidden = !games.length;
      const godot = pathInput('', 'folder'); godot.hidden = !!games.length;
      const gbox = el('div'); gbox.append(gs, godot);
      const godotRadio = radio('godot', 'A Godot game', games.length
        ? 'Read its scenes, exits and people (it isn’t changed until you build). These are the games in ~/Desktop/Projects.'
        : 'Read its scenes, exits and people (it isn’t changed until you build).', gbox);
      const gameName = () => { const g = games.find((x) => x.path === gs.value); return g ? g.name : ''; };
      const nameFromGame = () => {   // a project named after the game, unless a name was typed
        if (name.value.trim() && !name.dataset.fromGame) return;
        const n = gameName(); if (!n) return;
        name.value = n; name.dataset.fromGame = '1';
        if (!edited) where.input.value = `${base}/${n.replace(/[^\w .-]+/g, ' ').replace(/\s+/g, ' ').trim()}`;
      };
      name.addEventListener('input', () => { delete name.dataset.fromGame; });
      gs.addEventListener('change', () => { godot.hidden = !!gs.value; godotRadio.checked = true; nameFromGame(); });
      gs.addEventListener('focus', () => { godotRadio.checked = true; });
      godotRadio.addEventListener('change', nameFromGame);
      const ws = el('select');
      for (const w of worlds) { const o = el('option', '', `${w.name} · ${w.scenes} scenes${w.charts ? ' · with puzzle charts' : ''}`); o.value = w.file; ws.append(o); }
      const other = el('option', '', 'Another world file…'); other.value = ''; ws.append(other);
      const wfile = pathInput('', 'file'); wfile.hidden = !!worlds.length;
      ws.addEventListener('change', () => { wfile.hidden = !!ws.value; });
      const wbox = el('div'); wbox.append(ws, wfile);
      radio('world', 'A Plastico world', 'Bring in a world made with Plastico on its own, with its synced puzzle charts.', wbox);
      body.append(field('Start from', choices));
      const err = el('div', 'alert bad'); err.hidden = true; body.append(err);
      const go = btn('Create', 'btn primary', async () => {
        const how = (box.querySelector('input[name=start]:checked') || {}).value;
        const start = {};
        if (how === 'godot') { const gpath = gs.value || godot.input.value.trim(); if (!gpath) { err.hidden = false; err.textContent = 'Choose the Godot game’s folder.'; return; } start.plastico = { godot: gpath }; }
        if (how === 'world') {
          const file = ws.value || wfile.input.value.trim();
          if (!file) { err.hidden = false; err.textContent = 'Choose the world file.'; return; }
          start.plastico = { world_file: file };
          const w = worlds.find((x) => x.file === file);
          if (w && w.charts) start.puzzles = { charts_file: w.charts };   // the server looks for one next to any other file
        }
        go.disabled = true; err.hidden = true;
        await flushAll();
        try {
          await switching(async () => {
            await withLoading(() => api('POST', '/api/core/project/new', { name: name.value.trim(), path: where.input.value.trim(), start }));
            closeModal(); await loadState();
          });
          toast(`Made ${project().name}.`);
        } catch (e) { go.disabled = false; err.hidden = false; err.textContent = e.message; }
      });
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
      foot(box, [], [btn('Cancel', 'btn', closeModal), go]);
    });
  }

  function openPicker() {
    openModal((box) => {
      head(box, 'Open a project', 'Find the project’s folder (it holds a cassetto.json).');
      const body = el('div', 'modal-body'); box.append(body);
      const go = (p) => { closeModal(); openProject(p); };
      if (native()) {
        body.append(el('p', '', 'Pick the folder in the window that opens.'));
        window.pywebview.api.pick_folder((S.state && S.state.app.projects_dir) || '').then((p) => { if (p) go(p); else closeModal(); }, () => {
          body.textContent = ''; body.append(picker((S.state && S.state.app.projects_dir) || '~', 'project', go));
        });
      } else body.append(picker((S.state && S.state.app.projects_dir) || '~', 'project', go));
      foot(box, [], [btn('Cancel', 'btn', closeModal)]);
    });
  }

  function openRename() {
    openModal((box) => {
      head(box, 'Rename the project', 'The folder keeps its name; the world in Plastico takes the new one.');
      const body = el('div', 'modal-body'); box.append(body);
      const name = el('input'); name.value = project().name; body.append(field('Name', name));
      const save = btn('Rename', 'btn primary', async () => {
        try { await api('POST', '/api/core/project/rename', { name: name.value }); closeModal(); await loadState(); }
        catch (e) { toast(e.message, 'bad'); }
      });
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
      foot(box, [], [btn('Cancel', 'btn', closeModal), save]);
    });
  }

  function openImport() {
    openModal((box) => {
      head(box, 'Import puzzle charts', 'Paste what the Puzzle Charts page copies (⋯ → Copy as JSON), or choose a JSON file. The charts are added; nothing is replaced.');
      const body = el('div', 'modal-body'); box.append(body);
      const text = el('textarea'); text.placeholder = '{ "chart": "…", "steps": [ … ] }'; text.spellcheck = false;
      body.append(field('JSON', text));
      const file = pathInput('', 'file');
      body.append(field('Or a file', file, 'One chart, a list of charts, or a Plastico .charts.json.'));
      const go = btn('Import', 'btn primary', async () => {
        const b = text.value.trim() ? { text: text.value } : file.input.value.trim() ? { path: file.input.value.trim() } : null;
        if (!b) { toast('Paste the JSON or choose a file first.', 'bad'); return; }
        try {
          const r = await api('POST', '/api/puzzles/import', b);
          closeModal(); toast(`Imported ${r.imported.length} chart${r.imported.length === 1 ? '' : 's'}.`);
          show('puzzles', { chart: r.imported[0] });
        } catch (e) { toast(e.message, 'bad'); }
      });
      foot(box, [], [btn('Cancel', 'btn', closeModal), go]);
    });
  }

  // --- a project as one file: export the open one, import one into a new folder
  function openExport() {
    const p = project(); if (!p) return;
    const fname = `${p.name.replace(/[^\p{L}\p{N} _.-]/gu, '-').trim() || 'Project'}.cassetto`;
    const startDir = (S.state && S.state.app.downloads_dir) || '~';
    openModal((box) => {
      head(box, 'Export the project', 'The whole project (world, puzzle charts, sketches, history) in one .cassetto file. Import it on another computer, or keep it as a backup.');
      const body = el('div', 'modal-body'); box.append(body);
      const where = pathInput(`${startDir}/${fname}`, 'save');
      where.input.id = 'f-export-path';
      body.append(field('Save as', where, 'Choose… picks a folder; the file name stays as written.'));
      const go = btn('Export', 'btn primary', async () => {
        let dest = where.input.value.trim();
        if (!dest) { toast('Choose where to save it first.', 'bad'); return; }
        go.disabled = true;
        try {
          await flushAll();
          const r = await api('POST', '/api/core/project/export', { path: dest });
          closeModal(); toast(`Exported to ${home(r.file)}.`);
        } catch (e) { toast(e.message, 'bad'); go.disabled = false; }
      }); go.id = 'f-export-go';
      where.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
      foot(box, [], [btn('Cancel', 'btn', closeModal), go]);
    });
  }
  function openImportProject() {
    openModal((box) => {
      head(box, 'Import a project', 'Choose a .cassetto file exported by Cassetto. It becomes a new project in a folder of its own; nothing already here is replaced.');
      const body = el('div', 'modal-body'); box.append(body);
      const file = pathInput('', 'cassetto');
      file.input.id = 'f-import-path'; file.input.placeholder = '…/My game.cassetto';
      body.append(field('File', file));
      const into = pathInput((S.state && S.state.app.projects_dir) || '', 'folder');
      into.input.id = 'f-import-into';
      body.append(field('Put it in', into, 'A new folder named after the project goes in here.'));
      const go = btn('Import', 'btn primary', async () => {
        const src = file.input.value.trim();
        if (!src) { toast('Choose the .cassetto file first.', 'bad'); return; }
        go.disabled = true;
        try {
          await flushAll();
          await switching(async () => {
            await withLoading(() => api('POST', '/api/core/project/import', { path: src, into: into.input.value.trim() }));
            closeModal(); await loadState();
          });
          toast(`Imported ${project().name}.`);
        } catch (e) { toast(e.message, 'bad'); go.disabled = false; }
      }); go.id = 'f-import-go';
      foot(box, [], [btn('Cancel', 'btn', closeModal), go]);
    });
  }

  async function openInfo() {
    const p = project(); if (!p) return;
    await loadGodot();
    openModal((box) => {
      head(box, p.name, home(p.path));
      const body = el('div', 'modal-body'); box.append(body);
      const dl = el('dl', 'info');
      const row = (k, v) => { dl.append(el('dt', '', k), el('dd', '', v)); };
      row('Folder', p.path);
      row('Project format', `cassetto.project, version ${p.version}`);
      for (const m of modules()) row(m.title, `data version ${(p.modules[m.id] || {}).version || '–'} · ${Object.entries(m.summary || {}).filter(([k, v]) => typeof v !== 'object' && k !== 'godot').map(([k, v]) => `${v} ${k}`).join(', ')}`);
      row('Cassetto', isTest() ? `${versionLabel()} (${appVersion()})` : appVersion());
      body.append(dl);
      body.append(el('h3', 'sec-h', 'How the modules share'));
      const ul = el('ul', 'caps');
      for (const i of S.state.interfaces) { const li = el('li'); li.append(el('span', 'st works', titleOf(i.owner))); const t = el('span'); t.append(el('b', '', i.name + ' '), document.createTextNode(i.doc)); li.append(t); ul.append(li); }
      body.append(ul);
      body.append(el('h3', 'sec-h', 'Godot'));
      const g = S.godot || {};
      body.append(el('p', '', !g.linked ? 'Not linked. Cassetto works without Godot; link a game in Plastico (⋯ → World settings → Godot project).'
        : g.found ? `Linked to ${g.name} in ${home(g.path)}.${g.editor_open ? ' Godot has it open now: builds wait until it’s closed.' : ''}${g.godot_command ? '' : ' The godot command isn’t on the PATH, so the smoke test can’t run.'}`
          : (g.problem || 'The linked folder is missing.')));
      const caps = el('ul', 'caps');
      for (const c of g.capabilities || []) { const li = el('li'); li.append(el('span', `st ${c.state}`, c.state === 'works' ? 'Works' : 'Planned'), el('span', '', c.text)); caps.append(li); }
      body.append(caps);
      foot(box, [], [btn('Done', 'btn primary', closeModal)]);
    });
  }

  /* ---------------------------------------------------------------- settings */
  // The suite's settings, for the person rather than the project: how it looks and which keys do what.
  // Shortcuts change at once and are kept by CassettoKeys (~/.config/cassetto/keybindings.json).
  const SVG = (d, w = 1.4) => `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const SI = {
    look: 'M8 2.2a5.8 5.8 0 1 0 0 11.6 5.8 5.8 0 0 0 0-11.6Z M8 2.2v11.6 M8 5h5 M8 8h5.8 M8 11h5',
    keys: 'M1.8 4.5h12.4v7H1.8z M4 6.8h.01 M6.5 6.8h.01 M9 6.8h.01 M11.5 6.8h.01 M5 9.3h6',
    search: 'M7 2.8a4.2 4.2 0 1 0 0 8.4 4.2 4.2 0 0 0 0-8.4Z M10.2 10.2l3.3 3.3',
    reset: 'M3 8a5 5 0 1 0 1.5-3.6 M3 2.8v2.4h2.4',
    plus: 'M8 3.5v9M3.5 8h9',
    lock: 'M4.5 7.2h7v6h-7z M6 7.2V5.4a2 2 0 0 1 4 0v1.8',
    close: 'M4 4l8 8M12 4l-8 8',
  };
  const THEME_LOOK = {
    light: { p: '#E8EDF0', s: '#FAFBFC', i: '#14202A', l: '#C6D0D7', a: '#C2410C' },
    dark: { p: '#0D141A', s: '#151E26', i: '#E2E9EE', l: '#2D3B46', a: '#F08A4B' },
    oled: { p: '#000000', s: '#0A0A0A', i: '#E6E6E6', l: '#262626', a: '#F08A4B' },
  };
  const kbdOf = (c, cls) => { const s = el('span', cls || 'keycap'); for (const p of K.parts(c)) s.append(el('kbd', '', K.show(p))); return s; };

  function openSettings(pane) {
    if (S.settings) { S.settings.go(pane || S.settings.pane); return; }
    closeMenus();
    const ST = {
      pane: pane || lsGet('cassetto:settings-pane') || 'keys',
      q: '', find: null, scope: 'all',
      rec: null,        // {id, i}: the key being recorded; i = -1 adds one
      held: [],
      pending: null,    // {id, i, chord, others}: keys another action has, waiting for an answer
      note: null,       // {id, kind, text}
      flash: null, arm: false, armTimer: 0, file: '',
    };
    let paneBox = null, navBtns = {};
    openModal((box) => {
      const wrap = el('div', 'set'); box.append(wrap);
      const nav = el('nav', 'set-nav'); nav.setAttribute('aria-label', 'Settings');
      nav.append(el('h2', 'set-title', 'Settings'));
      const tab = (id, label, ic) => {
        const b = btn('', 'set-tab', () => go(id)); b.dataset.pane = id; b.innerHTML = SVG(ic); b.append(el('span', '', label));
        b.append(el('span', 'set-badge')); navBtns[id] = b; nav.append(b);
      };
      tab('look', 'Appearance', SI.look);
      tab('keys', 'Keyboard shortcuts', SI.keys);
      const nf = el('div', 'set-nav-foot', `Cassetto ${versionLabel()}`); nf.title = appVersion(); nav.append(nf);
      paneBox = el('section', 'set-pane'); wrap.append(nav, paneBox);
      const x = btn('', 'set-close', closeModal, 'Close (Esc)'); x.innerHTML = SVG(SI.close, 1.6); x.setAttribute('aria-label', 'Close'); wrap.append(x);
    }, 'settings');
    box().setAttribute('aria-label', 'Settings');
    api('GET', '/api/core/settings/keys').then((d) => { ST.file = d.file || ''; const f = $('#kb-file'); if (f) f.textContent = home(ST.file); }).catch(() => {});

    function box() { return $('#modal-box'); }
    function go(id) {
      stopRec(); ST.pending = null; ST.note = null;
      ST.pane = id === 'look' ? 'look' : 'keys'; lsSet('cassetto:settings-pane', ST.pane);
      buildPane();
    }
    function navState() {
      for (const [id, b] of Object.entries(navBtns)) b.setAttribute('aria-current', String(ST.pane === id));
      const n = K.changes(), bd = navBtns.keys.querySelector('.set-badge');
      bd.textContent = n ? String(n) : ''; bd.hidden = !n; bd.title = n ? `${n} changed from the defaults` : '';
      navBtns.look.querySelector('.set-badge').hidden = true;
    }
    function paneHead(title, sub) { const h = el('header', 'set-head'); h.append(el('h3', '', title), el('p', '', sub)); return h; }

    /* --- appearance */
    function buildLook() {
      paneBox.append(paneHead('Appearance', 'How Cassetto looks, in every module. It changes at once.'));
      const body = el('div', 'set-body');
      body.append(el('h4', 'set-sec', 'Theme'));
      const grid = el('div', 'theme-grid'); grid.setAttribute('role', 'radiogroup'); grid.setAttribute('aria-label', 'Theme');
      const cur = window.CassettoTheme.get();
      for (const [t, [label, sub]] of Object.entries(THEMES)) {
        const b = btn('', 'theme-card', () => { setTheme(t); buildPane(); });
        b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(t === cur));
        const pv = el('span', 'theme-pv' + (t === 'system' ? ' split' : ''));
        for (const look of t === 'system' ? [THEME_LOOK.light, THEME_LOOK.dark] : [THEME_LOOK[t]]) {
          const w = el('span', 'pv');
          w.style.cssText = `--p:${look.p};--s:${look.s};--i:${look.i};--l:${look.l};--a:${look.a}`;
          w.innerHTML = '<span class="pv-bar"><i></i><i></i><i></i></span><span class="pv-side"></span><span class="pv-card"><b></b><i></i><i></i></span>';
          pv.append(w);
        }
        const txt = el('span', 'theme-txt'); txt.append(el('b', '', label)); txt.append(el('small', '', sub || (t === 'light' ? 'Ink on paper' : 'Easy on the eyes at night')));
        b.append(pv, txt); grid.append(b);
      }
      body.append(grid);
      body.append(el('h4', 'set-sec', 'Hints'));
      const lab = el('label', 'set-switch');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = lsGet('cassetto:tabkeys') !== 'off';
      cb.addEventListener('change', () => { lsSet('cassetto:tabkeys', cb.checked ? 'on' : 'off'); renderTabs(); });
      const t = el('span'); t.append(el('b', '', 'Show the keys on the module tabs'), el('small', '', 'The shortcut that opens each module, next to its name at the top.'));
      lab.append(cb, el('span', 'sw'), t);
      body.append(lab);
      paneBox.append(body);
      setTimeout(() => { const on = grid.querySelector('[aria-checked="true"]'); if (on) on.focus({ preventScroll: true }); }, 0);
    }

    /* --- keyboard shortcuts */
    let listBox = null, search = null, findBtn = null, segBox = null, resetAllBtn = null;
    function buildKeys() {
      paneBox.append(paneHead('Keyboard shortcuts', 'Click a shortcut to give it new keys. An action can have more than one, or none. Changes work at once, in every module.'));
      const tools = el('div', 'kb-tools');
      const sw = el('div', 'kb-search');
      const si = el('span', 'kb-search-ic'); si.innerHTML = SVG(SI.search, 1.5);
      search = el('input'); search.type = 'search'; search.placeholder = 'Search actions or keys'; search.value = ST.find ? K.text(ST.find) : ST.q; search.spellcheck = false;
      search.setAttribute('aria-label', 'Search the shortcuts');
      search.addEventListener('input', () => { ST.q = search.value; ST.find = null; findBtn.setAttribute('aria-pressed', 'false'); renderList(); });
      search.addEventListener('keydown', (e) => {
        if (findBtn.getAttribute('aria-pressed') === 'true') {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setFind(false); return; }
          const c = K.chord(e); if (!c) return;
          e.preventDefault(); e.stopPropagation();
          ST.find = c; ST.q = ''; search.value = K.text(c); findBtn.setAttribute('aria-pressed', 'false'); search.classList.remove('listening');
          search.placeholder = 'Search actions or keys'; renderList();
        } else if (e.key === 'Escape' && search.value) { e.preventDefault(); e.stopPropagation(); search.value = ''; ST.q = ''; ST.find = null; renderList(); }
      }, true);
      findBtn = btn('', 'kb-find', () => setFind(findBtn.getAttribute('aria-pressed') !== 'true'), 'Find by pressing the keys');
      findBtn.innerHTML = SVG(SI.keys, 1.3); findBtn.append(el('span', '', 'Press keys')); findBtn.setAttribute('aria-pressed', 'false');
      sw.append(si, search, findBtn);
      segBox = el('div', 'kb-seg'); segBox.setAttribute('role', 'tablist'); segBox.setAttribute('aria-label', 'Where the keys work');
      tools.append(sw, segBox);
      listBox = el('div', 'set-body kb-list');
      const foot = el('footer', 'set-foot');
      const where = el('div', 'kb-where'); where.append(document.createTextNode('Kept in '), Object.assign(el('code', '', home(ST.file) || '~/.config/cassetto/keybindings.json'), { id: 'kb-file' }));
      resetAllBtn = btn('Reset all', 'btn small', resetAll);
      const r = el('div', 'r'); r.append(resetAllBtn, btn('Done', 'btn small primary', closeModal));
      foot.append(where, r);
      paneBox.append(tools, listBox, foot);
      renderList();
      setTimeout(() => { if (search && document.activeElement === document.body) search.focus(); }, 0);
    }
    function setFind(on) {
      findBtn.setAttribute('aria-pressed', String(on));
      search.classList.toggle('listening', on);
      search.placeholder = on ? 'Press the keys to look for…' : 'Search actions or keys';
      if (on) { search.value = ''; ST.q = ''; ST.find = null; renderList(); }
      search.focus();
    }
    function resetAll() {
      const n = K.changes(); if (!n) return;
      if (!ST.arm) {
        ST.arm = true; resetAllBtn.textContent = `Reset ${n} change${n === 1 ? '' : 's'}?`; resetAllBtn.classList.add('danger', 'armed');
        clearTimeout(ST.armTimer); ST.armTimer = setTimeout(() => { ST.arm = false; renderFoot(); }, 3500);
        return;
      }
      ST.arm = false; clearTimeout(ST.armTimer); stopRec(); ST.pending = null; ST.note = null;
      K.resetAll(); toast('Every shortcut is back to its default.');
    }
    function renderFoot() {
      if (!resetAllBtn) return;
      const n = K.changes();
      resetAllBtn.disabled = !n;
      if (!ST.arm) { resetAllBtn.textContent = 'Reset all'; resetAllBtn.classList.remove('danger', 'armed'); }
      resetAllBtn.title = n ? 'Put every shortcut back to its default' : 'Every shortcut has its default keys';
    }
    function matches(a) {
      if (ST.scope === 'changed' && !a.changed) return false;
      if (ST.scope !== 'all' && ST.scope !== 'changed' && a.scope !== ST.scope) return false;
      if (ST.find) return a.keys.includes(ST.find);
      const q = ST.q.trim().toLowerCase(); if (!q) return true;
      const sc = K.scopes.find((s) => s.id === a.scope);
      const hay = [a.label, a.sub, a.group, sc && sc.title, ...a.keys.map((c) => K.text(c)), ...a.keys].join(' ').toLowerCase();
      return q.split(/\s+/).every((w) => hay.includes(w));
    }
    function renderSeg() {
      segBox.textContent = '';
      const n = K.changes();
      if (ST.scope === 'changed' && !n) ST.scope = 'all';
      const opts = [['all', 'All'], ...K.scopes.map((s) => [s.id, s.title]), ...(n ? [['changed', `Changed · ${n}`]] : [])];
      for (const [id, label] of opts) {
        const b = btn(label, 'kb-seg-b', () => { ST.scope = id; renderList(); });
        b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(ST.scope === id));
        if (id === 'changed') b.classList.add('chg');
        segBox.append(b);
      }
    }
    function renderList() {
      if (!listBox) return;
      navState(); renderSeg(); renderFoot();
      const keepScroll = listBox.scrollTop;
      const focusKey = document.activeElement && listBox.contains(document.activeElement) ? document.activeElement.dataset.f : null;
      listBox.textContent = '';
      const all = K.actions();
      let shown = 0;
      for (const sc of K.scopes) {
        const acts = all.filter((a) => a.scope === sc.id && matches(a));
        const fixed = ST.find || ST.scope === 'changed' || (ST.scope !== 'all' && ST.scope !== sc.id) ? [] : K.fixed.filter((f) => f.scope === sc.id && (!ST.q.trim() || `${f.label} ${f.keys.join(' ')}`.toLowerCase().includes(ST.q.trim().toLowerCase())));
        if (!acts.length && !fixed.length) continue;
        shown += acts.length;
        const sec = el('section', 'kb-sec');
        const h = el('header', 'kb-sec-h'); h.append(el('h4', '', sc.title), el('span', '', sc.sub)); sec.append(h);
        let group = null;
        for (const a of acts) {
          if (a.group !== group) { group = a.group; if (group) sec.append(el('div', 'kb-group', group)); }
          sec.append(row(a));
        }
        if (fixed.length) {
          sec.append(el('div', 'kb-group', 'Fixed'));
          for (const f of fixed) {
            const r = el('div', 'kb-row fixed');
            const nm = el('div', 'kb-name'); const lk = el('span', 'kb-lock'); lk.innerHTML = SVG(SI.lock, 1.3); lk.title = 'This one can’t be changed';
            nm.append(el('span', 'kb-label', f.label), lk);
            const ks = el('div', 'kb-keys'); for (const c of f.keys) ks.append(kbdOf(c, 'keycap static'));
            r.append(nm, ks); sec.append(r);
          }
        }
        listBox.append(sec);
      }
      if (!listBox.firstChild) {
        const e = el('div', 'kb-empty');
        e.append(el('b', '', ST.find ? `Nothing uses ${K.text(ST.find)}` : ST.scope === 'changed' ? 'Nothing is changed' : `No shortcut matches “${ST.q.trim()}”`));
        e.append(el('span', '', ST.find ? 'That key is free: click a shortcut to give it to an action.' : 'Try other words, or look in All.'));
        e.append(btn('Clear the search', 'btn small', () => { ST.q = ''; ST.find = null; ST.scope = 'all'; search.value = ''; renderList(); search.focus(); }));
        listBox.append(e);
      }
      listBox.scrollTop = keepScroll;
      if (focusKey) { const f = listBox.querySelector(`[data-f="${CSS.escape(focusKey)}"]`); if (f) f.focus({ preventScroll: true }); }
      if (ST.flash) { const fl = ST.flash; setTimeout(() => { if (ST.flash === fl) ST.flash = null; }, 900); }
    }
    function row(a) {
      const r = el('div', 'kb-row' + (a.changed ? ' changed' : '') + (ST.flash === a.id ? ' flash' : '') + (ST.rec && ST.rec.id === a.id ? ' recording' : ''));
      r.dataset.id = a.id;
      const nm = el('div', 'kb-name');
      nm.append(el('span', 'kb-label', a.label));
      if (a.sub) nm.append(el('span', 'kb-sub', a.sub));
      const ks = el('div', 'kb-keys');
      const P = ST.pending && ST.pending.id === a.id ? ST.pending : null;
      a.keys.forEach((c, i) => {
        if (ST.rec && ST.rec.id === a.id && ST.rec.i === i) ks.append(recChip());
        else if (P && P.i === i) ks.append(kbdOf(P.chord, 'keycap pending'));
        else ks.append(chip(a, c, i));
      });
      if (ST.rec && ST.rec.id === a.id && ST.rec.i === -1) ks.append(recChip());
      else if (P && P.i === -1) ks.append(kbdOf(P.chord, 'keycap pending'));
      else if (!a.keys.length) {
        const b = btn('', 'kc-empty', () => startRec(a.id, -1), 'Give this action keys'); b.dataset.f = `${a.id}|add`;
        b.textContent = 'Not set'; ks.append(b);
      } else if (a.keys.length < 4) {
        const b = btn('', 'kc-add', () => startRec(a.id, -1), 'Add another key for this'); b.dataset.f = `${a.id}|add`;
        b.innerHTML = SVG(SI.plus, 1.6); b.setAttribute('aria-label', `Add another key for ${a.label}`); ks.append(b);
      }
      const rs = btn('', 'kc-reset', () => { stopRec(); ST.pending = null; ST.note = null; ST.flash = a.id; K.reset(a.id); }, `Back to the default: ${K.action(a.id).defaults.map(K.text).join(', ') || 'no keys'}`);
      rs.innerHTML = SVG(SI.reset, 1.5); rs.setAttribute('aria-label', `Reset ${a.label}`); rs.dataset.f = `${a.id}|reset`;
      if (!a.changed) { rs.classList.add('off'); rs.tabIndex = -1; rs.setAttribute('aria-hidden', 'true'); }
      ks.append(rs);
      r.append(nm, ks);
      if (P) r.append(conflictNote(a, P));
      else if (ST.rec && ST.rec.id === a.id) r.append(note(ST.note && ST.note.id === a.id ? ST.note : { kind: 'info', text: ST.rec.i === -1 ? 'Press the keys to add. Esc cancels.' : 'Press the new keys. Esc cancels.' }));
      else if (ST.note && ST.note.id === a.id) r.append(note(ST.note));
      return r;
    }
    function chip(a, c, i) {
      const w = el('span', 'kc' + (K.browserKeeps(c) && !native() ? ' warn' : ''));
      const main = btn('', 'kc-main', () => startRec(a.id, i), `Change ${K.text(c)}`);
      main.append(kbdOf(c)); main.dataset.f = `${a.id}|${i}`;
      const x = btn('', 'kc-x', () => { stopRec(); ST.pending = null; ST.note = null; ST.flash = a.id; K.set(a.id, a.keys.filter((k) => k !== c)); }, `Remove ${K.text(c)}`);
      x.innerHTML = SVG(SI.close, 1.7); x.setAttribute('aria-label', `Remove ${K.text(c)} from ${a.label}`); x.dataset.f = `${a.id}|x${i}`;
      w.append(main, x); return w;
    }
    function recChip() {
      const s = el('span', 'keycap rec'); s.setAttribute('aria-live', 'polite');
      for (const p of ST.held) s.append(el('kbd', '', K.show(p)));
      s.append(el('kbd', 'wait', ST.held.length ? '…' : 'Press keys'));
      return s;
    }
    function note(n) { const d = el('div', `kb-note ${n.kind || 'info'}`); d.append(el('span', '', n.text)); return d; }
    function conflictNote(a, P) {
      const d = el('div', 'kb-note warn');
      const names = P.others.map((id) => { const o = K.action(id); const sc = K.scopes.find((s) => s.id === o.scope); return `“${o.label}”${o.scope !== a.scope ? ` (${sc ? sc.title : o.scope})` : ''}`; });
      const t = el('span'); t.append(kbdOf(P.chord, 'keycap inline'), document.createTextNode(` already does ${names.join(' and ')}.`));
      const yes = btn('Use it here', 'btn small primary', () => {
        for (const id of P.others) K.set(id, K.keys(id).filter((k) => k !== P.chord));
        const moved = names.join(' and ');
        ST.pending = null; apply(a.id, P.i, P.chord, `Moved from ${moved}${P.others.every((id) => !K.keys(id).length) ? ', which has no keys now' : ''}.`);
      });
      yes.dataset.f = `${a.id}|yes`;
      const no = btn('Keep it there', 'btn small', () => { ST.pending = null; ST.note = null; renderList(); focusRow(a.id); });
      const b = el('span', 'kb-note-b'); b.append(no, yes);
      d.append(t, b);
      setTimeout(() => yes.focus({ preventScroll: true }), 0);
      return d;
    }
    function focusRow(id) { const f = listBox && listBox.querySelector(`.kb-row[data-id="${CSS.escape(id)}"] .kc-main, .kb-row[data-id="${CSS.escape(id)}"] .kc-empty`); if (f) f.focus({ preventScroll: true }); }

    // recording: every key goes to the recorder until a whole chord is pressed, or Esc
    function startRec(id, i) {
      stopRec(true);
      ST.pending = null; ST.note = null; ST.rec = { id, i }; ST.held = []; S.recording = true;
      window.addEventListener('keydown', onRecKey, true);
      window.addEventListener('keyup', onRecUp, true);
      box().addEventListener('pointerdown', onRecOutside, true);
      renderList();
      const r = listBox.querySelector(`.kb-row[data-id="${CSS.escape(id)}"]`); if (r) r.scrollIntoView({ block: 'nearest' });
      const rc = listBox.querySelector('.keycap.rec'); if (rc) { rc.tabIndex = -1; rc.focus({ preventScroll: true }); }
    }
    function stopRec(quiet) {
      if (!ST.rec) return;
      const id = ST.rec.id;
      ST.rec = null; ST.held = []; S.recording = false;
      window.removeEventListener('keydown', onRecKey, true);
      window.removeEventListener('keyup', onRecUp, true);
      const b = box(); if (b) b.removeEventListener('pointerdown', onRecOutside, true);
      if (!quiet) { renderList(); focusRow(id); }
    }
    function onRecOutside(e) { if (!e.target.closest('.keycap.rec')) { ST.note = null; stopRec(); } }
    function onRecUp(e) {
      if (!ST.rec) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const h = []; if (e.ctrlKey || e.metaKey) h.push('Ctrl'); if (e.altKey) h.push('Alt'); if (e.shiftKey) h.push('Shift');
      if (h.join() !== ST.held.join()) { ST.held = h; paintRec(); }
    }
    function onRecKey(e) {
      if (!ST.rec) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) { ST.note = null; stopRec(); return; }
      const c = K.chord(e);
      if (!c) { ST.held = K.held(e); paintRec(); return; }
      const { id, i } = ST.rec;
      const why = K.problem(c, id);
      if (why) { ST.note = { id, kind: 'bad', text: why }; ST.held = []; renderList(); const rc = listBox.querySelector('.keycap.rec'); if (rc) { rc.tabIndex = -1; rc.focus({ preventScroll: true }); } return; }
      stopRec(true);
      const now = K.keys(id);
      if (now.includes(c)) { ST.note = { id, kind: 'info', text: `${K.text(c)} already does this.` }; renderList(); focusRow(id); return; }
      const others = K.conflicts(c, id);
      if (others.length) { ST.pending = { id, i, chord: c, others }; ST.note = null; renderList(); return; }
      apply(id, i, c);
    }
    function paintRec() {
      const old = listBox && listBox.querySelector('.keycap.rec'); if (!old) return;
      const n = recChip(); n.tabIndex = -1; old.replaceWith(n); n.focus({ preventScroll: true });
    }
    function apply(id, i, c, msg) {
      let list = K.keys(id);
      if (i >= 0 && i < list.length) list[i] = c; else list.push(c);
      list = [...new Set(list)];
      ST.flash = id;
      const browser = K.browserKeeps(c) && !native();
      ST.note = msg ? { id, kind: 'info', text: msg }
        : browser ? { id, kind: 'warn', text: `A browser window may keep ${K.text(c)} for itself. It works in Cassetto’s own window.` } : null;
      K.set(id, list);      // renders again through onChange
      focusRow(id);
      if (ST.note) { const n = ST.note; setTimeout(() => { if (ST.note === n) { ST.note = null; renderList(); } }, 6000); }
    }

    function buildPane() {
      paneBox.textContent = ''; listBox = null; search = null; resetAllBtn = null;
      navState();
      if (ST.pane === 'look') buildLook(); else buildKeys();
    }
    S.settings = {
      get pane() { return ST.pane; },
      go,
      render: () => { if (ST.pane === 'keys') renderList(); else navState(); },
      escape: () => {       // Esc says "keep it there" to an open question before it closes the dialog
        if (!ST.pending) return false;
        const id = ST.pending.id; ST.pending = null; ST.note = null; renderList(); focusRow(id); return true;
      },
      close: () => { stopRec(true); clearTimeout(ST.armTimer); S.settings = null; },
    };
    buildPane();
  }
  $('#modal').addEventListener('keydown', (e) => {      // keep Tab inside the settings dialog
    if (!S.settings || e.key !== 'Tab') return;
    const f = [...$('#modal-box').querySelectorAll('button:not([disabled]):not([tabindex="-1"]),input,select,textarea,[tabindex="0"]')].filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
  });

  /* ---------------------------------------------------------------- start */
  (async function boot() {
    for (let i = 0; ; i++) {
      try { await loadState(); break; }
      catch (e) { S.down = true; renderStatus(); $('#welcome').hidden = false; await sleep(Math.min(5000, 500 + i * 500)); }
    }
    S.down = false; renderStatus();
    poll();
  })();
})();
