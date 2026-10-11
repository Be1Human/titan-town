import RAPIER from '../vendor/rapier.js';
import {CELL, CHUNK, STRIDE, chunkOf, MATERIAL_IDS, MATERIAL_KEYS} from './voxel-world.js';
import {mergeVoxelBoxes, shapeFromCells, prepareVoxelShape} from './rigid-shapes.js';
import {MATERIALS, impactEnergy} from './materials.js';
import {cellKey, cellGrid, gridIndex, gridCell, sourcePoint, worldPoint, cellsCenter, connectedRemainder, remainsConnectedAfterCut} from './rigid-fracture.js';
import {voxelMassProperties, prepareVoxelMass, subtractVoxelMass} from './engine/physics/voxel-mass.js';
import {contactDamage, collectContactCandidates, contactCapFloor, contactForceEventThreshold, CONTACT_FRACTURE_DEFAULTS} from './engine/physics/contact-fracture.js';
import {createMakeHoleCut, holeCellBounds} from './engine/core/make-hole.js';
import {BodySpatialIndex} from './engine/physics/body-spatial-index.js';
import {normalizeVoxelPalette,encodePaletteCells,restorePaletteCells} from './engine/assets/voxel-palette.js';
import {ReferencePhysicsPipeline} from './engine/physics/reference-physics-pipeline.js';
import {VoxelCollisionData} from './engine/physics/voxel-collision-data.js';

let initializing, initialized = false;
export const rigidRuntimeStats = {initializationMs: 0, warmupMs: 0};
export function initRigidPhysics() {
  if (initializing) return initializing;
  const started = performance.now();
  return initializing = RAPIER.init().then(() => {
    const warmStart = performance.now();
    warmContactAlgorithms();
    rigidRuntimeStats.warmupMs = performance.now() - warmStart;
    rigidRuntimeStats.initializationMs = performance.now() - started;
    initialized = true; return RAPIER;
  });
}

// Body count is not a simulation budget. Keep compatibility for consumers of
// these names, but grow retained collections independently of the active set.
export const RIGID_LIMITS = Object.freeze({bodies: Infinity, partsPerBody: 96, parts: Infinity, cellsPerBody: Infinity});
export const PERSISTENT_LIMITS = Object.freeze({...RIGID_LIMITS, volume: Infinity, cells: Infinity, gridVolume: Infinity});
// Exact greedy boxes up to this count. Rapier's native voxel shape emits one
// manifold per touching voxel, so a large resting body costs tens of ms per
// narrow phase; its compound equivalent costs well under one.
export const DYNAMIC_COMPOUND_PARTS = 4096;
// Debris resting on a native-voxel terrain chunk pays the same per-voxel
// manifolds; same-state A/B halved the step there and was neutral elsewhere.
export const TERRAIN_COMPOUND_PARTS = 4096;
// Project-side resident-data estimate, NOT a measured engine limit and NOT
// a measurement of driver/WASM heap usage. Refuse atomically rather than erase.
export const PHYSICS_MEMORY_BUDGET = 256 * 1024 * 1024;
export const estimatedBodyBytes = (cells, volume, parts = 1) => cells * 64 + volume * 4 + parts * 128 + 2048;
const IDENTITY = {x: 0, y: 0, z: 0, w: 1};
// A compound overlapping a terrain compound costs 1-6 ms per pair in Rapier
// even with no manifold (same-state snapshot, 2.3k-box body over ~20 chunks).
// Large bodies therefore keep their boxes in spatial clusters, one collider
// each on the same body; the first carries the whole mass, the rest none.
export const COMPOUND_SPLIT_BOXES = 256, COMPOUND_CLUSTER_CELLS = 32;
// At 6 iterations a resting debris pile can keep regenerating mm/s contact
// jitter, so its island never sleeps; 8 slept in every perturbed snapshot.
// In the browser the higher count and compound splitting both lowered
// first-collapse FPS, so both stay opt-in (solverIterations, compoundSplit).
export const SOLVER_ITERATIONS = 6;
// A near-rest island holding a heavy body (the 50+ t upper storey) and 1-cell
// chips (~1 kg) has contact mass ratios above 1000:1. At 6 substeps the solve
// does not converge: squeezed chips are ejected at 1-2.5 m/s with no external
// input and the whole island never reaches the sleep threshold. Rapier's
// per-island extra iterations converge it; they are applied only while the
// heavy body itself is nearly at rest, so violent collapse keeps 6 substeps.
// ?legacy=restiter disables.
export const HEAVY_BODY_MASS = 400, REST_EXTRA_ITERATIONS = 6, REST_SPEED = .5;
// A detached piece spawns with faces exactly flush against the static wall it
// left. At zero gap Rapier's friction held a 1-voxel sheet with no support
// beneath (town rooftops); a 0.1 mm inset per terrain box face lets it fall, while
// pieces resting on intact voxels stay put. Only static contact geometry is
// inset; every body query still uses exact dynamic boxes. ?legacy=noinset.
export const TERRAIN_INSET = .0001;
const boxCluster=(b,size)=>size?`${Math.floor((b.x+b.w/2)/size)},${Math.floor((b.y+b.h/2)/size)},${Math.floor((b.z+b.d/2)/size)}`:'';
export const entryColliders=entry=>entry.colliders??[entry.collider];
function castEntry(entry,ray,max,solid){
  let best=null;
  for(const c of entryColliders(entry)){const hit=c.castRayAndGetNormal(ray,best?best.timeOfImpact:max,solid);if(hit&&(!best||hit.timeOfImpact<best.timeOfImpact))best=hit;}
  return best;
}
export function projectEntry(entry,p,solid){
  let best=null,distance=Infinity;
  for(const c of entryColliders(entry)){const r=c.projectPoint(p,solid);if(!r)continue;const q=r.point,d=(q.x-p.x)**2+(q.y-p.y)**2+(q.z-p.z)**2;if(d<distance){distance=d;best=r;}}
  return best;
}
// Reserve the worst-case exact feature index and row objects before allocating.
// Actual typed-array residency is reported independently by collisionData.
const collisionBytes=(volume,width,height,depth)=>volume*9+2*depth+66*height*depth;
const vector = (v, fallback = {x: 0, y: 0, z: 0}) => ({x: Number.isFinite(v?.x) ? v.x : fallback.x, y: Number.isFinite(v?.y) ? v.y : fallback.y, z: Number.isFinite(v?.z) ? v.z : fallback.z});
function rotation(q) {
  if (!q || ![q.x, q.y, q.z, q.w].every(Number.isFinite)) return {...IDENTITY};
  const n = Math.hypot(q.x, q.y, q.z, q.w);
  return n > 1e-8 ? {x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n} : {...IDENTITY};
}
function worldExtents(half, q) {
  const {x, y, z, w} = q;
  return {
    x: Math.abs(1 - 2 * (y * y + z * z)) * half.x + Math.abs(2 * (x * y - z * w)) * half.y + Math.abs(2 * (x * z + y * w)) * half.z,
    y: Math.abs(2 * (x * y + z * w)) * half.x + Math.abs(1 - 2 * (x * x + z * z)) * half.y + Math.abs(2 * (y * z - x * w)) * half.z,
    z: Math.abs(2 * (x * z - y * w)) * half.x + Math.abs(2 * (y * z + x * w)) * half.y + Math.abs(1 - 2 * (x * x + y * y)) * half.z
  };
}
function compound(boxes, origin, center, cellSize = CELL, inset = 0) {
  const shapes = [], positions = [], rotations = [];
  for (const b of boxes) {
    shapes.push(new RAPIER.Cuboid(b.w * cellSize / 2 - inset, b.h * cellSize / 2 - inset, b.d * cellSize / 2 - inset));
    positions.push({x: (origin.x + b.x + b.w / 2) * cellSize - center.x, y: (origin.y + b.y + b.h / 2) * cellSize - center.y, z: (origin.z + b.z + b.d / 2) * cellSize - center.z});
    rotations.push(IDENTITY);
  }
  return RAPIER.ColliderDesc.compound(shapes, positions, rotations);
}
function warmContactAlgorithms() {
  // WASM contact code compiles lazily. Pay that one-time cost while the game
  // initializes instead of at the first explosion visible to the player.
  const world = new RAPIER.World({x: 0, y: -18, z: 0});
  try {
    world.createCollider(RAPIER.ColliderDesc.compound([new RAPIER.Cuboid(1, .1, 1)], [{x: -2, y: -.1, z: 0}], [IDENTITY]));
    const data = [];
    for (let x = -5; x < 5; x++) for (let z = -5; z < 5; z++) data.push(x, 0, z);
    world.createCollider(RAPIER.ColliderDesc.voxels(new Int32Array(data), {x: CELL, y: CELL, z: CELL}).setTranslation(2, -.1, 0));
    for (const x of [-2, 2]) {
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, .3, 0).setCcdEnabled(true));
      world.createCollider(RAPIER.ColliderDesc.compound([new RAPIER.Cuboid(.12, .1, .1), new RAPIER.Cuboid(.1, .1, .1)], [{x: -.12, y: 0, z: 0}, {x: .1, y: 0, z: 0}], [IDENTITY, IDENTITY]), body);
    }
    for (let i = 0; i < 60; i++) world.step();
  } finally { world.free(); }
}
function encodeCells(cells,sourceShapes=false) {
  const sorted = [...cells].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x), runs = [];
  for (const c of sorted) {
    const n = runs.length, mat = sourceShapes?(c.sourceShape||0):MATERIAL_IDS[c.mat] || MATERIAL_IDS.stone;
    if (n && runs[n - 4] === c.y && runs[n - 3] === c.z && runs[n - 5] + runs[n - 2] === c.x && runs[n - 1] === mat) runs[n - 2]++;
    else runs.push(c.x, c.y, c.z, 1, mat);
  }
  return runs;
}
function decodeCells(saved, memoryBudgetBytes = PHYSICS_MEMORY_BUDGET) {
  if (!Array.isArray(saved.runs)) return saved.cells;
  const cells = [], runs = saved.runs;
  if (runs.length % 5) return null;
  for (let i = 0; i < runs.length; i += 5) {
    const [x, y, z, length, material] = runs.slice(i, i + 5);
    if (![x, y, z, length, material].every(Number.isSafeInteger) || length <= 0 || cells.length + length > Math.floor(memoryBudgetBytes / 64) || !MATERIAL_KEYS[material]) return null;
    for (let dx = 0; dx < length; dx++) cells.push({x: x + dx, y, z, mat: MATERIAL_KEYS[material]});
  }
  return cells;
}

// Persistent detached pieces. Cosmetic chips continue to use debris-physics.js.
// Static colliders are materialized only around these pieces, never for the map.
export class RigidWorld {
  constructor(voxelWorld, options = {}) {
    if (!initialized) throw new Error('Call await initRigidPhysics() before creating RigidWorld');
    this.entries = new Map(); this.terrain = new Map(); this.nextId = 1;
    this.memoryBudgetBytes = options.memoryBudgetBytes ?? PHYSICS_MEMORY_BUDGET;
    this.poseObservers = new Set(); this.structureRevision = 0;
    this.rejected = 0; this.rebuilds = 0; this.stepMs = 0; this.dynamicParts = 0;
    this.contactSettings = {...CONTACT_FRACTURE_DEFAULTS, ...options};
    this.legacy=new Set(options.legacy||[]);
    if(this.legacy.has('contactwalk'))this.contactSettings.pairWalkAll=true;
    this.contactSettings.eventPairsOnly=!['contactwalk','forceevents','eventwalk'].some(flag=>this.legacy.has(flag));
    // Fragmented terrain chunks stay merged boxes up to this count; beyond it
    // they fall back to native voxels.
    this.terrainParts=Number.isFinite(options.terrainParts)&&options.terrainParts>=0?Math.floor(options.terrainParts):this.legacy.has('terrain256')?256:TERRAIN_COMPOUND_PARTS;
    this.surfaceReuse=Boolean(options.surfaceReuse);
    this.compoundParts=Number.isFinite(options.compoundParts)&&options.compoundParts>=0?Math.floor(options.compoundParts):DYNAMIC_COMPOUND_PARTS;
    this.terrainInset=this.legacy.has('noinset')?0:Number.isFinite(options.terrainInset)&&options.terrainInset>=0?options.terrainInset:TERRAIN_INSET;
    this.compoundSplit=options.compoundSplit===true;
    // ?legacy=bedrockjoin keeps the bottom layer inside the chunk compound.
    this.bedrockCollider=!this.legacy.has('bedrockjoin');
    this.solverIterations=Number.isInteger(options.solverIterations)&&options.solverIterations>0?options.solverIterations:SOLVER_ITERATIONS;
    this.restExtraIterations=this.legacy.has('restiter')?0:Number.isInteger(options.restExtraIterations)&&options.restExtraIterations>=0?options.restExtraIterations:REST_EXTRA_ITERATIONS;
    this.pipelineMode=options.pipeline==='reference'?'reference':'rapier';
    this.wholeStepMode=options.wholeStep===true;
    this.solverBackend=options.solverBackend==='js'?'js':options.solverBackend==='wasm'||this.wholeStepMode?'wasm':'js';
    this.nearBackend=options.nearBackend==='wasm'?'wasm':'js';
    this.reset(voxelWorld);
  }
  reset(voxelWorld = this.voxelWorld) {
    this.referencePipeline?.dispose();
    for (const token of this.preparationTokens ?? []) this.cancelPersistentPreparation(token);
    this.world?.free();
    this.eventQueue?.free();
    this.gravity = Number.isFinite(voxelWorld?.gravity) && voxelWorld.gravity >= 0 ? voxelWorld.gravity : 18;
    this.world = new RAPIER.World({x: 0, y: -this.gravity, z: 0});
    this.eventQueue = new RAPIER.EventQueue(true);
    this.world.integrationParameters.numSolverIterations = this.solverIterations;
    // Every body keeps CCD, so a step still stops at its first time of impact.
    // A second substep only resolves a further impact inside the same 1/60 s
    // and re-runs the narrow phase; same-snapshot A/B on titan-town measured
    // 46-50 ms -> 19 ms per step for it. ?legacy=ccdsub2 restores it.
    this.world.integrationParameters.maxCcdSubsteps = this.legacy.has('ccdsub2') ? 2 : 1;
    this.world.integrationParameters.normalizedAllowedLinearError = .001;
    this.world.integrationParameters.normalizedPredictionDistance = .008;
    this.voxelWorld = voxelWorld; this.entries.clear(); this.terrain.clear();
    this.structureRevision++; this.spatial = new BodySpatialIndex(CELL * CHUNK);
    this.activeEntries = new Map(); this.sleepingEntries = new Map(); this.bodyHandles = new Map(); this.colliderOwners = new Map();
    this.dirtyEntries = new Set(); this.terrainDirtyEntries = new Set(); this.terrainNeeds = new Map(); this.terrainStates = new Map();
    this.poseChanges = new Map(); this.lastAdmissionFailure = null; this.estimatedMemoryBytes = 0;
    this.fractureScratch = {};
    this.preparationTokens = new Set(); this.preparedMemoryBytes = 0;
    this.worksetStats = {synced: 0, terrainBodies: 0, queryCandidates: 0};
    this.dynamicParts = 0; this.nextId = 1; this.rejected = 0; this.rebuilds = 0; this.stepMs = 0;
    this.dynamicCells = 0; this.dynamicVolume = 0;
    this.simulationSeconds=0;this.completedSteps=0;
    this.terrainMs = 0; this.solverMs = 0; this.fractureMs = 0;
    this.fractureEvents = []; this.contactEvents = []; this.contactFractures = 0;
    this.incrementalCuts=0;this.incrementalRemoved=0;
    this.disposed = false;
    this.referencePipeline=this.pipelineMode==='reference'?new ReferencePhysicsPipeline(this):null;
  }
  add(cells, options = {}) {
    this.lastAdmissionFailure = null;
    if (this.disposed) return this._reject('disposed', false);
    if(options.id!==undefined&&this.entries.has(options.id))return this._reject('duplicate',false);
    if (options.cellSize !== undefined && (!Number.isFinite(options.cellSize) || options.cellSize < .025 || options.cellSize > .4)) return this._reject('invalid', false);
    const shape = this._cookShape(cells); if (!shape) return null;
    while (this.entries.has(`rigid-${this.nextId}`)) this.nextId++;
    const id = options.id ?? `rigid-${this.nextId++}`;
    if (this.entries.has(id)) return this._reject('duplicate', false);
    let entry;
    try { entry = this._makeEntry(shape, {...options, id}); }
    catch (error) { return this._reject('runtime', true, {message: String(error.message || error)}); }
    this._registerEntry(entry);
    this.world.propagateModifiedBodyPositionsToColliders();
    return entry;
  }
  addPersistent(cells, options = {}) { return this.add(cells, {...options, persistent: true}); }
  beginPersistentPreparation(cells, options = {}) {
    const token = {owner: this, world: this.world, options: {...options, persistent: true}, stage: 'bounds', state: 'preparing', prepared: null, failure: null, reservedBytes: 0};
    this.preparationTokens.add(token); token.iterator = this._preparePersistent(cells, token);
    return token;
  }
  cancelPersistentPreparation(token) {
    if (!this.preparationTokens.delete(token)) return false;
    this.preparedMemoryBytes -= token.reservedBytes; token.reservedBytes = 0;
    token.iterator = null; token.prepared = null; token.state = 'cancelled'; token.stage = 'cancelled'; return true;
  }
  _reservePreparation(token, required) {
    const available = this.memoryBudgetBytes - this.estimatedMemoryBytes - this.preparedMemoryBytes + token.reservedBytes;
    if (required > available) throw {admissionFailure: {reason: 'memory', retryable: true, requiredBytes: required, availableBytes: Math.max(0, available)}};
    this.preparedMemoryBytes += required - token.reservedBytes; token.reservedBytes = required;
  }
  *_preparePersistent(cells, token) {
    const options = token.options;
    if (this.disposed) throw {admissionFailure: {reason: 'disposed', retryable: false}};
    if (options.id !== undefined && this.entries.has(options.id)) throw {admissionFailure: {reason: 'duplicate', retryable: false}};
    if (options.cellSize !== undefined && (!Number.isFinite(options.cellSize) || options.cellSize < .025 || options.cellSize > .4)) throw {admissionFailure: {reason: 'invalid', retryable: false}};
    const shape = yield* prepareVoxelShape(cells, {maxParts:this.referencePipeline?0:this.compoundParts,validateCell: c => Boolean(c && MATERIALS[c.mat || 'stone']),
      checkBounds: (volume, count) => {
        const required = estimatedBodyBytes(count, volume) + volume;
        if (!Number.isSafeInteger(volume)) throw {admissionFailure: {reason: 'invalid', retryable: false}};
        this._reservePreparation(token, required);
      }});
    if (!shape) throw {admissionFailure: {reason: 'invalid', retryable: false}};
    shape.estimatedBytes = estimatedBodyBytes(shape.cells.length, shape.volume, shape.parts)+(this.referencePipeline?collisionBytes(shape.volume,shape.max.x-shape.min.x,shape.max.y-shape.min.y,shape.max.z-shape.min.z)+(this.wholeStepMode?shape.volume:0):0);
    this._reservePreparation(token, Math.max(token.reservedBytes, shape.estimatedBytes));
    const cellSize = options.cellSize || CELL, density = Number.isFinite(options.density) && options.density > 0 ? options.density : 1;
    const center = {}, palette = normalizeVoxelPalette(options.palette);
    for (const axis of ['x', 'y', 'z']) center[axis] = Number.isFinite(options.center?.[axis])?options.center[axis]:(shape.min[axis] + shape.max[axis]) * cellSize / 2;
    const massProperties = yield* prepareVoxelMass(shape.cells, {cellSize, density, origin: center});
    const width = shape.max.x - shape.min.x, depth = shape.max.z - shape.min.z, layer = width * depth;
    const grid = {min: shape.min, max: shape.max, width, depth, layer, data: new Int32Array(shape.volume)};
    const coordinates = shape.colliderKind === 'voxels' ? new Int32Array(shape.cells.length * 3) : null;
    for (let i = 0; i < shape.cells.length; i++) {
      const c = shape.cells[i];
      if (palette ? !palette[c.paletteIndex] : c.paletteIndex !== undefined) throw new Error('Voxel colour missing from object palette');
      grid.data[c.x - shape.min.x + (c.z - shape.min.z) * width + (c.y - shape.min.y) * layer] = i + 1;
      if (coordinates) { coordinates[i * 3] = c.x; coordinates[i * 3 + 1] = c.y; coordinates[i * 3 + 2] = c.z; }
      if ((i + 1) % 256 === 0) yield 'grid';
    }
    let collisionData=null;
    if(this.referencePipeline){collisionData=new VoxelCollisionData(grid,i=>shape.cells[grid.data[i]-1]?.mat,{defer:true});yield* collisionData.prepare();collisionData.revision=options.revision??0;}
    return {shape, massProperties, grid, coordinates, palette,collisionData};
  }
  advancePersistentPreparation(token, {budgetMs = 3, now = () => performance.now(), maxSteps = 16} = {}) {
    const started = now(), limit = Number.isFinite(budgetMs) ? Math.max(0, budgetMs) : 3;
    const stepLimit = Number.isFinite(maxSteps) ? Math.max(1, Math.floor(maxSteps)) : 16;
    if (!this.preparationTokens.has(token) || token.world !== this.world || this.disposed) {
      return {done: true, stage: 'cancelled', failure: {reason: 'disposed', retryable: false}, elapsedMs: now() - started};
    }
    let steps = 0;
    if (token.state === 'preparing') try {
      do {
        const next = token.iterator.next(); steps++;
        if (next.done) { token.prepared = next.value; token.state = 'ready'; token.stage = 'ready'; break; }
        token.stage = next.value;
      } while (steps < stepLimit && now() - started < limit);
    } catch (error) {
      const failure = error.admissionFailure ?? {reason: 'runtime', retryable: true, message: String(error.message || error)};
      this.preparedMemoryBytes -= token.reservedBytes; token.reservedBytes = 0; token.iterator = null; token.prepared = null;
      this._reject(failure.reason, failure.retryable, failure); token.failure = {...this.lastAdmissionFailure}; token.state = 'failed'; token.stage = 'failed';
    }
    return {done: token.state !== 'preparing', stage: token.stage, failure: token.failure, steps, elapsedMs: now() - started};
  }
  commitPreparedPersistent(token) {
    this.lastAdmissionFailure = null;
    if (!this.preparationTokens.has(token) || token.world !== this.world || this.disposed) return this._reject('disposed', false);
    if (token.state !== 'ready' || !token.prepared) return this._reject('invalid', false);
    const {shape} = token.prepared, available = this.memoryBudgetBytes - this.estimatedMemoryBytes - this.preparedMemoryBytes + token.reservedBytes;
    if (shape.estimatedBytes > available) return this._reject('memory', true, {requiredBytes: shape.estimatedBytes, availableBytes: Math.max(0, available)});
    if (token.options.id !== undefined && this.entries.has(token.options.id)) return this._reject('duplicate', false);
    let nextId = this.nextId; while (this.entries.has(`rigid-${nextId}`)) nextId++;
    const id = token.options.id ?? `rigid-${nextId}`, options = {...token.options, id};
    let entry;
    // Rapier's collider construction is one indivisible call. Only the JS
    // scans have been prepared over frames; report this commit separately.
    try { entry = this._makeEntry(shape, options, token.prepared); }
    catch (error) { return this._reject('runtime', true, {message: String(error.message || error)}); }
    this._registerEntry(entry); this.world.propagateModifiedBodyPositionsToColliders();
    if (token.options.id === undefined) this.nextId = nextId + 1;
    this.preparedMemoryBytes -= token.reservedBytes; token.reservedBytes = 0;
    token.state = 'committed'; token.iterator = null; token.prepared = null; this.preparationTokens.delete(token); return entry;
  }
  _reject(reason, retryable, extra = {}) { this.rejected++; this.lastAdmissionFailure = {reason,retryable,...extra}; return null; }
  _cookShape(cells, retainedBytes = this.estimatedMemoryBytes) {
    if (!Array.isArray(cells) || !cells.length) return this._reject('invalid',false);
    const min={x:Infinity,y:Infinity,z:Infinity},max={x:-Infinity,y:-Infinity,z:-Infinity};
    for (const c of cells) {
      if (!c || !MATERIALS[c.mat || 'stone']) return this._reject('invalid',false);
      for (const a of ['x','y','z']) { if (!Number.isSafeInteger(c[a]) || Math.abs(c[a])>8192) return this._reject('invalid',false); min[a]=Math.min(min[a],c[a]);max[a]=Math.max(max[a],c[a]+1); }
    }
    const volume=(max.x-min.x)*(max.y-min.y)*(max.z-min.z), available=this.memoryBudgetBytes-retainedBytes-this.preparedMemoryBytes;
    // Include the dense scratch used while cooking. Guard before allocating.
    const extra=this.referencePipeline?collisionBytes(volume,max.x-min.x,max.y-min.y,max.z-min.z)+(this.wholeStepMode?volume:0):0;
    const required=estimatedBodyBytes(cells.length,volume)+volume+extra;
    if (!Number.isSafeInteger(volume) || required>available) return this._reject('memory',true,{requiredBytes:required,availableBytes:Math.max(0,available)});
    try {
      const shape=shapeFromCells(cells,{allowVoxelFallback:true,maxParts:this.referencePipeline?0:this.compoundParts});
      if (!shape) return this._reject('invalid',false);
      shape.estimatedBytes=estimatedBodyBytes(shape.cells.length,shape.volume,shape.parts)+extra;
      if (shape.estimatedBytes>available) return this._reject('memory',true,{requiredBytes:shape.estimatedBytes,availableBytes:Math.max(0,available)});
      return shape;
    } catch(error) { return this._reject('runtime',true,{message:String(error.message||error)}); }
  }
  _registerEntry(entry) {
    for(const field of ['hiddenVisual','visual']){
      let value=entry[field];
      Object.defineProperty(entry,field,{enumerable:true,configurable:true,get:()=>value,set:next=>{if(next===value)return;value=next;if(this.entries.get(entry.id)===entry){this.structureRevision++;for(const observer of this.poseObservers)observer(entry);}}});
    }
    this.entries.set(entry.id,entry); this.bodyHandles.set(entry.body.handle,entry); for(const c of entryColliders(entry))this.colliderOwners.set(c.handle,entry);
    this._indexEntry(entry);
    this.dynamicParts+=entry.parts;this.dynamicCells+=entry.cells.length;this.dynamicVolume+=entry.grid.data.length;this.estimatedMemoryBytes+=entry.estimatedBytes;
    (entry.body.isSleeping()?this.sleepingEntries:this.activeEntries).set(entry.id,entry);
    this.dirtyEntries.add(entry);this.terrainDirtyEntries.add(entry);this.structureRevision++;
  }
  _makeEntry(shape, options, prepared = null) {
    const {id} = options, center = {}, half = {}, cellSize = options.cellSize || CELL;
    const palette=prepared ? prepared.palette : normalizeVoxelPalette(options.palette);
    if(!prepared && shape.cells.some(c=>palette?!palette[c.paletteIndex]:c.paletteIndex!==undefined))throw Error('Voxel colour missing from object palette');
    for (const axis of ['x', 'y', 'z']) { center[axis] = Number.isFinite(options.center?.[axis])?options.center[axis]:(shape.min[axis] + shape.max[axis]) * cellSize / 2; half[axis] = Math.max(Math.abs(shape.min[axis]*cellSize-center[axis]),Math.abs(shape.max[axis]*cellSize-center[axis])); }
    const position = vector(options.position, center), q = rotation(options.rotation), velocity = vector(options.velocity), angularVelocity = vector(options.angularVelocity);
    const descriptor = RAPIER.RigidBodyDesc.dynamic().setTranslation(position.x, position.y, position.z).setRotation(q)
      .setLinvel(velocity.x, velocity.y, velocity.z).setAngvel(angularVelocity).setLinearDamping(.18).setAngularDamping(.65)
      .setCcdEnabled(true).setCanSleep(true).setSleeping(Boolean(options.sleeping));
    const body = this.world.createRigidBody(descriptor);
    const density = Number.isFinite(options.density) && options.density > 0 ? options.density : 1;
    const strength = Number.isFinite(options.strength) && options.strength > 0 ? options.strength : 1;
    let massProperties, collider, clusters = null;
    try {
      massProperties = prepared?.massProperties ?? voxelMassProperties(shape.cells, {cellSize, density, origin: center});
      let colliderDesc, colliderCom = massProperties.localCenterOfMass;
      if (shape.colliderKind === 'voxels') {
        const coordinates = prepared?.coordinates ?? new Int32Array(shape.cells.length * 3);
        if (!prepared) shape.cells.forEach((c, i) => { coordinates[i * 3] = c.x; coordinates[i * 3 + 1] = c.y; coordinates[i * 3 + 2] = c.z; });
        colliderDesc = RAPIER.ColliderDesc.voxels(coordinates, {x: cellSize, y: cellSize, z: cellSize}).setTranslation(-center.x, -center.y, -center.z);
        colliderCom = massProperties.centerOfMass;
      } else if (shape.boxes.length >= COMPOUND_SPLIT_BOXES && this.compoundSplit) colliderDesc = null;
      else colliderDesc = compound(shape.boxes, shape.min, center, cellSize);
      if (colliderDesc) {
        collider = this.world.createCollider(colliderDesc.setMassProperties(massProperties.mass, colliderCom, massProperties.principalAngularInertia, massProperties.angularInertiaLocalFrame).setFriction(.8).setRestitution(.03)
          .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(0), body);
      } else {
        clusters = this._cookClusters(body, shape.boxes, shape.min, center, cellSize, COMPOUND_CLUSTER_CELLS, null, .8, .03);
        collider = clusters.values().next().value;
        collider.setMassProperties(massProperties.mass, colliderCom, massProperties.principalAngularInertia, massProperties.angularInertiaLocalFrame);
      }
      body.recomputeMassPropertiesFromColliders();
    } catch (error) { this.world.removeRigidBody(body); throw error; }
    const entry = {id, cells: shape.cells, center, position, rotation: q, half, body, collider, parts: shape.parts,
      occupiedBounds:{min:{...shape.min},max:{...shape.max}},
      estimatedBytes: shape.estimatedBytes ?? estimatedBodyBytes(shape.cells.length,shape.volume,shape.parts), poseRevision: 0,
      massProperties, density, strength, cellSize, persistent: Boolean(options.persistent), quality: shape.colliderKind,
      contactFracture: options.contactFracture ?? Boolean(this.contactSettings.contactFracture),
      revision: Number.isSafeInteger(options.revision) ? options.revision : 0, damage: new Map(), grid: prepared?.grid ?? cellGrid(shape.cells, shape.min, shape.max)};
    if(entry.contactFracture)entry.contactCapFloor=contactCapFloor(shape.cells);
    if(clusters){entry.clusterCells=COMPOUND_CLUSTER_CELLS;entry.clusterSet=clusters;entry.colliders=[...clusters.values()];}
    this._syncForceThreshold(entry);
    if(shape.colliderKind!=='voxels'&&shape.boxes){entry.boxes=shape.boxes;entry.boxOrigin={...shape.min};entry.liveBoxes=entry.mergedBoxes=shape.boxes.length;}
    if(this.referencePipeline){entry.collisionData=prepared?.collisionData??new VoxelCollisionData(entry.grid,i=>entry.cells[entry.grid.data[i]-1]?.mat);entry.collisionData.revision=entry.revision;}
    if(palette)entry.palette=palette;
    if(options.assetIdentity)entry.assetIdentity=structuredClone(options.assetIdentity);
    if(options.name)entry.name=String(options.name);
    for (const item of options.damage || []) {
      if (!Array.isArray(item) || item.length !== 4) continue;
      const [x, y, z, amount] = item, cell = gridCell(entry, x, y, z);
      if ([x, y, z].every(Number.isSafeInteger) && cell && Number.isFinite(amount) && amount > 0 && amount < MATERIALS[cell.mat].strength) entry.damage.set(cellKey(cell), amount);
    }
    this._syncEntry(entry);
    // Public body handles are used by grabs, joints and network replicas. Hook
    // their mutations so a sleeping body can enter the work set before Rapier
    // updates its island list on the next step.
    for (const method of ['wakeUp','sleep','setTranslation','setRotation','setLinvel','setAngvel','applyImpulse','applyImpulseAtPoint','applyTorqueImpulse','setBodyType','setNextKinematicTranslation','setNextKinematicRotation']) {
      if (typeof body[method] !== 'function') continue;
      const original=body[method].bind(body);
      body[method]=(...args)=>{const result=original(...args);if(this.entries.get(entry.id)===entry)this._touch(entry);return result;};
    }
    return entry;
  }
  remove(id) {
    const entry = this.entries.get(id); if (!entry || this.disposed) return false;
    this.world.removeRigidBody(entry.body); this.entries.delete(id); this.bodyHandles.delete(entry.body.handle);for(const c of entryColliders(entry))this.colliderOwners.delete(c.handle);
    this.activeEntries.delete(id);this.sleepingEntries.delete(id);this.spatial.remove(id);this.dirtyEntries.delete(entry);this.terrainDirtyEntries.delete(entry);this.poseChanges.delete(id);
    for(const key of entry.terrainKeys||[]){const count=this.terrainNeeds.get(key)-1;if(count>0)this.terrainNeeds.set(key,count);else this.terrainNeeds.delete(key);}
    this.dynamicParts -= entry.parts; this.dynamicCells -= entry.cells.length; this.dynamicVolume -= entry.grid.data.length;this.estimatedMemoryBytes-=entry.estimatedBytes;this.structureRevision++;return true;
  }
  subscribePoses(callback) { this.poseObservers.add(callback);return ()=>this.poseObservers.delete(callback); }
  _touch(entry) {
    this.referencePipeline?.activate(entry);
    this.dirtyEntries.add(entry);this.terrainDirtyEntries.add(entry);
    if(entry.body.isSleeping()){this.activeEntries.delete(entry.id);this.sleepingEntries.set(entry.id,entry);}
    else {this.sleepingEntries.delete(entry.id);this.activeEntries.set(entry.id,entry);}
  }
  _indexEntry(entry) {
    const bounds=entry.occupiedBounds??entry.grid,half={x:(bounds.max.x-bounds.min.x)*entry.cellSize/2,y:(bounds.max.y-bounds.min.y)*entry.cellSize/2,z:(bounds.max.z-bounds.min.z)*entry.cellSize/2};
    const p=worldPoint(entry,{x:(bounds.min.x+bounds.max.x)*entry.cellSize/2,y:(bounds.min.y+bounds.max.y)*entry.cellSize/2,z:(bounds.min.z+bounds.max.z)*entry.cellSize/2}),e=worldExtents(half,entry.rotation);
    entry.bounds={min:{x:p.x-e.x,y:p.y-e.y,z:p.z-e.z},max:{x:p.x+e.x,y:p.y+e.y,z:p.z+e.z}};
    entry.boundsRevision=entry.revision;
    this.spatial.update(entry,entry.bounds.min,entry.bounds.max);
  }
  _syncEntry(entry) {
    const p=entry.body.translation(),q=rotation(entry.body.rotation());
    const pose=[p.x,p.y,p.z,q.x,q.y,q.z,q.w],previous=entry.syncedPose;
    const changed=previous?pose.some((n,i)=>n!==previous[i]):['x','y','z'].some(a=>p[a]!==entry.position[a])||['x','y','z','w'].some(a=>q[a]!==entry.rotation[a]);
    entry.syncedPose=pose;
    Object.assign(entry.position,p);Object.assign(entry.rotation,q);
    this.worksetStats.synced++;
    if(this.entries.get(entry.id)===entry){
      if(changed||!entry.bounds||entry.boundsRevision!==entry.revision)this._indexEntry(entry);
      if(changed){entry.poseRevision++;this.poseChanges.set(entry.id,entry);this.terrainDirtyEntries.add(entry);for(const observer of this.poseObservers)observer(entry);}
    }
  }
  _flushDirtyPoses() {
    if(!this.dirtyEntries.size)return;
    this.world.propagateModifiedBodyPositionsToColliders();
    for(const entry of this.dirtyEntries)if(this.entries.get(entry.id)===entry){this._syncEntry(entry);if(!entry.bounds)this._indexEntry(entry);}
    this.dirtyEntries.clear();
  }
  _refreshWorkset(sync=false) {
    const work=new Map(this.activeEntries);
    this.world.forEachActiveRigidBody(body=>{const entry=this.bodyHandles.get(body.handle);if(entry&&!body.isSleeping())work.set(entry.id,entry);});
    for(const entry of this.dirtyEntries)if(this.entries.get(entry.id)===entry)work.set(entry.id,entry);
    for(const entry of work.values()){
      if(sync)this._syncEntry(entry);
      if(entry.body.isSleeping()){this.activeEntries.delete(entry.id);this.sleepingEntries.set(entry.id,entry);}
      else {this.sleepingEntries.delete(entry.id);this.activeEntries.set(entry.id,entry);}
    }
    if(sync)this.dirtyEntries.clear();
  }
  _candidates(min,max) { this._flushDirtyPoses();const entries=this.spatial.query(min,max);this.worksetStats.queryCandidates+=entries.length;return entries; }
  _terrainAroundBodies(dt) {
    const voxelWorld = this.voxelWorld;
    if (!voxelWorld?.chunks) return;
    // Sleeping footprints remain pinned. Recompute only moving/new/mutated
    // bodies; a changed terrain revision later wakes local sleeping neighbors.
    const updates=new Set([...this.activeEntries.values(),...this.terrainDirtyEntries]);
    this.worksetStats.terrainBodies=updates.size;
    for (const entry of updates) {
      if(this.entries.get(entry.id)!==entry)continue;
      const needed=new Set();
      const p = entry.position, e = worldExtents(entry.half, entry.rotation), v = entry.body.linvel();
      const angular = entry.body.angvel(), radius = Math.hypot(entry.half.x, entry.half.y, entry.half.z);
      const padding = .35 + Math.min(radius, radius * Math.hypot(angular.x, angular.y, angular.z) * dt);
      // Cover the full predicted trajectory. CCD cannot hit a thin wall whose
      // chunk has not been activated yet, especially during a long frame.
      const end = {x: p.x + v.x * dt, y: p.y + v.y * dt - .5 * this.gravity * dt * dt, z: p.z + v.z * dt};
      const minX = Math.max(-16, Math.floor((Math.min(p.x, end.x) - e.x - padding) / (CELL * CHUNK))), maxX = Math.min(15, Math.floor((Math.max(p.x, end.x) + e.x + padding) / (CELL * CHUNK)));
      const minY = Math.max(0, Math.floor((Math.min(p.y, end.y) - e.y - padding) / (CELL * CHUNK))), maxY = Math.min(7, Math.floor((Math.max(p.y, end.y) + e.y + padding) / (CELL * CHUNK)));
      const minZ = Math.max(-16, Math.floor((Math.min(p.z, end.z) - e.z - padding) / (CELL * CHUNK))), maxZ = Math.min(15, Math.floor((Math.max(p.z, end.z) + e.z + padding) / (CELL * CHUNK)));
      for (let y = minY; y <= maxY; y++) for (let z = minZ; z <= maxZ; z++) for (let x = minX; x <= maxX; x++) {
        const key = chunkOf(x * CHUNK, y * CHUNK, z * CHUNK);
        needed.add(key);
      }
      for(const key of entry.terrainKeys||[])if(!needed.has(key)){const count=this.terrainNeeds.get(key)-1;if(count>0)this.terrainNeeds.set(key,count);else this.terrainNeeds.delete(key);}
      for(const key of needed)if(!entry.terrainKeys?.has(key))this.terrainNeeds.set(key,(this.terrainNeeds.get(key)||0)+1);
      entry.terrainKeys=needed;
    }
    this.terrainDirtyEntries.clear();
    const changed = [];
    for (const [key, cached] of this.terrain) {
      if (!this.terrainNeeds.has(key)) { for(const c of cached.colliders)this.world.removeCollider(c, false); this.terrain.delete(key); }
    }
    for(const key of this.terrainStates.keys())if(!this.terrainNeeds.has(key))this.terrainStates.delete(key);
    for (const key of this.terrainNeeds.keys()) {
      const chunk = voxelWorld.chunks.get(key), previous = this.terrain.get(key);
      const state=this.terrainStates.get(key),revision=chunk?.revision||0;
      if(state&&state.chunk===chunk&&state.revision===revision)continue;
      if(state)changed.push(chunk||state.chunk);
      this.terrainStates.set(key,{chunk,revision});
      if (previous) { for(const c of previous.colliders)this.world.removeCollider(c, false);this.terrain.delete(key); }
      if(!chunk?.count)continue;
      // Rapier misses a new sub-shape of a compound while the body already
      // has a manifold (within prediction distance) with another sub-shape of
      // it: a chip sliding down a wall face crosses the 1-cell bedrock under
      // it in one step and leaves the world. The bottom layer is its own
      // collider, so its contact is generated independently of the walls.
      let layers=[chunk.data];
      if(chunk.y===0&&this.bedrockCollider){const bottom=chunk.data.slice(0,STRIDE);if(bottom.some(Boolean)){const rest=chunk.data.slice();rest.fill(0,0,STRIDE);const floor=new Uint8Array(chunk.data.length);floor.set(bottom);layers=[floor,rest];}}
      const colliders=[];
      for(const data of layers){
        let count=0;for(let i=0;i<data.length;i++)if(data[i])count++;
        if(!count)continue;
        const boxes = mergeVoxelBoxes(data, CHUNK, CHUNK, CHUNK, this.terrainParts);
        let desc;
        if (boxes) desc = compound(boxes, chunk, {x: 0, y: 0, z: 0}, CELL, this.terrainInset);
        else {
          // Rapier's native voxel shape avoids JS face meshing and BVH creation
          // for highly fragmented terrain. It preserves every empty cell.
          const coordinates = new Int32Array(count * 3); let write = 0;
          for (let i = 0; i < data.length; i++) if (data[i]) {
            coordinates[write++] = i & 31; coordinates[write++] = i >> 10; coordinates[write++] = (i >> 5) & 31;
          }
          desc = RAPIER.ColliderDesc.voxels(coordinates, {x: CELL, y: CELL, z: CELL}).setTranslation(chunk.x * CELL, chunk.y * CELL, chunk.z * CELL);
        }
        colliders.push(this.world.createCollider(desc.setFriction(.9).setRestitution(.02)));
      }
      this.terrain.set(key, {chunk, revision: chunk.revision || 0, collider: colliders.at(-1), colliders}); this.rebuilds++;
    }
    // Removing terrain must invalidate sleeping support islands as well.
    for (const chunk of changed) if(chunk) for (const entry of this.spatial.query({x:chunk.x*CELL-.4,y:chunk.y*CELL-.4,z:chunk.z*CELL-.4},{x:(chunk.x+CHUNK)*CELL+.4,y:(chunk.y+CHUNK)*CELL+.4,z:(chunk.z+CHUNK)*CELL+.4})) entry.body.wakeUp();
  }
  step(dt) {
    if (this.disposed) return;
    const start = performance.now(), elapsed = Number.isFinite(dt) ? Math.min(.1, Math.max(0, dt)) : 0;
    this.worksetStats.synced=0;this.poseChanges.clear();this._flushDirtyPoses();this._refreshWorkset();
    this._terrainAroundBodies(elapsed);
    const ready = performance.now(); this.terrainMs = ready - start;
    if (elapsed > 0 && this.entries.size) {
      const steps = Math.max(1, Math.ceil(elapsed / (1 / 60)));
      this.world.timestep = elapsed / steps;
      for (let i = 0; i < steps; i++) {
        if(this.referencePipeline){this.referencePipeline.step(this.world.timestep);continue;}
        this._restIterations();
        const previous = new Map();
        if ([...this.activeEntries.values()].some(entry => entry.contactFracture)) for (const entry of this.activeEntries.values()) {this._syncForceThreshold(entry);previous.set(entry.id, {velocity: vector(entry.body.linvel()), angularVelocity: vector(entry.body.angvel()), com: vector(entry.body.worldCom())});}
        this.world.step(previous.size ? this.eventQueue : undefined);
        this._refreshWorkset(true);
        if (previous.size) this._postSolveFracture(previous, this.world.timestep);
      }
    } else this.world.propagateModifiedBodyPositionsToColliders();
    this.solverMs = performance.now() - ready;
    this.simulationSeconds+=elapsed;this.completedSteps+=elapsed>0?Math.max(1,Math.ceil(elapsed/(1/60))):0;
    this.stepMs = performance.now() - start;
  }
  async stepAsync(dt){
    if(!this.referencePipeline)return this.step(dt);
    if(this.disposed)return false;const pipeline=this.referencePipeline,started=performance.now(),elapsed=Number.isFinite(dt)?Math.min(.1,Math.max(0,dt)):0;
    this.worksetStats.synced=0;this.poseChanges.clear();this._flushDirtyPoses();this._refreshWorkset();this._terrainAroundBodies(elapsed);
    const ready=performance.now();this.terrainMs=ready-started;
    if(elapsed>0&&this.entries.size){const steps=Math.max(1,Math.ceil(elapsed/(1/60)));this.world.timestep=elapsed/steps;
      for(let i=0;i<steps;i++)if(!await pipeline.stepAsync(this.world.timestep))return false;
    }else this.world.propagateModifiedBodyPositionsToColliders();
    this.solverMs=performance.now()-ready;this.stepMs=performance.now()-started;this.simulationSeconds+=elapsed;this.completedSteps+=elapsed>0?Math.max(1,Math.ceil(elapsed/(1/60))):0;return true;
  }
  _restIterations(){
    if(!this.restExtraIterations)return;
    for(const entry of this.activeEntries.values()){
      const body=entry.body;if(!(body.mass()>=HEAVY_BODY_MASS))continue;
      const v=body.linvel(),w=body.angvel(),extra=v.x*v.x+v.y*v.y+v.z*v.z<REST_SPEED*REST_SPEED&&w.x*w.x+w.y*w.y+w.z*w.z<REST_SPEED*REST_SPEED?this.restExtraIterations:0;
      if(entry.extraIterations!==extra){entry.extraIterations=extra;body.setAdditionalSolverIterations(extra);}
    }
  }
  // Rapier reports a pair when its total force exceeds the smaller threshold
  // of the two event-enabled colliders. Non-fracturing bodies never consume
  // events themselves, so only a fracturing partner can lower that bound.
  _syncForceThreshold(entry){
    const value=this.legacy.has('forceevents')?0:entry.contactFracture?contactForceEventThreshold(entry,this.contactSettings):Number.MAX_VALUE;
    if(entry.forceThreshold===value)return;
    entry.forceThreshold=value;for(const c of entryColliders(entry))c.setContactForceEventThreshold(value);
  }
  // Box coordinates are relative to origin. keys limits cooking to clusters
  // whose box set changed; a failed cook removes what it created.
  _cookClusters(body,list,origin,center,cellSize,size,keys,friction,restitution){
    const groups=new Map(),made=new Map();
    for(const b of list){if(!b)continue;const k=boxCluster(b,size);if(keys&&!keys.has(k))continue;let g=groups.get(k);if(!g)groups.set(k,g=[]);g.push(b);}
    try{for(const [k,boxes] of groups)made.set(k,this.world.createCollider(compound(boxes,origin,center,cellSize).setDensity(0).setFriction(friction).setRestitution(restitution)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(0),body));}
    catch(error){for(const c of made.values())this.world.removeCollider(c,false);throw error;}
    return made;
  }
  _postSolveFracture(previous, dt) {
    const forces = [];
    this.eventQueue.drainContactForceEvents(event => forces.push({a: event.collider1(), b: event.collider2(), maxForce: event.maxForceMagnitude(), direction: vector(event.maxForceDirection())}));
    const candidates = collectContactCandidates(this, previous, dt, this.contactSettings, forces);
    let applied = 0;
    for (const candidate of candidates) {
      if (applied >= this.contactSettings.maxContactFracturesPerStep) break;
      if (!this.entries.has(candidate.id)) continue;
      const result = this.destroySphere(candidate.point, candidate.radius, 1, 'contact', {id: candidate.id, contactForce: candidate.force});
      if (!result.damaged && !result.rejected.length) continue;
      result.contact = {...candidate, mode: 'postSolve'};
      this.fractureEvents.push(result); this.contactEvents.push(result.contact);
      if (result.changes.length) { applied++; this.contactFractures++; }
    }
  }
  drainFractureEvents() { return this.fractureEvents.splice(0); }
  drainContactEvents() { return this.contactEvents.splice(0); }
  collisionContact(x, feetY, z, height = 1.72, radius = .29, options = {}) {
    if (this.disposed || height <= .05 || radius <= 0) return null;
    const shape = new RAPIER.Cuboid(radius, (height - .05) / 2, radius), p = {x, y: feetY + height / 2, z};
    for (const entry of this._candidates({x:x-radius,y:feetY,z:z-radius},{x:x+radius,y:feetY+height,z:z+radius})) {
      if (entry.id === options.excludeId || options.excludeIds?.includes(entry.id)) continue;
      const e = worldExtents(entry.half, entry.rotation), a = entry.position;
      if (Math.abs(a.x - x) > e.x + radius || Math.abs(a.z - z) > e.z + radius || Math.abs(a.y - p.y) > e.y + height / 2) continue;
      if (entryColliders(entry).some(c => c.intersectsShape(shape, p, IDENTITY))) {
        const projection = projectEntry(entry, p, false);
        return {id: entry.id, point: projection?.point ? vector(projection.point) : {...p}};
      }
    }
    return null;
  }
  collides(x, feetY, z, height = 1.72, radius = .29, options = {}) {
    return Boolean(this.collisionContact(x, feetY, z, height, radius, options));
  }
  supportContact(x, z, fromY, maxDrop, radius = .26, options = {}) {
    if (this.disposed || maxDrop < 0) return null;
    let highest = null;
    for (const entry of this._candidates({x:x-radius,y:fromY-maxDrop-.002,z:z-radius},{x:x+radius,y:fromY+.002,z:z+radius})) {
      if (entry.id === options.excludeId || options.excludeIds?.includes(entry.id)) continue;
      const e = worldExtents(entry.half, entry.rotation), p = entry.position;
      if (Math.abs(p.x - x) > e.x + radius || Math.abs(p.z - z) > e.z + radius || p.y - e.y > fromY + .002 || p.y + e.y < fromY - maxDrop) continue;
      for (const dx of [-radius, 0, radius]) for (const dz of [-radius, 0, radius]) {
        const ray = new RAPIER.Ray({x: x + dx, y: fromY + .001, z: z + dz}, {x: 0, y: -1, z: 0});
        const hit = castEntry(entry, ray, maxDrop + .001, false);
        if (!hit || hit.normal.y < .35) continue;
        const y = fromY + .001 - hit.timeOfImpact;
        const closer = highest && Math.abs(y - highest.height) < 1e-6 && dx * dx + dz * dz < (highest.point.x - x) ** 2 + (highest.point.z - z) ** 2;
        if (y <= fromY + .002 && y >= fromY - maxDrop - .001 && (highest === null || y > highest.height + 1e-6 || closer)) {
          const point = {x: x + dx, y, z: z + dz}, source = sourcePoint(entry, point);
          const inside = sourcePoint(entry, {x: point.x - hit.normal.x * .001, y: point.y - hit.normal.y * .001, z: point.z - hit.normal.z * .001});
          const voxel = gridCell(entry, Math.floor(inside.x / entry.cellSize), Math.floor(inside.y / entry.cellSize), Math.floor(inside.z / entry.cellSize));
          const com = entry.body.worldCom(), v = entry.body.linvel(), w = entry.body.angvel(), r = {x: point.x - com.x, y: point.y - com.y, z: point.z - com.z};
          highest = {id: entry.id, height: y, point, sourcePoint: source, normal: vector(hit.normal), voxel: voxel && {...voxel},
            velocity: {x: v.x + w.y * r.z - w.z * r.y, y: v.y + w.z * r.x - w.x * r.z, z: v.z + w.x * r.y - w.y * r.x}};
        }
      }
    }
    return highest;
  }
  supportHeight(x, z, fromY, maxDrop, radius = .26, options = {}) { return this.supportContact(x, z, fromY, maxDrop, radius, options)?.height ?? null; }
  raycast(origin, direction, maxDistance = 60) {
    if (this.disposed) return null;
    const length = Math.hypot(direction.x, direction.y, direction.z); if (!length || !Number.isFinite(length) || !Number.isFinite(maxDistance) || maxDistance < 0) return null;
    const dir = {x: direction.x / length, y: direction.y / length, z: direction.z / length};
    const ray = new RAPIER.Ray(origin, dir); let nearest = null;
    this._flushDirtyPoses();const candidates=this.spatial.segment(origin,dir,maxDistance);this.worksetStats.queryCandidates+=candidates.length;
    for (const entry of candidates) {
      const hit = castEntry(entry, ray, nearest?.distance ?? maxDistance, true);
      if (!hit) continue;
      const distance = hit.timeOfImpact;
      const point = {x: origin.x + dir.x * distance, y: origin.y + dir.y * distance, z: origin.z + dir.z * distance};
      // Nudge into the surface before converting to source voxel coordinates;
      // choosing the first material in the body is wrong for mixed pieces.
      const p = sourcePoint(entry, {x: point.x - hit.normal.x * .001, y: point.y - hit.normal.y * .001, z: point.z - hit.normal.z * .001});
      const voxel = gridCell(entry, Math.floor(p.x / entry.cellSize), Math.floor(p.y / entry.cellSize), Math.floor(p.z / entry.cellSize));
      nearest = {id: entry.id, distance, normal: vector(hit.normal), point, mat: voxel?.mat || entry.cells[0].mat, voxel: voxel && {...voxel}};
    }
    return nearest;
  }
  damageRatio(id, voxel) {
    const entry = this.entries.get(id), cell = voxel && entry && gridCell(entry, voxel.x, voxel.y, voxel.z);
    return cell ? (entry.damage.get(cellKey(cell)) || 0) / MATERIALS[cell.mat].strength : 0;
  }
  destroySphere(point, radius, power, kind = 'generic', options = {}) {
    if (![radius, power].every(Number.isFinite) || radius <= 0 || power <= 0) return {removed: [], fragments: [], changes: [], damaged: 0, rejected: []};
    return this._cutCells(point, radius, (entry, c, dx, dy, dz) => {
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > radius * radius) return 0;
      return kind === 'contact' ? contactDamage(c.mat, options.contactForce, entry.strength, Math.sqrt(d2) / radius) : impactEnergy(c.mat, power, Math.sqrt(d2) / radius, kind);
    }, options);
  }
  // Static and dynamic MakeHole share material radii and the same metric
  // predicate. This path edits occupancy directly, independently of shape
  // strength, tool durability, old damage or the optional contact heuristic.
  makeHole(point, radii, options = {}) {
    const cut = createMakeHoleCut(radii, options);
    if (!cut || !cut.radius) return {removed: [], fragments: [], changes: [], damaged: 0, rejected: []};
    return this._cutCells(point, cut.radius, (entry, c, dx, dy, dz) => cut.contains(c.mat, dx, dy, dz) ? Infinity : 0, options);
  }
  _editConnectedVoxels(entry,indices,removed,damage){
    const oldMass=entry.massProperties,mass=subtractVoxelMass(oldMass,removed,{cellSize:entry.cellSize,density:entry.density,origin:entry.center});
    const oldCom=vector(entry.body.worldCom()),velocity=vector(entry.body.linvel()),omega=vector(entry.body.angvel()),changed=[];
    // Prepare mass first. If a native edit fails, restore every edited voxel
    // before publishing any source/grid/renderer state.
    if(entry.quality==='compound')this._replaceCompoundCollider(entry,indices,mass);
    else try{for(const c of removed){entry.collider.setVoxel(c.x,c.y,c.z,false);changed.push(c);}
      entry.collider.setMassProperties(mass.mass,mass.centerOfMass,mass.principalAngularInertia,mass.angularInertiaLocalFrame);
      entry.body.recomputeMassPropertiesFromColliders();}
    catch(error){for(const c of changed)entry.collider.setVoxel(c.x,c.y,c.z,true);
      entry.collider.setMassProperties(oldMass.mass,oldMass.centerOfMass,oldMass.principalAngularInertia,oldMass.angularInertiaLocalFrame);entry.body.recomputeMassPropertiesFromColliders();throw error;}
    for(const i of indices){const n=entry.grid.data[i]-1,last=entry.cells.pop();if(n<entry.cells.length){entry.cells[n]=last;entry.grid.data[gridIndex(entry.grid,last.x,last.y,last.z)]=n+1;}entry.grid.data[i]=0;}
    // Stable local volumes need not keep a stale physical AABB after their
    // boundary cells moved to another component. Retain grid/source/render
    // coordinates while refitting the occupied bounds used by broad phase.
    const bounds=entry.occupiedBounds??entry.grid;
    if(removed.some(c=>c.x===bounds.min.x||c.x===bounds.max.x-1||c.y===bounds.min.y||c.y===bounds.max.y-1||c.z===bounds.min.z||c.z===bounds.max.z-1)){
      const min={x:Infinity,y:Infinity,z:Infinity},max={x:-Infinity,y:-Infinity,z:-Infinity};
      for(const c of entry.cells){if(c.x<min.x)min.x=c.x;if(c.y<min.y)min.y=c.y;if(c.z<min.z)min.z=c.z;if(c.x+1>max.x)max.x=c.x+1;if(c.y+1>max.y)max.y=c.y+1;if(c.z+1>max.z)max.z=c.z+1;}
      entry.occupiedBounds={min,max};
    }
    entry.damage=damage;entry.massProperties=mass;entry.connectivityKnown=true;entry.revision++;
    entry.voxelEdits??=[];entry.voxelEdits.push({revision:entry.revision,removed:removed.map(c=>({x:c.x,y:c.y,z:c.z}))});if(entry.voxelEdits.length>64)entry.voxelEdits.shift();
    const freed=removed.length*64;entry.estimatedBytes-=freed;this.estimatedMemoryBytes-=freed;this.dynamicCells-=removed.length;
    const com=entry.body.worldCom(),r={x:com.x-oldCom.x,y:com.y-oldCom.y,z:com.z-oldCom.z};
    entry.body.setLinvel({x:velocity.x+omega.y*r.z-omega.z*r.y,y:velocity.y+omega.z*r.x-omega.x*r.z,z:velocity.z+omega.x*r.y-omega.y*r.x},true);
    entry.body.setAngvel(omega,true);this._touch(entry);this.structureRevision++;for(const observer of this.poseObservers)observer(entry);
    this.incrementalCuts++;this.incrementalRemoved+=removed.length;
  }
  // Large compounds keep their body, id and velocity like native voxels. Only
  // the collider is re-cooked from the remaining occupancy; the old one is
  // removed after its replacement exists, so a failed cook changes nothing.
  _editsInPlace(entry){return entry.quality==='voxels'||(entry.quality==='compound'&&entry.parts>RIGID_LIMITS.partsPerBody);}
  // Boxes untouched by a cut are still fully occupied and are kept. Only the
  // boxes containing removed cells are re-merged from their remaining cells,
  // so the union stays exactly the remaining occupancy. The list is sparse;
  // it is re-merged whole once local pieces have fragmented it noticeably.
  _localCompoundBoxes(entry,indices){
    const g=entry.grid,list=entry.boxes;
    if(this.legacy.has('fullrecook')||!list||!entry.boxOrigin||entry.boxOrigin.x!==g.min.x||entry.boxOrigin.y!==g.min.y||entry.boxOrigin.z!==g.min.z)return null;
    if(entry.liveBoxes>entry.mergedBoxes*1.5+64||list.length>entry.liveBoxes*2+64)return null;
    let owner=entry.boxOwner;
    if(!owner){owner=entry.boxOwner=new Int32Array(g.data.length);
      list.forEach((b,n)=>{if(!b)return;for(let y=b.y;y<b.y+b.h;y++)for(let z=b.z;z<b.z+b.d;z++){const row=y*g.layer+z*g.width;owner.fill(n+1,row+b.x,row+b.x+b.w);}});}
    const dropped=new Set(),gone=new Set(indices);
    for(const i of indices)if(owner[i])dropped.add(owner[i]-1);
    if(!dropped.size)return null;
    const lo={x:Infinity,y:Infinity,z:Infinity},hi={x:-Infinity,y:-Infinity,z:-Infinity};
    for(const n of dropped){const b=list[n];lo.x=Math.min(lo.x,b.x);lo.y=Math.min(lo.y,b.y);lo.z=Math.min(lo.z,b.z);hi.x=Math.max(hi.x,b.x+b.w);hi.y=Math.max(hi.y,b.y+b.h);hi.z=Math.max(hi.z,b.z+b.d);}
    const w=hi.x-lo.x,h=hi.y-lo.y,d=hi.z-lo.z,sub=new Uint8Array(w*h*d);
    for(const n of dropped){const b=list[n];for(let y=b.y;y<b.y+b.h;y++)for(let z=b.z;z<b.z+b.d;z++)for(let x=b.x;x<b.x+b.w;x++){
      const i=y*g.layer+z*g.width+x;if(g.data[i]&&!gone.has(i))sub[(y-lo.y)*w*d+(z-lo.z)*w+(x-lo.x)]=1;}}
    const local=mergeVoxelBoxes(sub,w,h,d);
    const live=entry.liveBoxes-dropped.size+local.length;if(live>this.compoundParts)return null;
    return {dropped,local:local.map(b=>({...b,x:b.x+lo.x,y:b.y+lo.y,z:b.z+lo.z})),live,owner};
  }
  _replaceCompoundCollider(entry,indices,mass){
    const g=entry.grid,height=g.max.y-g.min.y,s=entry.cellSize,c=entry.center,plan=this._localCompoundBoxes(entry,indices);
    let boxes,occupied;
    if(plan){
      const list=entry.boxes.slice();for(const n of plan.dropped)list[n]=null;
      for(const b of plan.local)list.push(b);
      boxes=list.filter(Boolean);plan.list=list;
    }else{
      occupied=new Uint8Array(g.data.length);
      for(let i=0;i<occupied.length;i++)if(g.data[i])occupied[i]=1;
      for(const i of indices)occupied[i]=0;
      boxes=mergeVoxelBoxes(occupied,g.width,height,g.depth,this.compoundParts);
    }
    let desc,com=mass.localCenterOfMass;const old=entry.collider,friction=old.friction(),restitution=old.restitution();
    const size=boxes&&this.compoundSplit?(plan?entry.clusterCells||0:boxes.length>=COMPOUND_SPLIT_BOXES?COMPOUND_CLUSTER_CELLS:0):0;
    if(size){
      // Only clusters that lost or gained a box are re-cooked. The others keep
      // their colliders; the mass moves to whichever collider stays primary.
      const keys=plan&&entry.clusterSet?new Set():null;
      if(keys){for(const n of plan.dropped)keys.add(boxCluster(entry.boxes[n],size));for(const b of plan.local)keys.add(boxCluster(b,size));}
      const made=this._cookClusters(entry.body,plan?plan.list:boxes,g.min,c,s,size,keys,friction,restitution),set=keys?new Map(entry.clusterSet):new Map(),retired=keys?[]:entryColliders(entry);
      if(keys)for(const k of keys){const prior=set.get(k);if(prior){retired.push(prior);set.delete(k);}}
      for(const [k,collider] of made)set.set(k,collider);
      const primary=retired.includes(old)?set.values().next().value:old;
      primary.setMassProperties(mass.mass,com,mass.principalAngularInertia,mass.angularInertiaLocalFrame);
      for(const collider of retired){this.world.removeCollider(collider,false);this.colliderOwners.delete(collider.handle);}
      for(const collider of made.values())this.colliderOwners.set(collider.handle,entry);
      entry.body.recomputeMassPropertiesFromColliders();
      entry.collider=primary;entry.clusterCells=size;entry.clusterSet=set;entry.colliders=[primary,...[...set.values()].filter(x=>x!==primary)];
    }else{
      if(boxes)desc=compound(boxes,g.min,c,s);
      else{
        const coordinates=[];
        for(let i=0;i<occupied.length;i++)if(occupied[i])coordinates.push(g.min.x+i%g.width,g.min.y+Math.floor(i/g.layer),g.min.z+Math.floor((i%g.layer)/g.width));
        desc=RAPIER.ColliderDesc.voxels(new Int32Array(coordinates),{x:s,y:s,z:s}).setTranslation(-c.x,-c.y,-c.z);com=mass.centerOfMass;
      }
      const collider=this.world.createCollider(desc.setMassProperties(mass.mass,com,mass.principalAngularInertia,mass.angularInertiaLocalFrame).setFriction(friction).setRestitution(restitution)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(0),entry.body);
      for(const prior of entryColliders(entry)){this.world.removeCollider(prior,false);this.colliderOwners.delete(prior.handle);}
      entry.body.recomputeMassPropertiesFromColliders();
      this.colliderOwners.set(collider.handle,entry);entry.collider=collider;entry.colliders=entry.clusterSet=null;entry.clusterCells=0;
    }
    entry.forceThreshold=undefined;this._syncForceThreshold(entry);
    const parts=boxes?boxes.length:1,bytes=(parts-entry.parts)*128;
    this.dynamicParts+=parts-entry.parts;entry.parts=parts;entry.estimatedBytes+=bytes;this.estimatedMemoryBytes+=bytes;
    if(!boxes){entry.quality='voxels';entry.boxes=entry.boxOwner=null;return;}
    if(plan){
      const {owner,list}=plan,first=list.length-plan.local.length;
      for(const i of indices)owner[i]=0;
      for(let n=first;n<list.length;n++){const b=list[n];for(let y=b.y;y<b.y+b.h;y++)for(let z=b.z;z<b.z+b.d;z++){const row=y*g.layer+z*g.width;owner.fill(n+1,row+b.x,row+b.x+b.w);}}
      entry.boxes=list;entry.liveBoxes=plan.live;
    }else{entry.boxes=boxes;entry.boxOrigin={...g.min};entry.liveBoxes=entry.mergedBoxes=boxes.length;entry.boxOwner=null;}
  }
  _splitNativeVoxels(entry,groups,indices,removed,proposed){
    // Keep the remainder with the largest bounding volume, as the recovered
    // splitter does. Only smaller local volumes need allocation and cooking.
    // Cook only genuinely separated components. The main body's occupancy,
    // complete mass tensor and COM velocity update in place, with no new BVH.
    let main=groups[0];for(const group of groups)if(group.boundingVolume>main.boundingVolume)main=group;
    const separated=groups.filter(group=>group!==main),plans=[];let temporary=0;const nextId=this.nextId;this.lastAdmissionFailure=null;
    for(const cells of separated){const shape=this._cookShape(cells,this.estimatedMemoryBytes+temporary);if(!shape)return null;temporary+=shape.estimatedBytes;plans.push(shape);}
    const velocity=vector(entry.body.linvel()),omega=vector(entry.body.angvel()),com=vector(entry.body.worldCom()),children=[];
    const moved=separated.flat(),allIndices=[...indices,...moved.map(c=>gridIndex(entry.grid,c.x,c.y,c.z))],mainDamage=new Map(proposed);
    for(const c of moved)mainDamage.delete(cellKey(c));
    const source=this.surfaceReuse?{id:entry.id,cells:entry.cells.slice(),cacheCells:entry.cells,center:{...entry.center},cellSize:entry.cellSize,revision:entry.revision,voxelEdits:entry.voxelEdits?.slice(),surfaceParent:entry.surfaceParent}:null;
    try{
      for(const shape of plans){while(this.entries.has(`rigid-${this.nextId}`))this.nextId++;const id=`rigid-${this.nextId++}`,position=worldPoint(entry,cellsCenter(shape.cells,entry.cellSize));
        const damage=shape.cells.flatMap(c=>proposed.has(cellKey(c))?[[c.x,c.y,c.z,proposed.get(cellKey(c))]]:[]);
        const child=this._makeEntry(shape,{id,revision:entry.revision+1,position,rotation:entry.rotation,angularVelocity:omega,damage,density:entry.density,strength:entry.strength,cellSize:entry.cellSize,persistent:entry.persistent,contactFracture:entry.contactFracture,palette:entry.palette,assetIdentity:entry.assetIdentity,name:entry.name});
        children.push(child);child.connectivityKnown=true;if(source)child.surfaceParent=source;if(child.assetIdentity)child.assetIdentity.bodyId=id;
        const cc=child.body.worldCom(),r={x:cc.x-com.x,y:cc.y-com.y,z:cc.z-com.z};child.body.setLinvel({x:velocity.x+omega.y*r.z-omega.z*r.y,y:velocity.y+omega.z*r.x-omega.x*r.z,z:velocity.z+omega.x*r.y-omega.y*r.x},true);}
      this._editConnectedVoxels(entry,allIndices,[...removed,...moved],mainDamage);
    }catch(error){for(const child of children)this.world.removeRigidBody(child.body);this.nextId=nextId;this._reject('runtime',true,{message:error.message});return null;}
    for(const child of children)this._registerEntry(child);return [entry,...children];
  }
  _cutCells(point, radius, cellDamage, options = {}) {
    const result = {removed: [], fragments: [], changes: [], damaged: 0, rejected: []};
    if (this.disposed || ![point?.x, point?.y, point?.z].every(Number.isFinite)) return result;
    const started = performance.now();
    // Snapshot ids: freshly split children cannot be attacked twice by the
    // same explosion, and an attack targeted at a ray hit cannot hit its rear.
    const targets = options.id ? [this.entries.get(options.id)].filter(Boolean) : this._candidates({x:point.x-radius,y:point.y-radius,z:point.z-radius},{x:point.x+radius,y:point.y+radius,z:point.z+radius});
    for (const entry of targets) {
      this._syncEntry(entry);
      const p = sourcePoint(entry, point), g = entry.grid, cellSize = entry.cellSize;
      const bounds = holeCellBounds(p, radius, cellSize, g.min, g.max); if (!bounds) continue;
      const {lo, hi} = bounds;
      const proposed = new Map(entry.damage), removed = [], indices = []; let damaged = 0;
      // holeCellBounds already clamps the integer domain. Walk each dense
      // row directly; retain the original y/z/x order and damage arithmetic.
      for (let y = lo.y; y <= hi.y; y++) {
        const sy=(y+.5)*cellSize;
        for(let z=lo.z;z<=hi.z;z++){
          const sz=(z+.5)*cellSize;let i=lo.x-g.min.x+(z-g.min.z)*g.width+(y-g.min.y)*g.layer;
          for(let x=lo.x;x<=hi.x;x++,i++){
            const c=entry.cells[g.data[i]-1];if(!c)continue;const sx=(x+.5)*cellSize;
            const energy=cellDamage(entry,c,sx-p.x,sy-p.y,sz-p.z);if(!energy)continue;
            const key=cellKey(c),damage=(proposed.get(key)||0)+energy;damaged++;
            if(damage+1e-8>=MATERIALS[c.mat].strength){proposed.delete(key);indices.push(i);removed.push({...c,rigidId:entry.id,cellSize,point:worldPoint(entry,{x:sx,y:sy,z:sz})});}
            else proposed.set(key,damage);
          }
        }
      }
      if (!removed.length) { entry.damage = proposed; result.damaged += damaged; continue; }
      const inPlace=this._editsInPlace(entry),localConnected=inPlace&&remainsConnectedAfterCut(entry,indices,this.fractureScratch);
      const groups=localConnected?null:connectedRemainder(entry,indices,this.fractureScratch);
      const velocity = vector(entry.body.linvel()), angularVelocity = vector(entry.body.angvel()), com = vector(entry.body.worldCom());
      const oldCenter = {...entry.center}, oldPosition = {...entry.position}, oldRotation = {...entry.rotation}, revision = entry.revision + 1;
      for (const chip of removed) {
        const dx = chip.point.x - com.x, dy = chip.point.y - com.y, dz = chip.point.z - com.z;
        chip.rotation = oldRotation;
        chip.velocity = {x: velocity.x + angularVelocity.y * dz - angularVelocity.z * dy, y: velocity.y + angularVelocity.z * dx - angularVelocity.x * dz, z: velocity.z + angularVelocity.x * dy - angularVelocity.y * dx};
      }
      if(inPlace&&(localConnected||groups.length===1)){
        try{this._editConnectedVoxels(entry,indices,removed,proposed);result.removed.push(...removed);result.damaged+=damaged;
          result.changes.push({oldId:entry.id,newIds:[entry.id],revision,oldCenter,oldPosition,oldRotation});}
        catch(error){this.rejected++;result.rejected.push({id:entry.id,reason:'runtime',message:error.message});}continue;
      }
      if(inPlace&&groups.length>1){const children=this._splitNativeVoxels(entry,groups,indices,removed,proposed);
        if(!children){result.rejected.push({id:entry.id,...this.lastAdmissionFailure});continue;}
        result.removed.push(...removed);result.damaged+=damaged;result.changes.push({oldId:entry.id,newIds:children.map(c=>c.id),revision,oldCenter,oldPosition,oldRotation});continue;}
      const plans=[];let temporaryBytes=0;
      this.lastAdmissionFailure=null;
      for(const cells of groups){const shape=this._cookShape(cells,this.estimatedMemoryBytes+temporaryBytes);if(!shape)break;plans.push({shape});temporaryBytes+=shape.estimatedBytes;}
      if (plans.length!==groups.length) { result.rejected.push({id:entry.id,...this.lastAdmissionFailure});continue; }
      const newEntries = [], previousNextId = this.nextId;
      try {
        for (let n = 0; n < plans.length; n++) {
          const shape = plans[n].shape, center = cellsCenter(shape.cells, cellSize), position = worldPoint(entry, center);
          while (this.entries.has(`rigid-${this.nextId}`)) this.nextId++;
          const id = n === 0 ? entry.id : `rigid-${this.nextId++}`;
          const damage = shape.cells.flatMap(c => proposed.has(cellKey(c)) ? [[c.x, c.y, c.z, proposed.get(cellKey(c))]] : []);
          const child = this._makeEntry(shape, {id, revision, position, rotation: oldRotation, angularVelocity, damage, density: entry.density, strength: entry.strength, cellSize, persistent: entry.persistent, contactFracture: entry.contactFracture,palette:entry.palette,assetIdentity:entry.assetIdentity,name:entry.name});
          newEntries.push(child);
          child.connectivityKnown=true;
          if(this.surfaceReuse)child.surfaceParent=entry;
          if(entry.assetIdentity)child.assetIdentity={...entry.assetIdentity,bodyId:id};
          const childCom = child.body.worldCom(), dx = childCom.x - com.x, dy = childCom.y - com.y, dz = childCom.z - com.z;
          child.body.setLinvel({x: velocity.x + angularVelocity.y * dz - angularVelocity.z * dy, y: velocity.y + angularVelocity.z * dx - angularVelocity.x * dz, z: velocity.z + angularVelocity.x * dy - angularVelocity.y * dx}, true);
        }
      } catch (error) {
        for (const child of newEntries) this.world.removeRigidBody(child.body);
        this.nextId = previousNextId;
        this.rejected++; result.rejected.push({id: entry.id, reason: 'runtime'}); continue;
      }
      this.remove(entry.id);
      for (const child of newEntries) this._registerEntry(child);
      result.removed.push(...removed); result.damaged += damaged;
      result.changes.push({oldId: entry.id, newIds: newEntries.map(c => c.id), revision, oldCenter, oldPosition, oldRotation});
    }
    if (result.changes.length) this.world.propagateModifiedBodyPositionsToColliders();
    this.fractureMs = performance.now() - started;
    return result;
  }
  impulse(id, impulse, point) {
    const entry = this.entries.get(id); if (!entry || this.disposed) return false;
    if (point) entry.body.applyImpulseAtPoint(vector(impulse), vector(point), true);
    else entry.body.applyImpulse(vector(impulse), true);
    return true;
  }
  blast(point, radius, power) {
    if (this.disposed || radius <= 0 || power <= 0) return 0;
    let affected = 0;
    for (const entry of this._candidates({x:point.x-radius,y:point.y-radius,z:point.z-radius},{x:point.x+radius,y:point.y+radius,z:point.z+radius})) {
      const p = entry.position, dx = p.x - point.x, dy = p.y - point.y, dz = p.z - point.z, distance = Math.hypot(dx, dy, dz);
      if (distance > radius + Math.hypot(entry.half.x, entry.half.y, entry.half.z)) continue;
      const strength = Math.max(0, 1 - Math.max(0, distance - Math.min(entry.half.x, entry.half.y, entry.half.z)) / radius) * power * entry.body.mass();
      if (!strength) continue;
      const n = distance || 1;
      entry.body.applyImpulse({x: dx / n * strength, y: (dy / n + .3) * strength, z: dz / n * strength}, true); affected++;
    }
    return affected;
  }
  snapshot(ids) {
    const bodies = [];
    const selected = ids == null ? null : ids instanceof Set ? ids : new Set(ids);
    for (const entry of this.entries.values()) {
      if (selected && !selected.has(entry.id)) continue;
      this._syncEntry(entry);
      bodies.push({id: entry.id, runs: encodeCells(entry.cells), center: {...entry.center}, position: {...entry.position}, rotation: {...entry.rotation}, velocity: vector(entry.body.linvel()), angularVelocity: vector(entry.body.angvel()), sleeping: entry.body.isSleeping(), revision: entry.revision,
        density: entry.density, strength: entry.strength, cellSize: entry.cellSize, persistent: entry.persistent, quality: entry.quality, contactFracture: entry.contactFracture,
        ...(entry.palette?{palette:entry.palette,paletteRuns:encodePaletteCells(entry.cells)}:{}),...(entry.assetIdentity?{assetIdentity:structuredClone(entry.assetIdentity),sourceShapeRuns:encodeCells(entry.cells,true)}:{}),...(entry.name?{name:entry.name}:{}),
        damage: entry.cells.flatMap(c => entry.damage.has(cellKey(c)) ? [[c.x, c.y, c.z, entry.damage.get(cellKey(c))]] : [])});
    }
    return {version: 1, bodies};
  }
  restore(snapshot) {
    if (snapshot != null && (snapshot.version !== 1 || !Array.isArray(snapshot.bodies))) throw new Error('Unsupported rigid-body save');
    this.reset(this.voxelWorld);
    const restored = [];
    for (const saved of snapshot?.bodies || []) {
      const cells=restorePaletteCells(decodeCells(saved,this.memoryBudgetBytes),saved.paletteRuns,saved.palette);
      if(saved.sourceShapeRuns&&cells){const sources=new Map();for(let i=0;i<saved.sourceShapeRuns.length;i+=5){const [x,y,z,n,id]=saved.sourceShapeRuns.slice(i,i+5);if(![x,y,z,n,id].every(Number.isSafeInteger)||n<1||n>cells.length||id<0||id>65535)throw Error('Invalid saved shape source');for(let dx=0;dx<n;dx++)sources.set(`${x+dx},${y},${z}`,id);}for(const c of cells){const id=sources.get(cellKey(c));if(id)c.sourceShape=id;}}
      const entry = this.add(cells, saved);
      if (entry) restored.push({entry, saved});
    }
    // Restored ids must not be re-used by subsequently detached pieces.
    while (this.entries.has(`rigid-${this.nextId}`)) this.nextId++;
    this.step(0);
    if (restored.length&&!this.referencePipeline) {
      // Register contacts before restoring sleep. New colliders otherwise wake
      // every saved resting body on the first visible frame after loading.
      this.world.timestep = 1e-6; this.world.step();
      for (const {entry, saved} of restored) {
        entry.body.setTranslation(vector(saved.position, entry.center), false);
        entry.body.setRotation(rotation(saved.rotation), false);
        entry.body.setLinvel(vector(saved.velocity), false);
        entry.body.setAngvel(vector(saved.angularVelocity), false);
      }
      // Applying the saved transforms marks colliders as modified. Consume
      // those flags before putting the restored contact islands back to sleep.
      this.world.step();
      for (const {entry, saved} of restored) {
        if (saved.sleeping) entry.body.sleep();
        else {
          // Active bodies retain exact saved velocity and pose; they should
          // naturally wake anything they contact on the next visible step.
          entry.body.setTranslation(vector(saved.position, entry.center), false);
          entry.body.setRotation(rotation(saved.rotation), false);
          entry.body.setLinvel(vector(saved.velocity), false);
          entry.body.setAngvel(vector(saved.angularVelocity), false);
          entry.body.wakeUp();
        }
        this._syncEntry(entry);
      }
      this.world.propagateModifiedBodyPositionsToColliders();
    }
    return this.entries.size;
  }
  get stats() {
    const awake=this.activeEntries.size,voxels=this.dynamicCells;
    return {bodies: this.entries.size, voxels, awake, sleeping: this.entries.size - awake, colliders: this.entries.size + this.terrain.size, dynamicColliders: this.entries.size, dynamicParts: this.dynamicParts, dynamicCells: this.dynamicCells, dynamicVolume: this.dynamicVolume, staticChunks: this.terrain.size, terrainChunks: this.terrain.size, terrainColliders: this.terrain.size, stepMs: this.stepMs, terrainMs: this.terrainMs || 0, solverMs: this.solverMs || 0, fractureMs: this.fractureMs || 0, rebuilds: this.rebuilds, rejected: this.rejected, lastAdmissionFailure:this.lastAdmissionFailure, estimatedMemoryBytes:this.estimatedMemoryBytes,memoryBudgetBytes:this.memoryBudgetBytes,fractureScratchBytes:(this.fractureScratch.seen?.byteLength||0)+(this.fractureScratch.queue?.byteLength||0)+(this.fractureScratch.marks?.byteLength||0)+(this.fractureScratch.localQueue?.byteLength||0),workset:{...this.worksetStats},contactFractures: this.contactFractures, incrementalCuts:this.incrementalCuts,incrementalRemoved:this.incrementalRemoved,contactMode:this.referencePipeline?'limitedConstraint':'postSolve',reference:this.referencePipeline?.stats};
  }
  dispose() {
    this.referencePipeline?.dispose();
    if (this.disposed) return;
    for (const token of this.preparationTokens) this.cancelPersistentPreparation(token);
    this.world.free(); this.eventQueue.free(); this.world = null; this.eventQueue = null; this.entries.clear(); this.terrain.clear(); this.fractureEvents.length = 0; this.contactEvents.length = 0; this.dynamicParts = 0; this.dynamicCells = 0; this.dynamicVolume = 0;this.activeEntries.clear();this.sleepingEntries.clear();this.bodyHandles.clear();this.colliderOwners.clear();this.spatial.clear();this.dirtyEntries.clear();this.terrainDirtyEntries.clear();this.terrainNeeds.clear();this.terrainStates.clear();this.poseChanges.clear();this.fractureScratch={};this.estimatedMemoryBytes=0;this.structureRevision++;this.disposed = true;
  }
}
