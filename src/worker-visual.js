import * as THREE from '../vendor/three.module.js';
import {normalizeAppearance} from './character-config.js';
import {createSculptedWorker} from './sculpted-worker.js';
import {createBlockWorker} from './block-worker.js';
import {createRoundedVoxelWorker} from './rounded-worker.js';
import {createCourierRig} from './courier-rig.js';

// The same visual is used by NPCs, remote players and the appearance editor.
// Gameplay owns this outer transform. The inner model owns cosmetic scale and
// bones, so animating it cannot overwrite a character's world/downed pose.
export function createWorkerVisual(input, options = {}) {
  const appearance = normalizeAppearance(input);
  const worldScale=Number.isFinite(options.worldScale)&&options.worldScale>0?options.worldScale:1;
  // Persist the selected silhouette, so all editor, NPC and remote renders
  // agree even while additional model variants are developed in this project.
  const variant = options.variant ?? (appearance.silhouette === 'human' ? 'block' : 'rounded-voxel');
  const worker = variant==='block'?createBlockWorker({appearance}):variant==='rounded-voxel'?createRoundedVoxelWorker({appearance}):createSculptedWorker({variant, appearance});
  const group = new THREE.Group(); group.name = 'construction-worker';
  worker.group.scale.set(appearance.width*worldScale, appearance.height*worldScale, appearance.width*worldScale);
  group.add(worker.group); group.updateMatrixWorld(true);
  const courier = appearance.template === 'crew-01' && variant === 'block' ? createCourierRig(worker, appearance) : null;
  if (options.courier !== true) courier?.setVisible(false);
  const scale = new THREE.Matrix4().makeScale(appearance.width*worldScale, appearance.height*worldScale, appearance.width*worldScale);
  const bounds = worker.mesh.geometry.boundingBox.clone().applyMatrix4(scale);
  if(worker.clothingMesh?.visible){bounds.union(worker.clothingMesh.geometry.boundingBox.clone().applyMatrix4(scale));bounds.translate(new THREE.Vector3(0,-Math.min(0,bounds.min.y),0));}
  const propBounds = appearance.prop === 'none' ? null : new THREE.Box3().setFromObject(worker.prop);
  const propLocalBounds = worker.prop.geometry.boundingBox.clone();
  const propScale = new THREE.Vector3(appearance.width*worldScale, appearance.height*worldScale, appearance.width*worldScale);
  let detached = false;
  function setPropVisible(visible) { if(worker.setPropsVisible)worker.setPropsVisible(visible);else worker.prop.visible = Boolean(visible) && appearance.prop !== 'none'; }
  function setPose({phase = 0, walk = 0, time = 0, carrying = false, down = false, action = 'idle', progress = 0} = {}) {
    worker.animate(phase / 3.7, down ? 0 : Math.max(0, Math.min(1, walk)));
    const authoredPose=worker.pose?.({phase,walk,time,carrying,down,action,progress})===true;
    if (!down && !authoredPose) {
      worker.bones.head.rotation.y = Math.sin(time * .65) * .025;
      if(worker.signaturePose&&(['signature','apose'].includes(action)||action==='idle'&&appearance.prop==='signature'&&!carrying)){worker.signaturePose(action==='idle'?'apose':action);}
      else if (action === 'tpose') {
        // Reference arms open into the exact authored T pose. In the downward
        // pose their shoulders sit outside the torso, avoiding coplanar faces.
        worker.bones.leftShoulder.position.x += worker.tposeShoulderOffset||0;
        worker.bones.rightShoulder.position.x -= worker.tposeShoulderOffset||0;
        worker.bones.leftShoulder.rotation.z = -Math.PI/2;
        worker.bones.rightShoulder.rotation.z = Math.PI/2;
      } else if (action === 'jump') {
        for (const side of ['left','right']) {
          worker.bones[`${side}Hip`].rotation.x = -.65;
          worker.bones[`${side}Knee`].rotation.x = 1.1;
          worker.bones[`${side}Shoulder`].rotation.z = side==='left'?-.85:.85;
          worker.bones[`${side}Elbow`].rotation.x = -.45;
        }
      } else if (action === 'hammer') {
        const swing=Math.sin(Math.max(0,Math.min(1,progress))*Math.PI);
        worker.bones.leftShoulder.rotation.x = -.5-swing*1.85;
        worker.bones.leftElbow.rotation.x = -.25-swing*.7;
        worker.bones.leftWrist.rotation.x = -.1+swing*.25;
        worker.bones.spine.rotation.x = .12-swing*.18;
        worker.bones.rightShoulder.rotation.x = -.5;
        worker.bones.rightElbow.rotation.x = -.65;
      } else if (carrying || action === 'carry') {
        for (const side of ['left', 'right']) {
          worker.bones[`${side}Shoulder`].rotation.x = -.95;
          worker.bones[`${side}Shoulder`].rotation.z = side==='left'?-.20:.20;
          worker.bones[`${side}Elbow`].rotation.x = -.55;
          worker.bones[`${side}Wrist`].rotation.x = .12;
        }
      } else if (appearance.prop !== 'none' && action !== 'edit') {
        worker.bones[`${worker.propSide||'left'}Shoulder`].rotation.x *= .20;
        worker.bones[`${worker.propSide||'left'}Elbow`].rotation.x = -.12;
      }
    }
    if (!detached) setPropVisible(!carrying && !['carry','tpose','edit','jump'].includes(action));
    group.updateMatrixWorld(true);if(!detached)worker.alignProps?.(action==='idle'&&appearance.prop==='signature'?'apose':action);group.updateMatrixWorld(true); worker.skeleton.update();
  }
  function detachProp(parent) {
    if (appearance.prop === 'none') return null;
    parent.attach(worker.prop); detached = true; setPropVisible(true);
    return worker.prop;
  }
  function attachProp() {
    (worker.propAttachment||worker.attachments.leftHand).add(worker.prop);
    worker.prop.position.set(0, 0, 0); worker.prop.quaternion.identity(); worker.prop.scale.set(1, 1, 1);
    worker.prop.matrixAutoUpdate = true; detached = false; setPropVisible(true);
  }
  function dispose() { courier?.dispose(); worker.dispose(); group.removeFromParent(); }
  setPose();
  return {group, mesh: worker.mesh, clothingMesh:worker.clothingMesh,clothing:worker.clothing,prop: worker.prop, bones: worker.bones, skeleton: worker.skeleton,
    appearance, worldScale, bounds, propBounds, propLocalBounds, propScale, height: bounds.max.y, courier,
    metrics: worker.metrics, attachments: worker.attachments, parts: worker.parts, rigPoints: worker.rigPoints, skinCell:worker.skinCell, skinAtlas:worker.skinAtlas, boxes:worker.boxes, extraProps:worker.extraProps||[], setPose, animate: worker.animate,
    setPropVisible, detachProp, attachProp, dispose};
}
