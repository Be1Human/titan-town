import * as THREE from '../vendor/three.module.js';
import {loadJSONResource} from './json-resource.js';

// Skinned titan built from the CC0 Quaternius mannequin rig
// (assets/characters/titan-rig/titan-rig.json, see scripts/import-titan-rig.mjs).
// Proportions, face, hair and the kick/climb/look overlays are original.
export const TITAN_RIG_URL=new URL('../assets/characters/titan-rig/titan-rig.json',import.meta.url);
export function loadTitanRig(url=TITAN_RIG_URL){return loadJSONResource(url);}

export const TITAN_VARIANTS=[
  {name:'standard',height:9.5,skin:0xd9a283,hair:0xc9a24a,hairStyle:'messy',scales:{'DEF-head':1.3,'DEF-spine_003':1.08}},
  {name:'bighead',height:7.6,skin:0xd88f78,hair:0x3a2a20,hairStyle:'bald',scales:{'DEF-head':1.55,'DEF-spine_001':1.22,'DEF-hips':1.1}},
  {name:'lanky',height:10.4,skin:0xe8c8b2,hair:0x1c1a19,hairStyle:'long',scales:{'DEF-head':1.22,'DEF-upper_arm_L':1.12,'DEF-upper_arm_R':1.12,'DEF-forearm_L':1.1,'DEF-forearm_R':1.1,'DEF-thigh_L':1.06,'DEF-thigh_R':1.06}},
  {name:'brute',height:8.6,skin:0xbf8960,hair:0x5a3a22,hairStyle:'short',scales:{'DEF-spine_003':1.26,'DEF-head':.98,'DEF-upper_arm_L':1.08,'DEF-upper_arm_R':1.08,'DEF-thigh_L':1.16,'DEF-thigh_R':1.16,'DEF-shin_L':1.08,'DEF-shin_R':1.08}},
  {name:'longarm',height:9,skin:0xb99a72,hair:0x8e3b22,hairStyle:'ponytail',scales:{'DEF-head':1.28,'DEF-upper_arm_L':1.2,'DEF-upper_arm_R':1.2,'DEF-forearm_L':1.16,'DEF-forearm_R':1.16}}
];

// 城垣巨猿 (original design): far taller than the ground titans, arms long
// enough to knuckle-walk, short legs, hunched back, a skinned coat of flat
// voxel fur shingles lying along the body (lighter chest and belly), and a
// bare light-skinned ape face with human traits.
// Bone scales are local and compound down the chain; the comments give the
// resulting effective scale (spine_003 1.34, shoulder 1.54, upper arm 2.0,
// forearm 2.4, hand 1.92, head 1.2, thigh 0.74, shin 0.78).
export const APE_VARIANT={name:'wall-ape',height:17,skin:0x55473b,faceSkin:0xb59a82,hair:0x5d5046,hairStyle:'none',face:'ape',hunch:.55,headLift:.75,
  scales:{'DEF-spine_002':1.12,'DEF-spine_003':1.2,'DEF-neck':.8,'DEF-head':1.18,'DEF-shoulder_L':1.15,'DEF-shoulder_R':1.15,'DEF-upper_arm_L':1.3,'DEF-upper_arm_R':1.3,
    'DEF-forearm_L':1.2,'DEF-forearm_R':1.2,'DEF-hand_L':.8,'DEF-hand_R':.8,'DEF-thigh_L':.74,'DEF-thigh_R':.74,'DEF-shin_L':1.05,'DEF-shin_R':1.05},
  coat:{length:.036,width:.024,dark:0x4f4238,mid:0x6b5c50,light:0xb3a28c,back:1.35}};

const prepared=new WeakMap();
function decode(text,Type){
  const binary=atob(text),bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  return new Type(bytes.buffer);
}
function prepare(rig){
  if(prepared.has(rig))return prepared.get(rig);
  if(rig?.format!=='titan-rig-v1')throw new Error('巨人骨骼资源格式无效');
  const geometry=new THREE.BufferGeometry(),m=rig.mesh;
  geometry.setAttribute('position',new THREE.BufferAttribute(decode(m.position,Float32Array),3));
  geometry.setAttribute('normal',new THREE.BufferAttribute(decode(m.normal,Float32Array),3));
  geometry.setAttribute('skinIndex',new THREE.BufferAttribute(decode(m.skinIndex,Uint8Array),4));
  geometry.setAttribute('skinWeight',new THREE.BufferAttribute(decode(m.skinWeight,Float32Array),4));
  geometry.setIndex(new THREE.BufferAttribute(decode(m.index,Uint16Array),1));
  geometry.computeBoundingSphere();
  const inverse=decode(rig.inverseBind,Float32Array),inverses=rig.bones.map((_,i)=>new THREE.Matrix4().fromArray(inverse,i*16));
  const clips={};
  for(const [name,clip]of Object.entries(rig.clips))clips[name]=new THREE.AnimationClip(name,clip.duration,clip.tracks.map(t=>{
    const times=decode(t.times,Float32Array),values=decode(t.values,Float32Array);
    return t.path==='quaternion'?new THREE.QuaternionKeyframeTrack(`${t.bone}.quaternion`,times,values):new THREE.VectorKeyframeTrack(`${t.bone}.position`,times,values);
  }));
  const result={rig,geometry,inverses,clips,contacts:rig.contacts,strides:rig.strides,height:rig.height};
  prepared.set(rig,result);return result;
}

const v1=new THREE.Vector3(),v2=new THREE.Vector3(),v3=new THREE.Vector3(),q1=new THREE.Quaternion(),q2=new THREE.Quaternion(),q3=new THREE.Quaternion(),Y=new THREE.Vector3(0,1,0);
// Rotate a bone so its +Y (along the bone) moves toward a world direction.
function aimBone(bone,direction,weight){
  if(weight<=0)return;
  bone.updateWorldMatrix(true,false);
  bone.getWorldQuaternion(q1);v1.copy(Y).applyQuaternion(q1).normalize();
  q2.setFromUnitVectors(v1,v2.copy(direction).normalize());q3.identity().slerp(q2,Math.min(1,weight));
  q1.premultiply(q3);bone.parent.getWorldQuaternion(q2).invert();bone.quaternion.copy(q2.multiply(q1));
  bone.updateWorldMatrix(false,true);
}
function turnBone(bone,axis,angle){
  if(!angle)return;
  bone.updateWorldMatrix(true,false);bone.getWorldQuaternion(q1);q3.setFromAxisAngle(axis,angle);q1.premultiply(q3);
  bone.parent.getWorldQuaternion(q2).invert();bone.quaternion.copy(q2.multiply(q1));bone.updateWorldMatrix(false,true);
}

// Face and hair in rest-pose head units; offsets are from the head bone origin
// with +Z the face direction, then re-expressed in the head bone's frame.
function decorate(head,variant,materials,geometries){
  head.updateWorldMatrix(true,false);
  const restQ=head.getWorldQuaternion(new THREE.Quaternion()),inv=restQ.clone().invert(),headScale=head.getWorldScale(new THREE.Vector3()).x;
  const add=(geometry,material,offset,rotation=[0,0,0],scale=[1,1,1])=>{
    geometries.push(geometry);const mesh=new THREE.Mesh(geometry,material);
    mesh.position.fromArray(offset).applyQuaternion(inv);
    mesh.quaternion.copy(inv).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)));
    mesh.scale.fromArray(scale);mesh.castShadow=true;head.add(mesh);return mesh;
  };
  const sphere=r=>new THREE.SphereGeometry(r,14,10),box=(x,y,z)=>new THREE.BoxGeometry(x,y,z);
  const {skin,eye,pupil,tooth,mouth,hair,brow}=materials;
  if(variant.face==='ape'){apeFace(add,sphere,box,materials);return headScale;}
  for(const s of[-1,1]){
    add(sphere(.022),eye,[s*.036,.14,.098],[0,0,0],[1,.8,.55]);
    add(sphere(.011),pupil,[s*.036,.14,.11],[0,0,0],[1,1,.5]);
    add(box(.05,.014,.03),brow,[s*.036,.165,.104],[0,0,s*-.18]);
    add(sphere(.03),skin,[s*.09,.115,-.005],[0,0,0],[.35,1,.7]);
    add(sphere(.03),skin,[s*.05,.07,.09],[0,0,0],[1,.8,.6]);
  }
  add(box(.03,.05,.035),skin,[0,.11,.117],[-.25,0,0]);
  add(sphere(.018),skin,[0,.087,.128],[0,0,0],[1.1,.8,.8]);
  add(box(.085,.024,.02),mouth,[0,.052,.104]);
  for(let i=0;i<6;i++)add(box(.011,.012,.008),tooth,[-.03+i*.012,.058,.113]);
  for(let i=0;i<6;i++)add(box(.011,.009,.008),tooth,[-.03+i*.012,.045,.112]);
  add(box(.1,.03,.05),skin,[0,.02,.075],[.2,0,0]);
  const style=variant.hairStyle;
  if(style!=='bald')add(sphere(.11),hair,[0,.2,-.012],[0,0,0],[.86,.62,1.06]);
  if(style==='messy')for(let i=0;i<9;i++){const a=i/9*Math.PI*2;add(box(.05,.026,.07),hair,[Math.sin(a)*.07,.25+(i%3)*.01,Math.cos(a)*.075-.01],[.3*Math.cos(a),a,.4*Math.sin(a)]);}
  if(style==='long'){add(box(.17,.2,.04),hair,[0,.08,-.1],[.12,0,0]);for(const s of[-1,1])add(box(.03,.18,.09),hair,[s*.085,.1,-.03]);}
  if(style==='short')add(box(.17,.05,.2),hair,[0,.235,0]);
  if(style==='ponytail'){add(sphere(.03),hair,[0,.2,-.11]);add(box(.04,.16,.04),hair,[0,.11,-.135],[.25,0,0]);}
  if(style==='bald')for(const s of[-1,1])add(box(.025,.05,.09),hair,[s*.083,.16,-.02]);
  return headScale;
}

// Ape face with human traits: heavy brow ridge over deep sockets, small
// deep-set eyes, broad flat nose and protruding muzzle on a bare light face;
// a short fur cap and cheek tufts stay behind the face outline.
function apeFace(add,sphere,box,{eye,pupil,tooth,mouth,hair,socket,face,faceDark}){
  add(sphere(.1),face,[0,.115,.062],[0,0,0],[1.08,1.05,.62]);
  add(sphere(.075),face,[0,.066,.092],[0,0,0],[1.28,.78,.9]);
  add(box(.2,.042,.075),faceDark,[0,.172,.1],[-.25,0,0]);
  for(const s of[-1,1]){
    add(sphere(.032),socket,[s*.043,.142,.11],[0,0,0],[1.15,.75,.45]);
    add(sphere(.014),eye,[s*.043,.142,.117],[0,0,0],[1,.85,.6]);
    add(sphere(.008),pupil,[s*.043,.142,.124],[0,0,0],[1,1,.5]);
    add(sphere(.038),face,[s*.08,.1,.08],[0,0,0],[.8,1,.7]);
    add(sphere(.013),socket,[s*.02,.095,.158],[0,0,0],[1.25,.8,.6]);
  }
  add(box(.09,.05,.042),faceDark,[0,.108,.14],[-.15,0,0]);
  add(box(.115,.022,.022),mouth,[0,.046,.14]);
  for(let i=0;i<7;i++)add(box(.012,.013,.008),tooth,[-.036+i*.012,.052,.149]);
  add(box(.12,.032,.06),face,[0,.02,.112],[.25,0,0]);
  add(sphere(.118),hair,[0,.2,-.04],[0,0,0],[.98,.62,1.06]);
  for(const s of[-1,1])for(let i=0;i<3;i++)add(box(.03,.05,.05),hair,[s*(.112+i*.004),.15-i*.045,.02-i*.01],[0,0,s*(.15+i*.12)]);
}

// Skinned coat of voxel fur shingles: one thin tapered plate per surface
// vertex of the rig, lying along the surface and pointing down, bound to that
// vertex's bones so the coat follows every scaled bone without hiding the
// body outline.
function buildCoat(data,variant,skeleton,materials,geometries){
  const coat=variant.coat,g=data.geometry,pos=g.attributes.position,nor=g.attributes.normal,si=g.attributes.skinIndex,sw=g.attributes.skinWeight;
  const names=data.rig.bones.map(b=>b.name),head=names.indexOf('DEF-head'),neck=names.indexOf('DEF-neck');
  const torso=new Set(['DEF-hips','DEF-spine_001','DEF-spine_002','DEF-spine_003'].map(n=>names.indexOf(n)));
  const chest=new Set(['DEF-shoulder_L','DEF-shoulder_R'].map(n=>names.indexOf(n)));
  const skip=new Set(names.map((n,i)=>/f_|thumb|toe|foot/.test(n)?i:-1).filter(i=>i>=0));
  const colors={dark:new THREE.Color(coat.dark),mid:new THREE.Color(coat.mid),light:new THREE.Color(coat.light)};
  // Clumps inherit their bone's compounded scale; shrink them back so long
  // arms keep the same fur size as the torso.
  const eff=data.rig.bones.map(()=>1);data.rig.bones.forEach((b,i)=>{eff[i]=(b.parent>=0?eff[b.parent]:1)*(variant.scales[b.name]??1);});
  const P=[],C=[],SI=[],SW=[],I=[],seen=new Set();let hash=1;
  const rnd=()=>{hash=(hash*16807)%2147483647;return hash/2147483647;};
  const p=new THREE.Vector3(),n=new THREE.Vector3(),dir=new THREE.Vector3(),t=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Color(),DOWN=new THREE.Vector3(0,-1,-.15).normalize();
  const clump=(v,length,width,tint)=>{
    // Down the surface tangent, lifted slightly off it.
    dir.copy(DOWN).addScaledVector(n,-DOWN.dot(n));
    if(dir.lengthSq()<1e-4)dir.set(0,0,-1).addScaledVector(n,-n.z);
    dir.normalize().multiplyScalar(.93).addScaledVector(n,.36).normalize();
    t.crossVectors(dir,n).normalize();b.crossVectors(t,dir).normalize();
    const base=P.length/3,ring=[[-1,-1],[1,-1],[1,1],[-1,1]];
    for(const [k,top] of [[1,0],[.45,1]])for(const [x,y] of ring){
      const q=p.clone().addScaledVector(n,-.002).addScaledVector(dir,length*top).addScaledVector(t,x*width*k).addScaledVector(b,(y+1)*width*.22*k);
      P.push(q.x,q.y,q.z);c.copy(tint).multiplyScalar(top?1.12:.85);C.push(c.r,c.g,c.b);
      for(let j=0;j<4;j++){SI.push(si.getComponent(v,j));SW.push(sw.getComponent(v,j));}
    }
    for(const [a,b2,c2,d] of [[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7],[4,5,6,7]])I.push(base+a,base+b2,base+c2,base+a,base+c2,base+d);
  };
  for(let v=0;v<pos.count;v++){
    p.fromBufferAttribute(pos,v);const key=`${Math.round(p.x/.006)},${Math.round(p.y/.006)},${Math.round(p.z/.006)}`;if(seen.has(key))continue;seen.add(key);
    let bone=0,best=-1;for(let j=0;j<4;j++){const w=sw.getComponent(v,j);if(w>best){best=w;bone=si.getComponent(v,j);}}
    if(skip.has(bone))continue;
    n.fromBufferAttribute(nor,v).normalize();
    let length=coat.length*(.75+.5*rnd()),tone=colors.dark.clone().lerp(colors.mid,.25+rnd()*.45);
    if(bone===head){if(n.z>-.05)continue;length*=.6;}
    else if(bone===neck&&n.z>.2)continue;
    else if((torso.has(bone)&&n.z>.35)||(chest.has(bone)&&n.z>.6)){tone=colors.mid.clone().lerp(colors.light,.6+rnd()*.4);length*=.6;}
    else if(torso.has(bone)&&n.z<-.3&&bone!==names.indexOf('DEF-hips'))length*=coat.back;
    else if(names[bone].includes('hand'))length*=.4;
    const k=1/Math.pow(eff[bone],.75);length*=k;
    clump(v,length,coat.width*(.8+.4*rnd())*k,tone);
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(P,3));geometry.setAttribute('color',new THREE.Float32BufferAttribute(C,3));
  geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(SI,4));geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(SW,4));
  geometry.setIndex(I);geometry.computeVertexNormals();geometry.computeBoundingSphere();geometries.push(geometry);
  materials.coat=new THREE.MeshStandardMaterial({vertexColors:true,roughness:1,flatShading:true});
  const mesh=new THREE.SkinnedMesh(geometry,materials.coat);mesh.name='wall-ape coat';mesh.castShadow=true;mesh.receiveShadow=true;mesh.frustumCulled=false;
  mesh.bind(skeleton,new THREE.Matrix4());return mesh;
}

export function createTitanModel(rig,index,{height,variant:custom=null}={}){
  const data=prepare(rig),variant=custom??TITAN_VARIANTS[index%TITAN_VARIANTS.length],H=height??variant.height;
  const geometries=[],skin=new THREE.MeshStandardMaterial({color:variant.skin,roughness:.78});
  const materials={skin,eye:new THREE.MeshStandardMaterial({color:0xf2ede1,roughness:.35}),pupil:new THREE.MeshStandardMaterial({color:0x1d1814,roughness:.3}),tooth:new THREE.MeshStandardMaterial({color:0xf0e8d2,roughness:.5}),mouth:new THREE.MeshStandardMaterial({color:0x4a1e1a,roughness:.8}),hair:new THREE.MeshStandardMaterial({color:variant.hair,roughness:.95}),brow:new THREE.MeshStandardMaterial({color:new THREE.Color(variant.skin).multiplyScalar(.72),roughness:.9})};
  if(variant.face==='ape'){const face=variant.faceSkin??variant.skin;materials.socket=new THREE.MeshStandardMaterial({color:0x17110d,roughness:.9});materials.face=new THREE.MeshStandardMaterial({color:face,roughness:.8});materials.faceDark=new THREE.MeshStandardMaterial({color:new THREE.Color(face).multiplyScalar(.68),roughness:.85});materials.hair.flatShading=true;}
  const bones=data.rig.bones.map(b=>{const bone=new THREE.Bone();bone.name=b.name;bone.position.fromArray(b.t);bone.quaternion.fromArray(b.r);bone.scale.fromArray(b.s);return bone;});
  data.rig.bones.forEach((b,i)=>b.parent>=0&&bones[b.parent].add(bones[i]));
  const byName=Object.fromEntries(bones.map(b=>[b.name,b]));
  const mesh=new THREE.SkinnedMesh(data.geometry,skin);mesh.name=`titan-${variant.name}`;mesh.castShadow=true;mesh.receiveShadow=true;mesh.frustumCulled=false;
  mesh.add(bones[0]);const skeleton=new THREE.Skeleton(bones,data.inverses.map(m=>m.clone()));mesh.updateMatrixWorld(true);mesh.bind(skeleton,new THREE.Matrix4());
  const footRest=byName['DEF-toe_L'].getWorldPosition(new THREE.Vector3()).y;
  for(const [name,s]of Object.entries(variant.scales))byName[name]?.scale.multiplyScalar(s);
  mesh.updateMatrixWorld(true);
  const footOffset=footRest-byName['DEF-toe_L'].getWorldPosition(new THREE.Vector3()).y;
  const restHeads=Object.fromEntries(['DEF-hips','DEF-neck','DEF-head'].map(n=>[n,byName[n].getWorldPosition(new THREE.Vector3()).y]));
  const neckBack=new THREE.Vector3(0,0,-1).applyQuaternion(byName['DEF-neck'].getWorldQuaternion(new THREE.Quaternion()).invert());
  decorate(byName['DEF-head'],variant,materials,geometries);
  // Fur tufts in rest-pose metres, scattered around each bone (deterministic).
  for(const [name,[count,size]]of Object.entries(variant.fur??{})){
    const bone=byName[name];if(!bone)continue;bone.updateWorldMatrix(true,false);const s=bone.getWorldScale(new THREE.Vector3()).x||1;
    for(let i=0;i<count;i++){
      const a=i/count*Math.PI*2+name.length,g=new THREE.BoxGeometry(size/s,size*1.6/s,size*.7/s);geometries.push(g);
      const tuft=new THREE.Mesh(g,materials.hair);tuft.position.set(Math.cos(a)*size*.9/s,(i%3)*size*.8/s,Math.sin(a)*size*.9/s);tuft.rotation.set(Math.sin(a)*.5,a,Math.cos(a)*.4);tuft.castShadow=true;bone.add(tuft);
    }
  }
  const group=new THREE.Group(),body=new THREE.Group(),scale=H/data.height;group.name=custom?`titan-${variant.name}`:`titan-${index}`;
  body.scale.setScalar(scale);body.position.y=footOffset*scale;body.add(mesh);group.add(body);
  const coat=variant.coat?buildCoat(data,variant,skeleton,materials,geometries):null;if(coat)body.add(coat);
  const restPose=bones.map(b=>({p:b.position.clone(),q:b.quaternion.clone()}));
  const mixer=new THREE.AnimationMixer(mesh),actions=new Map();let current=null;
  function action(name){
    if(!actions.has(name)){const a=mixer.clipAction(data.clips[name]);actions.set(name,a);}
    return actions.get(name);
  }
  function play(name,{fade=.25,loop=true,timeScale=1,restart=false,from=0}={}){
    const next=action(name);next.timeScale=timeScale;
    if(current===next&&!restart)return next;
    next.reset();next.time=from;next.setLoop(loop?THREE.LoopRepeat:THREE.LoopOnce,Infinity);next.clampWhenFinished=!loop;next.enabled=true;next.setEffectiveWeight(1);next.play();
    if(current&&current!==next&&fade>0)next.crossFadeFrom(current,fade,false);else if(current&&current!==next)current.stop();
    current=next;return next;
  }
  // Model-space direction (+Z forward) to world.
  const world=(x,y,z)=>v3.set(x,y,z).applyQuaternion(group.quaternion);
  const rightAxis=()=>new THREE.Vector3(1,0,0).applyQuaternion(group.quaternion);
  const overlays={
    look(yaw){turnBone(byName['DEF-neck'],Y,yaw*.4);turnBone(byName['DEF-head'],Y,yaw*.6);},
    bend(angle){turnBone(byName['DEF-spine_001'],rightAxis(),angle*.55);turnBone(byName['DEF-spine_003'],rightAxis(),angle*.45);},
    aim(name,x,y,z,weight){aimBone(byName[name],world(x,y,z),weight);},
    aimWorld(name,direction,weight){aimBone(byName[name],direction,weight);},
    turn(name,axis,angle){turnBone(byName[name],axis,angle);},
    rightAxis
  };
  // The mixer only writes a bone when its blended value changed since the last
  // update; bones it skipped still carry last frame's overlay, so restore
  // their clean clip pose before overlaying again.
  const clean=bones.map(b=>b.quaternion.clone()),posed=bones.map(b=>b.quaternion.clone());
  function animate(dt,overlay){
    mixer.update(dt);
    for(let i=0;i<bones.length;i++){const q=bones[i].quaternion;if(q.equals(posed[i]))q.copy(clean[i]);else clean[i].copy(q);}
    group.updateMatrixWorld(true);overlay?.(overlays);
    for(let i=0;i<bones.length;i++)posed[i].copy(bones[i].quaternion);
    mesh.updateMatrixWorld(true);
  }
  const p=new THREE.Vector3();
  function bonePoint(name,target=new THREE.Vector3()){return byName[name].getWorldPosition(target);}
  const SEGMENTS=[
    ['torso','DEF-hips','DEF-spine_003',.15],['head','DEF-head',null,.12],
    ['armL','DEF-upper_arm_L','DEF-forearm_L',.065],['armL','DEF-forearm_L','DEF-hand_L',.055],['armR','DEF-upper_arm_R','DEF-forearm_R',.065],['armR','DEF-forearm_R','DEF-hand_R',.055],
    ['legL','DEF-thigh_L','DEF-shin_L',.085],['legL','DEF-shin_L','DEF-foot_L',.065],['legR','DEF-thigh_R','DEF-shin_R',.085],['legR','DEF-shin_R','DEF-foot_R',.065]
  ];
  // World capsules for hit tests; the nape sphere sits behind the neck/head joint.
  function capsules(){
    const out=[],k=scale,headScale=byName['DEF-head'].getWorldScale(p).x/scale;
    for(const [part,a,b,r]of SEGMENTS){
      const start=bonePoint(a,new THREE.Vector3());
      let end;
      if(b)end=bonePoint(b,new THREE.Vector3());
      else{const head=byName[a];head.updateWorldMatrix(true,false);end=new THREE.Vector3(0,.22,0).applyMatrix4(head.matrixWorld);start.lerp(end,.38);}
      const boneScale=byName[a].getWorldScale(p).x/scale;
      out.push({part,start,end,radius:r*k*(part==='head'?headScale:Math.max(1,boneScale))});
    }
    const neck=bonePoint('DEF-neck',new THREE.Vector3()),head=bonePoint('DEF-head',new THREE.Vector3()),nape=neck.lerp(head,.45);
    const back=neckBack.clone().applyQuaternion(byName['DEF-neck'].getWorldQuaternion(q1));back.y*=.3;
    if(back.lengthSq()<1e-6)back.set(0,0,-1).applyQuaternion(group.quaternion);
    nape.addScaledVector(back.normalize(),.085*k*headScale);
    return {capsules:out,nape:{point:nape,radius:.07*k*Math.max(1,headScale)}};
  }
  function resetPose(){bones.forEach((b,i)=>{b.position.copy(restPose[i].p);b.quaternion.copy(restPose[i].q);clean[i].copy(restPose[i].q);posed[i].copy(restPose[i].q);});mixer.stopAllAction();current=null;}
  function dispose(){mixer.stopAllAction();mixer.uncacheRoot(mesh);skeleton.dispose();geometries.forEach(g=>g.dispose());Object.values(materials).forEach(m=>m.dispose());}
  return {group,body,mesh,coat,skeleton,bones:byName,variant,height:H,scale,clips:data.clips,contacts:data.contacts,strides:data.strides,restHeads,play,animate,bonePoint,capsules,resetPose,dispose,get current(){return current?.getClip().name??null;},get action(){return current;}};
}
