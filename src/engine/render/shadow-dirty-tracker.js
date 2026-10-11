import {Material, Object3D} from '../../../vendor/three.module.js';

const UNSET = Symbol('uninitialized-shadow-scene');
const defaultCompile = Material.prototype.onBeforeCompile, defaultShadow = Object3D.prototype.onBeforeShadow;
const changed = (a, b) => !a || a.length !== b.length || b.some((value, i) => !Object.is(value, a[i]));
const matrix = m => m?.elements ? Array.from(m.elements) : [];
function attribute(out, a) {
  out.push(a || null);
  if (a) out.push(a.version, a.data?.version, a.array || a.data?.array || a.buffer, a.count, a.itemSize, a.normalized, a.offset, a.data?.stride);
}
function texture(out, t) {
  out.push(t || null);
  if (!t) return;
  out.push(t.version, t.source, t.source?.version, t.channel, t.mapping, t.wrapS, t.wrapT, t.minFilter, t.magFilter, t.flipY, t.matrixAutoUpdate);
  // UV transforms are uniforms; their setters need not bump Texture.version.
  out.push(t.offset?.x, t.offset?.y, t.repeat?.x, t.repeat?.y, t.center?.x, t.center?.y, t.rotation, ...matrix(t.matrix));
}
function activeMaterials(object) {
  if (!Array.isArray(object.material)) return object.material?.visible === false || !object.material ? [] : [object.material];
  const result = [], seen = new Set();
  for (const group of object.geometry?.groups || []) {
    const m = object.material[group.materialIndex];
    if (m && m.visible !== false && !seen.has(m)) { seen.add(m); result.push(m); }
  }
  return result;
}
function customShader(m) { return m && (m.isShaderMaterial || m.isRawShaderMaterial || m.onBeforeCompile !== defaultCompile); }
function materialState(out, m, diagnostics, depthOverride = false, customDepthUsage = false) {
  out.push(m, depthOverride ? m.version : undefined, m.visible, m.opacity, m.transparent, m.alphaTest, m.alphaToCoverage, m.alphaHash, m.side, m.shadowSide, m.wireframe, m.wireframeLinewidth, m.linewidth,
    m.depthTest, m.depthWrite, m.depthFunc, m.polygonOffset, m.polygonOffsetFactor, m.polygonOffsetUnits, m.clipShadows, m.clipIntersection, m.displacementScale, m.displacementBias,
    m.userData?.shadowRevision, depthOverride ? m.onBeforeCompile : undefined);
  if (m.alphaTest > 0 || m.alphaToCoverage || m.alphaHash || customDepthUsage || depthOverride && customShader(m)) { texture(out, m.map); texture(out, m.alphaMap); }
  texture(out, m.displacementMap);
  if (m.clipShadows) for (const p of m.clippingPlanes || []) out.push(p.normal.x, p.normal.y, p.normal.z, p.constant);
  if (depthOverride && customShader(m)) diagnostics.add('Custom depth/shader inputs must advance revision or userData.shadowRevision; hidden unversioned uniforms are not observable.');
  if (!depthOverride && (m.isShaderMaterial || m.isRawShaderMaterial)) diagnostics.add('Three does not inherit source shader deformation into stock shadows; use a matching custom depth/distance material and explicit versions.');
}
function casterState(object, materials, diagnostics, includeReceivers) {
  const geometry = object.geometry, depth = object.customDepthMaterial, distance = object.customDistanceMaterial;
  // Source onBeforeCompile hooks are not inherited by WebGLShadowMap's stock
  // depth material. Visual-only colour/normal hooks must not invalidate depth.
  const custom = customShader(depth) || customShader(distance);
  const shape = [geometry, geometry?.drawRange?.start, geometry?.drawRange?.count, geometry?.morphTargetsRelative];
  attribute(shape, geometry?.attributes?.position); attribute(shape, geometry?.index);
  for (const g of geometry?.groups || []) shape.push(g.start, g.count, g.materialIndex);
  const usesUV = materials.some(m => m.alphaTest > 0 || m.alphaToCoverage || m.alphaHash || m.displacementMap);
  if (usesUV) for (const name of ['uv', 'uv1', 'uv2', 'uv3']) attribute(shape, geometry?.attributes?.[name]);
  const displaced = materials.some(m => m.displacementMap && m.displacementScale !== 0);
  if (displaced) attribute(shape, geometry?.attributes?.normal);
  // Custom vertex/depth programs may use extra attributes such as cut-mask
  // indices. Their public buffer versions are observable, unlike hidden uniforms.
  if (custom) for (const name of Object.keys(geometry?.attributes || {}).sort()) { shape.push(name); attribute(shape, geometry.attributes[name]); }
  const deformation = [object.count, object.skeleton, object.bindMode, ...matrix(object.bindMatrix), ...matrix(object.bindMatrixInverse)];
  if (object.isInstancedMesh) {
    attribute(deformation, object.instanceMatrix); texture(deformation, object.morphTexture);
    // Stock Three instanceColor is RGB and does not alter depth. A custom
    // program can opt in with shadowRevision rather than invalidating RGB edits.
  }
  if (object.skeleton) {
    attribute(shape, geometry?.attributes?.skinIndex); attribute(shape, geometry?.attributes?.skinWeight);
    const skeleton = object.skeleton;
    for (let i = 0; i < skeleton.bones.length; i++) deformation.push(skeleton.bones[i], ...matrix(skeleton.bones[i]?.matrixWorld), ...matrix(skeleton.boneInverses[i]));
    // Do not use boneTexture.version: Skeleton.update bumps it during rendering
    // even at rest. Bone world matrices catch animation before that upload.
  }
  for (const a of geometry?.morphAttributes?.position || []) attribute(shape, a);
  if (displaced) for (const a of geometry?.morphAttributes?.normal || []) attribute(shape, a);
  if (usesUV) for (const a of geometry?.morphAttributes?.uv || []) attribute(shape, a);
  if (custom) for (const name of Object.keys(geometry?.morphAttributes || {}).sort()) {
    shape.push(name); for (const a of geometry.morphAttributes[name]) attribute(shape, a);
  }
  deformation.push(...(object.morphTargetInfluences || []));
  const appearance = [depth || null, distance || null];
  for (const m of materials) materialState(appearance, m, diagnostics, false, custom);
  for (const m of [depth, distance]) if (m) materialState(appearance, m, diagnostics, true);
  if (object.onBeforeShadow !== defaultShadow) diagnostics.add('onBeforeShadow changes to hidden depth inputs require revision or userData.shadowRevision.');
  if (object.isBatchedMesh) diagnostics.add('BatchedMesh per-instance internal data requires explicit shadowRevision or shadowAlwaysUpdate.');
  return {kind: 'caster', transform: matrix(object.matrixWorld), shape, deformation, appearance,
    state: [object.castShadow, includeReceivers ? object.receiveShadow : undefined, object.layers?.mask, object.frustumCulled, object.onBeforeShadow, object.userData?.shadowRevision]};
}
function lightState(light, vsm) {
  const shadow = light.shadow, camera = shadow?.camera;
  // A light's default target often is not a scene child. Three itself updates
  // that target on getWorldPosition; derive it here before comparing the pose.
  light.target?.updateWorldMatrix?.(true, false);
  const projection = [shadow, camera, light.angle, light.distance, shadow?.focus, shadow?.mapSize?.x, shadow?.mapSize?.y];
  if (vsm) projection.push(shadow?.radius, shadow?.blurSamples);
  if (camera) {
    for (const key of ['near', 'far', 'left', 'right', 'top', 'bottom', 'fov', 'aspect', 'zoom', 'filmGauge', 'filmOffset']) projection.push(camera[key]);
    const view = camera.view; projection.push(view?.enabled, view?.fullWidth, view?.fullHeight, view?.offsetX, view?.offsetY, view?.width, view?.height, ...matrix(camera.projectionMatrix));
  }
  // Derived camera pose, output map textures, needsUpdate, light RGB/intensity
  // and sampling-only shadow bias/radius are not depth-map input changes.
  return {kind: 'light', transform: [...matrix(light.matrixWorld), light.target || null, ...matrix(light.target?.matrixWorld)], projection,
    state: [light.castShadow, light.layers?.mask, light.userData?.shadowRevision]};
}

/** Exact value comparison of public Three shadow inputs, with no time throttle.
 * Call scene.updateMatrixWorld(true) first, after actor/bone motion and geometry
 * edits. Buffer/texture edits must use Three needsUpdate/version contracts.
 * Hidden custom depth uniforms and onBeforeShadow state must increment the
 * caller revision or object/material.userData.shadowRevision, or call invalidate.
 * userData.shadowAlwaysUpdate is an explicit conservative per-frame fallback.
 * Main camera poses and RGB-only edits do not invalidate PCF depth. Camera layer
 * selection or renderer shadow-map type changes must invalidate explicitly
 * because this API has no main camera or renderer.
 * VSM users must set includeReceivers:true. Installed Three does not render
 * Sprite shadows; custom sprite shadow implementations need explicit invalidation.
 * This tracks observable inputs, not arbitrary GPU/shader equivalence.
 */
/** layered:true additionally classifies casters for a cached static map plus
 * a per-frame dynamic overlay (see layered-shadow-cache.js). A caster becomes
 * dynamic the frame its inputs change, and returns to the static layer only
 * during a static redraw after `settleFrames` unchanged frames, or on its own
 * after `demoteFrames`. Newly added casters start dynamic, so their arrival
 * does not discard the static layer. lastPlan is valid when needsUpdate is true.
 */
export class ShadowDirtyTracker {
  constructor({includeReceivers = false, layered = false, settleFrames = 8, demoteFrames = 120} = {}) {
    Object.assign(this, {includeReceivers, layered, settleFrames, demoteFrames}); this.reset();
  }
  reset() { this.previous = new Map(); this.motion = new Map(); this.revision = UNSET; this.pending = null; this.lastReasons = []; this.diagnostics = []; this.lastPlan = null; return this; }
  invalidate(reason = 'explicit') { this.pending = reason || 'explicit'; return this; }
  needsUpdate(scene, revision) {
    const next = new Map(), reasons = [], diagnostics = new Set(), changedObjects = new Set();
    let global = false;
    const reason = (type, object) => { if (reasons.length < 32) reasons.push({type, objectId: object?.id ?? null}); };
    if (this.revision === UNSET) { reason('initial'); global = true; } else if (!Object.is(this.revision, revision)) { reason('revision'); global = true; }
    if (this.pending) { reason(this.pending); global = true; }
    scene?.traverseVisible(object => {
      if (object.isLight && object.castShadow && object.shadow) next.set(object, lightState(object, this.includeReceivers));
      if (!(object.castShadow || this.includeReceivers && object.receiveShadow)) return;
      if (object.isSprite) { diagnostics.add('Installed Three WebGLShadowMap does not render Sprite shadows.'); return; }
      if (!(object.isMesh || object.isPoints || object.isLine)) return;
      if (object.isInstancedMesh && object.count <= 0 || object.geometry?.drawRange?.count === 0) return;
      const materials = activeMaterials(object); if (!materials.length) return;
      next.set(object, casterState(object, materials, diagnostics, this.includeReceivers));
      if (object.userData?.shadowAlwaysUpdate || materials.some(m => m.userData?.shadowAlwaysUpdate) || object.customDepthMaterial?.userData?.shadowAlwaysUpdate || object.customDistanceMaterial?.userData?.shadowAlwaysUpdate) { reason('explicit-per-frame', object); changedObjects.add(object); }
    });
    const removed = [];
    for (const [object, snapshot] of next) {
      const old = this.previous.get(object);
      if (!old || old.kind !== snapshot.kind) { reason(`${snapshot.kind}-added`, object); if (snapshot.kind === 'light') global = true; else changedObjects.add(object); continue; }
      for (const field of Object.keys(snapshot)) if (field !== 'kind' && changed(old[field], snapshot[field])) {
        reason(`${snapshot.kind}-${field}`, object);
        if (snapshot.kind === 'light') global = true; else changedObjects.add(object);
      }
    }
    for (const [object, old] of this.previous) if (!next.has(object)) { reason(`${old.kind}-removed`, object); if (old.kind === 'light') global = true; else removed.push(object); }
    const hadPrevious = this.previous;
    this.previous = next; this.revision = revision; this.pending = null; this.lastReasons = reasons; this.diagnostics = [...diagnostics];
    this.lastPlan = this.layered ? this.plan(next, hadPrevious, changedObjects, removed, global) : null;
    if (this.lastPlan?.static && !reasons.length) reason('layer-settled');
    return reasons.length > 0;
  }
  plan(next, previous, changedObjects, removed, global) {
    let staticDirty = global, dynamicDirty = false;
    for (const object of removed) {
      if (this.motion.get(object)?.dynamic) dynamicDirty = true; else staticDirty = true;
      this.motion.delete(object);
    }
    for (const [object, snapshot] of next) {
      if (snapshot.kind !== 'caster') continue;
      let m = this.motion.get(object);
      if (!m) this.motion.set(object, m = {dynamic: false, still: 0});
      if (!previous.has(object)) {
        // Joins the static layer at once if that layer is being redrawn anyway.
        m.dynamic = true; m.still = this.settleFrames; dynamicDirty = true;
      } else if (changedObjects.has(object)) {
        // A previously static caster is baked into the cached map.
        if (!m.dynamic) staticDirty = true;
        m.dynamic = true; m.still = 0; dynamicDirty = true;
      } else if (m.dynamic && ++m.still >= this.demoteFrames) staticDirty = true;
    }
    const dynamic = [];
    for (const [object, snapshot] of next) {
      if (snapshot.kind !== 'caster') continue;
      const m = this.motion.get(object);
      if (m.dynamic && staticDirty && m.still >= this.settleFrames) m.dynamic = false;
      if (m.dynamic) dynamic.push(object);
    }
    return {static: staticDirty, dynamicChanged: dynamicDirty, dynamic};
  }
}
export const createShadowDirtyTracker = options => new ShadowDirtyTracker(options);
