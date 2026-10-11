import * as THREE from '../vendor/three.module.js';
import {normalizeAppearance,CHARACTER_CELL,CHARACTER_PARTS} from './character-config.js';
import {TURNAROUND_PEOPLE} from './reference-turnaround-data.js';
import {createRig,createSurfaceBuilder} from './sculpted-worker.js';
import {createCharacterVoxels} from './character-voxels.js';

export const REFERENCE_VOXEL_SIZE=CHARACTER_CELL*3;
export const REFERENCE_HEAD_DROP=REFERENCE_VOXEL_SIZE*2;
const ARM_CLEARANCE=REFERENCE_VOXEL_SIZE;
const cache=new Map(),LIMIT=12,S=REFERENCE_VOXEL_SIZE;
export function referencePart([x,y,z,index],female){
 if(z>=19||(female&&index===63))return 'head';
 if(z<=11&&x!==16){const side=x<16?'left':'right';return side+(z<2?'Foot':z<6?'Knee':'Hip');}
 if(z>=17&&(x<=13||x>=19)){const side=x<16?'left':'right',distance=Math.abs(x-16);return side+(distance>=10?'Wrist':distance>=7?'Elbow':'Shoulder');}
 return 'spine';
}

// VOX uses Z up and its eye strip faces -Y. Rotate each whole arm from its
// source T pose into the downward bind pose; the animation can restore that
// exact source pose without changing any cell, silhouette or palette colour.
export function referenceBindPoint(cell,part){
 const [x,y,z]=cell,p=[(x-16)*S,(z+.5)*S,-(y-16)*S];
 if(part==='head')p[1]-=REFERENCE_HEAD_DROP;
 if(/Shoulder|Elbow|Wrist/.test(part)){
  const side=part.startsWith('left')?-1:1,shoulder=side*2.5*S,dx=p[0]-shoulder,dy=p[1]-18*S;
  p[0]=shoulder+side*(dy+ARM_CLEARANCE);p[1]=18*S-side*dx;
 }
 return p;
}

export function createReferenceWorker(input){
 const a=normalizeAppearance(input),female=a.template==='reference-female',source=TURNAROUND_PEOPLE[female?'female':'male'];
 const boot=.15*a.bootSize,hip=boot+.75*a.legLength,top=hip+.45*a.torsoHeight;
 const sx=.1875*a.torsoWidth*a.shoulderWidth+ARM_CLEARANCE*a.armSize,elbow=top-.30*a.armLength,wrist=top-.525*a.armLength,headY=top+(.30-REFERENCE_HEAD_DROP)*a.headHeight;
 const rig=createRig({hip,spine:hip+.225*a.torsoHeight,head:headY,shoulder:[sx,top,.0375*a.torsoDepth],elbow:[sx,elbow,.0375*a.torsoDepth],wrist:[sx,wrist,.0375*a.torsoDepth],legX:.1125*a.torsoWidth,legTop:hip,knee:boot+.30*a.legLength,ankle:boot/2});
 const key=JSON.stringify({...a,width:1,height:1}),cached=cache.get(key);
 if(cached){cache.delete(key);cache.set(key,cached);}
 const b=cached?{parts:cached.parts}:createCharacterVoxels(rig);
 // The source grid's half-cell origin must survive the finer edit grid. This
 // avoids rounding a three-cell-wide source voxel differently per joint.
 if(!cached)for(const part of b.parts)part.origin=rig.points[part.name].map((n,i)=>i===1&&part.name.endsWith('Foot')?0:Math.round(n/CHARACTER_CELL)*CHARACTER_CELL+(i===1?0:-CHARACTER_CELL/2));
 const relativeColor=(value,original,chosen)=>{if(chosen===original)return value;const src=new THREE.Color(value),base=new THREE.Color(original),paint=new THREE.Color(chosen);src.setRGB(Math.min(1,src.r*paint.r/Math.max(.001,base.r)),Math.min(1,src.g*paint.g/Math.max(.001,base.g)),Math.min(1,src.b*paint.b/Math.max(.001,base.b)));return '#'+src.getHexString();};
 if(!cached){
  for(const cell of source.voxels){
   const part=referencePart(cell,female),index=cell[3],hair=index===(female?63:245);
   if(hair&&(a.hair==='none'||a.hair==='short'&&female&&cell[2]<20))continue;
   let p=referenceBindPoint(cell,part),size=[S,S,S],paint=source.palette[index-1];
   if(part==='head'){
    p=[p[0]*a.headWidth,headY+(p[1]-(1.65-REFERENCE_HEAD_DROP))*a.headHeight,p[2]*Math.sqrt(a.headWidth)];size=[S*a.headWidth,S*a.headHeight,S*Math.sqrt(a.headWidth)];
    if(hair)paint=relativeColor(paint,source.palette[(female?63:245)-1],a.hairColor);
    if(index===71)paint=a.faceColor;
    if(index===178){paint=a.eyeColor;p[0]*=a.eyeSpacing;size[0]*=a.eyeSize;size[1]*=a.eyeSize;}
    if([71,178,235,255].includes(index)&&cell[1]<=14){p[1]+=(a.facePosition-1)*.12;size[0]*=a.faceSize;size[1]*=a.faceSize;}
    if(index===255&&a.expression==='happy')paint=a.faceColor;
    if(index===235&&a.expression==='surprised')size[1]*=1.6;
    if(index===255&&['angry','worried'].includes(a.expression))p[1]+=(cell[0]<16?-1:1)*.025*(a.expression==='angry'?1:-1);
   }else if(/Shoulder|Elbow|Wrist/.test(part)){
    const side=part.startsWith('left')?-1:1,old=[side*(.1875+ARM_CLEARANCE),1.35,.0375],hand=part.endsWith('Wrist'),factor=hand?a.gloveSize:1;
    p=[side*sx+(p[0]-old[0])*a.armSize*factor,top+(p[1]-old[1])*a.armLength,.0375*a.torsoDepth+(p[2]-old[2])*a.armSize*factor];
    size=[S*a.armSize*factor,S*(hand?a.gloveSize:a.armLength),S*a.armSize*factor];
    if(index===71)paint=a.gloveColor;
    else paint=relativeColor(paint,source.palette[(female?236:69)-1],a.bodyColor);
   }else if(part.endsWith('Foot')){
    const side=part.startsWith('left')?-1:1;p=[side*.1125*a.torsoWidth+(p[0]-side*.1125)*a.bootSize,p[1]*a.bootSize,p[2]*a.bootSize];size=size.map(n=>n*a.bootSize);
    if(female&&index===71)paint=a.gloveColor;
   }else if(/Hip|Knee/.test(part)){
    const side=part.startsWith('left')?-1:1;p=[side*.1125*a.torsoWidth+(p[0]-side*.1125)*a.legWidth,boot+(p[1]-.15)*a.legLength,p[2]];
    size=[S*a.legWidth,S*a.legLength,S];paint=index===71?a.gloveColor:index===(female?186:90)?a.outfitColor:paint;
   }else{
    p=[p[0]*a.torsoWidth,hip+(p[1]-.9)*a.torsoHeight,p[2]*a.torsoDepth];size=[S*a.torsoWidth,S*a.torsoHeight,S*a.torsoDepth];
    if(index===(female?186:90))paint=a.outfitColor;
    else if(index===71)paint=a.faceColor;
    else if(![254,240].includes(index))paint=relativeColor(paint,source.palette[(female?236:69)-1],a.bodyColor);
   }
   // A 90-degree arm rotation swaps source X/Y dimensions.
   if(/Shoulder|Elbow|Wrist/.test(part))size=[size[1],size[0],size[2]];
   b.box(p,size,paint,part);
  }
  if(a.hat!=='none'){
   const y=top+(.63-REFERENCE_HEAD_DROP)*a.headHeight,w=.64*a.hatWidth*a.headWidth,d=.52*a.headWidth;
   b.box([0,y,0],[w,.05,d],a.hatColor,'head');b.box([0,y+.09,0],[w*.78,.15*a.hatHeight,d*.8],a.hatColor,'head');
  }
  b.apply(a.voxelEdits);
 }
 const geometry=cached?.geometry||b.finish(),resource=cached||{geometry,parts:b.parts,references:0,retained:true};resource.references++;
 if(!cached){cache.set(key,resource);if(cache.size>LIMIT){const oldest=cache.keys().next().value,old=cache.get(oldest);cache.delete(oldest);old.retained=false;if(!old.references)old.geometry.dispose();}}
 const material=new THREE.MeshStandardMaterial({vertexColors:true,roughness:1}),mesh=new THREE.SkinnedMesh(geometry,material),group=new THREE.Group();mesh.name='reference-'+(female?'female':'male');mesh.castShadow=true;mesh.frustumCulled=false;mesh.add(rig.bones.root);group.add(mesh);group.updateMatrixWorld(true);
 const skeleton=new THREE.Skeleton(rig.list);mesh.bind(skeleton);
 const attachments={};for(const side of ['left','right']){const hand=new THREE.Group();hand.position.set(0,-.06,.06);rig.bones[`${side}Wrist`].add(hand);attachments[`${side}Hand`]=hand;}
 const pb=createSurfaceBuilder(rig),box=(p,s,c)=>pb.box(p,s,new THREE.Color(c),rig.skin('root'));
 if(a.prop==='ingot')box([0,0,.025],[.24,.11,.13],'#d6ad36');
 else if(a.prop==='clipboard'){box([0,0,.02],[.22,.29,.03],'#705133');box([0,0,.04],[.18,.24,.01],'#e5ddbf');}
 else if(a.prop==='tape'){box([0,0,.01],[.11,.09,.07],a.hatColor);box([0,-.1,.01],[.025,.18,.01],'#c5bc8e');}
 else {box([0,-.03,0],[.04,.40,.04],'#8d653b');box([0,-.20,0],[.24,.13,.13],'#515659');}
 const prop=new THREE.Mesh(pb.finish(),material);prop.castShadow=true;attachments.leftHand.add(prop);prop.visible=a.prop!=='none';
 const rest=rig.list.map(bone=>bone.position.clone());
 function animate(time=0,amount=0){const t=Number.isFinite(time)?time:0,k=THREE.MathUtils.clamp(Number.isFinite(amount)?amount:0,0,1);rig.list.forEach((bone,i)=>{bone.rotation.set(0,0,0);bone.position.copy(rest[i]);});for(const s of [-1,1]){const n=s<0?'left':'right',v=Math.sin(t*3.7)*s*k;rig.bones[`${n}Hip`].rotation.x=v*.60;rig.bones[`${n}Knee`].rotation.x=Math.max(0,-v)*.9;rig.bones[`${n}Foot`].rotation.x=-Math.max(0,-v)*.25;rig.bones[`${n}Shoulder`].rotation.x=-v*.55;rig.bones[`${n}Elbow`].rotation.x=-Math.abs(v)*.4;}rig.bones.spine.rotation.z=Math.sin(t*3.7)*k*.05;group.updateMatrixWorld(true);skeleton.update();}
 const metrics={variant:'block',template:a.template,cellSize:CHARACTER_CELL,sourceVoxelSize:S,sourceVoxels:source.voxelCount,cells:b.parts.reduce((n,p)=>n+p.cells.size,0),triangles:geometry.index.count/3,vertices:geometry.attributes.position.count,propTriangles:prop.geometry.index.count/3,drawCalls:prop.visible?2:1,bones:16,skinned:true};let disposed=false;
 return{group,mesh,bones:rig.bones,skeleton,attachments,prop,animate,metrics,parts:b.parts,rigPoints:rig.points,tposeShoulderOffset:ARM_CLEARANCE*a.armSize,dispose(){if(disposed)return;disposed=true;resource.references--;if(!resource.references&&!resource.retained)geometry.dispose();prop.geometry.dispose();material.dispose();skeleton.dispose();prop.removeFromParent();group.removeFromParent();}};
}
