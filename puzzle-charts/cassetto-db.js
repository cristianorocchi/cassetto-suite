/* Puzzle Charts in Cassetto: a stand-in for the claude.ai artifact database the page saves to.
 *
 * The page asks window.claude.use('db') for a database with collections of documents. On claude.ai
 * that is the artifact's own store. In Cassetto this file answers instead, with the same calls the
 * page makes (collection, doc, set, delete, limit, onSnapshot), and keeps the documents in the open
 * project through the Puzzle Charts module:
 *
 *   charts/<id>   one chart              GET/PUT/DELETE /api/puzzles/charts/<id>
 *   meta/world    the world's scenes and people (from Plastico, read only)   GET /api/puzzles/world
 *
 * Snapshots are sent again whenever the project says the charts or the world changed, whoever
 * changed them (this page, Plastico renaming a scene, a file edited by hand).
 */
(function () {
  'use strict';
  if (!window.cassetto || window.claude) return;   // on claude.ai: the real database
  const C = window.cassetto;

  const toCode = (e) => (e && e.status === 409 ? 'revoked' : e && e.status === 413 ? 'quota_exceeded' : 'unavailable');
  const fail = (e) => { const x = new Error(e.message); x.code = toCode(e); return x; };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const snap = (docs) => ({ docs: docs.map((d) => ({ id: d.id, exists: true, data: () => clone(d.data) })), empty: !docs.length, metadata: { fromCache: false } });
  const newId = () => 'c' + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

  const told = new Set();
  function listen(load, types, cb, errCb) {
    let timer = 0, alive = true;
    const run = async () => {
      try { const docs = await load(); if (alive) cb(snap(docs)); }
      catch (e) { if (alive && errCb) errCb(fail(e)); }
    };
    const later = () => { clearTimeout(timer); timer = setTimeout(run, 120); };
    const offs = types.map((t) => C.on(t, later));
    run();
    return () => { alive = false; offs.forEach((f) => f()); };
  }

  async function loadCharts() {
    const r = await C.api('GET', '/api/puzzles/charts');
    for (const p of r.problems || []) if (!told.has(p)) { told.add(p); C.error(p); }
    return r.docs;
  }
  async function loadMeta() {
    const r = await C.api('GET', '/api/puzzles/world');
    return r.world ? [{ id: 'world', data: r.world }] : [];
  }

  function collection(name) {
    if (name === 'charts') {
      return {
        doc(id) {
          id = id || newId();
          return {
            id,
            set: (body) => C.api('PUT', `/api/puzzles/charts/${encodeURIComponent(id)}`, body).then(() => undefined, (e) => { throw fail(e); }),
            delete: () => C.api('DELETE', `/api/puzzles/charts/${encodeURIComponent(id)}`).then(() => undefined, (e) => { throw fail(e); }),
          };
        },
        limit() { return this; },
        onSnapshot: (cb, errCb) => listen(loadCharts, ['puzzles.changed', 'project.opened'], cb, errCb),
      };
    }
    if (name === 'meta') {
      return {
        doc(id) { return { id, set: () => Promise.reject(Object.assign(new Error('read only'), { code: 'invalid_argument' })), delete: () => Promise.resolve() }; },
        limit() { return this; },
        onSnapshot: (cb, errCb) => listen(loadMeta, ['world.changed', 'project.opened'], cb, errCb),
      };
    }
    throw new Error(`no collection ${name}`);
  }

  const db = { collection };
  const user = { can: async () => true };
  window.claude = { use: async (what) => (what === 'db' ? db : what === 'user' ? user : null) };
})();
