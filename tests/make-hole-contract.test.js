import test from 'node:test';
import assert from 'node:assert/strict';
import {VoxelWorld, CELL, MATERIAL_KEYS, keyOf} from '../src/voxel-world.js';
import {RigidWorld, initRigidPhysics} from '../src/rigid-world.js';
import {cellKey, worldPoint} from '../src/rigid-fracture.js';
import {voxelMassProperties} from '../src/engine/physics/voxel-mass.js';
import {createMakeHoleCut, normalizeHoleRadii, holeCellBounds} from '../src/engine/core/make-hole.js';

await initRigidPhysics();
const emptyResult = {removed: [], fragments: [], changes: [], damaged: 0, rejected: []};
const keys = cells => cells.map(cellKey).sort();
const close = (a, b, tolerance = 4e-5) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const closePoint = (a, b) => { for (const axis of ['x', 'y', 'z']) close(a[axis], b[axis]); };
function box(x, y, z, width, height, depth, mat = 'wood') {
  const cells = [];
  for (let b = y; b < y + height; b++) for (let c = z; c < z + depth; c++) for (let a = x; a < x + width; a++) cells.push({x: a, y: b, z: c, mat});
  return cells;
}
function staticWorld(cells) { const world = new VoxelWorld(); for (const c of cells) world.set(c.x, c.y, c.z, c.mat); return world; }
function mixedBox() { return box(-8, 8, -4, 16, 8, 8).map((c, i) => ({...c, mat: MATERIAL_KEYS[1 + i % (MATERIAL_KEYS.length - 1)]})); }
const q = {x: Math.sin(.53) / Math.sqrt(3), y: Math.sin(.53) / Math.sqrt(3), z: Math.sin(.53) / Math.sqrt(3), w: Math.cos(.53)};

test('ordered radii and bounded floor ranges form one validated cut contract', () => {
  assert.deepEqual(normalizeHoleRadii([9, 8, 7]), [5, 5, 5]);
  assert.deepEqual(normalizeHoleRadii([.2, .4, .8]), [.2, .2, .2]);
  for (const radii of [null, [], [.1, .2], [-1, 0, 0], [Infinity, 0, 0]]) assert.equal(createMakeHoleCut(radii), null);
  assert.equal(createMakeHoleCut([.2, 0, 0], {noise: -1}), null);
  assert.equal(createMakeHoleCut([.2, 0, 0], {seed: .5}), null);
  assert.equal(createMakeHoleCut([.2, 0, 0], {noise: 2}).noise, .35);
  assert.deepEqual(holeCellBounds({x: -.05, y: 1.05, z: -.05}, .1, .1, {x: -5, y: 0, z: -5}, {x: 5, y: 20, z: 5}), {lo: {x: -3, y: 8, z: -3}, hi: {x: 1, y: 12, z: 1}});
  assert.equal(holeCellBounds({x: 100, y: 0, z: 0}, .1, .1, {x: -5, y: 0, z: -5}, {x: 5, y: 20, z: 5}), null);
});

test('the same mixed voxel shape has identical static and dynamic material cuts', () => {
  const cells = mixedBox(), point = {x: -.03, y: 1.13, z: .07};
  const categories = {plaster: 0, stone: 1, brick: 1, concrete: 2, wood: 0, darkwood: 0, roof: 1, metal: 1, rust: 1, dark: 3, glass: 0, leaf: 0, fuel: 1};
  for (const radii of [[.43, .28, .12], [.31, 0, 0], [.24, .5, .8]]) {
    const world = staticWorld(cells), physics = new RigidWorld(new VoxelWorld());
    try {
      physics.addPersistent(cells, {strength: 999, density: 1.3});
      const ordered = [radii[0], Math.min(radii[0], radii[1]), Math.min(...radii)];
      const expected = cells.filter(c => categories[c.mat] < 3 && Math.hypot((c.x + .5) * CELL - point.x, (c.y + .5) * CELL - point.y, (c.z + .5) * CELL - point.z) <= ordered[categories[c.mat]]);
      const removed = world.makeHole(point, radii), dynamic = physics.makeHole(point, radii);
      assert.deepEqual(keys(removed), keys(expected)); assert.deepEqual(keys(dynamic.removed), keys(expected));
      assert.ok(dynamic.removed.every(c => c.mat !== 'dark'));
      const remaining = [...physics.entries.values()].flatMap(e => e.cells).concat(dynamic.fragments.flatMap(f => f.cells));
      const deleted = new Set(keys(expected)); assert.deepEqual(keys(remaining), keys(cells.filter(c => !deleted.has(cellKey(c)))));
    } finally { physics.dispose(); }
  }
});

test('translated and rotated local cuts preserve the same cells at 2.5, 5, 10 and 20 cm scales', () => {
  const cells = mixedBox(), referencePoint = {x: -.03, y: 1.13, z: .07}, referenceRadii = [.43, .28, .12];
  for (const options of [{}, {seed: 39, noise: .2}]) {
    const expected = keys(staticWorld(cells).makeHole(referencePoint, referenceRadii, options));
    for (const cellSize of [.025, .05, .1, .2]) {
      const scale = cellSize / CELL, physics = new RigidWorld(new VoxelWorld());
      try {
        const entry = physics.addPersistent(cells, {cellSize, rotation: q, position: {x: -3.125, y: 4.75, z: 2.25}, strength: .1});
        const point = worldPoint(entry, Object.fromEntries(Object.entries(referencePoint).map(([axis, n]) => [axis, n * scale])));
        const result = physics.makeHole(point, referenceRadii.map(n => n * scale), {...options, id: entry.id});
        assert.deepEqual(keys(result.removed), expected, `${cellSize} ${JSON.stringify(options)}`);
        assert.ok(result.removed.every(c => c.cellSize === cellSize));
      } finally { physics.dispose(); }
    }
  }
});

test('negative centres, exact boundaries and world clipping do not miss candidate voxels', () => {
  const world = staticWorld([{x: -2, y: 10, z: -1, mat: 'wood'}, {x: -1, y: 10, z: -1, mat: 'wood'}, {x: 0, y: 10, z: -1, mat: 'wood'}, {x: 1, y: 10, z: -1, mat: 'wood'}]);
  assert.deepEqual(world.makeHole({x: -.05, y: 1.05, z: -.05}, [.1, 0, 0]).map(c => c.x), [-2, -1, 0]);
  const edge = staticWorld([{x: -512, y: 255, z: 511, mat: 'wood'}, {x: -511, y: 255, z: 511, mat: 'dark'}]);
  assert.equal(edge.makeHole({x: -51.15, y: 25.55, z: 51.15}, [1, 1, 1]).length, 1);
  assert.equal(edge.get(-511, 255, 511), 'dark');
});

test('optional edge noise repeats across storage order and uses no global random state', () => {
  const cells = box(27, 8, -7, 16, 12, 16), point = {x: 3.23, y: 1.33, z: .13}, radii = [.63, .2, .1];
  const a = staticWorld(cells), b = staticWorld([...cells].reverse()), plain = staticWorld(cells), other = staticWorld(cells);
  const expected = keys(a.makeHole(point, radii, {seed: 71, noise: .3}));
  assert.deepEqual(keys(b.makeHole(point, radii, {seed: 71, noise: .3})), expected);
  assert.notDeepEqual(keys(plain.makeHole(point, radii)), expected);
  assert.notDeepEqual(keys(other.makeHole(point, radii, {seed: 72, noise: .3})), expected);
  const cut = createMakeHoleCut(radii, {seed: 71, noise: .3});
  assert.equal(cut.contains('dark', 0, 0, 0), false);
  assert.equal(cut.contains('wood', cut.radius + .001, 0, 0), false);
});

test('direct cuts clear deleted damage, retain survivor damage and preserve mixed rotating split mass and COM velocity', () => {
  const physics = new RigidWorld(new VoxelWorld());
  try {
    const cells = [...box(0, 10, 0, 20, 4, 4), ...box(20, 10, 0, 20, 4, 4, 'rust')];
    const parent = physics.addPersistent(cells, {rotation: q, position: {x: 4, y: 5, z: 6}, velocity: {x: 2, y: 1, z: -.7}, angularVelocity: {x: 1, y: -.3, z: 2}, density: 1.4,
      damage: [[1, 11, 0, .2], [37, 11, 0, .3], [20, 11, 0, .4]]});
    const pose = {center: {...parent.center}, position: {...parent.position}, rotation: {...parent.rotation}}, com = {...parent.body.worldCom()}, velocity = {...parent.body.linvel()}, omega = {...parent.body.angvel()}, mass = parent.body.mass();
    const result = physics.makeHole(worldPoint(parent, {x: 2, y: 1.2, z: .2}), [.33, .33, .33], {id: parent.id});
    assert.equal(result.changes[0].newIds.length, 2); assert.equal(result.damaged, result.removed.length);
    let total = voxelMassProperties(result.removed, {density: 1.4}).mass;
    const damage = new Map();
    for (const child of physics.entries.values()) {
      assert.equal(child.revision, 1); assert.equal(child.persistent, true); total += child.body.mass();
      for (const [key, value] of child.damage) damage.set(key, value);
      const cc = child.body.worldCom(), dx = cc.x - com.x, dy = cc.y - com.y, dz = cc.z - com.z;
      closePoint(child.body.linvel(), {x: velocity.x + omega.y * dz - omega.z * dy, y: velocity.y + omega.z * dx - omega.x * dz, z: velocity.z + omega.x * dy - omega.y * dx});
      closePoint(child.body.angvel(), omega);
      for (const c of child.cells) closePoint(worldPoint(child, {x: (c.x + .5) * CELL, y: (c.y + .5) * CELL, z: (c.z + .5) * CELL}), worldPoint(pose, {x: (c.x + .5) * CELL, y: (c.y + .5) * CELL, z: (c.z + .5) * CELL}));
    }
    for (const fragment of result.fragments) total += voxelMassProperties(fragment.cells, {density: 1.4}).mass;
    close(total, mass, .002); assert.deepEqual([...damage].sort(), [['1,11,0', .2], ['37,11,0', .3]]);
    assert.ok(result.removed.some(c => cellKey(c) === '20,11,0'));
    const loaded = JSON.parse(JSON.stringify(physics.snapshot())); physics.restore(loaded);
    assert.deepEqual([...physics.entries.values()].flatMap(e => [...e.damage]).sort(), [...damage].sort());
  } finally { physics.dispose(); }
});

test('failed direct split leaves geometry, damage, bodies and ID allocation unchanged', () => {
  const physics = new RigidWorld(new VoxelWorld());
  try {
    const entry = physics.add(box(0, 10, 0, 40, 4, 4), {damage: [[1, 11, 0, .2]]});
    const before = JSON.stringify(physics.snapshot()), nextId = physics.nextId, budget = physics.memoryBudgetBytes;
    physics.memoryBudgetBytes = physics.estimatedMemoryBytes;
    const result = physics.makeHole(entry.position, [.33, .33, .33], {id: entry.id});
    assert.equal(result.rejected[0].reason, 'memory'); assert.deepEqual(result.removed, []);
    assert.equal(JSON.stringify(physics.snapshot()), before); assert.equal(physics.nextId, nextId);
    physics.memoryBudgetBytes = budget;
    const recovered = physics.makeHole(entry.position, [.33, .33, .33], {id: entry.id});
    assert.equal(recovered.rejected.length, 0); assert.equal(recovered.changes[0].newIds.length, 2); assert.equal(recovered.changes[0].newIds[0], entry.id);
    physics.reset();
    const parent = physics.add(box(0, 10, 0, 40, 4, 4)), saved = JSON.stringify(physics.snapshot()), previousNextId = physics.nextId;
    const makeEntry = physics._makeEntry.bind(physics); let created = 0;
    physics._makeEntry = (...args) => { if (++created === 2) throw new Error('injected creation failure'); return makeEntry(...args); };
    const failed = physics.makeHole(parent.position, [.33, .33, .33], {id: parent.id});
    assert.equal(failed.rejected[0].reason, 'runtime'); assert.equal(physics.nextId, previousNextId);
    assert.equal(JSON.stringify(physics.snapshot()), saved); let bodies = 0; physics.world.forEachRigidBody(() => bodies++); assert.equal(bodies, 1);
  } finally { physics.dispose(); }
});

test('invalid and zero cuts are no-ops and a complete cut removes all collider and damage state', () => {
  const cells = box(0, 10, 0, 2, 2, 2), world = staticWorld(cells), physics = new RigidWorld(new VoxelWorld());
  try {
    const entry = physics.add(cells, {damage: [[0, 10, 0, .3]]});
    world.damage.set(keyOf(0, 10, 0), .3);
    for (const [point, radii] of [[{x: NaN, y: 1, z: 0}, [.3, 0, 0]], [entry.position, [0, 0, 0]], [entry.position, [-1, 0, 0]]]) {
      assert.deepEqual(physics.makeHole(point, radii), emptyResult); assert.deepEqual(world.makeHole(point, radii), []);
      assert.deepEqual(world.lastMutation.changes, []); assert.equal(entry.damage.get('0,10,0'), .3);
    }
    const result = physics.makeHole(entry.position, [.3, .3, .3]);
    assert.equal(result.removed.length, 8); assert.equal(result.changes[0].newIds.length, 0); assert.equal(physics.entries.size, 0); assert.equal(physics.dynamicCells, 0); assert.equal(physics.dynamicVolume, 0);
    world.makeHole({x: .1, y: 1.1, z: .1}, [.3, .3, .3]); assert.equal(world.damage.size, 0); assert.equal(world.count, 0);
  } finally { physics.dispose(); }
});
