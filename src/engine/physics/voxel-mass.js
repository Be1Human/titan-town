import {referenceMaterialFor} from '../core/reference-materials.js';

const identity = {x: 0, y: 0, z: 0, w: 1};

function quaternionFromColumns(m) {
  const trace = m[0] + m[4] + m[8];
  let x, y, z, w;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = s / 4; x = (m[7] - m[5]) / s; y = (m[2] - m[6]) / s; z = (m[3] - m[1]) / s;
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(Math.max(0, 1 + m[0] - m[4] - m[8])) * 2;
    w = (m[7] - m[5]) / s; x = s / 4; y = (m[1] + m[3]) / s; z = (m[2] + m[6]) / s;
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(Math.max(0, 1 + m[4] - m[0] - m[8])) * 2;
    w = (m[2] - m[6]) / s; x = (m[1] + m[3]) / s; y = s / 4; z = (m[5] + m[7]) / s;
  } else {
    const s = Math.sqrt(Math.max(0, 1 + m[8] - m[0] - m[4])) * 2;
    w = (m[3] - m[1]) / s; x = (m[2] + m[6]) / s; y = (m[5] + m[7]) / s; z = s / 4;
  }
  const length = Math.hypot(x, y, z, w);
  return length > 0 ? {x: x / length, y: y / length, z: z / length, w: w / length} : {...identity};
}

// Jacobi diagonalization of the full symmetric tensor. Keeping the eigenframe
// matters for asymmetric mixed-material bodies; a diagonal-only tensor does
// not preserve their angular response. Matrix storage here is row-major.
export function principalInertia(tensor) {
  const a = [...tensor], basis = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let iteration = 0; iteration < 24; iteration++) {
    let p = 0, q = 1;
    if (Math.abs(a[2]) > Math.abs(a[p * 3 + q])) { p = 0; q = 2; }
    if (Math.abs(a[5]) > Math.abs(a[p * 3 + q])) { p = 1; q = 2; }
    const off = a[p * 3 + q];
    if (Math.abs(off) <= Math.max(1e-16, Math.max(a[0], a[4], a[8]) * 1e-13)) break;
    const angle = .5 * Math.atan2(2 * off, a[q * 3 + q] - a[p * 3 + p]);
    const c = Math.cos(angle), s = Math.sin(angle), pp = a[p * 3 + p], qq = a[q * 3 + q];
    for (let k = 0; k < 3; k++) if (k !== p && k !== q) {
      const kp = a[k * 3 + p], kq = a[k * 3 + q];
      a[k * 3 + p] = a[p * 3 + k] = c * kp - s * kq;
      a[k * 3 + q] = a[q * 3 + k] = s * kp + c * kq;
    }
    a[p * 3 + p] = c * c * pp - 2 * s * c * off + s * s * qq;
    a[q * 3 + q] = s * s * pp + 2 * s * c * off + c * c * qq;
    a[p * 3 + q] = a[q * 3 + p] = 0;
    for (let k = 0; k < 3; k++) {
      const kp = basis[k * 3 + p], kq = basis[k * 3 + q];
      basis[k * 3 + p] = c * kp - s * kq;
      basis[k * 3 + q] = s * kp + c * kq;
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[i * 3 + i] - a[j * 3 + j]);
  const frame = [];
  for (let row = 0; row < 3; row++) for (const column of order) frame.push(basis[row * 3 + column]);
  const determinant = frame[0] * (frame[4] * frame[8] - frame[5] * frame[7]) - frame[1] * (frame[3] * frame[8] - frame[5] * frame[6]) + frame[2] * (frame[3] * frame[7] - frame[4] * frame[6]);
  if (determinant < 0) for (let row = 0; row < 3; row++) frame[row * 3 + 2] *= -1;
  return {principalAngularInertia: {x: Math.max(1e-12, a[order[0] * 3 + order[0]]), y: Math.max(1e-12, a[order[1] * 3 + order[1]]), z: Math.max(1e-12, a[order[2] * 3 + order[2]])}, angularInertiaLocalFrame: quaternionFromColumns(frame)};
}

export function voxelMassProperties(cells, {cellSize = .1, density = 1, origin = {x: 0, y: 0, z: 0}} = {}) {
  if (!Number.isFinite(cellSize) || cellSize <= 0 || !Number.isFinite(density) || density <= 0 || !cells.length) throw new Error('Invalid voxel mass input');
  const baseMass = cellSize ** 3 * 500 * density;
  let mass = 0, sx = 0, sy = 0, sz = 0;
  for (const c of cells) {
    const m = baseMass * referenceMaterialFor(c.mat).densityCoefficient;
    mass += m; sx += m * (c.x + .5) * cellSize; sy += m * (c.y + .5) * cellSize; sz += m * (c.z + .5) * cellSize;
  }
  const centerOfMass = {x: sx / mass, y: sy / mass, z: sz / mass};
  const tensor = new Array(9).fill(0);
  for (const c of cells) {
    const m = baseMass * referenceMaterialFor(c.mat).densityCoefficient;
    const x = (c.x + .5) * cellSize - centerOfMass.x, y = (c.y + .5) * cellSize - centerOfMass.y, z = (c.z + .5) * cellSize - centerOfMass.z;
    const own = .1 * m * cellSize ** 2;
    tensor[0] += m * (y * y + z * z) + own; tensor[4] += m * (x * x + z * z) + own; tensor[8] += m * (x * x + y * y) + own;
    tensor[1] -= m * x * y; tensor[2] -= m * x * z; tensor[5] -= m * y * z;
  }
  tensor[3] = tensor[1]; tensor[6] = tensor[2]; tensor[7] = tensor[5];
  return {mass, centerOfMass, localCenterOfMass: {x: centerOfMass.x - origin.x, y: centerOfMass.y - origin.y, z: centerOfMass.z - origin.z}, inertiaTensor: tensor, ...principalInertia(tensor)};
}

// Exact material mass and full tensor subtraction around the old COM. Working
// relative to that COM avoids subtracting huge world-origin moments. Geometry
// origins and world-space point velocities do not change when a hole is made.
export function subtractVoxelMass(previous,removed,{cellSize=.1,density=1,origin={x:0,y:0,z:0}}={}){
  const baseMass=cellSize**3*500*density,old=previous.centerOfMass,tensor=[...previous.inertiaTensor];
  let mass=previous.mass,sx=0,sy=0,sz=0;
  for(const c of removed){const m=baseMass*referenceMaterialFor(c.mat).densityCoefficient,x=(c.x+.5)*cellSize-old.x,y=(c.y+.5)*cellSize-old.y,z=(c.z+.5)*cellSize-old.z,own=.1*m*cellSize**2;
    mass-=m;sx-=m*x;sy-=m*y;sz-=m*z;
    tensor[0]-=m*(y*y+z*z)+own;tensor[4]-=m*(x*x+z*z)+own;tensor[8]-=m*(x*x+y*y)+own;
    tensor[1]+=m*x*y;tensor[2]+=m*x*z;tensor[5]+=m*y*z;}
  if(!(mass>0))throw Error('Cannot subtract all material from a retained body');
  const x=sx/mass,y=sy/mass,z=sz/mass,centerOfMass={x:old.x+x,y:old.y+y,z:old.z+z};
  tensor[0]-=mass*(y*y+z*z);tensor[4]-=mass*(x*x+z*z);tensor[8]-=mass*(x*x+y*y);
  tensor[1]+=mass*x*y;tensor[2]+=mass*x*z;tensor[5]+=mass*y*z;tensor[3]=tensor[1];tensor[6]=tensor[2];tensor[7]=tensor[5];
  return {mass,centerOfMass,localCenterOfMass:{x:centerOfMass.x-origin.x,y:centerOfMass.y-origin.y,z:centerOfMass.z-origin.z},inertiaTensor:tensor,...principalInertia(tensor)};
}

// Preserve source-order floating point summation and the full inertia tensor;
// only scheduling changes. No body exists until both passes have completed.
export function* prepareVoxelMass(cells, {cellSize = .1, density = 1, origin = {x: 0, y: 0, z: 0}, batchSize = 256} = {}) {
  if (!Number.isFinite(cellSize) || cellSize <= 0 || !Number.isFinite(density) || density <= 0 || !cells.length) throw new Error('Invalid voxel mass input');
  const baseMass = cellSize ** 3 * 500 * density, batch = Math.max(1, Math.floor(batchSize));
  let mass = 0, sx = 0, sy = 0, sz = 0, work = 0;
  for (const c of cells) {
    const m = baseMass * referenceMaterialFor(c.mat).densityCoefficient;
    mass += m; sx += m * (c.x + .5) * cellSize; sy += m * (c.y + .5) * cellSize; sz += m * (c.z + .5) * cellSize;
    if (++work >= batch) { work = 0; yield 'mass'; }
  }
  const centerOfMass = {x: sx / mass, y: sy / mass, z: sz / mass}, tensor = new Array(9).fill(0);
  for (const c of cells) {
    const m = baseMass * referenceMaterialFor(c.mat).densityCoefficient;
    const x = (c.x + .5) * cellSize - centerOfMass.x, y = (c.y + .5) * cellSize - centerOfMass.y, z = (c.z + .5) * cellSize - centerOfMass.z;
    const own = .1 * m * cellSize ** 2;
    tensor[0] += m * (y * y + z * z) + own; tensor[4] += m * (x * x + z * z) + own; tensor[8] += m * (x * x + y * y) + own;
    tensor[1] -= m * x * y; tensor[2] -= m * x * z; tensor[5] -= m * y * z;
    if (++work >= batch) { work = 0; yield 'inertia'; }
  }
  tensor[3] = tensor[1]; tensor[6] = tensor[2]; tensor[7] = tensor[5];
  return {mass, centerOfMass, localCenterOfMass: {x: centerOfMass.x - origin.x, y: centerOfMass.y - origin.y, z: centerOfMass.z - origin.z}, inertiaTensor: tensor, ...principalInertia(tensor)};
}
