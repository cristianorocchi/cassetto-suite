// The world as the app sees it: the plan (world) merged with the game (game scan) and the
// puzzle charts, plus the analysis: routes, what the player can reach, and the checks.
// Pure functions, no DOM: tests/model.test.mjs runs them under node.

// w and d are a new scene's footprint in whole grid cells; h is how tall its block stands.
export const KINDS = {
  outside: { label: 'Outside', long: 'Outside (third person)', w: 12, d: 7, h: 0.5 },
  inside: { label: 'Inside', long: 'Inside (first person)', w: 6, d: 4, h: 3 },
  closeup: { label: 'Close-up', long: 'Close-up (a view of one thing)', w: 3, d: 2, h: 1.8 },
};

// --- the ground grid: one unit per cell from the origin, a heavier line every MAJOR. The grid on screen,
// snapping and the footprints all use these, so a block's edges always fall on grid lines.
export const GRID = 1;
export const MAJOR = 5;
export const MAX_CELLS = 40;
const cells = (v, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 1 ? Math.min(MAX_CELLS, n) : dflt; };
/** A scene's block: footprint w × d (whole cells) and height h. */
export function sizeOf(s) {
  const k = KINDS[s && s.kind] || KINDS.inside;
  return { w: cells(s && s.w, k.w), d: cells(s && s.d, k.d), h: k.h };
}
/** The centre on one axis that puts both edges of a block `size` cells long on grid lines. */
export function snapAxis(c, size) { return Math.round((c - size / 2) / GRID) * GRID + size / 2; }
export function snapCenter(x, z, w, d) { return { x: snapAxis(x, w), z: snapAxis(z, d) }; }
export function footprint(x, z, w, d) { return { x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2 }; }
const EPS = 1e-6;
/** True if two footprints share some area (touching along an edge is fine). */
export function overlap(a, b) { return a.x0 < b.x1 - EPS && b.x0 < a.x1 - EPS && a.z0 < b.z1 - EPS && b.z0 < a.z1 - EPS; }
/** The scenes on `floor` whose blocks would overlap a block w × d centred at x, z. */
export function overlapping(scenes, x, z, w, d, floor, skip = new Set()) {
  const f = footprint(x, z, w, d);
  return scenes.filter((q) => !skip.has(q.id) && (q.floor || 0) === (floor || 0) && overlap(f, footprint(q.x, q.z, sizeOf(q).w, sizeOf(q).d)));
}
/** The grid position nearest to x, z (snapped) where a w × d block on `floor` overlaps nothing. */
export function freeSpot(scenes, x, z, w, d, floor, skip = new Set()) {
  const c = snapCenter(x, z, w, d);
  for (let r = 0; r <= 60; r++) {
    let best = null, bestD = Infinity;
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
      const px = c.x + i * GRID, pz = c.z + j * GRID;
      if (overlapping(scenes, px, pz, w, d, floor, skip).length) continue;
      const dd = Math.hypot(i, j);
      if (dd < bestD) { bestD = dd; best = { x: px, z: pz }; }
    }
    if (best) return best;
  }
  return c;
}

/** A group of blocks (a scene and the scenes inside it, at their positions before the move) moved by dx, dz
 * and df floors: the nearest grid offset to dx, dz at which none of them overlaps a block outside the group. */
export function freeShift(scenes, group, dx, dz, df = 0) {
  const ids = new Set(group.map((g) => g.id));
  const others = scenes.filter((q) => !ids.has(q.id));
  for (let r = 0; r <= 40; r++) {
    let best = null, bestD = Infinity;
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
      const ox = dx + i * GRID, oz = dz + j * GRID;
      if (group.some((g) => overlapping(others, g.x + ox, g.z + oz, sizeOf(g).w, sizeOf(g).d, (g.floor || 0) + df).length)) continue;
      const dd = Math.hypot(i, j);
      if (dd < bestD) { bestD = dd; best = { dx: ox, dz: oz }; }
    }
    if (best) return best;
  }
  return { dx, dz };
}

// --- scenes inside scenes: a scene can have a parent; children follow their parent's act ---
export function childrenOf(world, id) { return world.scenes.filter((q) => q.parent === id); }
export function descendantsOf(world, id) {
  const out = new Set(), q = [id];
  while (q.length) { const p = q.pop(); for (const c of world.scenes) if (c.parent === p && !out.has(c.id)) { out.add(c.id); q.push(c.id); } }
  return out;
}
export function ancestorsOf(world, id) {
  const out = [], by = new Map(world.scenes.map((q) => [q.id, q]));
  let cur = by.get(id), guard = 0;
  while (cur && cur.parent && by.has(cur.parent) && guard++ < 200) { cur = by.get(cur.parent); out.push(cur); }
  return out;
}
/** Where a new child of `parent` goes: just below it on the map (towards +z), edges on the grid, nothing overlapped. */
export function childSpot(world, parent, w, d) {
  const P = sizeOf(parent), floor = parent.floor || 0;
  const left = parent.x - P.w / 2, z = parent.z + P.d / 2 + d / 2;
  // along the parent's bottom edge, from its left corner (after the children already there)
  const kids = childrenOf(world, parent.id).reduce((n, k) => n + sizeOf(k).w, 0);
  for (let k = 0; k < P.w + kids; k++) {
    const off = (kids + k) % Math.max(1, P.w + kids);
    const x = left + off + w / 2;
    if (!overlapping(world.scenes, x, z, w, d, floor).length) return { x, z };
  }
  return freeSpot(world.scenes, left + w / 2, z, w, d, floor);    // that edge is taken: the nearest free place
}
export const STATE_LABEL = { game: 'In the game', ready: 'Ready to build', idea: 'Idea', delete: 'To delete' };
export const FLOOR_H = 4.4;

export function pairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }
export const firstName = (n) => String(n || '').split(',')[0].trim();

export function derive(world, game, charts, uploads = []) {
  const phases = (game && game.phases && game.phases.length ? game.phases : world.phases) || [];
  const gScenes = (game && game.scenes) || {};
  const people = new Map(world.people.map((p) => [p.id, p]));
  const upl = new Set(uploads);
  const scenes = new Map();
  for (const s of world.scenes) {
    const g = gScenes[s.id] && gScenes[s.id].exists ? gScenes[s.id] : null;
    const state = s.delete ? 'delete' : g ? 'game' : s.status;
    scenes.set(s.id, { ...s, g, inGame: !!g, state, hasPicture: (g && g.has_art) || upl.has(s.id), frame: g && g.frame });
  }
  // game exits, by direction
  const exitsByPair = new Map();
  const openEnds = [];
  for (const e of (game && game.exits) || []) {
    if (!e.to) { openEnds.push(e); continue; }
    const k = `${e.from}>${e.to}`;
    if (!exitsByPair.has(k)) exitsByPair.set(k, []);
    exitsByPair.get(k).push(e);
  }
  const links = new Map(), pairs = new Map(), out = new Map(), inn = new Map();
  for (const id of scenes.keys()) { out.set(id, []); inn.set(id, []); }
  for (const l of world.links) {
    if (!scenes.has(l.from) || !scenes.has(l.to)) continue;
    const exits = exitsByPair.get(`${l.from}>${l.to}`) || [];
    const inGame = exits.length > 0;
    const ends = [scenes.get(l.from), scenes.get(l.to)];
    const state = l.delete || ends.some((s) => s.delete) ? 'delete' : inGame ? 'game' : l.status;
    // a way the game only opens at some times of day (its hotspot is tagged with phases)
    let gamePhases = null;
    for (const e of exits) if (Array.isArray(e.phases)) gamePhases = [...new Set([...(gamePhases || []), ...e.phases])];
    const L = { ...l, exits, inGame, state, gamePhases, script: exits.some((e) => e.via === 'script') && !exits.some((e) => e.via === 'exit') };
    links.set(l.id, L);
    out.get(l.from).push(L); inn.get(l.to).push(L);
    const k = pairKey(l.from, l.to);
    if (!pairs.has(k)) { const [a, b] = l.from < l.to ? [l.from, l.to] : [l.to, l.from]; pairs.set(k, { key: k, a, b, ab: null, ba: null }); }
    const P = pairs.get(k);
    if (l.from === P.a) P.ab = L; else P.ba = L;
  }
  for (const P of pairs.values()) {
    const ls = [P.ab, P.ba].filter(Boolean);
    P.links = ls;
    P.oneWay = ls.length === 1;
    P.state = ls.some((l) => l.state === 'delete') ? (ls.every((l) => l.state === 'delete') ? 'delete' : 'mixed-delete')
      : ls.every((l) => l.state === 'game') ? 'game' : ls.some((l) => l.state === 'game') ? 'mixed' : ls.some((l) => l.state === 'ready') ? 'ready' : 'idea';
    P.locked = ls.some((l) => l.lock);
    P.timed = ls.some((l) => (l.open && l.open.length) || l.gamePhases);
  }
  // puzzle chart steps per scene
  const steps = new Map();
  for (const c of (charts && charts.charts) || []) {
    for (const n of c.nodes) {
      if (!n.scene) continue;
      if (!steps.has(n.scene)) steps.set(n.scene, []);
      steps.get(n.scene).push({ chart: c, node: n });
    }
  }
  const chartById = new Map(((charts && charts.charts) || []).map((c) => [c.id, c]));
  const M = { world, game, charts, chartById, phases, scenes, links, pairs, out, inn, openEnds, people, steps };
  M.start = world.start && scenes.has(world.start) ? world.start : '';
  return M;
}

// --- time of day and people ---

export function sceneOpenAt(S, phase) { return !phase || !S.open || !S.open.length || S.open.includes(phase); }
export function linkOpenAt(L, phase) {
  if (!phase) return true;
  if (L.open && L.open.length && !L.open.includes(phase)) return false;
  if (L.gamePhases && !L.gamePhases.includes(phase)) return false;
  return true;
}
/** [{id, name, from:'game'|'plan'}] for a scene at a phase. */
/** People the game puts in a scene that the plan takes out of it, per time of day ('' = any time). */
export function awayAt(S, phase) {
  const away = S.away || {};
  return new Set(phase ? away[phase] || [] : Object.values(away).flat());
}
export function peopleAt(M, S, phase) {
  const out = new Map();
  const gp = (S.g && S.g.people) || {};
  if (phase) { const away = awayAt(S, phase); for (const id of gp[phase] || []) if (!away.has(id)) out.set(id, 'game'); }
  else for (const [ph, ids] of Object.entries(gp)) { const away = awayAt(S, ph); for (const id of ids) if (!away.has(id)) out.set(id, 'game'); }
  const plan = S.people || {};
  const list = phase ? plan[phase] || [] : Object.values(plan).flat();
  for (const id of list) if (!out.has(id)) out.set(id, 'plan');
  return [...out].map(([id, from]) => ({ id, from, name: firstName((M.people.get(id) || {}).name) || id }));
}

// --- locks ---

/** Where the player gets what a lock needs: the lock's own "where", else a puzzle chart step that gives it. */
export function keySource(M, needs) {
  for (const c of (M.charts && M.charts.charts) || []) {
    for (const n of c.nodes) {
      if (n.gid && n.gid === needs && n.scene) return { scene: n.scene, chart: c.name, step: n.title, kind: n.kind };
    }
  }
  return null;
}
export function lockKeys(M) {
  const keys = new Map();
  for (const L of M.links.values()) {
    if (!L.lock || L.state === 'delete') continue;
    const k = L.lock.needs;
    if (!keys.has(k)) keys.set(k, { needs: k, type: L.lock.type || 'item', links: [], where: '', whereFrom: '' });
    const K = keys.get(k);
    K.links.push(L);
    if (!K.where && L.lock.where && M.scenes.has(L.lock.where)) { K.where = L.lock.where; K.whereFrom = 'plan'; }
  }
  for (const K of keys.values()) {
    if (!K.where) { const src = keySource(M, K.needs); if (src && M.scenes.has(src.scene)) { K.where = src.scene; K.whereFrom = `chart “${src.chart}”`; } }
  }
  return [...keys.values()].sort((a, b) => a.needs.localeCompare(b.needs));
}

// --- graph ---

/**
 * Who can go where. opts: phase (only what is open then), keys (Set: locks they open; null = every
 * lock open), skip (a link id treated as closed), builtOnly (only what is in the game), act (scenes of one act).
 */
export function adjacency(M, opts = {}) {
  const { phase = null, keys = null, skip = null, builtOnly = false } = opts;
  const adj = new Map();
  for (const S of M.scenes.values()) adj.set(S.id, []);
  for (const L of M.links.values()) {
    if (L.state === 'delete' || L.id === skip) continue;
    if (builtOnly && L.state !== 'game') continue;
    const a = M.scenes.get(L.from), b = M.scenes.get(L.to);
    if (!a || !b || a.state === 'delete' || b.state === 'delete') continue;
    if (builtOnly && (a.state !== 'game' || b.state !== 'game')) continue;
    if (!linkOpenAt(L, phase) || !sceneOpenAt(b, phase)) continue;
    if (keys && L.lock && !keys.has(L.lock.needs)) continue;
    adj.get(L.from).push({ to: L.to, link: L });
  }
  return adj;
}
export function bfs(adj, start) {
  const dist = new Map([[start, 0]]), prev = new Map();
  const q = [start];
  while (q.length) {
    const v = q.shift();
    for (const { to, link } of adj.get(v) || []) {
      if (dist.has(to)) continue;
      dist.set(to, dist.get(v) + 1); prev.set(to, { from: v, link }); q.push(to);
    }
  }
  return { dist, prev };
}
export function pathTo(res, target) {
  if (!res.dist.has(target)) return null;
  const scenes = [target], links = [];
  let v = target;
  while (res.prev.has(v)) { const p = res.prev.get(v); links.unshift(p.link); scenes.unshift(p.from); v = p.from; }
  return { scenes, links };
}
export function route(M, from, to, opts = {}) { return pathTo(bfs(adjacency(M, opts), from), to); }

function sccs(ids, adj) {
  let i = 0; const idx = new Map(), low = new Map(), on = new Set(), st = [], out = [];
  function strong(v) {
    idx.set(v, i); low.set(v, i); i++; st.push(v); on.add(v);
    for (const { to } of adj.get(v) || []) {
      if (!idx.has(to)) { strong(to); low.set(v, Math.min(low.get(v), low.get(to))); }
      else if (on.has(to)) low.set(v, Math.min(low.get(v), idx.get(to)));
    }
    if (low.get(v) === idx.get(v)) { const c = []; let w; do { w = st.pop(); on.delete(w); c.push(w); } while (w !== v); out.push(c); }
  }
  for (const v of ids) if (!idx.has(v)) strong(v);
  return out;
}

const nm = (M, id) => (M.scenes.get(id) || {}).name || id;
function listNames(names) {
  const q = names.map((n) => `${n}`);
  if (q.length <= 2) return q.join(' and ');
  return q.slice(0, -1).join(', ') + ' and ' + q[q.length - 1];
}

/** Everything worth knowing about the structure, worst first. */
export function checks(M) {
  const issues = [];
  const add = (level, head, text, scenes = [], links = []) => issues.push({ level, head, text, scenes, links });
  for (const p of (M.game && M.game.problems) || []) add(p.level === 'error' ? 'error' : 'warn', 'In the game', p.text, p.scene ? [p.scene] : []);

  const live = [...M.scenes.values()].filter((s) => s.state !== 'delete');
  const adj = adjacency(M);
  const acts = M.world.acts || [];
  // reachability, act by act, from each act's start (act 1 also from the game's start)
  for (const act of acts) {
    const mine = live.filter((s) => s.act === act.id);
    if (!mine.length) continue;
    let start = act.start && M.scenes.has(act.start) ? act.start : '';
    if (!start && M.start && M.scenes.get(M.start).act === act.id) start = M.start;
    const label = acts.length > 1 ? `Act ${act.id}` : 'This world';
    if (!start) {
      if (mine.length > 1) add('info', `${label} has no start`, `Pick the scene ${acts.length > 1 ? 'the act' : 'the game'} starts in (World settings), and Plastico can check what the player can reach.`);
      continue;
    }
    const reach = bfs(adj, start);
    const lost = mine.filter((s) => !reach.dist.has(s.id));
    if (lost.length) add('warn', 'Can’t be reached', `${listNames(lost.map((s) => s.name))} can’t be reached from ${nm(M, start)}, the start${acts.length > 1 ? ` of act ${act.id}` : ''}.`, lost.map((s) => s.id));
    // no way back: reached, but the start can't be reached from there
    const back = new Map(); for (const S of live) back.set(S.id, []);
    for (const [v, list] of adj) for (const { to, link } of list) if (back.has(to)) back.get(to).push({ to: v, link });
    const toStart = bfs(back, start);
    const trapped = mine.filter((s) => reach.dist.has(s.id) && !toStart.dist.has(s.id));
    if (trapped.length) add('warn', 'No way back', `Once in ${listNames(trapped.map((s) => s.name))}, the player can’t get back to ${nm(M, start)}. Fine for the end of ${acts.length > 1 ? 'an act' : 'the game'}; a trap anywhere else.`, trapped.map((s) => s.id));
    // locks: is what opens a lock only behind that same lock?
    for (const K of lockKeys(M)) {
      for (const L of K.links) {
        if (M.scenes.get(L.from).act !== act.id) continue;
        if (!K.where) continue;
        const without = bfs(adjacency(M, { skip: L.id }), start);
        if (!without.dist.has(K.where) && reach.dist.has(K.where)) {
          add('error', 'Key behind its own lock', `${K.needs} opens the way from ${nm(M, L.from)} to ${nm(M, L.to)}, but the player gets it in ${nm(M, K.where)}, which can only be reached through that way.`, [K.where, L.from, L.to], [L.id]);
        }
      }
    }
  }
  for (const S of live) {
    const outs = (M.out.get(S.id) || []).filter((l) => l.state !== 'delete');
    const ins = (M.inn.get(S.id) || []).filter((l) => l.state !== 'delete');
    if (!outs.length && !ins.length && live.length > 1) add('warn', 'Not joined', `${S.name} has no ways in or out yet.`, [S.id]);
    else if (!outs.length) add('warn', 'Dead end', `${S.name} has no way out.`, [S.id]);
  }
  for (const K of lockKeys(M)) {
    if (!K.where) add('warn', 'Where is the key?', `The way${K.links.length > 1 ? 's' : ''} from ${listNames(K.links.map((l) => `${nm(M, l.from)} to ${nm(M, l.to)}`))} need${K.links.length > 1 ? '' : 's'} ${K.needs}, but nothing says where the player gets it. Set it on the lock, or give it a step in a puzzle chart.`, [], K.links.map((l) => l.id));
  }
  // time of day: a scene nobody can enter at the times it is open
  if (M.phases.length) {
    for (const S of live) {
      const ins = (M.inn.get(S.id) || []).filter((l) => l.state !== 'delete');
      if (!ins.length) continue;
      const when = M.phases.filter((p) => sceneOpenAt(S, p) && ins.some((l) => linkOpenAt(l, p)));
      if (!when.length) add('warn', 'Never open', `${S.name} is never open at a time when a way into it is.`, [S.id]);
    }
    // people in two places at once
    for (const p of M.phases) {
      const where = new Map();
      for (const S of live) for (const who of peopleAt(M, S, p)) {
        if (!where.has(who.id)) where.set(who.id, []);
        where.get(who.id).push(S);
      }
      for (const [id, list] of where) {
        if (list.length < 2) continue;
        // the scenes where the plan puts them come first: clicking the check opens the first one
        const planned = (S) => peopleAt(M, S, p).some((w) => w.id === id && w.from === 'plan');
        const ordered = [...list.filter(planned), ...list.filter((S) => !planned(S))];
        add('warn', 'In two places', `${firstName((M.people.get(id) || {}).name) || id} is in ${listNames(ordered.map((s) => s.name))} at once (${p}). Take them out of one: the × on their name under People here.`, ordered.map((s) => s.id));
      }
    }
    // people the plan takes out of a scene the game puts them in: only Godot can do that
    const leaving = [];
    for (const S of live) for (const ph of M.phases) for (const id of awayAt(S, ph)) {
      if (((S.g && S.g.people && S.g.people[ph]) || []).includes(id)) leaving.push({ S, id, ph });
    }
    if (leaving.length) {
      const by = new Map();
      for (const l of leaving) { const k = l.S.id + '|' + l.id; if (!by.has(k)) by.set(k, { S: l.S, id: l.id, phs: [] }); by.get(k).phs.push(l.ph); }
      add('info', 'To change in Godot', `In the plan, ${listNames([...by.values()].map((b) => `${firstName((M.people.get(b.id) || {}).name) || b.id} leaves ${b.S.name} (${b.phs.length === M.phases.length ? 'all day' : b.phs.join(', ')})`))}. Take them out of those scenes in Godot.`, [...new Set(leaving.map((l) => l.S.id))]);
    }
  }
  // one-way ways and hubs
  const oneWay = [...M.pairs.values()].filter((P) => P.oneWay && P.state !== 'delete');
  if (oneWay.length) add('info', 'One-way', `${oneWay.length === 1 ? 'One way only goes' : `${oneWay.length} ways only go`} one direction: ${listNames(oneWay.map((P) => { const l = P.links[0]; return `${nm(M, l.from)} → ${nm(M, l.to)}`; }))}.`, [], oneWay.map((P) => P.links[0].id));
  for (const S of live) {
    const n = [...M.pairs.values()].filter((P) => (P.a === S.id || P.b === S.id) && P.state !== 'delete').length;
    if (n >= 6) add('info', 'Hub', `${S.name} joins ${n} places: the player will pass through it a lot. Worth making it rewarding to cross (changes over time, people to meet).`, [S.id]);
  }
  for (const e of M.openEnds) {
    if (!M.scenes.has(e.from)) continue;
    const planned = (M.out.get(e.from) || []).some((l) => l.via === e.hotspot);
    if (!planned) add('info', 'Leads nowhere yet', `${nm(M, e.from)} has a way (${e.name || e.hotspot}) that doesn’t lead anywhere yet.`, [e.from]);
  }
  // puzzle charts that mention places the map doesn't have
  for (const c of (M.charts && M.charts.charts) || []) {
    const missing = [...new Set(c.nodes.filter((n) => n.scene && !M.scenes.has(n.scene)).map((n) => n.scene))];
    if (missing.length) add('warn', 'Chart place missing', `The puzzle chart “${c.name}” has steps in ${listNames(missing)}, which ${missing.length > 1 ? 'aren’t' : 'isn’t'} on this map.`);
  }
  const order = { error: 0, warn: 1, info: 2 };
  issues.sort((a, b) => order[a.level] - order[b.level]);
  return issues;
}

export function stats(M) {
  const live = [...M.scenes.values()].filter((s) => s.state !== 'delete');
  const pairs = [...M.pairs.values()].filter((p) => p.state !== 'delete');
  return {
    scenes: live.length, inGame: live.filter((s) => s.inGame).length,
    ways: pairs.length, waysInGame: pairs.filter((p) => p.state === 'game').length,
    steps: [...M.steps.values()].reduce((n, l) => n + l.length, 0),
  };
}

// --- tidy up: on the ground, floors kept, close to where the scenes already are ---
// Overlapping scenes on the same floor push apart, joined ones pull to a comfortable distance,
// and a weak pull back home keeps the map recognisable.
export function tidy(M, ids) {
  const nodes = ids.map((id) => {
    const s = M.scenes.get(id); const k = sizeOf(s);
    return { id, x: s.x, z: s.z, x0: s.x, z0: s.z, floor: s.floor, w: k.w, d: k.d, r: Math.hypot(k.w, k.d) / 2 };
  });
  const at = new Map(nodes.map((n) => [n.id, n]));
  const edges = [...M.pairs.values()].filter((P) => at.has(P.a) && at.has(P.b) && P.state !== 'delete').map((P) => [at.get(P.a), at.get(P.b)]);
  for (let it = 0; it < 300; it++) {
    const t = 1 - it / 300;
    const fx = new Map(nodes.map((n) => [n, [0, 0]]));
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (a.floor !== b.floor) continue;
      let dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
      const want = a.r + b.r + 1.5;
      if (d >= want) continue;
      if (d < 0.01) { dx = (i % 2 ? 1 : -1); dz = 0.3; d = Math.hypot(dx, dz); }
      const push = (want - d) / 2;
      fx.get(a)[0] -= dx / d * push; fx.get(a)[1] -= dz / d * push;
      fx.get(b)[0] += dx / d * push; fx.get(b)[1] += dz / d * push;
    }
    for (const [a, b] of edges) {
      const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz) || 1;
      const want = a.r + b.r + 3;
      if (d <= want) continue;
      const pull = (d - want) * 0.08;
      fx.get(a)[0] += dx / d * pull; fx.get(a)[1] += dz / d * pull;
      fx.get(b)[0] -= dx / d * pull; fx.get(b)[1] -= dz / d * pull;
    }
    for (const n of nodes) {
      const f = fx.get(n);
      f[0] += (n.x0 - n.x) * 0.01; f[1] += (n.z0 - n.z) * 0.01;
      n.x += Math.max(-1.5, Math.min(1.5, f[0])) * (0.3 + 0.7 * t);
      n.z += Math.max(-1.5, Math.min(1.5, f[1])) * (0.3 + 0.7 * t);
    }
  }
  // back on the grid, and never on top of each other (nor of scenes left where they were)
  const placed = [...M.scenes.values()].filter((q) => !at.has(q.id)).map((q) => ({ id: q.id, x: q.x, z: q.z, floor: q.floor, w: sizeOf(q).w, d: sizeOf(q).d }));
  const out = new Map();
  for (const n of [...nodes].sort((a, b) => (b.w * b.d) - (a.w * a.d))) {
    const p = freeSpot(placed, n.x, n.z, n.w, n.d, n.floor);
    placed.push({ id: n.id, x: p.x, z: p.z, floor: n.floor, w: n.w, d: n.d });
    out.set(n.id, p);
  }
  return out;
}
