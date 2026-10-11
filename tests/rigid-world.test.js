import test from 'node:test';
import assert from 'node:assert/strict';
import {VoxelWorld, chunkOf} from '../src/voxel-world.js';
import {initRigidPhysics, RigidWorld} from '../src/rigid-world.js';
import {mergeVoxelBoxes} from '../src/rigid-shapes.js';

await initRigidPhysics();
function cells(x, y, z, w, h, d, mat = 'wood') {
  const out = [];
  for (let b = y; b < y + h; b++) for (let c = z; c < z + d; c++) for (let a = x; a < x + w; a++) out.push({x: a, y: b, z: c, mat});
  return out;
}
function floor(world, y = 0) { world.box(-30, y, -30, 60, 2, 60, 'concrete'); }
function run(physics, frames = 360) { for (let i = 0; i < frames; i++) physics.step(1 / 60); }
function close(a, b, epsilon = .02) { assert.ok(Math.abs(a - b) <= epsilon, `${a} should be close to ${b} ± ${epsilon}`); }

test('actual WASM bodies fall, collide with one another, stack and sleep without losing player collisions', () => {
  const world = new VoxelWorld(); floor(world);
  world.box(128, 0, 128, 4, 4, 4, 'stone');
  const physics = new RigidWorld(world);
  try {
    const bottom = physics.add(cells(-5, 10, -5, 10, 10, 10));
    const top = physics.add(cells(-5, 25, -5, 10, 10, 10));
    run(physics, 480);
    close(bottom.position.y, .7); close(top.position.y, 1.7, .035);
    assert.equal(bottom.body.isSleeping(), true); assert.equal(top.body.isSleeping(), true);
    assert.equal(physics.stats.sleeping, 2);
    assert.equal(physics.collides(0, 1.3, 0), true);
    close(physics.supportHeight(0, 0, 2.3, .3), 2.2, .035);
    assert.equal(physics.collides(0, 2.21, 0), false);
    assert.ok(physics.stats.staticChunks < world.chunks.size);
    const saved = physics.snapshot(), topY = top.position.y;
    physics.restore(saved); run(physics, 60);
    assert.equal(physics.stats.sleeping, 2, 'loading a resting stack must keep it asleep after the first contact update');
    close(physics.entries.get(top.id).position.y, topY, .002);
  } finally { physics.dispose(); }
});

test('deleting static support rebuilds only that chunk and wakes a resting rigid piece', () => {
  const world = new VoxelWorld(); floor(world);
  world.box(2, 2, 2, 8, 8, 8, 'stone');
  const physics = new RigidWorld(world);
  try {
    const entry = physics.add(cells(2, 15, 2, 8, 8, 8));
    run(physics, 420); assert.equal(entry.body.isSleeping(), true); close(entry.position.y, 1.4);
    const before = physics.stats.rebuilds, chunk = world.getChunk(chunkOf(2, 2, 2));
    const revision = chunk.revision;
    world.box(2, 2, 2, 8, 8, 8, null);
    assert.ok(chunk.revision > revision);
    physics.step(1 / 60); assert.equal(entry.body.isSleeping(), false);
    assert.equal(physics.stats.rebuilds, before + 1);
    run(physics); close(entry.position.y, .6);
    const stable = physics.stats.rebuilds; run(physics, 10); assert.equal(physics.stats.rebuilds, stable);
  } finally { physics.dispose(); }
});

test('a destroyed support chunk across the 32-cell boundary wakes and releases the block', () => {
  const world = new VoxelWorld(); floor(world);
  world.box(30, 2, 0, 4, 15, 8, 'stone');
  const physics = new RigidWorld(world);
  try {
    const entry = physics.add(cells(28, 19, 0, 8, 6, 8)); run(physics, 420);
    assert.equal(entry.body.isSleeping(), true); close(entry.position.y, 2);
    world.box(30, 2, 0, 4, 15, 8, null); run(physics, 80);
    assert.ok(entry.position.y < 1, 'both neighboring support chunks must update');
  } finally { physics.dispose(); }
});

test('non-convex pieces preserve open holes for ray and player queries', () => {
  const world = new VoxelWorld(), physics = new RigidWorld(world);
  try {
    const ring = [...cells(-12, 0, 0, 4, 25, 4), ...cells(8, 0, 0, 4, 25, 4), ...cells(-8, 21, 0, 16, 4, 4)];
    const entry = physics.add(ring, {sleeping: true}); physics.step(0);
    assert.ok(entry.parts >= 3);
    assert.equal(physics.raycast({x: 0, y: 1, z: -2}, {x: 0, y: 0, z: 1}, 5), null);
    assert.equal(physics.collides(0, .1, .2), false);
    assert.equal(physics.raycast({x: -1, y: 1, z: -2}, {x: 0, y: 0, z: 1}, 5).id, entry.id);
    assert.equal(physics.supportHeight(0, .2, 1.9, 1.9), null, 'a header above the ray cannot become a fake floor');
    close(physics.supportHeight(0, .2, 2.8, 1), 2.5);
  } finally { physics.dispose(); }
});

test('tilted pieces expose real slope normals and continuous heights', () => {
  const physics = new RigidWorld(new VoxelWorld());
  try {
    const angle = .25;
    physics.add(cells(-20, 0, -10, 40, 2, 20), {position: {x: 0, y: 1, z: 0}, rotation: {x: 0, y: 0, z: Math.sin(angle / 2), w: Math.cos(angle / 2)}, sleeping: true});
    physics.step(0);
    const left = physics.supportHeight(-.8, 0, 2, 2, 0), right = physics.supportHeight(.8, 0, 2, 2, 0);
    close(right - left, 1.6 * Math.tan(angle), .001);
    const hit = physics.raycast({x: 0, y: 3, z: 0}, {x: 0, y: -1, z: 0}, 4);
    close(hit.normal.y, Math.cos(angle), .001);
    assert.equal(physics.supportHeight(0, 0, .4, .4), null);
  } finally { physics.dispose(); }
});

test('compact save restores occupied cells, rotation, velocities, sleep state and future ids', () => {
  const world = new VoxelWorld(), physics = new RigidWorld(world);
  try {
    const original = cells(1, 1, 1, 20, 4, 6, 'wood');
    const first = physics.add(original, {id: 'rigid-3', position: {x: 2, y: 4, z: 3}, rotation: {x: .1, y: .2, z: 0, w: .9}, velocity: {x: 1, y: 2, z: 3}, angularVelocity: {x: .5, y: 0, z: -.2}});
    physics.add(cells(1, 1, 1, 2, 2, 2, 'metal'), {id: 'rigid-1', position: {x: 3, y: 1, z: 2}, sleeping: true});
    physics.step(0);
    const save = JSON.parse(JSON.stringify(physics.snapshot())), rotationBefore = {...first.rotation};
    assert.ok(JSON.stringify(save.bodies[0].runs).length < JSON.stringify(original).length / 5);
    assert.equal(physics.restore(save), 2);
    const restored = physics.entries.get('rigid-3');
    assert.deepEqual(restored.cells, original); assert.deepEqual(restored.position, {x: 2, y: 4, z: 3});
    for (const axis of ['x', 'y', 'z', 'w']) close(restored.rotation[axis], rotationBefore[axis], 1e-6);
    close(restored.body.linvel().y, 2, 1e-6); close(restored.body.angvel().x, .5, 1e-6);
    assert.equal(physics.entries.get('rigid-1').body.isSleeping(), true);
    assert.equal(physics.add(cells(0, 0, 0, 2, 2, 2)).id, 'rigid-2');
    assert.equal(physics.add(cells(0, 0, 0, 2, 2, 2)).id, 'rigid-4');
    physics.restore(undefined); assert.equal(physics.entries.size, 0);
  } finally { physics.dispose(); }
});

test('small pieces and fragmented shapes remain physical beyond the former body quotas', () => {
  const physics = new RigidWorld(new VoxelWorld(), {compoundParts: 96});
  try {
    const small = cells(0, 0, 0, 2, 2, 2);
    const first = physics.add(small.slice(0, 1)); assert.ok(first);
    assert.ok(physics.add(small.slice(0, 7), {position: {x: 5, y: 1, z: 0}}));
    const fragmented = [];
    for (let x = 0; x < 12; x++) for (let z = 0; z < 12; z++) fragmented.push({x: x * 2, y: 0, z: z * 2, mat: 'wood'});
    const exact = physics.add(fragmented, {position: {x: 11.15, y: .05, z: 1.15}});
    assert.equal(exact.quality, 'voxels');
    assert.equal(physics.raycast({x: 10.05, y: 1, z: .05}, {x: 0, y: -1, z: 0}, 2)?.id, exact.id);
    assert.equal(physics.raycast({x: 10.15, y: 1, z: .05}, {x: 0, y: -1, z: 0}, 2), null, 'voxel fallback retains the gaps between islands');
    for (let i = 0; i < 193; i++) assert.ok(physics.add(small, {position: {x: 20 + i, y: 1, z: 0}, sleeping: true}));
    assert.equal(physics.stats.bodies, 196);
    const before = JSON.stringify(physics.snapshot()), nextId = physics.nextId, budget = physics.memoryBudgetBytes;
    physics.memoryBudgetBytes = physics.estimatedMemoryBytes;
    assert.equal(physics.add(small), null); assert.equal(physics.lastAdmissionFailure.reason, 'memory');
    assert.equal(physics.lastAdmissionFailure.retryable, true); assert.equal(physics.entries.get(first.id), first);
    assert.equal(JSON.stringify(physics.snapshot()), before); assert.equal(physics.nextId, nextId);
    assert.equal(physics.collides(.05, .02, .05, .06, .02), true);
    physics.memoryBudgetBytes = budget; assert.ok(physics.add(small));
  } finally { physics.dispose(); }
});

test('static terrain holes stay open and only nearby chunks are constructed', () => {
  const world = new VoxelWorld();
  world.box(-16, 0, -16, 32, 3, 32, 'stone'); world.box(-4, 0, -4, 8, 3, 8, null);
  for (let x = 64; x < 320; x += 32) world.box(x, 0, 0, 4, 4, 4, 'stone');
  const physics = new RigidWorld(world);
  try {
    const entry = physics.add(cells(-2, 10, -2, 4, 4, 4)); run(physics, 70);
    assert.ok(entry.position.y < -.5, 'a small block should fall through the terrain aperture');
    assert.ok(physics.stats.staticChunks < 5, 'distant chunks are never activated');
  } finally { physics.dispose(); }
});

test('fragmented chunks use exact native voxel colliders without closing apertures', () => {
  // 512 isolated cells: native voxels under a 256-part terrain limit, a
  // compound under the default limit. Both keep every aperture open.
  for (const [terrainParts, type] of [[256, 18], [undefined, 8]]) {
    const world = new VoxelWorld();
    for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) if ((x + z) % 2 === 0 && !(x >= 12 && x < 20 && z >= 12 && z < 20)) world.set(x, 0, z, 'stone');
    const physics = new RigidWorld(world, terrainParts === undefined ? {} : {terrainParts});
    try {
      const land = physics.add(cells(1, 10, 1, 8, 6, 8));
      const fall = physics.add(cells(14, 10, 14, 4, 4, 4));
      run(physics, 150);
      close(land.position.y, .4, .03);
      assert.ok(fall.position.y < -.5);
      assert.equal(physics.terrain.get(chunkOf(0, 0, 0)).collider.shape.type, type, `terrain part limit ${terrainParts ?? 'default'} selects shape ${type}`);
    } finally { physics.dispose(); }
  }
});

test('a fast fragment activates terrain along its swept path before CCD runs', () => {
  const world = new VoxelWorld(); world.box(40, 0, -10, 1, 50, 20, 'concrete');
  const physics = new RigidWorld(world);
  try {
    const entry = physics.add(cells(-21, 19, -1, 2, 2, 2), {velocity: {x: 80, y: 0, z: 0}});
    physics.step(.1);
    assert.ok(entry.position.x < 3.96, `fast block tunneled to ${entry.position.x}`);
    assert.ok(physics.stats.staticChunks > 0);
  } finally { physics.dispose(); }
});

test('impulses wake sleeping pieces and disposed worlds can reset without stale colliders', () => {
  const world = new VoxelWorld(); floor(world);
  const physics = new RigidWorld(world);
  const entry = physics.add(cells(0, 3, 0, 8, 8, 8)); run(physics, 420);
  assert.equal(entry.body.isSleeping(), true);
  assert.equal(physics.impulse(entry.id, {x: entry.body.mass() * 3, y: 0, z: 0}), true);
  assert.equal(entry.body.isSleeping(), false); physics.step(1 / 60); assert.ok(entry.body.linvel().x > 1);
  assert.equal(physics.blast(entry.position, 3, 4), 1);
  physics.dispose(); physics.dispose(); assert.equal(physics.stats.bodies, 0);
  assert.equal(physics.collides(0, 0, 0), false);
  physics.reset(new VoxelWorld()); assert.ok(physics.add(cells(0, 0, 0, 2, 2, 2))); physics.step(0);
  assert.equal(physics.stats.staticChunks, 0); physics.dispose();
});

test('greedy collision boxes exactly cover the original voxel occupancy', () => {
  const width = 9, height = 6, depth = 8, data = new Uint8Array(width * height * depth);
  for (let i = 0; i < data.length; i++) data[i] = ((i * 17 + (i >> 3)) % 7) < 4 ? 1 : 0;
  const boxes = mergeVoxelBoxes(data, width, height, depth), output = new Uint8Array(data.length);
  for (const b of boxes) for (let y = b.y; y < b.y + b.h; y++) for (let z = b.z; z < b.z + b.d; z++) for (let x = b.x; x < b.x + b.w; x++) output[x + z * width + y * width * depth]++;
  assert.deepEqual(output, data);
});

test('the nine-body browser lab survives save/load and sixty frames without a settling cascade', () => {
  const world = new VoxelWorld();
  world.box(-120, 0, -95, 240, 2, 230, 'stone');
  world.box(-120, 2, -95, 240, 18, 4, 'plaster');
  world.box(-120, 2, -95, 4, 18, 230, 'plaster');
  world.box(116, 2, -95, 4, 18, 230, 'plaster');
  world.box(-120, 20, -95, 240, 2, 4, 'darkwood');
  world.box(-120, 20, -95, 4, 2, 230, 'darkwood');
  world.box(116, 20, -95, 4, 2, 230, 'darkwood');
  world.box(-59, 2, -36, 11, 12, 20, 'brick');
  world.box(-6, 2, -36, 11, 12, 20, 'brick');
  const physics = new RigidWorld(world);
  try {
    physics.add(cells(-64, 14, -34, 74, 4, 16, 'wood'), {id: 'bridge'});
    physics.add(cells(26, 3, 35, 20, 3, 18, 'stone'), {id: 'step-1'});
    physics.add(cells(26, 3, 17, 20, 6, 18, 'stone'), {id: 'step-2'});
    physics.add(cells(26, 3, -1, 20, 9, 18, 'stone'), {id: 'step-3'});
    for (let i = 0; i < 5; i++) physics.add(cells(53, 3 + i * 9, -54, 12, 7, 12, i % 2 ? 'wood' : 'brick'), {id: `stack-${i}`});
    run(physics, 900); assert.equal(physics.stats.sleeping, 9);
    const save = JSON.parse(JSON.stringify(physics.snapshot())), staticSave = world.snapshot();
    const loadedWorld = new VoxelWorld(); loadedWorld.restore(staticSave);
    physics.reset(loadedWorld); physics.restore(save);
    assert.equal(physics.stats.sleeping, 9);
    const awakeCounts = [], changes = [];
    for (let i = 0; i < 60; i++) {
      physics.step(1 / 60); awakeCounts.push(physics.stats.awake);
      changes.push(Math.max(...save.bodies.map(b => Math.abs(physics.entries.get(b.id).position.y - b.position.y))));
    }
    assert.equal(physics.stats.sleeping, 9, `awake over sixty frames: ${awakeCounts.join(',')}`);
    assert.ok(awakeCounts.every(n => n === 0), `restored bodies woke again: ${awakeCounts.join(',')}`);
    assert.ok(Math.max(...changes) < .003, `height changed ${Math.max(...changes)} m`);
  } finally { physics.dispose(); }
});

test('large compounds split into clustered colliders with the same mass, queries, cuts and resting pose', () => {
  // Perforated so greedy merging leaves hundreds of boxes across several clusters.
  const slab = cells(-40, 20, -40, 80, 4, 80).filter(c => !(c.x % 3 === 0 && c.z % 3 === 0 && c.y < 23));
  const run2 = legacy => {
    const world = new VoxelWorld(); floor(world);
    return {world, physics: new RigidWorld(world, legacy ? {} : {compoundSplit: true})};
  };
  const split = run2(false), whole = run2(true);
  try {
    const a = split.physics.add(slab.map(c => ({...c})), {sleeping: true}), b = whole.physics.add(slab.map(c => ({...c})), {sleeping: true});
    split.physics.step(0); whole.physics.step(0);
    assert.ok(a.parts >= 256 && a.parts === b.parts, `boxes ${a.parts}/${b.parts}`);
    assert.ok(a.colliders.length > 4, `clusters ${a.colliders?.length}`);
    assert.equal(b.colliders ?? null, null);
    for (const c of a.colliders) assert.equal(split.physics.colliderOwners.get(c.handle), a);
    close(a.body.mass(), b.body.mass(), 1e-3);
    for (const axis of ['x', 'y', 'z']) close(a.body.worldCom()[axis], b.body.worldCom()[axis], 1e-6);
    const probes = [];
    for (let x = -3.9; x < 4; x += .7) for (let z = -3.9; z < 4; z += .7) probes.push([x, z]);
    const sample = p => probes.map(([x, z]) => [p.raycast({x, y: 6, z}, {x: 0, y: -1, z: 0}, 10)?.distance ?? null, p.collides(x, 2.3, z, 1, .2), p.supportHeight(x, z, 3, 1.5)]);
    const same = (m, n, label) => m.forEach((row, i) => row.forEach((v, j) => v === null || typeof v === 'boolean' ? assert.equal(v, n[i][j], `${label} ${probes[i]} ${j}`) : close(v, n[i][j], 1e-5)));
    same(sample(split.physics), sample(whole.physics), 'initial');
    const before = new Set(a.colliders.map(c => c.handle));
    const ra = split.physics.makeHole({x: -3.2, y: 2.2, z: -3.2}, [.45, .45, .45]), rb = whole.physics.makeHole({x: -3.2, y: 2.2, z: -3.2}, [.45, .45, .45]);
    assert.ok(ra.changes.length && ra.changes.length === rb.changes.length);
    assert.equal(split.physics.entries.get(a.id), a, 'the cut edits the large body in place');
    const kept = a.colliders.filter(c => before.has(c.handle)).length;
    assert.ok(kept > 0 && kept < before.size, `only touched clusters re-cook (${kept} of ${before.size} kept)`);
    assert.equal(split.physics.colliderOwners.size, [...split.physics.entries.values()].reduce((n, e) => n + (e.colliders?.length ?? 1), 0));
    close(a.body.mass(), b.body.mass(), 1e-3);
    same(sample(split.physics), sample(whole.physics), 'after cut');
    a.body.wakeUp(); b.body.wakeUp(); run(split.physics, 300); run(whole.physics, 300);
    assert.equal(a.body.isSleeping(), true);
    close(a.position.y, b.position.y, .01);
    const restored = new RigidWorld(split.world, {compoundSplit: true});
    try {
      restored.restore(split.physics.snapshot());
      const r = restored.entries.get(a.id);
      assert.ok(r.colliders.length > 4); close(r.body.mass(), a.body.mass(), 1e-3);
    } finally { restored.dispose(); }
  } finally { split.physics.dispose(); whole.physics.dispose(); }
});
