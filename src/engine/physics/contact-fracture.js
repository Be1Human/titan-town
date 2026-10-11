import {CELL} from '../../voxel-world.js';
import {MATERIALS} from '../../materials.js';
import {sourcePoint, gridCell} from '../../rigid-fracture.js';
import {contactBreakageCap} from '../core/reference-materials.js';

export const CONTACT_FRACTURE_DEFAULTS = Object.freeze({
  contactFracture: false,
  // Rapier impulse/dt is a force estimate. The verified reference coefficient
  // table does not establish its unit conversion; this is project calibration.
  contactForceScale: .08, minimumImpactSpeed: 2,
  maxContactFracturesPerStep: 2, maximumContactRadius: .3
});

// A conservative floor, never an average material: only used to reject force
// values that cannot exceed ANY material's individual breakage threshold.
const globalCapFloor=Math.min(...Object.keys(MATERIALS).map(mat=>contactBreakageCap(mat)));
// Smallest Rapier contact force that can still pass this entry's cap test:
// force = maxForce * contactForceScale must exceed the cap floor. Pairs below
// it can never produce a candidate, so Rapier need not report them.
export function contactForceEventThreshold(entry, settings) {
  const scale=settings.contactForceScale, floor=(entry.contactCapFloor??globalCapFloor)*Math.max(0,entry.strength??1);
  if(floor===Infinity)return Number.MAX_VALUE;
  if(!(scale>0)||!Number.isFinite(floor))return 0;
  return Math.max(0,floor/scale*(1-1e-6));
}
export function contactCapFloor(cells) {
  let floor=Infinity;const seen=new Set();
  for(const c of cells)if(!seen.has(c.mat)){seen.add(c.mat);floor=Math.min(floor,contactBreakageCap(c.mat));}
  return floor;
}

export function contactDamage(material, force, strength = 1, distanceFraction = 0) {
  const cap = contactBreakageCap(material, strength);
  if (!Number.isFinite(force) || force <= cap || !MATERIALS[material]) return 0;
  const excess = Math.min(8, force / cap - 1);
  return MATERIALS[material].strength * excess * (1 - .65 * Math.max(0, Math.min(1, distanceFraction)));
}

function pointVelocity(state, point) {
  if (!state) return {x: 0, y: 0, z: 0};
  const r = {x: point.x - state.com.x, y: point.y - state.com.y, z: point.z - state.com.z}, w = state.angularVelocity, v = state.velocity;
  return {x: v.x + w.y * r.z - w.z * r.y, y: v.y + w.z * r.x - w.x * r.z, z: v.z + w.x * r.y - w.y * r.x};
}

function contactCell(entry, point, outward) {
  const s = entry.cellSize || CELL;
  const local = sourcePoint(entry, {x: point.x - outward.x * s * .1, y: point.y - outward.y * s * .1, z: point.z - outward.z * s * .1});
  const x = Math.floor(local.x / s), y = Math.floor(local.y / s), z = Math.floor(local.z / s);
  const exact = gridCell(entry, x, y, z);
  if (exact) return exact;
  // Solver points can lie on shared edges. Resolve only immediately adjacent
  // occupied voxels; never use the first body material or bridge a real hole.
  let nearest, distance = s * s * 1.21;
  for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const c = gridCell(entry, x + dx, y + dy, z + dz); if (!c) continue;
    const d = ((c.x + .5) * s - local.x) ** 2 + ((c.y + .5) * s - local.y) ** 2 + ((c.z + .5) * s - local.z) ** 2;
    if (d < distance) { distance = d; nearest = c; }
  }
  return nearest;
}

// Deliberately postSolve: impulses are read after Rapier's constraint solver.
// It does not cap solver constraints as the researched engine branch does.
// The strongest normal impulse within each manifold drives one local cut,
// avoiding a dependence on the number of contact points used for a flat face.
export function collectContactCandidates(physics, previous, dt, settings, forceEvents = []) {
  const candidates = new Map(), owners = physics.colliderOwners || new Map(), forces = new Map();
  const pairKey = (a, b) => a < b ? `${a}/${b}` : `${b}/${a}`;
  for (const event of forceEvents) {
    const key = pairKey(event.a, event.b);
    if (!forces.has(key) || event.maxForce > forces.get(key).maxForce) forces.set(key, event);
  }
  // Large bodies carry several clustered colliders; every one is a contact source.
  const collidersOf = entry => entry.colliders ?? [entry.collider];
  if(!physics.colliderOwners)for (const entry of physics.entries.values()) for (const c of collidersOf(entry)) owners.set(c.handle, entry);
  // These per-body quantities are invariant throughout this read-only pass.
  // Keep the same bound and arithmetic, without recomputing angular radius
  // and COM offsets for every contact partner of a densely stacked piece.
  const angularBounds = new Map();
  function angularBound(entry, state, scale) {
    if (!state) return 0;
    if (!angularBounds.has(entry.id)) angularBounds.set(entry.id,new Map());
    const sizes=angularBounds.get(entry.id);
    if (!sizes.has(scale)) sizes.set(scale,
      Math.hypot(...Object.values(state.angularVelocity)) *
      (Math.hypot(entry.half.x,entry.half.y,entry.half.z) +
       Math.hypot(state.com.x-entry.position.x,state.com.y-entry.position.y,state.com.z-entry.position.z) + scale));
    return sizes.get(scale);
  }
  // |va-vb| <= |va|+|vb|, and the angular bound grows with scale. A body whose
  // own bound plus the largest partner bound misses the impact threshold has
  // no pair that can pass the per-pair test below, so its pairs are not walked.
  const speedOf=state=>Math.hypot(state.velocity.x,state.velocity.y,state.velocity.z);
  let maxScale=0,partnerBound=0;
  for(const id of previous.keys()){const entry=physics.entries.get(id);if(entry)maxScale=Math.max(maxScale,entry.cellSize||CELL);}
  for(const [id,state] of previous){const entry=physics.entries.get(id);if(entry)partnerBound=Math.max(partnerBound,speedOf(state)+angularBound(entry,state,maxScale));}
  // Only valid when every fracturing collider carries contactForceEventThreshold:
  // Rapier then reports each pair whose summed solver impulse exceeds the
  // smaller threshold, so a pair without an event cannot pass the cap test.
  const eventColliders=settings.eventPairsOnly===true?new Set():null;
  if(eventColliders)for(const event of forceEvents){eventColliders.add(event.a);eventColliders.add(event.b);}
  for (const id of previous.keys()) {
    const entry=physics.entries.get(id);if(!entry)continue;
    if (!entry.contactFracture || !previous.has(entry.id)) continue;
    if(eventColliders&&!collidersOf(entry).some(c=>eventColliders.has(c.handle)))continue;
    if(settings.pairWalkAll!==true){const state=previous.get(id);if(speedOf(state)+angularBound(entry,state,entry.cellSize||CELL)+partnerBound<settings.minimumImpactSpeed)continue;}
    // Production bodies cache the initial materials on creation. A retained
    // body's edits only remove cells, so that floor remains conservative.
    // New split bodies recompute it. Custom callers lacking it use the global
    // floor; strength changes are applied live rather than cached.
    const minimumCap=(entry.contactCapFloor??globalCapFloor)*Math.max(0,entry.strength??1);
    if(minimumCap===Infinity)continue;
    for (const collider of collidersOf(entry)) physics.world.contactPairsWith(collider, other => {
      const otherEntry = owners.get(other.handle), otherState = otherEntry && previous.get(otherEntry.id);
      const state=previous.get(entry.id),s=entry.cellSize||CELL;
      // An upper bound on relative point speed over both occupied domains.
      // This only skips pairs that cannot pass the existing impact threshold.
      const dv={x:state.velocity.x-(otherState?.velocity.x||0),y:state.velocity.y-(otherState?.velocity.y||0),z:state.velocity.z-(otherState?.velocity.z||0)};
      const speedBound=Math.hypot(dv.x,dv.y,dv.z)+angularBound(entry,state,s);
      // The original bound uses the querying body's voxel size on both sides.
      // Retain that convention for mixed-scale bodies as well.
      const otherBound=angularBound(otherEntry,otherState,s);
      if(speedBound+otherBound<settings.minimumImpactSpeed)return;
      const event = forces.get(pairKey(collider.handle, other.handle)),projections=new Map();
      if(eventColliders&&!event)return;
      physics.world.contactPair(collider, other, (manifold, flipped) => {
        let impulse = 0;
        const contactCount=manifold.numContacts();
        for (let i = 0; i < contactCount; i++) impulse = Math.max(impulse, manifold.contactImpulse(i));
        const manifoldImpulse = impulse;
        // CCD may consume solver contacts before the final narrow-phase view.
        // Its force event still comes from the actual contact solve. Use it
        // instead of estimating an impulse from changes in body velocity.
        if (event) impulse = Math.max(impulse, event.maxForce * dt);
        const force = impulse / dt * settings.contactForceScale;
        if (!Number.isFinite(force) || force <= 0 || force/minimumCap<=1) return;
        const solverCount=manifold.numSolverContacts();
        const raw = manifold.normal(), normal = flipped ? {x: -raw.x, y: -raw.y, z: -raw.z} : {x: raw.x, y: raw.y, z: raw.z};
        const points = [];
        for (let i = 0; i < solverCount; i++) {
          const point = manifold.solverContactPoint(i); if (point) points.push(point);
        }
        if (!points.length && event && Math.hypot(normal.x, normal.y, normal.z) > .5) {
          // The force event has no contact location. Project along the known
          // manifold normal onto this collider; the localized cut position is
          // approximate, while its driving impulse is solver-produced.
          // A voxel/compound pair can contain thousands of empty CCD
          // manifolds with the same normal. They all request the identical
          // whole-shape projection. Cache it and only reconsider a stronger
          // impulse; do not reduce contacts or discard any solver point.
          const key=normal.x+','+normal.y+','+normal.z,cached=projections.get(key);
          if(cached&&impulse<=cached.impulse)return;
          let point=cached?.point;
          // A clustered body projects onto the cluster in this pair, which is
          // the part actually touching the partner.
          if(!cached){const radius=Math.hypot(entry.half.x,entry.half.y,entry.half.z)+s,p=entry.position;
            point=collider.projectPoint({x:p.x+normal.x*radius,y:p.y+normal.y*radius,z:p.z+normal.z*radius},false)?.point;}
          projections.set(key,{point,impulse});if(point)points.push(point);
        }
        for (const point of points) {
          const a = pointVelocity(previous.get(entry.id), point), b = pointVelocity(otherState, point);
          const speed = (a.x - b.x) * normal.x + (a.y - b.y) * normal.y + (a.z - b.z) * normal.z;
          if (speed < settings.minimumImpactSpeed) continue;
          const cell = contactCell(entry, point, normal); if (!cell) continue;
          const cap = contactBreakageCap(cell.mat, entry.strength), ratio = force / cap;
          if (ratio <= 1) continue;
          const s = entry.cellSize || CELL;
          const radius = Math.min(settings.maximumContactRadius, s * (1.25 + Math.sqrt(Math.min(16, ratio - 1)) * .5));
          const eventDriven = Boolean(event && event.maxForce * dt > manifoldImpulse);
          const candidate = {id: entry.id, otherId: otherEntry?.id || null, point: {...point}, normal, impulse, manifoldImpulse, solverForce: impulse / dt, force, cap, impactSpeed: speed, material: cell.mat, ratio, radius,
            impulseSource: eventDriven ? 'contactForceEvent' : 'contactManifold', impulseApproximate: eventDriven, pointApproximate: !solverCount};
          if (!candidates.has(entry.id) || candidates.get(entry.id).ratio < ratio) candidates.set(entry.id, candidate);
        }
      });
    });
  }
  return [...candidates.values()].sort((a, b) => b.ratio - a.ratio);
}
