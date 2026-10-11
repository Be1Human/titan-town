import {makeHoleRadiusForMaterial} from './reference-materials.js';

// Project API budget, not a recovered native limit. Existing static callers
// already cap the outer radius at five metres.
export const MAX_HOLE_RADIUS = 5;
export function normalizeHoleRadii(radii) {
  if (!Array.isArray(radii) || radii.length !== 3 || !radii.every(n => Number.isFinite(n) && n >= 0)) return null;
  const soft = Math.min(MAX_HOLE_RADIUS, radii[0]), medium = Math.min(soft, radii[1]);
  return Object.freeze([soft, medium, Math.min(medium, radii[2])]);
}

function hash(n) { n = Math.imul(n ^ n >>> 16, 0x7feb352d); n = Math.imul(n ^ n >>> 15, 0x846ca68b); return (n ^ n >>> 16) >>> 0; }
function direction(seed, octave) {
  const v = [0, 1, 2].map(axis => hash(seed ^ Math.imul(octave * 3 + axis + 1, 0x9e3779b9)) / 2147483647.5 - 1);
  const length = Math.hypot(...v) || 1; return v.map(n => n / length);
}

// The verified contract is three ordered physical-material radii and a local
// distance test. Native floating/fixed kernels have directional perturbation;
// the optional smooth seeded field below is our own algorithm, not that code.
// It is independent of traversal order, chunking, occupancy and object IDs.
export function createMakeHoleCut(radii, {seed = 0, noise = 0} = {}) {
  const ordered = normalizeHoleRadii(radii);
  if (!ordered || !Number.isSafeInteger(seed) || !Number.isFinite(noise) || noise < 0) return null;
  noise = Math.min(.35, noise);
  const vectors = noise ? [1, 2, 3].map(octave => direction(seed >>> 0, octave)) : null, cache = new Map();
  const cut = {radii: ordered, seed: seed >>> 0, noise, radius: ordered[0] * (1 + noise),
    contains(material, dx, dy, dz) {
      let radius = cache.get(material);
      if (radius === undefined) { radius = makeHoleRadiusForMaterial(material, ordered); cache.set(material, radius); }
      if (!radius) return false; // category 3 and zero radii never cut.
      const distance2 = dx * dx + dy * dy + dz * dz;
      if (noise && distance2 > 0) {
        const distance = Math.sqrt(distance2), x = dx / distance, y = dy / distance, z = dz / distance;
        const a = vectors[0], b = vectors[1], c = vectors[2];
        const u = x * a[0] + y * a[1] + z * a[2], v = x * b[0] + y * b[1] + z * b[2], w = x * c[0] + y * c[1] + z * c[2];
        radius *= 1 + noise * (.5 * u + .3 * v ** 3 + .2 * (2 * w ** 2 - 1));
      }
      // Rapier stores poses as float32; a tiny metric tolerance keeps a cell
      // exactly on the boundary included after a rigid frame transformation.
      return distance2 <= radius * radius + Math.max(1e-12, radius * radius * 1e-6);
    }};
  return Object.freeze(cut);
}

// Exclusive max bounds match both fixed world limits and rigid shape grids.
// Floor (including negatives) and one conservative voxel of padding ensure
// every candidate centre reaches the same narrow-phase predicate.
export function holeCellBounds(point, radius, cellSize, min, max) {
  const lo = {}, hi = {};
  for (const axis of ['x', 'y', 'z']) {
    lo[axis] = Math.max(min[axis], Math.floor((point[axis] - radius) / cellSize) - 1);
    hi[axis] = Math.min(max[axis] - 1, Math.floor((point[axis] + radius) / cellSize) + 1);
  }
  return lo.x > hi.x || lo.y > hi.y || lo.z > hi.z ? null : {lo, hi};
}
