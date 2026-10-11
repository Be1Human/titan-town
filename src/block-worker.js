import * as THREE from '../vendor/three.module.js';
import {normalizeAppearance} from './character-config.js';
import {createRig,createSurfaceBuilder} from './sculpted-worker.js';
import {createCharacterVoxels} from './character-voxels.js';
import {createReferenceWorker} from './reference-worker.js';
import {createCrewWorker} from './crew-worker.js';
const geometryCache=new Map(),CACHE_LIMIT=12;

// Approved human silhouette. Each local voxel follows exactly one joint.
export function createBlockWorker(options={}){
 const a=normalizeAppearance(options.appearance||options);
 if(a.template.startsWith('reference-'))return createReferenceWorker(a);
 if(a.template.startsWith('crew-'))return createCrewWorker(a);
 const W=.35*a.torsoWidth,H=.47*a.torsoHeight,D=.225*a.torsoDepth;
 const bootH=.12*a.bootSize,legH=.65*a.legLength,base=bootH+legH,top=base+H;
 const hw=.49*a.headWidth,hh=.40*a.headHeight,hd=.30,hy=top+hh/2+.015;
 const armW=.125*a.armSize,shoulderX=W*.5*a.shoulderWidth+armW*.53;
 const glove=.135*a.gloveSize,sy=top-.065,armH=Math.min(.48*a.armLength,sy-glove*.75-.04),wy=sy-armH;
 const lx=Math.max(W*.30,.08*a.legWidth),ankle=bootH/2;
 const rig=createRig({hip:base,spine:base+H*.5,head:hy,shoulder:[shoulderX,sy,0],elbow:[shoulderX,sy-armH*.52,0],wrist:[shoulderX,wy,0],legX:lx,legTop:base,knee:bootH+legH*.5,ankle});
 const key=JSON.stringify({...a,width:1,height:1}),cached=geometryCache.get(key);
 if(cached){geometryCache.delete(key);geometryCache.set(key,cached);}
 const {bones,skin}=rig,b=cached?{parts:cached.parts}:createCharacterVoxels(rig),box=b.box;
 const body=a.bodyColor,hat=a.hatColor,outfit=a.outfitColor,face=a.faceColor,hair=a.hairColor,gloveColor=a.gloveColor,dark='#35342c',sole='#66513a',buckle='#dfd1ae';
 if(!cached){
 box([0,base+H/2,0],[W,H,D],body);
 box([0,top+.02,0],[W*.45,.09,D*.75],face,'head');
 box([0,hy,0],[hw,hh,hd],face,'head');
 const fw=hw*.89*a.faceSize,fh=hh*.8*a.faceSize,fy=hy+(a.facePosition-1)*hh*.42,fz=hd/2+.0125;
 box([0,fy,fz],[Math.min(hw,fw),fh,.025],face,'head');
 const ex=Math.min(hw*.27,hw*.215*a.eyeSpacing),ew=Math.min(hw*.42,.16*a.eyeSize),eh=.075*a.eyeSize;
 for(const side of [-1,1]){
  const ey=fy+.01,eyeH=a.expression==='happy'?eh*.55:a.expression==='surprised'?eh*1.3:eh;
  box([side*ex,ey,fz],[ew,eyeH,.025],'#f6ecd9','head');
  box([side*ex+side*.013,ey,fz],[.05*a.eyeSize,eyeH,.025],a.eyeColor,'head');
  box([side*ex+side*.018,ey,fz],[.025,eyeH*.8,.025],'#243f41','head');
  box([side*ex,ey+eyeH/2+.015,fz],[ew,.025,.025],dark,'head');
  if(['angry','worried'].includes(a.expression))box([side*(ex+(a.expression==='angry'?-.025:.025)),ey+eyeH/2+.034,fz],[ew*.55,.025,.025],hair,'head');
 }
 box([0,fy-.048,fz+.013],[.045,.05,.045],face,'head');
 box([0,fy-.095,fz],[a.expression==='surprised'?.025:.065,a.expression==='surprised'?.05:.025,.025],a.expression==='happy'?'#945d43':'#674d3c','head');
 if(a.hair!=='none'){
  const crown=hy+hh/2;
  box([0,crown-.017,-.028],[hw+.025,.10,hd+.025],hair,'head');
  box([-.035,crown+.045,-.016],[hw*.77,.10,hd*.95],hair,'head');
  box([.04,crown+.11,-.015],[hw*.44,.075,hd*.65],hair,'head');
  box([0,hy+.03,-hd/2],[hw+.025,hh*.9,.075],hair,'head');
  for(const s of [-1,1])box([s*hw/2,hy+.047,0],[.05,hh*.62,hd],hair,'head');
  if(a.hair==='swept'){
   box([-.115,hy+hh*.34,hd/2+.01],[hw*.36,.115,.075],hair,'head');
   box([-.16,hy+hh*.16,hd/2+.01],[.075,.075,.075],hair,'head');
  }else if(a.hair==='ponytail'){
   for(const s of [-1,1])box([s*(hw/2+.025),hy-.025,-.025],[.075,hh+.20,hd*.65],hair,'head');
   box([.025,hy+hh*.36,hd/2+.01],[hw*.72,.10,.075],hair,'head');
  }
 }
 const hatY=hy+hh/2+.075,hatW=(hw+.13)*a.hatWidth,hatD=hd+.15,hatH=.13*a.hatHeight;
 if(a.hat!=='none'){
  box([0,hatY,.01],[hatW,.05,hatD],hat,'head');
  box([0,hatY+.06,-.015],[hatW*.83,hatH*.7,hatD*.82],hat,'head');
  box([0,hatY+.11,-.015],[hatW*.60,hatH*.45,hatD*.65],hat,'head');
  if(a.hat==='hardhat')box([0,hatY+.09,-.01],[hatW*.16,hatH*1.12,hatD*.72],hat,'head');
  else box([0,hatY,hatD*.43],[hatW*.85,.025,hatD*.4],hat,'head');
 }
 const front=D/2+.0125;
 box([0,base+.025,0],[W,.05,D+.025],outfit);
 if(a.outfit==='overalls'){
  box([0,base+H*.19,front],[W,H*.38,.025],outfit);
  box([0,base+H*.49,front],[W*.58,H*.30,.025],outfit);
  for(const s of [-1,1]){box([s*W*.28,top-H*.22,front],[.05,H*.44,.025],outfit);box([s*W*.28,top-H*.38,front+.025],[.025,.025,.025],hat);}
 }else if(a.outfit==='vest'){
  for(const s of [-1,1])box([s*W*.27,base+H*.58,front],[W*.40,H*.80,.025],outfit);
  box([0,base+H*.5,front+.025],[W,.025,.025],buckle);
 }else if(a.outfit==='satchel'){
  box([W*.3,base+H*.35,front+.025],[W*.38,H*.26,.075],outfit);
  for(let i=0;i<5;i++)box([W*(-.32+i*.13),top-H*(.12+i*.12),front],[.05,.085,.025],outfit);
 }else{
  for(const s of [-1,1])box([s*W*.43,base+H*.55,front],[.05,H*.9,.025],hair);
  box([0,top-.05,front],[.075,.075,.025],face);
 }
 for(const side of [-1,1]){
  const n=side<0?'left':'right',x=side*shoulderX,reach=Math.max(armW,shoulderX-W/2+armW*.5);
  box([side*(W/2+reach/2),sy-.015,0],[reach,.10,armW],body,`${n}Shoulder`);
  box([x,sy-armH*.26,0],[armW,armH*.52,armW],body,`${n}Shoulder`);
  box([x,sy-armH*.76,0],[armW*.92,armH*.48,armW],body,`${n}Elbow`);
  box([x,wy+.025,0],[armW,.05,armW+.025],body,`${n}Elbow`);
  box([x,wy-glove*.35,.0125],[glove,glove,glove*.8],gloveColor,`${n}Wrist`);
  box([x-side*glove*.48,wy-glove*.12,.05],[.025,glove*.5,.05],gloveColor,`${n}Wrist`);
  const legW=Math.min(.13*a.legWidth,lx*1.6);
  box([side*lx,bootH+legH*.75,0],[legW,legH*.50,.175],outfit,`${n}Hip`);
  box([side*lx,bootH+legH*.25,0],[legW,legH*.50,.175],outfit,`${n}Knee`);
  box([side*lx,bootH/2,.025],[Math.min(.145*a.bootSize,lx*1.9),bootH,.225*a.bootSize],sole,`${n}Foot`);
 }
 b.apply(a.voxelEdits);
 }
 const geometry=cached?.geometry||b.finish(),material=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.92});
 const resource=cached||{geometry,parts:b.parts,references:0,retained:true};resource.references++;
 if(!cached){geometryCache.set(key,resource);if(geometryCache.size>CACHE_LIMIT){const oldest=geometryCache.keys().next().value,old=geometryCache.get(oldest);geometryCache.delete(oldest);old.retained=false;if(!old.references)old.geometry.dispose();}}
 const mesh=new THREE.SkinnedMesh(geometry,material),group=new THREE.Group();mesh.name='block-worker';mesh.add(bones.root);group.add(mesh);mesh.castShadow=true;mesh.frustumCulled=false;
 group.updateMatrixWorld(true);const skeleton=new THREE.Skeleton(rig.list);mesh.bind(skeleton);
 const attachments={};for(const n of ['left','right']){const hand=new THREE.Group();hand.position.set(0,-glove*.35,glove*.4);bones[`${n}Wrist`].add(hand);attachments[`${n}Hand`]=hand;}
 const pb=createSurfaceBuilder(rig),pbox=(p,s,c)=>pb.box(p,s,new THREE.Color(c),skin('root'));
 if(a.prop==='ingot')pbox([0,0,.03],[.24,.11,.13],'#d6ad36');
 else if(a.prop==='clipboard'){pbox([0,0,.02],[.22,.29,.03],'#705133');pbox([0,0,.04],[.18,.24,.01],'#e5ddbf');}
 else if(a.prop==='tape'){pbox([0,0,.01],[.11,.09,.07],a.hatColor);pbox([0,-.1,.01],[.025,.18,.01],'#c5bc8e');}
 else {pbox([0,-.03,0],[.04,.40,.04],'#8d653b');pbox([0,-.20,0],[.24,.13,.13],'#515659');}
 const prop=new THREE.Mesh(pb.finish(),material);prop.castShadow=true;attachments.leftHand.add(prop);prop.visible=a.prop!=='none';
 function animate(time=0,amount=0){
  const t=Number.isFinite(time)?time:0,k=Number.isFinite(amount)?THREE.MathUtils.clamp(amount,0,1):0;
  for(const bone of rig.list){bone.rotation.set(0,0,0);bone.position.fromArray(bone.name==='root'?rig.points.root:rig.points[bone.name].map((v,i)=>v-rig.points[bone.parent.name][i]));}
  for(const s of [-1,1]){
   const n=s<0?'left':'right',v=Math.sin(t*3.7)*s*k;
   bones[`${n}Hip`].rotation.x=v*.60;bones[`${n}Knee`].rotation.x=Math.max(0,-v)*.90;
   bones[`${n}Shoulder`].rotation.x=-v*.55;bones[`${n}Elbow`].rotation.x=-Math.abs(v)*.40;
   bones[`${n}Foot`].rotation.x=-Math.max(0,-v)*.25;
  }
  bones.spine.rotation.z=Math.sin(t*3.7)*k*.05;
  bones.root.position.y=Math.abs(Math.sin(t*3.7))*k*.025;
  group.updateMatrixWorld(true);skeleton.update();
 }
 let disposed=false;const metrics={variant:'block',cellSize:.025,vertices:geometry.attributes.position.count,triangles:geometry.index.count/3,propTriangles:prop.geometry.index.count/3,drawCalls:prop.visible?2:1,bones:16,skinned:true,cells:b.parts.reduce((n,p)=>n+p.cells.size,0)};
 return{group,mesh,bones,skeleton,attachments,prop,animate,metrics,parts:b.parts,rigPoints:rig.points,dispose(){if(disposed)return;disposed=true;resource.references--;if(!resource.references&&!resource.retained)geometry.dispose();prop.geometry.dispose();material.dispose();skeleton.dispose();prop.removeFromParent();group.removeFromParent();}};
}
