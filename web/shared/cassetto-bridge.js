/* The link between a module's page and the Cassetto shell around it.
 *
 * Inside the shell, window.cassetto is the shell's link for this module: the open project, the
 * project's events, moving to another module, the save status and the core's interfaces. A page
 * opened on its own (no shell) gets a link that does the same on its own, without the other modules.
 *
 *   cassetto.embedded                 true inside the shell
 *   cassetto.module                   this module's id ("plastico", "puzzles")
 *   cassetto.project()                {id, name, path, ...} or null
 *   cassetto.api(method, path, body)  a request to Cassetto's server (JSON in and out)
 *   cassetto.call(name, ...args)      an interface of another module, through the core
 *   cassetto.on(type, fn)             project events ("world.changed", "puzzles.changed", ...) and the
 *                                     shell's own ("activate", "deactivate"); returns an unsubscribe
 *   cassetto.register({flush, navigate})   what the shell may ask of this page
 *   cassetto.navigate(module, target) show another module, at `target` (a scene, a chart step...)
 *   cassetto.status(state, text)      saved | busy | dirty | err, for the shell's save indicator
 *   cassetto.error(message)           a problem the person should see
 */
(function () {
  'use strict';
  const m = location.pathname.match(/^\/m\/([a-z][a-z0-9_-]*)\//);
  const moduleId = m ? m[1] : 'shell';
  let shell = null;
  try { if (window.parent !== window && window.parent.Cassetto && window.parent.Cassetto.isShell) shell = window.parent.Cassetto; } catch (e) { shell = null; }

  async function api(method, path, body) {
    const opt = { method, headers: { 'X-Cassetto': '1' } };
    if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
    const r = await fetch(path, opt);
    let data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    if (!r.ok) { const e = new Error((data && data.error) || `HTTP ${r.status}`); e.status = r.status; e.code = data && data.code; throw e; }
    return data;
  }

  if (shell) {
    window.cassetto = shell.connect(moduleId, window);
  } else {
    // on its own: follow the project's events here, keep everything else local
    const subs = new Map();
    let hooks = {}, project = null, seq = 0, stopped = false;
    const emit = (type, ev) => { for (const fn of subs.get(type) || []) { try { fn(ev); } catch (e) { console.error(e); } } };
    (async function poll() {
      try { const st = await api('GET', '/api/core/state'); project = st.project; seq = st.seq; } catch (e) { /* server down */ }
      while (!stopped) {
        try {
          const r = await api('GET', `/api/core/events?after=${seq}&wait=20`);
          seq = r.seq;
          for (const ev of r.events) { if (ev.type === 'project.opened') project = ev.data.project; emit(ev.type, ev); emit('*', ev); }
        } catch (e) { await new Promise((res) => setTimeout(res, 3000)); }
      }
    })();
    window.cassetto = {
      embedded: false, module: moduleId,
      project: () => project,
      api, call: (name, ...args) => api('POST', `/api/core/call/${name}`, { args, caller: moduleId }).then((r) => r.result),
      on(type, fn) { if (!subs.has(type)) subs.set(type, new Set()); subs.get(type).add(fn); return () => subs.get(type).delete(fn); },
      register(h) { hooks = h || {}; const t = new URLSearchParams(location.hash.slice(1)).get('target'); if (t && hooks.navigate) { try { hooks.navigate(JSON.parse(t)); } catch (e) { /* bad link */ } } },
      navigate(mod, target) { location.href = `/#module=${encodeURIComponent(mod)}${target ? '&target=' + encodeURIComponent(JSON.stringify(target)) : ''}`; },
      status() {}, error(msg) { console.warn(msg); },
    };
  }
})();
