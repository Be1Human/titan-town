import * as T from '../vendor/three.module.js';
import {createSlimWorker} from './slim-worker.js';
import {normalizeAppearance} from './character-config.js';
import {gameCharacterScale} from './character-scale.js';
import {sourcePoint,worldPoint,gridCell} from './rigid-fracture.js';

// Read the actual approved body, rather than maintaining another set of limb
// proportions. The simulation cache stores numbers only, never a live mesh.
const dimensions=new Map();
export function gripDimensions(input){
  const key=JSON.stringify(input||{});if(dimensions.has(key))return dimensions.get(key);
  const a=normalizeAppearance(input),worker=createSlimWorker(a),value=bodyGripDimensions({...worker,appearance:a,worldScale:gameCharacterScale(a)});worker.dispose();
  if(dimensions.size>=16)dimensions.delete(dimensions.keys().next().value);dimensions.set(key,value);return value;
}
export function bodyGripDimensions(visual){
  const arm=visual.boxes.find(b=>b.name==='rightShoulder'),body=visual.boxes.find(b=>b.name==='spine'),a=visual.appearance||{};
  const reach=handRest(visual,'right');
  return {top:arm.center[1]+arm.size[1]/2,arm:Math.abs(reach.y)+.05,width:body.size[0],side:Math.abs(visual.rigPoints?.rightShoulder?.[0]??body.size[0]/2),handX:Math.abs(reach.x),handZ:reach.z,scaleX:(a.width||1)*(visual.worldScale??1),scaleY:(a.height||1)*(visual.worldScale??1)};
}
export function carryTarget(player,yaw,pitch,frame){
  const length=Math.hypot(frame.arm-.05,frame.handX,frame.handZ??.06),drop=length*.66,side=frame.side??frame.width/2;
  // Only a small pitch adjustment: looking straight up must not suspend cargo
  // over the head or turn a floor-level grab into telekinesis.
  const lift=Math.sin(pitch||0)*length*.18;
  const forward=Math.sqrt(Math.max(0,length*length-(drop-lift)*(drop-lift)-side*side));
  return {x:player.x-Math.sin(yaw)*forward*frame.scaleX,y:player.y+(frame.top-drop+lift)*frame.scaleY,z:player.z-Math.cos(yaw)*forward*frame.scaleX};
}
const point=new T.Vector3(),delta=new T.Vector3(),rest=new T.Vector3(),parentInverse=new T.Matrix4();
function handRest(visual,side){
  visual.group.updateWorldMatrix(true,true);
  const shoulder=visual.bones[side+'Shoulder'];
  return shoulder.worldToLocal(visual.attachments[side+'Hand'].getWorldPosition(new T.Vector3()));
}
export function solveHand(visual,side,target){
  const bone=visual.bones[side+'Shoulder'],hand=visual.attachments[side+'Hand'];
  visual.group.updateWorldMatrix(true,true);parentInverse.copy(bone.parent.matrixWorld).invert();
  rest.copy(handRest(visual,side));
  point.copy(target).applyMatrix4(parentInverse);delta.subVectors(point,bone.position);
  if(delta.lengthSq()<1e-10)return false;
  bone.quaternion.setFromUnitVectors(rest.clone().normalize(),delta.normalize());
  visual.group.updateWorldMatrix(true,true);visual.skeleton.update();return true;
}

// Exact two-hand rigid-arm solve: the gun's two grip markers lie on both arm
// reach spheres. Arms remain one unbroken cuboid with their original length.
export function fitTwoHandTool(visual,tool,offset,pitch=0){
  const left=visual.bones.leftShoulder,right=visual.bones.rightShoulder;
  const l=handRest(visual,'left').length(),r=handRest(visual,'right').length();
  // Lead with the support shoulder. Parallel shoulders plus rigid straight
  // arms forced the trigger hand across/inside the chest. A natural torso
  // turn provides the fore/aft difference between the two weapon grips.
  const width=visual.boxes.find(b=>b.name==='spine').size[0],turn=Math.asin(Math.min(.92,offset.z/width));
  visual.bones.spine.rotation.y=turn;visual.bones.head.rotation.y=-turn;
  tool.rotation.set(-Math.max(-1.45,Math.min(1.45,pitch)),0,0);
  visual.group.updateWorldMatrix(true,true);
  const gap=offset.clone().applyQuaternion(tool.quaternion),a=tool.parent.worldToLocal(right.getWorldPosition(new T.Vector3())),b=tool.parent.worldToLocal(left.getWorldPosition(new T.Vector3())).sub(gap),axis=b.clone().sub(a),distance=axis.length();
  axis.normalize();const along=(r*r-l*l+distance*distance)/(2*distance),centre=a.clone().addScaledVector(axis,along),radius=Math.sqrt(Math.max(0,r*r-along*along));
  const preference=new T.Vector3(right.position.x,right.position.y-r*.68,r*.58).sub(centre);preference.addScaledVector(axis,-preference.dot(axis)).normalize();
  tool.position.copy(centre).addScaledVector(preference,radius);
  visual.group.updateWorldMatrix(true,true);
  solveHand(visual,'right',tool.localToWorld(new T.Vector3()));solveHand(visual,'left',tool.localToWorld(offset.clone()));
}

// Cast against the held body's occupied voxel grid only. No full scene scan,
// and empty interiors or holes are respected after the object is fractured.
function surfacePoint(entry,origin,target){
  const start=sourcePoint(entry,origin),end=sourcePoint(entry,target),d={x:end.x-start.x,y:end.y-start.y,z:end.z-start.z},length=Math.hypot(d.x,d.y,d.z);if(!length)return null;
  for(const k of ['x','y','z'])d[k]/=length;
  const cell=entry.cellSize,p={},next={},step={},stride={};for(const k of ['x','y','z']){p[k]=Math.floor(start[k]/cell);step[k]=Math.sign(d[k]);stride[k]=d[k]?Math.abs(cell/d[k]):Infinity;next[k]=d[k]?((p[k]+(d[k]>0?1:0))*cell-start[k])/d[k]:Infinity;}
  let distance=0;for(let i=0;i<256&&distance<=length+.5;i++){
    if(gridCell(entry,p.x,p.y,p.z))return worldPoint(entry,{x:start.x+d.x*distance,y:start.y+d.y*distance,z:start.z+d.z*distance});
    const axis=next.x<=next.y&&next.x<=next.z?'x':next.y<=next.z?'y':'z';distance=next[axis];next[axis]+=stride[axis];p[axis]+=step[axis];
  }return null;
}
const carryContacts=new WeakMap();
export function carryHandContacts(visual){return (carryContacts.get(visual)?.contacts||[]).map(([side,point])=>({side,point:{...point}}));}
export function clearCarryHands(visual){carryContacts.delete(visual);}
export function fitCarryHands(visual,entry){
  if(!entry)return;
  visual.group.updateWorldMatrix(true,true);
  const previous=carryContacts.get(visual);
  if(previous?.entry===entry&&previous.revision===entry.revision){
    for(const [side,local]of previous.contacts){const p=worldPoint(entry,local);solveHand(visual,side,new T.Vector3(p.x,p.y,p.z));}return;
  }
  const centre=worldPoint(entry,entry.center);
  const right=new T.Vector3(1,0,0).transformDirection(visual.mesh.matrixWorld),q=new T.Quaternion(entry.rotation.x,entry.rotation.y,entry.rotation.z,entry.rotation.w).invert(),sourceRight=right.clone().applyQuaternion(q);
  const half=Object.fromEntries(['x','y','z'].map(axis=>[axis,(entry.grid.max[axis]-entry.grid.min[axis])*entry.cellSize/2]));
  const spread=Math.min(.18,(Math.abs(sourceRight.x)*half.x+Math.abs(sourceRight.y)*half.y+Math.abs(sourceRight.z)*half.z)*.65);
  const contacts=[];for(const side of ['left','right']){
    const shoulder=visual.bones[side+'Shoulder'].getWorldPosition(new T.Vector3());
    const target=new T.Vector3(centre.x,centre.y,centre.z).addScaledVector(right,(side==='left'?-1:1)*spread);
    const contact=surfacePoint(entry,shoulder,target)||surfacePoint(entry,shoulder,centre);if(contact){contacts.push([side,sourcePoint(entry,contact)]);solveHand(visual,side,new T.Vector3(contact.x,contact.y,contact.z));}
  }
  carryContacts.set(visual,{entry,revision:entry.revision,contacts});
}
