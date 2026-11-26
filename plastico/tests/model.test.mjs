// node --test tests/  (the page's analysis: routes, locks, checks)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../web/js/model.js';

function world(scenes, links, extra = {}) {
  return {
    name: 'T', start: scenes[0][0], phases: extra.phases || [], acts: extra.acts || [{ id: '1', name: '', start: '' }],
    areas: [], people: extra.people || [],
    scenes: scenes.map(([id, more = {}]) => ({ id, name: id.toUpperCase(), kind: 'inside', act: '1', area: '', x: 0, z: 0, floor: 0, status: 'idea', open: [], people: {}, notes: '', delete: false, ...more })),
    links: links.map(([from, to, more = {}], i) => ({ id: `l${i}`, from, to, status: 'idea', lock: null, open: [], via: '', notes: '', delete: false, ...more })),
  };
}
const both = (a, b, more) => [[a, b, more], [b, a, more]];
const heads = (M) => model.checks(M).map((i) => i.head);

test('pairs two directions into one way, one-way otherwise', () => {
  const M = model.derive(world([['a'], ['b'], ['c']], [...both('a', 'b'), ['b', 'c'], ['c', 'a']]), null, null);
  assert.equal(M.pairs.size, 3);
  assert.equal(M.pairs.get(model.pairKey('a', 'b')).oneWay, false);
  assert.equal(M.pairs.get(model.pairKey('b', 'c')).oneWay, true);
  assert.ok(heads(M).includes('One-way'));
});

test('unreachable, dead end and no way back', () => {
  const M = model.derive(world([['a'], ['b'], ['c'], ['d']], [...both('a', 'b'), ['b', 'c'], ['d', 'a']]), null, null);
  const h = heads(M);
  assert.ok(h.includes('Can’t be reached'));   // d
  assert.ok(h.includes('Dead end'));           // c
  assert.ok(h.includes('No way back'));        // c
});

test('a key that can only be got behind its own lock', () => {
  const lock = { needs: 'key', type: 'item', where: 'c', note: '' };
  const M = model.derive(world([['a'], ['b'], ['c']], [...both('a', 'b'), ...both('b', 'c', { lock })]), null, null);
  assert.ok(heads(M).includes('Key behind its own lock'));
  const ok = model.derive(world([['a'], ['b'], ['c']], [...both('a', 'b'), ...both('b', 'c', { lock: { ...lock, where: 'a' } })]), null, null);
  assert.ok(!heads(ok).includes('Key behind its own lock'));
});

test('a lock with nowhere to get its key', () => {
  const M = model.derive(world([['a'], ['b']], both('a', 'b', { lock: { needs: 'k', type: 'flag', where: '', note: '' } })), null, null);
  assert.ok(heads(M).includes('Where is the key?'));
});

test('the key is found in a puzzle chart step', () => {
  const charts = { charts: [{ name: 'C', nodes: [{ id: 'n', kind: 'item', title: 'Get the key', scene: 'a', gid: 'k' }] }] };
  const M = model.derive(world([['a'], ['b']], both('a', 'b', { lock: { needs: 'k', type: 'item', where: '', note: '' } })), null, charts);
  const [K] = model.lockKeys(M);
  assert.equal(K.where, 'a');
  assert.ok(!heads(M).includes('Where is the key?'));
  assert.equal(M.steps.get('a').length, 1);
});

test('routes respect locks and time of day', () => {
  const w = world([['a'], ['b'], ['c']], [...both('a', 'b', { open: ['night'] }), ...both('b', 'c', { lock: { needs: 'k', type: 'item', where: 'a', note: '' } })], { phases: ['day', 'night'] });
  const M = model.derive(w, null, null);
  assert.deepEqual(model.route(M, 'a', 'c').scenes, ['a', 'b', 'c']);
  assert.equal(model.route(M, 'a', 'c', { keys: new Set() }), null);
  assert.deepEqual(model.route(M, 'a', 'c', { keys: new Set(['k']) }).scenes, ['a', 'b', 'c']);
  assert.equal(model.route(M, 'a', 'b', { phase: 'day' }), null);
  assert.deepEqual(model.route(M, 'a', 'b', { phase: 'night' }).scenes, ['a', 'b']);
});

test('one person in two places at once', () => {
  const w = world([['a', { people: { day: ['amy'] } }], ['b', { people: { day: ['amy'] } }]], both('a', 'b'), { phases: ['day'], people: [{ id: 'amy', name: 'Amy' }] });
  assert.ok(heads(model.derive(w, null, null)).includes('In two places'));
});

test('someone the game puts in a scene can be taken out of it in the plan', () => {
  const w = world([['a', { people: { day: ['amy'] } }], ['b']], both('a', 'b'), { phases: ['day'], people: [{ id: 'amy', name: 'Amy' }] });
  const game = { phases: ['day'], scenes: { a: { exists: true }, b: { exists: true, people: { day: ['amy'] } } }, exits: [] };
  let M = model.derive(w, game, null);
  const two = model.checks(M).find((i) => i.head === 'In two places');
  assert.deepEqual(two.scenes, ['a', 'b']);   // the scene the plan put her in comes first: that one is fixable here
  w.scenes[1].away = { day: ['amy'] };
  M = model.derive(w, game, null);
  assert.ok(!heads(M).includes('In two places'));
  assert.ok(heads(M).includes('To change in Godot'));
  assert.deepEqual(model.peopleAt(M, M.scenes.get('b'), 'day'), []);
});

test('scenes and links marked to delete are left out of the analysis', () => {
  const w = world([['a'], ['b'], ['c', { delete: true }]], [...both('a', 'b'), ...both('b', 'c')]);
  const M = model.derive(w, null, null);
  assert.equal(model.stats(M).scenes, 2);
  assert.equal(model.route(M, 'a', 'c'), null);
  assert.equal(M.pairs.get(model.pairKey('b', 'c')).state, 'delete');
});

test('game exits make a link "in the game"', () => {
  const w = world([['a'], ['b']], both('a', 'b'));
  const game = { phases: [], scenes: { a: { exists: true }, b: { exists: true } }, exits: [{ from: 'a', to: 'b', via: 'exit', hotspot: 'h' }, { from: 'b', to: '', via: 'exit', hotspot: 'roof' }] };
  const M = model.derive(w, game, null);
  assert.equal(M.pairs.get(model.pairKey('a', 'b')).state, 'mixed');
  assert.equal(M.openEnds.length, 1);
  assert.ok(heads(M).includes('Leads nowhere yet'));
});

test('tidy keeps floors and separates overlapping scenes', () => {
  const w = world([['a'], ['b'], ['c', { floor: 1 }]], [...both('a', 'b'), ...both('a', 'c')]);
  const M = model.derive(w, null, null);
  const p = model.tidy(M, ['a', 'b', 'c']);
  const d = Math.hypot(p.get('a').x - p.get('b').x, p.get('a').z - p.get('b').z);
  assert.ok(d > 4, `a and b should no longer overlap (${d})`);
});

// --- the grid: sizes in whole cells, edges on the lines, no overlaps ---
const onGrid = (c, size) => Number.isInteger(c - size / 2) && Number.isInteger(c + size / 2);

test('sizes are whole cells per kind, and the stored size wins', () => {
  assert.deepEqual(model.sizeOf({ kind: 'inside' }), { w: 6, d: 4, h: 3 });
  assert.deepEqual(model.sizeOf({ kind: 'outside' }), { w: 12, d: 7, h: 0.5 });
  assert.deepEqual(model.sizeOf({ kind: 'closeup', w: 5, d: 3 }), { w: 5, d: 3, h: 1.8 });
  assert.equal(model.sizeOf({ kind: 'inside', w: 0, d: 2.6 }).w, 6);   // not a size: the kind's
  assert.equal(model.sizeOf({ kind: 'inside', w: 0, d: 2.6 }).d, 3);
});

test('snapping puts the edges, not the centre, on grid lines, for odd and even sizes', () => {
  for (const size of [1, 2, 3, 4, 7, 12]) for (const c of [-7.3, -0.2, 0, 0.49, 3.6, 11.01]) {
    const s = model.snapAxis(c, size);
    assert.ok(onGrid(s, size), `size ${size} at ${c} -> ${s}`);
    assert.ok(Math.abs(s - c) <= model.GRID / 2 + 1e-9);
  }
});

test('blocks side by side touch without overlapping; one cell over, they overlap', () => {
  const a = { id: 'a', kind: 'inside', x: 3, z: 2, floor: 0 };            // 6 x 4: x 0..6, z 0..4
  assert.equal(model.overlapping([a], 9, 2, 6, 4, 0).length, 0);          // x 6..12: shares an edge
  assert.equal(model.overlapping([a], 3, 6, 6, 4, 0).length, 0);          // below it
  assert.equal(model.overlapping([a], 8, 2, 6, 4, 0).length, 1);          // x 5..11
  assert.equal(model.overlapping([a], 8, 2, 6, 4, 1).length, 0);          // another floor
  const p = model.freeSpot([a], 4, 2, 6, 4, 0);
  assert.ok(onGrid(p.x, 6) && onGrid(p.z, 4));
  assert.equal(model.overlapping([a], p.x, p.z, 6, 4, 0).length, 0);
});

test('a moved group slides to the nearest place where none of it overlaps', () => {
  const others = [{ id: 'x', kind: 'inside', x: 13, z: 2, floor: 0 }];   // x 10..16
  const group = [{ id: 'p', kind: 'inside', x: 3, z: 2, floor: 0 }, { id: 'c', kind: 'closeup', x: 1.5, z: 5, floor: 0 }];
  const f = model.freeShift([...others, ...group], group, 6, 0, 0);       // p would be at 9: x 6..12, on top of x
  assert.ok(!(f.dx === 6 && f.dz === 0));
  for (const g of group) assert.equal(model.overlapping(others, g.x + f.dx, g.z + f.dz, model.sizeOf(g).w, model.sizeOf(g).d, 0).length, 0);
});

test('a child goes just below its parent, edges on the grid; descendants and ancestors', () => {
  const w = { scenes: [{ id: 'room', kind: 'inside', x: 3, z: 2, floor: 1, parent: '' }] };
  const p1 = model.childSpot(w, w.scenes[0], 3, 2);
  assert.deepEqual(p1, { x: 1.5, z: 5 });                                  // left edges line up, top edge on the room's bottom edge
  w.scenes.push({ id: 'desk', kind: 'closeup', x: p1.x, z: p1.z, floor: 1, parent: 'room' });
  const p2 = model.childSpot(w, w.scenes[0], 3, 2);
  assert.deepEqual(p2, { x: 4.5, z: 5 });                                  // the next one beside the first
  w.scenes.push({ id: 'drawer', kind: 'closeup', x: 1.5, z: 7, floor: 1, parent: 'desk' });
  assert.deepEqual([...model.descendantsOf(w, 'room')].sort(), ['desk', 'drawer']);
  assert.deepEqual(model.ancestorsOf(w, 'drawer').map((q) => q.id), ['desk', 'room']);
});

test('tidy keeps every block on the grid and apart', () => {
  const W = world([['a'], ['b'], ['c']], both('a', 'b'));
  W.scenes.forEach((s) => { s.x = 0.3; s.z = 0.1; });
  const M = model.derive(W, null, null);
  const pos = model.tidy(M, ['a', 'b', 'c']);
  const placed = [...pos.entries()].map(([id, p]) => ({ id, kind: 'inside', ...p, floor: 0 }));
  for (const q of placed) {
    assert.ok(onGrid(q.x, 6) && onGrid(q.z, 4));
    assert.equal(model.overlapping(placed, q.x, q.z, 6, 4, 0, new Set([q.id])).length, 0);
  }
});
