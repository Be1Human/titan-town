import RAPIER from '../../../vendor/rapier.js';
import {CELL} from '../../voxel-world.js';
import {gridCell, rotateVector} from '../../rigid-fracture.js';
import {referenceMaterialFor} from '../core/reference-materials.js';

// The two/three spherical-joint door structure is verified. This distance
// threshold is an explicit project configuration in metres.
export const VOXEL_JOINT_DEFAULTS = Object.freeze({maxSeparation: .2});
const axes = ['x', 'y', 'z'];
const validId = id => (typeof id === 'string' && id.length > 0) || Number.isSafeInteger(id);
function vector(value, integer = false) {
  if (!value || !axes.every(a => integer ? Number.isSafeInteger(value[a]) : Number.isFinite(value[a]))) throw new Error('Invalid voxel-joint anchor');
  return Object.fromEntries(axes.map(a => [a, value[a]]));
}
function endpoint(value) {
  if (validId(value?.bodyId)) return {type: 'dynamic', bodyId: value.bodyId, voxel: vector(value.voxel, true), sourcePoint: vector(value.sourcePoint)};
  if (value?.cell) {
    const cell = vector(value.cell, true);
    return {type: 'static', cell, point: vector(value.point ?? Object.fromEntries(axes.map(a => [a, (cell[a] + .5) * CELL])))};
  }
  throw new Error('A joint endpoint needs a source voxel or a static world cell');
}
function definition(value, id) {
  const a = endpoint(value.a), b = endpoint(value.b), maxSeparation = value.maxSeparation === undefined ? VOXEL_JOINT_DEFAULTS.maxSeparation : value.maxSeparation;
  if (!validId(id) || (a.type === 'static' && b.type === 'static') || (a.type === 'dynamic' && b.type === 'dynamic' && a.bodyId === b.bodyId)) throw new Error('Invalid voxel-joint bodies');
  if (maxSeparation !== null && (!Number.isFinite(maxSeparation) || maxSeparation <= 0)) throw new Error('Invalid joint separation threshold');
  return {id, type: 'ball', role: typeof value.role === 'string' ? value.role : 'connection', a, b, maxSeparation, contactsEnabled: value.contactsEnabled !== false};
}
function pointOnBody(entry, source) {
  const p = entry.body.translation(), q = entry.body.rotation(), r = rotateVector(Object.fromEntries(axes.map(a => [a, source[a] - entry.center[a]])), q);
  return Object.fromEntries(axes.map(a => [a, p[a] + r[a]]));
}
const distance = (a, b) => Math.hypot(...axes.map(k => a[k] - b[k]));

// Call rebind(result.changes) immediately after each successful source cut,
// and step() before/after physics.step(). This does not drain fracture events;
// the caller can share those events with grabs, charges and replication.
export class VoxelJointSystem {
  constructor(physics) {
    this.physics = physics; this.records = new Map(); this.events = []; this.nextId = 1;
    this.engineWorld = physics.world; this.staticBody = null;
  }
  _ensureWorld() {
    const world = this.physics?.disposed ? null : this.physics?.world;
    if (this.engineWorld !== world) {
      // RigidWorld.reset/restore frees the old native world. Never inspect its
      // stale JS handles; rebuild only from source definitions in the new one.
      this.engineWorld = world; this.staticBody = null;
      for (const record of this.records.values()) { record.native = null; record.bindings = null; }
    }
    return world;
  }
  _resolve(anchor) {
    if (anchor.type === 'static') {
      const c = anchor.cell, mat = this.physics.voxelWorld?.get(c.x, c.y, c.z);
      return mat && referenceMaterialFor(mat).physical ? {point: anchor.point, local: anchor.point, entry: null} : null;
    }
    const entry = this.physics.entries.get(anchor.bodyId), c = anchor.voxel;
    const cell = entry && gridCell(entry, c.x, c.y, c.z);
    if (!cell || !referenceMaterialFor(cell.mat).physical) return null;
    return {entry, point: pointOnBody(entry, anchor.sourcePoint), local: Object.fromEntries(axes.map(a => [a, anchor.sourcePoint[a] - entry.center[a]]))};
  }
  _drop(record) {
    if(record.native&&this.physics.referencePipeline&&!this.physics.referencePipeline.writingBodies)this.physics.referencePipeline.externalMutationRevision++;
    if(record.native)this.physics.referencePipeline?.jointKinds.delete(record.native.handle);
    if (record.native?.isValid()) this.engineWorld.removeImpulseJoint(record.native, true);
    record.native = null; record.bindings = null;
  }
  _create(record, a, b, wakeUp = true) {
    if ((!a.entry || !b.entry) && !this.staticBody) this.staticBody = this.engineWorld.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const bodyA = a.entry?.body ?? this.staticBody, bodyB = b.entry?.body ?? this.staticBody;
    record.native = this.engineWorld.createImpulseJoint(RAPIER.JointData.spherical(a.local, b.local), bodyA, bodyB, wakeUp);
    // Rapier 0.21 reports this spherical binding as Generic. Preserve our
    // explicit authoring kind rather than interpreting every Generic as a ball.
    this.physics.referencePipeline?.jointKinds.set(record.native.handle,'ball');
    if(this.physics.referencePipeline&&!this.physics.referencePipeline.writingBodies)this.physics.referencePipeline.externalMutationRevision++;
    record.native.setContactsEnabled(record.contactsEnabled);
    record.bindings = [a.entry, b.entry];
  }
  _releaseStaticBody() {
    if (!this.staticBody || [...this.records.values()].some(r => r.native && (r.a.type === 'static' || r.b.type === 'static'))) return;
    if (this.staticBody.isValid()) this.engineWorld.removeRigidBody(this.staticBody);
    this.staticBody = null;
  }
  add(value) {
    if (!this._ensureWorld()) return null;
    while (this.records.has(`voxel-joint-${this.nextId}`)) this.nextId++;
    const id = value.id ?? `voxel-joint-${this.nextId++}`;
    if (this.records.has(id)) return null;
    const record = {...definition(value, id), active: true, reason: null, native: null, bindings: null};
    const a = this._resolve(record.a), b = this._resolve(record.b);
    if (!a || !b || (record.maxSeparation !== null && distance(a.point, b.point) > record.maxSeparation)) return null;
    try { this._create(record, a, b); this.records.set(id, record); return record; }
    catch { this._drop(record); this._releaseStaticBody(); return null; }
  }
  get(id) { return this.records.get(id); }
  remove(id) {
    this._ensureWorld(); const record = this.records.get(id); if (!record) return false;
    this._drop(record); this.records.delete(id); this._releaseStaticBody(); return true;
  }
  breakJoint(id, reason = 'manual') {
    this._ensureWorld(); const record = this.records.get(id); if (!record?.active) return false;
    this._drop(record); record.active = false; record.reason = reason;
    this.events.push({id, role: record.role, reason}); this._releaseStaticBody(); return true;
  }
  rebind(changes = []) {
    if (!this._ensureWorld()) return this.stats();
    for (const change of changes) for (const record of this.records.values()) {
      if (!record.active) continue;
      for (const side of ['a', 'b']) {
        const anchor = record[side]; if (anchor.type !== 'dynamic' || anchor.bodyId !== change.oldId) continue;
        const c = anchor.voxel, child = change.newIds.map(id => this.physics.entries.get(id)).find(e => e && gridCell(e, c.x, c.y, c.z));
        if (!child) { this.breakJoint(record.id, 'source-voxel-removed'); break; }
        anchor.bodyId = child.id; this._drop(record);
      }
    }
    return this.step();
  }
  step({wakeUp = true} = {}) {
    if (!this._ensureWorld()) return this.stats();
    for (const record of this.records.values()) {
      if (!record.active) continue;
      const a = this._resolve(record.a), b = this._resolve(record.b);
      if (!a || !b) { this.breakJoint(record.id, 'anchor-missing'); continue; }
      if (record.maxSeparation !== null && distance(a.point, b.point) > record.maxSeparation) { this.breakJoint(record.id, 'project-separation-limit'); continue; }
      if (record.native?.isValid() && record.bindings[0] === a.entry && record.bindings[1] === b.entry) continue;
      this._drop(record);
      try { this._create(record, a, b, wakeUp); }
      catch { this.breakJoint(record.id, 'native-joint-rejected'); }
    }
    this._releaseStaticBody(); return this.stats();
  }
  stats() {
    let active = 0, native = 0; for (const r of this.records.values()) { if (r.active) active++; if (r.native) native++; }
    return {total: this.records.size, active, broken: this.records.size - active, native, staticAnchorBodies: this.staticBody ? 1 : 0, failurePolicy: 'project-voxel-presence-and-anchor-separation'};
  }
  drainEvents() { return this.events.splice(0); }
  snapshot() {
    this.step();
    return {version: 1, nextId: this.nextId, joints: [...this.records.values()].map(r => ({...definition(r, r.id), active: r.active, reason: r.reason}))};
  }
  restore(saved) {
    if (!saved || saved.version !== 1 || !Array.isArray(saved.joints)) throw new Error('Unsupported voxel-joint save');
    const records = saved.joints.map(r => ({...definition(r, r.id), active: r.active !== false, reason: typeof r.reason === 'string' ? r.reason : null, native: null, bindings: null}));
    if (new Set(records.map(r => r.id)).size !== records.length) throw new Error('Duplicate voxel-joint save id');
    this.clear(); this.nextId = Number.isSafeInteger(saved.nextId) && saved.nextId > 0 ? saved.nextId : 1;
    for (const record of records) this.records.set(record.id, record);
    return this.step({wakeUp: false});
  }
  clear() {
    this._ensureWorld(); for (const r of this.records.values()) this._drop(r);
    this.records.clear(); this.events.length = 0; this.nextId = 1; this._releaseStaticBody();
  }
  dispose() { this.clear(); this.physics = null; this.engineWorld = null; }
}
