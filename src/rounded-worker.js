import * as THREE from '../vendor/three.module.js';
import {normalizeAppearance, CHARACTER_CELL} from './character-config.js';
import {buildCharacterParts, styleCharacterMaterial} from './character-model.js';
import {createRig} from './sculpted-worker.js';
import {createCharacterVoxels} from './character-voxels.js';

const geometryCache = new Map(), CACHE_LIMIT = 8;

// Original pear-shaped worker volumes, sampled on the project's 2.5 cm grid.
// Only exposed coplanar faces are merged. One rigidly skinned draw contains
// every articulated body segment; no per-voxel Mesh or per-bone draw is used.
export function createRoundedVoxelWorker(options = {}) {
  const a = normalizeAppearance(options.appearance || options), cell = CHARACTER_CELL;
  const source = buildCharacterParts({...a, width: 1, height: 1, voxelEdits: []});
  const snap = n => Math.round(n / cell) * cell;
  const bodyY = y => y <= .3 ? y * a.legLength : y <= 1.14 ? .3 * a.legLength + (y - .3) * a.torsoHeight : .3 * a.legLength + .84 * a.torsoHeight + (y - 1.14) * a.headHeight;
  const hands = {}, elbows = {}, shoulders = {}, wrists = {}, sourceWrists = {};
  for (const side of [-1, 1]) {
    const name = side < 0 ? 'left' : 'right', holding = ['ingot', 'clipboard'].includes(a.prop), hammer = a.prop === 'hammer' && side < 0, raised = a.prop === 'tape' && side > 0, hip = a.prop === 'hammer' && side > 0;
    const hand = [side * (holding ? .365 : hammer ? .615 : raised ? .585 : hip ? .510 : .505), holding ? .88 : hammer ? 1.105 : raised ? 1.15 : hip ? .845 : .795, holding ? .445 : hammer ? .215 : raised ? .28 : hip ? .19 : .12];
    const elbow = [side * (holding ? .475 : hammer ? .530 : raised ? .535 : hip ? .575 : .51), holding ? .965 : hammer ? 1.05 : raised ? 1.025 : hip ? .98 : .955, holding ? .18 : hammer ? .11 : raised ? .14 : .045];
    const wrist = [hand[0] - side * .030, hand[1] + (hammer ? -.018 : .055), hand[2] - .045];
    sourceWrists[name] = wrist;
    shoulders[name] = [side * .38 * a.torsoWidth * a.shoulderWidth, bodyY(1.105), -.01 * a.torsoDepth].map(snap);
    const map = p => p.map((v, i) => shoulders[name][i] + (v - [side * .38, 1.105, -.01][i]) * a.armLength);
    hands[name] = map(hand); elbows[name] = map(elbow).map(snap); wrists[name] = map(wrist).map(snap);
  }
  const rig = createRig({hip: snap(bodyY(.3)), spine: snap(bodyY(.88)), head: snap(bodyY(1.36)), shoulder: [.375, bodyY(1.105), 0], elbow: [.5, bodyY(.95), .05], wrist: [.55, bodyY(.8), .1],
    shoulders, elbows, wrists, legX: snap(.225 * a.legWidth), legTop: snap(.25 * a.legLength), knee: snap(.15 * a.legLength), ankle: snap(.05 * a.bootSize)});
  const cacheKey = JSON.stringify({...a, width: 1, height: 1}), cached = geometryCache.get(cacheKey);
  if (cached) { geometryCache.delete(cacheKey); geometryCache.set(cacheKey, cached); }
  const b = cached ? {parts: cached.parts} : createCharacterVoxels(rig), access = source.filter(part => part.limb === 'accessory');
  function transform(part) {
    const p = [...part.p], s = [...part.s];
    if (part.limb.endsWith('Arm')) {
      const name = part.limb.startsWith('left') ? 'left' : 'right', side = name === 'left' ? -1 : 1;
      const shoulder = [side * .38, 1.105, -.01];
      for (let i = 0; i < 3; i++) { p[i] = shoulders[name][i] + (p[i] - shoulder[i]) * a.armLength; s[i] *= a.armLength; }
      const nearHand = p.reduce((d, v, i) => d + (v - hands[name][i]) ** 2, 0) < (.22 * a.armLength) ** 2;
      if (nearHand) for (let i = 0; i < 3; i++) s[i] *= a.gloveSize;
      const distance = (point, target) => point.reduce((d, v, i) => d + (v - target[i]) ** 2, 0);
      const nameBone = nearHand ? `${name}Wrist` : distance(p, shoulders[name]) < distance(p, wrists[name]) ? `${name}Shoulder` : `${name}Elbow`;
      return {p, s, bone: nameBone};
    }
    if (part.limb.endsWith('Leg')) {
      const name = part.limb.startsWith('left') ? 'left' : 'right', boot = part.surface === 'rubber';
      p[0] *= a.legWidth; p[1] *= boot ? a.bootSize : a.legLength;
      s[0] *= boot ? a.bootSize : a.legWidth; s[1] *= boot ? a.bootSize : a.legLength; s[2] *= boot ? a.bootSize : 1;
      return {p, s, bone: `${name}${boot ? 'Foot' : part.p[1] > .21 ? 'Hip' : 'Knee'}`};
    }
    const head = p[1] > 1.14, hat = part.surface === 'plastic' && p[1] > 1.4;
    p[0] *= head ? a.headWidth : a.torsoWidth; s[0] *= head ? a.headWidth : a.torsoWidth;
    p[2] *= head ? Math.sqrt(a.headWidth) : a.torsoDepth; s[2] *= head ? Math.sqrt(a.headWidth) : a.torsoDepth;
    p[1] = bodyY(p[1]); s[1] *= head ? a.headHeight : a.torsoHeight;
    if (hat) { p[0] *= a.hatWidth; p[2] *= a.hatWidth; s[0] *= a.hatWidth; s[2] *= a.hatWidth; p[1] = bodyY(1.55) + (p[1] - bodyY(1.55)) * a.hatHeight; s[1] *= a.hatHeight; }
    if (part.surface === 'rubber' && part.p[1] > 1.2) { p[0] *= a.eyeSpacing; p[1] += (a.facePosition - 1) * .12; for (let i = 0; i < 3; i++) s[i] *= a.eyeSize; }
    return {p, s, bone: head ? 'head' : 'spine'};
  }
  if (!cached) for (const part of source) {
    if (part.limb === 'accessory') continue;
    const {p, s, bone} = transform(part);
    let paint = `#${part.color.toString(16).padStart(6, '0')}`;
    if (part.limb === 'body' && part.surface === 'fabric' && part.p[1] < .45) paint = a.outfitColor;
    if (part.limb === 'body' && part.surface === 'rubber' && part.p[1] > 1.35) paint = a.eyeColor;
    if (a.hair !== 'none' && part.limb === 'body' && part.surface === 'fabric' && part.p[1] > 1.45 && part.p[2] < -.16) paint = a.hairColor;
    b.box(p, s, paint, bone);
  }
  if (!cached) {
    // Preserve the saved trousers/belt colour even for the plain outfit. This
    // is an in-place colour band on the existing cells, never an overlay box.
    const torso = b.parts.find(part => part.name === 'spine');
    for (const key of torso.cells.keys()) {
      const y = torso.origin[1] + (Number(key.split(',')[1]) + .5) * cell;
      if (y < bodyY(.45)) torso.cells.set(key, a.outfitColor);
    }
    b.apply(a.voxelEdits);
  }
  const geometry = cached?.geometry || b.finish(), material = styleCharacterMaterial(new THREE.MeshStandardMaterial({vertexColors: true, roughness: .94, metalness: 0}));
  const resource = cached || {geometry, parts: b.parts, references: 0, retained: true};
  resource.references++;
  if (!cached) {
    geometryCache.set(cacheKey, resource);
    if (geometryCache.size > CACHE_LIMIT) { const key = geometryCache.keys().next().value, old = geometryCache.get(key); geometryCache.delete(key); old.retained = false; if (!old.references) old.geometry.dispose(); }
  }
  const mesh = new THREE.SkinnedMesh(geometry, material), group = new THREE.Group();
  mesh.name = group.name = 'rounded-voxel-worker'; mesh.add(rig.bones.root); group.add(mesh);
  mesh.castShadow = true; mesh.frustumCulled = false;
  group.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(rig.list); mesh.bind(skeleton);
  const attachments = {};
  for (const name of ['left', 'right']) { const hand = new THREE.Group(); hand.name = `${name}-hand-attachment`; rig.bones[`${name}Wrist`].add(hand); attachments[`${name}Hand`] = hand; }
  const propRig = {list: rig.list, points: Object.fromEntries(Object.keys(rig.points).map(name => [name, [0, 0, 0]]))}, pb = createCharacterVoxels(propRig);
  // Keep the approved held-object placement in the bind pose; the same mesh
  // is subsequently detached/re-attached by the shared appearance wrapper.
  const propSide = a.prop === 'tape' ? 'right' : 'left', propAttachment = attachments[`${propSide}Hand`];
  for (const part of access) {
    const p = part.p.map((v, i) => v - sourceWrists[propSide][i]);
    pb.box(p, part.s, `#${part.color.toString(16).padStart(6, '0')}`);
  }
  if (!access.length) pb.box([0, 0, 0], [cell, cell, cell], a.bodyColor);
  const prop = new THREE.Mesh(pb.finish(), material); prop.name = 'rounded-worker-prop'; prop.castShadow = true; propAttachment.add(prop); prop.visible = a.prop !== 'none';
  const rest = rig.list.map(bone => bone.position.clone());
  function animate(time = 0, amount = 0) {
    const k = Number.isFinite(amount) ? THREE.MathUtils.clamp(amount, 0, 1) : 0, t = Number.isFinite(time) ? time : 0;
    for (let i = 0; i < rig.list.length; i++) { rig.list[i].rotation.set(0, 0, 0); rig.list[i].position.copy(rest[i]); }
    rig.bones.root.position.y += Math.abs(Math.sin(t * 3.7)) * k * .018;
    rig.bones.spine.rotation.z = Math.sin(t * 3.7) * k * .035;
    for (const side of [-1, 1]) { const name = side < 0 ? 'left' : 'right', swing = Math.sin(t * 3.7) * side * k;
      rig.bones[`${name}Hip`].rotation.x = swing * .38; rig.bones[`${name}Knee`].rotation.x = Math.max(0, -swing) * .7;
      rig.bones[`${name}Foot`].rotation.x = -Math.max(0, -swing) * .18; rig.bones[`${name}Shoulder`].rotation.x = -swing * .25; rig.bones[`${name}Elbow`].rotation.x = -Math.abs(swing) * .25;
    }
    group.updateMatrixWorld(true); skeleton.update();
  }
  animate();
  const metrics = Object.freeze({variant: 'rounded-voxel', cellSize: cell, cells: b.parts.reduce((n, p) => n + p.cells.size, 0), vertices: geometry.attributes.position.count, triangles: geometry.index.count / 3,
    propTriangles: prop.geometry.index.count / 3, drawCalls: prop.visible ? 2 : 1, bones: rig.list.length, skinned: true, height: geometry.boundingBox.max.y, footY: geometry.boundingBox.min.y, forward: '+Z'});
  let disposed = false;
  return {group, mesh, bones: rig.bones, skeleton, attachments, prop, propSide, propAttachment, animate, metrics, parts: b.parts, rigPoints: rig.points,
    dispose() { if (disposed) return; disposed = true; resource.references--; if (!resource.references && !resource.retained) geometry.dispose(); prop.geometry.dispose(); material.dispose(); skeleton.dispose(); prop.removeFromParent(); group.removeFromParent(); }};
}
