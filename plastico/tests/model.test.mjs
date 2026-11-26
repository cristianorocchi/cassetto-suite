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
