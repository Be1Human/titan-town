import * as T from '../vendor/three.module.js';
import {normalizeAppearance,CHARACTER_CELL,CHARACTER_PARTS} from './character-config.js';
import {createSlimSkin} from './slim-skin.js';
import {cutBlockPolygons,skinFaceUV,insideCutBlock} from './cut-block-geometry.js';
import {createSkinClothing} from './skin-clothing.js';
import {softJawPolygons,insideSoftJaw,unwarpJawPoint} from './soft-jaw-geometry.js';

export const SLIM_STRUCTURE_VERSION=25;
export const SLIM_HEAD_SCALE=.605;
export const SLIM_SKIN_MAPPING_VERSION=2;
const cache=new Map(),LIMIT=16;
const ease=n=>{const t=Math.max(0,Math.min(1,n));return t*t*(3-2*t);};
const mix=(a,b,t)=>a+(b-a)*t;

// Approved white mannequin: a broad blank head, short trunk, a distinct
// crotch bridge and separated slim legs. The six source skin regions cover
// fifteen closed solids; hands/soles use the last source pixels, no extra skin.
export function createSlimWorker(input){
 const a=normalizeAppearance(input),leg=.545*a.legLength,pelvis=.085*a.legLength,foot=.085*a.legLength,limb=leg-pelvis,segment=(limb-foot)/2,torso=.335*a.torsoHeight,top=leg+torso,head=.52*a.headHeight*SLIM_HEAD_SCALE;
 // Reduce torso/pelvis depth while retaining the approved front silhouette.
 const tw=.295*a.torsoWidth,td=.185*a.torsoDepth,aw=.085*a.armSize,al=.38*a.armLength,ad=.10625*a.armSize,hand=al/4,handWidth=.112*a.armSize,handDepth=.135*a.armSize,lw=.10*a.legWidth,ld=.115*a.legWidth,lx=(lw+.060)/2,hw=.60*a.headWidth*SLIM_HEAD_SCALE,hd=.46*Math.sqrt(a.headWidth)*SLIM_HEAD_SCALE;
 // The slim rigid arms join the torso with a small overlap at the shoulder.
 const shoulderGap=0,shoulderOverlap=.015,armRootX=tw/2-shoulderOverlap,armRootY=top-.025;
 const group=new T.Group(),bones={},list=[],points={},index={};
 function bone(name,point,parent){const b=new T.Bone();b.name=name;points[name]=point;index[name]=list.length;list.push(b);bones[name]=b;b.position.fromArray(parent?point.map((v,i)=>v-points[parent][i]):point);if(parent)bones[parent].add(b);return b;}
 bone('root',[0,0,0]);bone('spine',[0,leg,0],'root');bone('head',[0,top,0],'spine');
 // Edge hinges fold the closed cuboids into each other at a flexed joint,
 // instead of opening a crack between their opposing cap faces.
 for(const s of [-1,1]){const side=s<0?'left':'right';bone(side+'Shoulder',[s*armRootX,armRootY,0],'spine');bone(side+'Elbow',[s*(armRootX+aw),armRootY-al/2,-ad/2],side+'Shoulder');bone(side+'Hip',[s*lx,limb,-ld/2],'root');bone(side+'Knee',[s*lx,foot+segment,ld/2],side+'Hip');}
 const boxes=[
  {name:'spine',part:0,center:[0,leg+torso/2,0],size:[tw,torso,td],pixels:[16,24,8]},
  {name:'head',part:1,center:[0,top+head/2,0],size:[hw,head,hd],pixels:[32,32,32],outerThickness:.016*SLIM_HEAD_SCALE},
  ...[-1,1].flatMap(s=>{const side=s<0?'left':'right';return[
   {name:side+'Shoulder',part:s<0?2:5,center:[s*(armRootX+aw/2),armRootY-al/4,0],size:[aw,al/2,ad],pixels:[6,16,8],skinName:side+'Shoulder',skinRange:[0,.5]},
   {name:side+'Elbow',part:s<0?3:6,center:[s*(armRootX+aw/2),armRootY-al*.625+.002,0],size:[aw,al/4+.004,ad],pixels:[6,8,8],skinName:side+'Shoulder',skinRange:[.5,.75]},
  ];}),
  ...[-1,1].flatMap(s=>{const side=s<0?'left':'right';return[
   {name:side+'Hip',part:s<0?8:11,center:[s*lx,foot+segment*1.5,0],size:[lw,segment,ld],pixels:[8,16,8],skinName:side+'Hip',skinRange:[1/12,.5]},
   {name:side+'Knee',part:s<0?9:12,center:[s*lx,foot+segment/2+.002,0],size:[lw,segment+.004,ld],pixels:[8,16,8],skinName:side+'Hip',skinRange:[.5,5/6]},
  ];}),
  // Only the first trouser/waist row belongs to the broad hip bridge.
  // The remaining upper-leg rows start on the narrow thighs, not the buttocks.
  {name:'spine',role:'pelvis',part:0,center:[0,leg-pelvis/2,0],size:[tw,pelvis,td],pixels:[16,4,8],skinRange:[0,1/12]},
  ...[-1,1].flatMap(s=>{const side=s<0?'left':'right';return[
   {name:side+'Hand',bone:side+'Elbow',role:'hand',part:s<0?3:6,center:[s*(armRootX+aw/2),armRootY-al+hand/2,0],size:[handWidth,hand,handDepth],pixels:[6,8,8],skinName:side+'Shoulder',skinRange:[.75,1]},
   {name:side+'Sole',bone:side+'Knee',role:'foot',part:s<0?9:12,center:[s*lx,foot/2,.035],size:[lw*1.14,foot,ld+.07],pixels:[8,8,10],skinName:side+'Hip',skinRange:[5/6,1]},
  ];}),
 ];
 for(const b of boxes)b.bevel=b.role==='foot'?.004:.003;
 boxes[1].jaw={inset:.14,depthInset:.05,height:.08,rounding:.2,radius:.012*SLIM_HEAD_SCALE,segments:[10,16,8]};
 boxes[1].crown={inset:.10,depthInset:.10,height:.10,rounding:.30};
 const shapes=boxes.map((b,row)=>({...b,row,skinBounds:b}));
 // Compatibility names refer to existing rigid bones, not new joints.
 bones.hips=bones.spine;points.hips=points.spine;
 for(const side of ['left','right'])for(const end of ['Wrist','Foot']){const owner=side+(end==='Foot'?'Knee':'Elbow');bones[side+end]=bones[owner];points[side+end]=[...points[owner]];}
 const key=JSON.stringify({structureVersion:SLIM_STRUCTURE_VERSION,skinMappingVersion:SLIM_SKIN_MAPPING_VERSION,...a,width:1,height:1});let resource=cache.get(key);
 if(!resource){
  const skin=createSlimSkin(a,boxes,shapes),positions=[],normals=[],uvs=[],indices=[],si=[],sw=[],tags=[],faces=[],colors=[],finishes=[],ranges=[];
  const parts=CHARACTER_PARTS.map((name,i)=>({name,index:i,origin:[...points[name]],cells:new Map()}));
  const seen=new Set();for(const b of boxes)if(!seen.has(b.part)){parts[b.part].origin=[...b.center];seen.add(b.part);}
  for(const b of shapes){
   const start=positions.length/3;
   for(const polygon of b.jaw?softJawPolygons(b):cutBlockPolygons(b.size,b.bevel)){
    const offset=positions.length/3,face=b.faceOverride??polygon.face,tile=skin.tiles[b.row][face];
    for(const [vertex,local] of polygon.points.entries()){const p=local.map((n,i)=>n+b.center[i]),source=(polygon.sourcePoints?.[vertex]||local).map((n,i)=>n+b.center[i]),uv=skinFaceUV(source,b.skinBounds,face);if(b.detail==='fringe')uv[1]=Math.min(.40,uv[1]);const [u,v]=uv;
     positions.push(...p.map(n=>Math.abs(n)<1e-7?0:n));normals.push(...(polygon.normals?.[vertex]||polygon.normal));uvs.push((tile.x+u*tile.width)/skin.width,1-(tile.y+v*tile.height)/skin.height);si.push(index[b.bone||b.name],0,0,0);sw.push(1,0,0,0);tags.push(b.part);faces.push(face);colors.push(1,1,1);finishes.push(.94,0);
    }
    for(let i=1;i<polygon.points.length-1;i++)indices.push(offset,offset+i,offset+i+1);
   }
   ranges.push({name:b.name,detail:b.role??b.detail??'body',part:b.part,start,count:positions.length/3-start});
   const part=parts[b.part],limits=b.size.map((n,i)=>[Math.floor((b.center[i]-n/2-part.origin[i])/CHARACTER_CELL),Math.ceil((b.center[i]+n/2-part.origin[i])/CHARACTER_CELL)]);
   for(let x=limits[0][0];x<limits[0][1];x++)for(let y=limits[1][0];y<limits[1][1];y++)for(let z=limits[2][0];z<limits[2][1];z++){
    const p=[x,y,z].map((n,i)=>part.origin[i]+(n+.5)*CHARACTER_CELL);const local=p.map((n,i)=>n-b.center[i]);if(!(b.jaw?insideSoftJaw(local,b):insideCutBlock(local,b.size,b.bevel)))continue;
    const tile=skin.tiles[b.row][4],[u,v]=skinFaceUV(unwarpJawPoint(p,b),b.skinBounds,4);part.cells.set([x,y,z].join(','),skin.sample((tile.x+u*tile.width)/skin.width,1-(tile.y+v*tile.height)/skin.height));
   }
  }
  for(const [part,x,y,z,color]of a.voxelEdits)if(color!==null&&parts[part].cells.has([x,y,z].join(',')))parts[part].cells.set([x,y,z].join(','),color);
  const geometry=new T.BufferGeometry();for(const [name,array,size,Type]of [['position',positions,3,T.Float32BufferAttribute],['normal',normals,3,T.Float32BufferAttribute],['uv',uvs,2,T.Float32BufferAttribute],['color',colors,3,T.Float32BufferAttribute],['workerSurface',finishes,2,T.Float32BufferAttribute],['skinIndex',si,4,T.Uint16BufferAttribute],['skinWeight',sw,4,T.Float32BufferAttribute],['characterPart',tags,1,T.Uint8BufferAttribute],['skinFace',faces,1,T.Uint8BufferAttribute]])geometry.setAttribute(name,new Type(array,size));
  geometry.setIndex(indices);geometry.computeBoundingBox();geometry.computeBoundingSphere();geometry.userData.planarCharacter=true;geometry.userData.textureOnly=true;geometry.userData.partRanges=ranges;
  resource={geometry,skin,parts,clothing:createSkinClothing(a,boxes,index),references:0,retained:true};cache.set(key,resource);
  if(cache.size>LIMIT){const old=cache.get(cache.keys().next().value);cache.delete(cache.keys().next().value);old.retained=false;if(!old.references){old.geometry.dispose();old.skin.texture.dispose();old.clothing.dispose();}}
 }else{cache.delete(key);cache.set(key,resource);}resource.references++;
 const material=new T.MeshStandardMaterial({map:resource.skin.texture,roughness:.94}),mesh=new T.SkinnedMesh(resource.geometry,material);mesh.name='crew-01-slim';mesh.castShadow=true;mesh.receiveShadow=true;mesh.frustumCulled=false;mesh.add(bones.root);group.add(mesh);group.updateMatrixWorld(true);const skeleton=new T.Skeleton(list);mesh.bind(skeleton);
 const clothingMaterial=new T.MeshStandardMaterial({map:resource.clothing.texture,roughness:.94,alphaTest:1/255,transparent:true,depthWrite:true});
 const clothingMesh=new T.SkinnedMesh(resource.clothing.geometry,clothingMaterial);clothingMesh.name='crew-01-outer-skin';clothingMesh.visible=resource.clothing.texels>0;clothingMesh.castShadow=clothingMesh.receiveShadow=true;clothingMesh.frustumCulled=false;group.add(clothingMesh);clothingMesh.bind(skeleton,mesh.bindMatrix);
 const attachments={},equipmentBones={};
 for(const side of ['left','right']){const g=new T.Group();g.position.set((side==='left'?1:-1)*aw/2,-al/2+.035,.06+ad/2);bones[side+'Elbow'].add(g);attachments[side+'Hand']=g;}
 for(const [name,y]of [['spine',torso/2],['hips',0]]){const g=new T.Group();g.position.y=y;bones.spine.add(g);equipmentBones[name]=g;}for(const side of ['left','right'])equipmentBones[side+'Shoulder']=bones[side+'Shoulder'];
 const propGeometry=new T.BufferGeometry();propGeometry.setAttribute('position',new T.Float32BufferAttribute([],3));propGeometry.setAttribute('color',new T.Float32BufferAttribute([],3));propGeometry.setIndex([]);propGeometry.boundingBox=new T.Box3(new T.Vector3(),new T.Vector3());propGeometry.boundingSphere=new T.Sphere(new T.Vector3(),0);const prop=new T.Mesh(propGeometry,material);prop.visible=false;attachments.leftHand.add(prop);
 const rest=list.map(b=>b.position.clone());
 function reset(){list.forEach((b,i)=>{b.position.copy(rest[i]);b.rotation.set(0,0,0);});}
 // Face-split voxel corners repeat the same bind position and skin weights;
 // one representative per distinct vertex gives the same lowest sole point.
 const soles=[mesh,...(clothingMesh.visible?[clothingMesh]:[])].map(m=>{const a=m.geometry.attributes,seen=new Set(),vertices=[];
  for(let i=0;i<a.characterPart.count;i++){if(![9,12].includes(a.characterPart.getX(i)))continue;const key=[a.position.getX(i),a.position.getY(i),a.position.getZ(i),a.skinIndex.getX(i),a.skinIndex.getY(i),a.skinIndex.getZ(i),a.skinIndex.getW(i),a.skinWeight.getX(i),a.skinWeight.getY(i),a.skinWeight.getZ(i),a.skinWeight.getW(i)].join();if(!seen.has(key)){seen.add(key);vertices.push(i);}}
  return {mesh:m,vertices};});
 const soleVertex=new T.Vector3();
 function ground(){group.updateMatrixWorld(true);skeleton.update();let y=Infinity;for(const sole of soles)for(const i of sole.vertices)y=Math.min(y,sole.mesh.getVertexPosition(i,soleVertex).y);bones.root.position.y-=y;}
 // Arms stay rigid through every pose; only the shoulder swings.
 // Elbow bones remain as stable skin/attachment owners with zero rotation.
 function animate(time=0,amount=0){reset();const k=Math.max(0,Math.min(1,amount)),phase=time*3.7;for(const s of [-1,1]){const side=s<0?'left':'right',swing=Math.sin(phase)*s*k;bones[side+'Hip'].rotation.set(-.13+swing*.48,0,s*.045);bones[side+'Knee'].rotation.set(.26+Math.max(0,-Math.cos(phase)*s)*k*.72,0,-s*.045);bones[side+'Shoulder'].rotation.set(-swing*.48,0,0);bones[side+'Elbow'].rotation.set(0,0,0);}ground();}
 function pose({action='idle',carrying=false,down=false,time=0,progress=0}={}){
  for(const side of ['left','right'])bones[side+'Elbow'].rotation.set(0,0,0);
  if(down)return true;bones.head.rotation.y=Math.sin(time*.65)*.025;
  if(action==='tpose'||action==='edit'){for(const s of [-1,1]){const side=s<0?'left':'right';bones[side+'Shoulder'].rotation.set(0,0,action==='tpose'?s*Math.PI/2:0);bones[side+'Elbow'].rotation.set(0,0,0);bones[side+'Hip'].rotation.set(0,0,0);bones[side+'Knee'].rotation.set(0,0,0);}}
  else if(carrying||action==='carry')for(const side of ['left','right']){bones[side+'Shoulder'].rotation.x=-.75;}
  else if(action==='hammer'){const p=Math.max(0,Math.min(1,progress)),wind=ease(p/.32),strike=ease((p-.32)/.18),recover=ease((p-.5)/.5);bones.leftShoulder.rotation.x=mix(mix(mix(-.5,-2.15,wind),-.45,strike),-.5,recover);bones.rightShoulder.rotation.x=-.25;}
  else if(action==='jump'){bones.leftShoulder.rotation.z=-.75;bones.rightShoulder.rotation.z=.75;for(const side of ['left','right']){bones[side+'Hip'].rotation.x=-.65;bones[side+'Knee'].rotation.x=1.1;}}
  else if(action==='run'){for(const side of ['left','right']){bones[side+'Hip'].rotation.x*=1.2;bones[side+'Knee'].rotation.x*=1.25;}}
  // Crouching also applies while the shoulders hold a tool or heavy cargo.
  if(action==='crouch'){for(const side of ['left','right']){bones[side+'Hip'].rotation.x=-.55;bones[side+'Knee'].rotation.x=1.1;}}
  ground();return true;
 }
 animate();group.updateMatrixWorld(true);skeleton.update();let disposed=false;
 const clothingTriangles=resource.clothing.geometry.index.count/3;
 const metrics={variant:'block',design:'approved-white-body',jaw:boxes[1].jaw,crown:boxes[1].crown,shoulderGap,shoulderOverlap,armSuspension:false,limbProfile:{upperArmWidth:aw,forearmWidth:aw,thighWidth:lw,calfWidth:lw,legGap:.060},template:a.template,structureVersion:SLIM_STRUCTURE_VERSION,skinMappingVersion:SLIM_SKIN_MAPPING_VERSION,bodyParts:boxes.length,logicalParts:6,geometryPieces:shapes.length+(clothingMesh.visible?1:0),textureOnly:!clothingMesh.visible,outerLayer:{texels:resource.clothing.texels,thickness:resource.clothing.thickness,triangles:clothingTriangles},cellSize:CHARACTER_CELL,cells:resource.parts.reduce((n,p)=>n+p.cells.size,0),bodyTriangles:resource.geometry.index.count/3,triangles:resource.geometry.index.count/3+clothingTriangles,vertices:resource.geometry.attributes.position.count+resource.clothing.geometry.attributes.position.count,propTriangles:0,drawCalls:1+(clothingMesh.visible?1:0),bones:11,skinned:true};
 return{group,mesh,clothingMesh,clothing:resource.clothing,prop,extraProps:[],bones,skeleton,attachments,equipmentBones,parts:resource.parts,rigPoints:points,boxes,skinAtlas:resource.skin,metrics,propSide:'left',propAttachment:attachments.leftHand,animate,pose,setPropsVisible(){prop.visible=false;},skinCell(part){const owner=/Wrist/.test(part)?part.replace(/Wrist/,'Elbow'):/Foot/.test(part)?part.replace(/Foot/,'Knee'):part;return{indices:[index[owner]??index.spine,0,0,0],weights:[1,0,0,0]};},
  dispose(){if(disposed)return;disposed=true;resource.references--;if(!resource.references&&!resource.retained){resource.geometry.dispose();resource.skin.texture.dispose();resource.clothing.dispose();}propGeometry.dispose();material.dispose();clothingMaterial.dispose();skeleton.dispose();group.removeFromParent();}};
}
