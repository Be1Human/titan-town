import * as THREE from '../vendor/three.module.js';
import {voxelizeTool} from './voxel-tool.js';
import {normalizeAppearance} from './character-config.js';
import {createFirstPersonSkin} from './first-person-skin.js';

const axisY=new THREE.Vector3(0,1,0),axisZ=new THREE.Vector3(0,0,1);
function box(parent,size,position,material){
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(...size),material);mesh.position.fromArray(position);parent.add(mesh);return mesh;
}
function palm(parent,position,material,{length=.048,radius=.032,scale=[1.13,1,.62]}={}){
  const mesh=new THREE.Mesh(new THREE.CapsuleGeometry(radius,length,4,12),material);
  mesh.position.fromArray(position);mesh.scale.fromArray(scale);parent.add(mesh);return mesh;
}
function link(parent,a,b,radius,material,endRadius=radius){
  const start=new THREE.Vector3(...a),end=new THREE.Vector3(...b),delta=end.clone().sub(start);
  const mesh=new THREE.Mesh(new THREE.CylinderGeometry(endRadius,radius,delta.length(),12),material);
  mesh.position.copy(start).add(end).multiplyScalar(.5);mesh.quaternion.setFromUnitVectors(axisY,delta.normalize());parent.add(mesh);
}
function finger(parent,points,material,radius=.010){
  for(let i=1;i<points.length;i++)link(parent,points[i-1],points[i],radius,material,radius*.94);
}
export function handMaterials(){
  const glove=new THREE.MeshStandardMaterial({color:0x7b7057,roughness:.96});
  const pad=new THREE.MeshStandardMaterial({color:0x575c53,roughness:1});
  const sleeve=new THREE.MeshStandardMaterial({color:0x526675,roughness:1});
  const cuff=new THREE.MeshStandardMaterial({color:0x353e43,roughness:1});
  // Leather and fabric use voxel colour variation, without wood grain.
  for(const [name,material] of Object.entries({glove,pad,sleeve,cuff})){
    material.userData.voxelWood=false;material.userData.characterPart=name;
  }
  return {glove,pad,sleeve,cuff};
}

// A cylindrical grip: four fingers wrap around the front of the handle, with
// the thumb crossing from the opposite side. The wrist grows out of the palm.
function closedGrip(parent,center,materials,{size=1,tilt=0,trigger=false}={}){
  const hand=new THREE.Group();hand.position.fromArray(center);hand.rotation.x=tilt;hand.scale.setScalar(size);parent.add(hand);
  const {glove,pad}=materials;
  palm(hand,[.022,-.014,.049],glove);
  box(hand,[.048,.008,.007],[.025,.016,.069],pad);
  link(hand,[.028,-.046,.054],[.040,-.097,.067],.027,glove,.035);
  for(let i=0;i<4;i++){
    const y=.028-i*.024;
    const points=trigger&&i===0?[[.054,y,.036],[.063,y,.006],[.045,y,-.041],[.019,y,-.077]]:[[.054,y,.036],[.063,y,.006],[.042,y,-.030],[.007,y,-.040],[-.024,y,-.023]];
    finger(hand,points,glove,i===3?.009:.011);
    box(hand,[.016,.016,.013],[.061,y,.013],pad);
  }
  finger(hand,[[-.010,.042,.054],[-.039,.016,.034],[-.040,-.010,.005],[-.017,-.024,-.022]],glove,.013);
  hand.updateMatrix();
  return new THREE.Vector3(.040,-.094,.067).applyMatrix4(hand.matrix);
}

function supportGrip(parent,materials){
  const {glove}=materials;
  // Left palm cups the underside of the pump; its fingers curl over the left
  // edge. Its wrist is behind the palm, toward the stock, rather than the muzzle.
  const support=palm(parent,[-.020,-.112,-.295],glove,{length:.044,radius:.032,scale:[1.25,1,.57]});support.rotation.x=Math.PI/2;
  for(let i=0;i<4;i++){
    const z=-.337+i*.027;
    finger(parent,[[-.052,-.106,z],[-.073,-.075,z],[-.071,-.028,z],[-.048,.015,z],[-.018,.025,z]],glove,.011);
  }
  finger(parent,[[.013,-.109,-.248],[.044,-.089,-.258],[.063,-.050,-.274],[.045,-.019,-.286]],glove,.014);
  link(parent,[-.028,-.112,-.254],[-.046,-.134,-.210],.032,glove,.035);
  return new THREE.Vector3(-.046,-.134,-.210);
}

function chargeGrip(parent,materials){
  const right=new THREE.Group(),left=new THREE.Group();parent.add(right,left);
  const {glove,pad}=materials;
  palm(right,[.116,-.024,.017],glove,{scale:[.64,1,1]});
  box(right,[.008,.008,.043],[.137,.012,.015],pad);
  for(let i=0;i<4;i++){
    const y=.016-i*.025;
    finger(right,[[.130,y,.040],[.123,y,.080],[.097,y,.092],[.064,y,.090]],glove,.011);
  }
  finger(right,[[.105,.042,.014],[.088,.062,-.021],[.060,.042,-.026]],glove,.014);
  link(right,[.112,-.060,.018],[.113,-.113,.036],.030,glove,.035);
  const lower=palm(left,[-.040,-.151,.025],glove,{length:.030,radius:.032,scale:[1.45,1,.56]});lower.rotation.x=Math.PI/2;
  for(let i=0;i<4;i++){
    const x=-.076+i*.023;
    finger(left,[[x,-.149,.045],[x,-.134,.078],[x,-.104,.085]],glove,.010);
  }
  finger(left,[[-.084,-.142,.010],[-.112,-.110,.020],[-.110,-.076,.048]],glove,.013);
  link(left,[-.041,-.153,.025],[-.070,-.173,.045],.030,glove,.035);
  return [{wrist:new THREE.Vector3(.113,-.113,.036),source:right},{wrist:new THREE.Vector3(-.070,-.173,.045),source:left}];
}

export function addToolHands(model,kind,materials){
  const right=new THREE.Vector3(.57,-.77,-.24),left=new THREE.Vector3(-.45,-.70,-.37);
  function hand(build,elbow,anchor){const source=new THREE.Group();model.add(source);return {wrist:build(source),elbow,source,anchor:new THREE.Vector3(...anchor)};}
  if(kind===0)return [hand(parent=>closedGrip(parent,[0,-.045,0],materials,{size:1/.76}),right,[0,-.045,0])];
  if(kind===1||kind===3)return [
    hand(parent=>closedGrip(parent,[0,-.166,.13],materials,{tilt:-.32,trigger:true}),right,[0,-.166,.13]),
    hand(parent=>supportGrip(parent,materials),left,[-.020,-.112,-.295]),
  ];
  if(kind===4)return [hand(parent=>closedGrip(parent,[0,-.068,0],materials),right,[0,-.068,0])];
  return chargeGrip(model,materials).map((socket,i)=>({...socket,elbow:i?left:right,anchor:new THREE.Vector3(...(i?[-.040,-.151,.025]:[.116,-.024,.017]))}));
}

// Voxelize each hand separately from its tool. Each palm stays on its grip;
// the wrist follows glove size and the sleeve continues to meet that wrist.
export function detachToolHands(model,sockets){
  for(const socket of sockets){
    model.remove(socket.source);
    const hand=voxelizeTool(socket.source),pivot=new THREE.Group();pivot.name='customizable glove';
    pivot.position.copy(socket.anchor);hand.position.sub(socket.anchor);pivot.add(hand);model.add(pivot);
    socket.hand=pivot;
    socket.source.traverse(node=>{if(node.isMesh)node.geometry.dispose();});delete socket.source;
  }
}

export function makeArmTemplate(materials){
  const arm=new THREE.Group();
  link(arm,[0,0,-.025],[0,0,.036],.035,materials.glove,.041);
  link(arm,[0,0,.024],[0,0,.060],.044,materials.cuff,.047);
  link(arm,[0,0,.051],[0,0,.400],.047,materials.sleeve,.072);
  return voxelizeTool(arm);
}

export function attachArmRig(group,models,sockets,materials){
  const template=makeArmTemplate(materials),rigs=[];
  models.forEach((model,index)=>{
    for(const [side,socket]of sockets[index].entries()){
      const arm=template.clone(true);arm.name=side===0?'right forearm':'left forearm';
      const skinArm=new THREE.Mesh(arm.children[0].geometry,arm.children[0].material);skinArm.name=side===0?'right skin arm':'left skin arm';skinArm.visible=false;arm.add(skinArm);
      const skinSleeve=new THREE.Mesh(skinArm.geometry,skinArm.material);skinSleeve.name='outer skin sleeve';skinSleeve.visible=false;arm.add(skinSleeve);
      model.add(arm);rigs.push({model,arm,skinArm,skinSleeve,legacyArm:arm.children.filter(c=>c!==skinArm&&c!==skinSleeve),side:side===0?'right':'left',...socket,baseElbow:socket.elbow.clone(),baseWrist:socket.wrist.clone()});
    }
  });
  const relative=new THREE.Matrix4(),inverse=new THREE.Matrix4(),end=new THREE.Vector3(),direction=new THREE.Vector3();
  let thickness=1,skin=null,skinKey=null;
  function setAppearance(input){
    const a=normalizeAppearance(input),length=a.armLength*a.height;
    const key=a.template==='crew-01'&&a.silhouette==='human'?JSON.stringify(a):null;
    if(key!==skinKey){
      const next=key?createFirstPersonSkin(a):null;
      for(const rig of rigs){
        rig.skinSleeve.visible=!!next&&next.outerParts[rig.side].index.count>0;rig.skinArm.visible=!!next;rig.hand.visible=!next;rig.legacyArm.forEach(mesh=>mesh.visible=!next);
        if(next){rig.skinArm.geometry=next.parts[rig.side];rig.skinArm.material=next.material;rig.skinSleeve.geometry=next.outerParts[rig.side];rig.skinSleeve.material=next.outerMaterial;}
        else {rig.skinArm.geometry=rig.legacyArm[0].geometry;rig.skinArm.material=rig.legacyArm[0].material;rig.skinSleeve.geometry=rig.skinArm.geometry;rig.skinSleeve.material=rig.skinArm.material;}
      }
      skin?.dispose();skin=next;skinKey=key;
    }
    thickness=a.armSize*a.width;
    const shoulder=THREE.MathUtils.clamp(Math.sqrt(a.torsoWidth*a.shoulderWidth)*a.width,.7,1.6);
    for(const rig of rigs){
      rig.hand.scale.setScalar(a.gloveSize*a.width);
      if(skin)rig.wrist.copy(rig.anchor);
      else rig.wrist.copy(rig.baseWrist).sub(rig.anchor).multiplyScalar(a.gloveSize*a.width).add(rig.anchor);
      rig.elbow.copy(rig.baseElbow);rig.elbow.x*=shoulder;
      rig.elbow.y-=.15*(length-1);rig.elbow.z+=.24*(length-1);
    }
    update();return a;
  }
  function update(){
    group.updateMatrix();
    for(const rig of rigs){
      if(!rig.model.visible)continue;
      rig.model.updateMatrix();relative.multiplyMatrices(group.matrix,rig.model.matrix);inverse.copy(relative).invert();
      end.copy(rig.elbow).applyMatrix4(inverse);direction.copy(end).sub(rig.wrist);
      rig.arm.scale.x=thickness/rig.model.scale.x;rig.arm.scale.y=thickness/rig.model.scale.y;
      rig.arm.position.copy(rig.wrist);rig.arm.scale.z=direction.length()/.400;
      rig.arm.quaternion.setFromUnitVectors(axisZ,direction.normalize());
    }
  }
  update();return {update,rigs,setAppearance,dispose(){skin?.dispose();skin=null;}};
}
