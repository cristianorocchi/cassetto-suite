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
        error: (msg) => toast(msg, 'bad'),
      };
    },
    flushAll,
  };
  async function flushAll() {
    const jobs = [];
    for (const [, l] of S.links) if (l.hooks.flush) { try { jobs.push(Promise.resolve(l.hooks.flush())); } catch (e) { /* page gone */ } }
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
  function shortcut(e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return false;
    const n = parseInt(e.key, 10);
    if (!(n >= 1 && n <= 9)) return false;
    const m = modules()[n - 1]; if (!m || !project()) return false;
    show(m.id); return true;
  }
  document.addEventListener('keydown', (e) => { if (shortcut(e)) e.preventDefault(); if (e.key === 'Escape') { closeMenus(); } });

  /* ---------------------------------------------------------------- rendering */
  function renderTabs() {
    const t = $('#tabs'); t.textContent = '';
    modules().forEach((m, i) => {
      const b = el('button', 'tab'); b.type = 'button'; b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(S.active === m.id)); b.disabled = !project();
      b.append(icon(ICONS[m.id] || ICONS.plastico), document.createTextNode(m.title));
      if ((S.statuses.get(m.id) || {}).state === 'err') b.append(el('span', 'bad'));
      b.append(el('kbd', '', `Ctrl ${i + 1}`));
      b.title = `${m.title} (Ctrl+${i + 1})`;
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
  function renderHead() {
    const p = project();
    $('#proj-name').textContent = p ? p.name : 'No project';
    document.title = p ? `${p.name} · Cassetto` : 'Cassetto';
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
    const now = project() && project().path;
    if (before !== now) {
      resetFrames();
      S.godot = null;
      if (now) {
        const want = new URLSearchParams(location.hash.slice(1));
        const first = want.get('module') || lsGet('cassetto:module');
        let target = null; try { target = want.get('target') ? JSON.parse(want.get('target')) : null; } catch (e) { target = null; }
        if (location.hash) history.replaceState(null, '', location.pathname);
        show(modules().some((m) => m.id === first) ? first : modules()[0].id, target);
        loadGodot();
      }
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
  async function openProject(path) {
    closeMenus();
    if (project() && project().path === path) return;
    await flushAll();
    try { await withLoading(() => api('POST', '/api/core/project/open', { path })); await loadState(); toast(`Opened ${project().name}.`); }
    catch (e) { toast(e.message, 'bad'); await loadState(); }
  }
  async function closeProject() {
    closeMenus(); await flushAll();
    try { await api('POST', '/api/core/project/close'); } catch (e) { toast(e.message, 'bad'); }
    await loadState();
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
    else if (ev.type === 'project.renamed') { if (S.state && S.state.project) S.state.project.name = ev.data.name; renderHead(); }
    else if (ev.type === 'world.changed') { refreshSoon(); loadGodot(); }
    else if (ev.type.endsWith('.changed')) refreshSoon();
    for (const id of S.links.keys()) emitTo(id, ev.type, ev);
  }
  setInterval(() => { api('POST', '/api/core/heartbeat').catch(() => {}); }, 10000);
  api('POST', '/api/core/heartbeat').catch(() => {});
  window.addEventListener('pagehide', () => { flushAll(); });

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
    let rec = [];
    try { rec = (await api('GET', '/api/core/recent')).recent.filter((r) => r.exists && (!project() || r.path !== project().path)).slice(0, 5); } catch (e) { /* offline */ }
    if (rec.length) { box.append(el('div', 'mi-head', 'Recent')); for (const r of rec) box.append(mi(r.name, home(r.path), () => openProject(r.path))); }
    if (project()) {
      box.append(el('div', 'mi-sep'));
      box.append(mi('Rename…', project().name, openRename));
      box.append(mi('Import puzzle charts…', 'From the Puzzle Charts page’s “Copy as JSON”, or a file', openImport));
      box.append(mi('About this project', 'Its folder, format, modules and the link to Godot', openInfo));
      box.append(el('div', 'mi-sep'));
      box.append(mi('Close the project', '', closeProject));
    }
  });
  menu($('#btn-links'), $('#menu-links'), async (box) => {
    box.append(el('div', 'mi-head', 'Puzzle steps the world doesn’t have room for'));
    let r = null;
    try { r = await api('GET', '/api/puzzles/references'); } catch (e) { box.append(el('div', 'mi-note', e.message)); return; }
    for (const m of r.missing_scenes) box.append(mi(`“${m.title}” is in ${m.scene}`, `${m.chart_name}: no scene ${m.scene} in the world`, () => show('puzzles', { chart: m.chart, step: m.step })));
    for (const m of r.missing_people) box.append(mi(`“${m.title}” is with ${m.who}`, `${m.chart_name}: nobody called ${m.who} in the world`, () => show('puzzles', { chart: m.chart, step: m.step })));
    box.append(el('div', 'mi-note', 'Pick a step to fix it in Puzzle Charts, or add the scene or person in Plastico.'));
  });
  $('#btn-godot').addEventListener('click', () => openInfo());
  document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => ({ new: openNew, open: openPicker })[b.dataset.act]()));

  /* ---------------------------------------------------------------- dialogs */
  function openModal(build) {
    const box = $('#modal-box'); box.textContent = '';
    build(box);
    $('#modal').hidden = false;
    const f = box.querySelector('input:not([type=radio]),textarea,select'); if (f) setTimeout(() => f.focus(), 0);
  }
  function closeModal() { $('#modal').hidden = true; }
  $('#modal').addEventListener('mousedown', (e) => { if (e.target === $('#modal')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
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
      if (native()) {
        try { const p = await (kind === 'file' ? window.pywebview.api.pick_file(inp.value) : window.pywebview.api.pick_folder(inp.value)); if (p) { inp.value = p; if (onPick) onPick(p); inp.dispatchEvent(new Event('input')); } return; }
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
    const up = btn('Up', 'btn small'); const pickHere = btn(kind === 'file' ? 'Open' : 'Use this folder', 'btn small primary');
    top.append(up, where, pickHere);
    const list = el('div', 'picker-list');
    box.append(top, list);
    let cur = null, asked = 0;
    async function go(path) {
      const mine = ++asked;     // only the folder asked for last is shown
      let d;
      try { d = await api('GET', `/api/core/fs?path=${encodeURIComponent(path)}`); if (mine !== asked) return; }
      catch (e) {
        if (mine !== asked) return;
        const parent = path.replace(/\/[^/]*\/?$/, '') || '/';
        if (parent !== path) return go(parent);
        list.textContent = ''; list.append(el('div', 'empty', e.message)); return;
      }
      cur = d; where.value = d.path; up.disabled = !d.parent; pickHere.hidden = kind === 'file';
      list.textContent = '';
      for (const x of d.dirs) {
        const b = el('button'); b.type = 'button'; b.append(icon(FOLDER), document.createTextNode(x.name));
        if (x.project) b.append(el('span', 'tag p', 'Cassetto project')); else if (x.godot) b.append(el('span', 'tag', 'Godot project'));
        b.addEventListener('click', () => go(x.path));
        b.addEventListener('dblclick', () => { if (kind === 'project' && x.project) onPick(x.path); });
        list.append(b);
      }
      if (kind === 'file') for (const x of d.json) { const b = el('button'); b.type = 'button'; b.append(icon(FILE), document.createTextNode(x.name)); b.addEventListener('click', () => onPick(x.path)); list.append(b); }
      if (!list.firstChild) list.append(el('div', 'empty', kind === 'file' ? 'No folders or JSON files here.' : 'No folders here.'));
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
    let worlds = [];
    try { worlds = (await api('GET', '/api/core/plastico-worlds')).worlds; } catch (e) { /* none */ }
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
      const godot = pathInput('', 'folder');
      radio('godot', 'A Godot game', 'Read its scenes, exits and people (it isn’t changed until you build).', godot);
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
        if (how === 'godot') { if (!godot.input.value.trim()) { err.hidden = false; err.textContent = 'Choose the Godot game’s folder.'; return; } start.plastico = { godot: godot.input.value.trim() }; }
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
          await withLoading(() => api('POST', '/api/core/project/new', { name: name.value.trim(), path: where.input.value.trim(), start }));
          closeModal(); await loadState(); toast(`Made ${project().name}.`);
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
      row('Cassetto', S.state.app.version);
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
