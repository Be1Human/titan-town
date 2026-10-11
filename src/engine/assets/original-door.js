import {CELL, keyOf} from '../../voxel-world.js';
import {VOXEL_JOINT_DEFAULTS} from '../physics/voxel-joints.js';

// Authored plank grooves and rails; no original game model or voxel payload.
// The verified connection structure uses two coaxial ball joints, with a
// third ball on the opposite stile for the locked variant, not a hinge type.
export function createOriginalDoor({id = 'original-yard-door', origin = {x: 0, y: 0, z: 0}, locked = false, cellSize = .05, openingWidth = 1.2, openingHeight = 2.4, frameThickness = .2, frameDepth = .2, clearance = .05, density = .65, strength = 1.25, maxSeparation = VOXEL_JOINT_DEFAULTS.maxSeparation} = {}) {
  if (!id || !['x', 'y', 'z'].every(a => Number.isFinite(origin[a])) || !Number.isFinite(cellSize) || cellSize < .025 || cellSize > .1) throw new Error('Invalid original door placement');
  if (![openingWidth, openingHeight, frameThickness, frameDepth, clearance, density, strength].every(v => Number.isFinite(v) && v > 0) || openingWidth <= 2 * clearance + 4 * cellSize || openingHeight <= 2 * clearance + 8 * cellSize) throw new Error('Invalid original door dimensions');
  const base = Object.fromEntries(['x', 'y', 'z'].map(a => [a, Math.round(origin[a] / CELL)]));
  const position = Object.fromEntries(['x', 'y', 'z'].map(a => [a, base[a] * CELL]));
  const w = Math.round(openingWidth / CELL), h = Math.round(openingHeight / CELL), t = Math.max(1, Math.round(frameThickness / CELL)), d = Math.max(2, Math.round(frameDepth / CELL));
  const frameCells = [], set = (x, y, z) => frameCells.push({x, y, z, mat: 'darkwood'});
  for (let y = 0; y < h + t; y++) for (let z = 0; z < d; z++) {
    for (let x = -t; x < 0; x++) set(base.x + x, base.y + y, base.z + z - Math.floor(d / 2));
    for (let x = w; x < w + t; x++) set(base.x + x, base.y + y, base.z + z - Math.floor(d / 2));
    if (y >= h) for (let x = 0; x < w; x++) set(base.x + x, base.y + y, base.z + z - Math.floor(d / 2));
  }
  const bw = Math.round((w * CELL - 2 * clearance) / cellSize), bh = Math.round((h * CELL - 2 * clearance) / cellSize), bd = Math.max(2, Math.round(.1 / cellSize));
  const cells = [], mid = Math.floor(bh / 2);
  for (let y = 0; y < bh; y++) for (let z = 0; z < bd; z++) for (let x = 0; x < bw; x++) {
    const rail = x < 2 || x >= bw - 2 || y < 3 || y >= bh - 3 || Math.abs(y - mid) < 2;
    if (!rail && z === 0 && x % 5 === 4) continue;
    cells.push({x, y, z, mat: rail ? 'darkwood' : 'wood'});
  }
  const offset = {x: position.x + clearance, y: position.y + clearance, z: position.z - bd * cellSize / 2};
  const center = {x: bw * cellSize / 2, y: bh * cellSize / 2, z: bd * cellSize / 2};
  const bodyId = `${id}:blade`, blade = {id: bodyId, name: '可破坏木门', cells, cellSize, position: Object.fromEntries(['x', 'y', 'z'].map(a => [a, offset[a] + center[a]])), density, strength};
  function connection(role, voxel, frameX) {
    const sourcePoint = Object.fromEntries(['x', 'y', 'z'].map(a => [a, (voxel[a] + .5) * cellSize]));
    const point = Object.fromEntries(['x', 'y', 'z'].map(a => [a, offset[a] + sourcePoint[a]]));
    return {id: `${id}:${role}`, role: role === 'lock' ? 'door-lock' : 'door-pivot', a: {cell: {x: frameX, y: Math.floor(point.y / CELL), z: Math.floor(point.z / CELL)}, point}, b: {bodyId, voxel, sourcePoint}, maxSeparation};
  }
  const jointDefs = [connection('lower', {x: 0, y: Math.max(1, Math.floor(bh * .15)), z: Math.floor(bd / 2)}, base.x - 1), connection('upper', {x: 0, y: Math.min(bh - 2, Math.floor(bh * .85)), z: Math.floor(bd / 2)}, base.x - 1)];
  const lock = connection('lock', {x: bw - 1, y: mid, z: Math.floor(bd / 2)}, base.x + w);
  return {id, name: '原创木框门', locked: Boolean(locked), origin: position, frameCells, blade, jointDefs, lock, failurePolicy: 'project-voxel-presence-and-anchor-separation'};
}

// Stage physics admission first. A body/joint rejection restores every frame
// cell exactly, so spawning a door cannot silently replace terrain on failure.
// Restores must use physics.restore + joints.restore, never this installer:
// re-installing an asset would fill destroyed cells and resurrect broken locks.
export function installOriginalDoor(physics, joints, model = createOriginalDoor()) {
  if (physics.entries.has(model.blade.id)) return {entry: physics.entries.get(model.blade.id), installed: false, rejected: null, jointIds: []};
  const entry = physics.addPersistent(model.blade.cells, model.blade);
  if (!entry) return {entry: null, installed: false, rejected: 'body-admission', jointIds: []};
  const world = physics.voxelWorld, previous = model.frameCells.map(c => ({...c, old: world.get(c.x, c.y, c.z), damage: world.damage.get(keyOf(c.x, c.y, c.z))})), jointIds = [];
  try {
    for (const c of model.frameCells) world.set(c.x, c.y, c.z, c.mat);
    for (const def of [...model.jointDefs, ...(model.locked ? [model.lock] : [])]) {
      const joint = joints.add(def); if (!joint) throw new Error('joint-admission'); jointIds.push(joint.id);
    }
    entry.name = model.blade.name;
    return {entry, installed: true, rejected: null, jointIds};
  } catch {
    for (const id of jointIds) joints.remove(id);
    physics.remove(entry.id);
    for (const c of previous) {
      world.set(c.x, c.y, c.z, c.old);
      if (c.damage !== undefined) world.damage.set(keyOf(c.x, c.y, c.z), c.damage);
    }
    return {entry: null, installed: false, rejected: 'joint-admission', jointIds: []};
  }
}
