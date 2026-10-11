import {loadJSONResource} from '../../json-resource.js';
import {VoxelWorld,CELL,STRIDE,MATERIAL_IDS,chunkOf,localIndex} from '../../voxel-world.js';
import {meshChunk} from '../../mesher.js';
import {packVoxelSurfaces} from '../../voxel-surfaces.js';
import {importVoxAsset,VOX_LIMITS} from './vox-import.js';

// The authoring hierarchy survives render batching. Definitions are immutable;
// every placed instance writes to independent world cells and retains IDs.
const resourceCache=new Map();
const root=new URL('../../../assets/',import.meta.url);
const load=async p=>{if(!resourceCache.has(p))resourceCache.set(p,loadJSONResource(new URL(p,root)));return resourceCache.get(p);};
const modelCache=new WeakMap();
const paletteCache=new WeakMap();
function decode(model){
  if(modelCache.has(model))return modelCache.get(model);
  const data=new Uint8Array(model.size[0]*model.size[1]*model.size[2]);let offset=0;
  for(let i=0;i<model.runs.length;i+=2){data.fill(MATERIAL_IDS[model.materials[model.runs[i+1]]]??0,offset,offset+model.runs[i]);offset+=model.runs[i];}
  if(offset!==data.length)throw new Error('Invalid voxel resource length: '+model.name);
  modelCache.set(model,data);return data;
}
function matrix(rotation=[0,0,0]){
  const [x,y,z]=rotation.map(v=>v*Math.PI/180),cx=Math.cos(x),sx=Math.sin(x),cy=Math.cos(y),sy=Math.sin(y),cz=Math.cos(z),sz=Math.sin(z);
  return [cy*cz,-cy*sz,sy,sx*sy*cz+cx*sz,-sx*sy*sz+cx*cz,-sx*cy,-cx*sy*cz+sx*sz,cx*sy*sz+sx*cz,cx*cy];
}
const mul=(m,p)=>[0,1,2].map(i=>m[i*3]*p[0]+m[i*3+1]*p[1]+m[i*3+2]*p[2]);
const inverse=(m,p)=>[0,1,2].map(i=>(m[i]*p[0]+m[i+3]*p[1]+m[i+6]*p[2])/(m[i]*m[i]+m[i+3]*m[i+3]+m[i+6]*m[i+6]));
const compose=(a,b)=>[0,1,2].flatMap(i=>[0,1,2].map(j=>a[i*3]*b[j]+a[i*3+1]*b[j+3]+a[i*3+2]*b[j+6]));
export async function loadSceneAssets(scenePath){
  const scene=await load(scenePath),palette=await load(scene.palette),prefabs=new Map(),models=new Map();
  await Promise.all(Object.entries(scene.prefabs).map(async([id,p])=>prefabs.set(id,await load(p))));
  const paths=new Set([...prefabs.values()].flatMap(p=>p.shapes.map(s=>s.file)));
  await Promise.all([...paths].map(async p=>{
    if(!/\.vox$/i.test(p)){models.set(p,await load(p));return;}
    const url=new URL(p,root);let bytes;
    if(url.protocol==='file:'&&typeof process!=='undefined'&&process.versions?.node){const fs=await import('node:fs/promises');if((await fs.stat(url)).size>VOX_LIMITS.bytes)throw Error('VOX 文件超过 32 MB');bytes=await fs.readFile(url);}
    else{const response=await fetch(url);if(!response.ok)throw Error('VOX 资源加载失败：'+p);if(Number(response.headers.get('content-length'))>VOX_LIMITS.bytes)throw Error('VOX 文件超过 32 MB');bytes=await response.arrayBuffer();}
    models.set(p,importVoxAsset(bytes,{name:p.split('/').at(-1),assetId:p,...scene.voxImports?.[p]}).resource);
  }));
  if(scene.requireOriginalAssets){
    for(const resource of [palette,...prefabs.values(),...models.values()])if(resource.authorship!=='project-original')throw new Error('原创场景引用了非原创资产：'+(resource.assetId??resource.prefabId??resource.id));
  }
  return {scene,palette,prefabs,models,stats:{resourceFiles:paths.size,prefabs:prefabs.size}};
}
export function assembleVoxelScene(assets,{world=new VoxelWorld(),buildSurfaces=true,fillMissingOnly=false,filterCell=null}={}){
  const {scene,palette,prefabs,models}=assets,owners=world.assetOwners??new Map(),instances=world.assetInstances??new Map(),shapes=world.assetShapes??new Map(),lights=[],signs=[];
  const nativePaletteCells=world.nativePaletteCells??new Map(),nativePaletteRecords=world.nativePaletteRecords??new Map();
  let ownerId=shapes.size;
  function set(x,y,z,id,owner=0,nativeIndex=0){
    if(y<0||y>=256||x<-512||x>=512||z<-512||z>=512)return;
    if(filterCell&&!filterCell(x,y,z,id))return;
    const key=chunkOf(x,y,z),c=world.getChunk(key,Boolean(id));if(!c)return;const i=localIndex(x,y,z),old=c.data[i];
    if(fillMissingOnly&&old)id=old;
    c.data[i]=id;const delta=Number(Boolean(id))-Number(Boolean(old));c.count+=delta;world.count+=delta;
    if(owner){let data=owners.get(key);if(!data){data=new Uint16Array(32768);owners.set(key,data);}data[i]=owner;}
    if(nativeIndex){let data=nativePaletteCells.get(key);if(!data){data=new Uint8Array(32768);nativePaletteCells.set(key,data);}data[i]=nativeIndex;}
  }
  const foundation=world.foundation??new Int16Array(STRIDE*STRIDE).fill(-1),terrain=world.terrainColumns??new Int16Array(STRIDE*STRIDE).fill(-1);
  const pathDistance=(x,z,a,b)=>{const dx=b[0]-a[0],dz=b[1]-a[1],t=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/(dx*dx+dz*dz)));return Math.hypot(x-a[0]-dx*t,z-a[1]-dz*t);};
  const ground=scene.terrain;
  if(ground)for(let z=Math.round(ground.min[1]/CELL);z<Math.round(ground.max[1]/CELL);z++)for(let x=Math.round(ground.min[0]/CELL);x<Math.round(ground.max[0]/CELL);x++){
    const px=(x+.5)*CELL,pz=(z+.5)*CELL;
    let path=ground.paths.some(p=>p.points.slice(1).some((b,i)=>pathDistance(px,pz,p.points[i],b)<p.width/2));
    path||=ground.plazas.some(p=>Math.hypot(px-p.center[0],pz-p.center[1])<p.radius);
    const stream=ground.stream.points.slice(1).some((b,i)=>pathDistance(px,pz,ground.stream.points[i],b)<ground.stream.width/2);
    // Authored solid depth is opt-in; existing scenes retain their exact grid.
    const height=stream?(ground.streamHeightCells??1):(ground.heightCells??3),index=x+512+(z+512)*STRIDE;
    if(!Number.isInteger(height)||height<1||height>255)throw Error('Invalid terrain voxel height');
    for(let y=0;y<height;y++)set(x,y,z,MATERIAL_IDS[y<height-1?'stone':stream?'stone':path?'concrete':'leaf']);
    foundation[index]=height-1;terrain[index]=height;
  }
  for(const placement of scene.instances){
    const prefab=prefabs.get(placement.prefab);if(!prefab)throw new Error('Unknown prefab '+placement.prefab);
    const base=matrix(placement.rotation).map(v=>v*(placement.scale??1)),origin=placement.position;
    const instance={instanceId:placement.id,prefabId:prefab.prefabId,shapeIds:[],bodyIds:prefab.bodies.map(b=>placement.id+'/'+b.id),tags:prefab.tags??[]};instances.set(placement.id,instance);
    for(const shape of prefab.shapes){
      const resource=models.get(shape.file),model=resource.models.find(m=>m.name===shape.object);if(!model)throw new Error('Missing model '+shape.object);
      const data=decode(model),cell=resource.cellSize??CELL,rotation=compose(base,matrix(shape.rotation)),offset=mul(base,shape.position??[0,0,0]).map((v,i)=>v+origin[i]);
      if(!Number.isFinite(cell)||cell<=0)throw Error('Invalid asset cell size');
      const corners=[];for(let a=0;a<8;a++)corners.push(mul(rotation,model.origin.map((v,i)=>v+((a>>i)&1)*model.size[i]*cell)).map((v,i)=>v+offset[i]));
      const lo=[0,1,2].map(i=>Math.floor(Math.min(...corners.map(p=>p[i]))/CELL+1e-6)),hi=[0,1,2].map(i=>Math.ceil(Math.max(...corners.map(p=>p[i]))/CELL-1e-6));
      const numericId=++ownerId;if(numericId>65535)throw new Error('Scene shape budget exceeded');
      const descriptor={shapeId:placement.id+'/'+shape.id,instanceId:placement.id,assetId:resource.assetId,model:model.name,bodyId:placement.id+'/'+shape.body,numericId,bounds:{min:lo.map(v=>v*CELL),max:hi.map(v=>v*CELL)},motion:prefab.bodies.find(b=>b.id===shape.body)?.motion??'static',resource:shape.file};
      shapes.set(numericId,descriptor);instance.shapeIds.push(descriptor.shapeId);
      let nativePalette;
      if(model.nativePaletteBase64){
        if(!paletteCache.has(model))paletteCache.set(model,Uint8Array.from(atob(model.nativePaletteBase64),c=>c.charCodeAt(0)));
        nativePalette=paletteCache.get(model);
        if(nativePalette.length!==data.length)throw new Error('Invalid native palette length: '+model.name);
        nativePaletteRecords.set(numericId,{...descriptor,min:lo,max:hi,palette:resource.palette,paletteAppearance:resource.paletteAppearance,source:resource.source});
      }
      const aligned=Math.abs(cell-CELL)<1e-8&&rotation.every((v,i)=>Math.abs(v-(i%4===0?1:0))<1e-8)&&offset.every(v=>Math.abs(v/CELL-Math.round(v/CELL))<1e-6);
      if(aligned){
        const start=model.origin.map((v,i)=>Math.round((v+offset[i])/CELL));
        for(let y=0;y<model.size[1];y++)for(let z=0;z<model.size[2];z++)for(let x=0;x<model.size[0];x++){
          const i=x+z*model.size[0]+y*model.size[0]*model.size[2],id=data[i];
          if(id)set(start[0]+x,start[1]+y,start[2]+z,id,numericId,nativePalette?.[x+model.size[0]*(y+model.size[1]*z)]??0);
        }
      }else for(let y=lo[1];y<hi[1];y++)for(let z=lo[2];z<hi[2];z++)for(let x=lo[0];x<hi[0];x++){
        const p=inverse(rotation,[(x+.5)*CELL-offset[0],(y+.5)*CELL-offset[1],(z+.5)*CELL-offset[2]]),q=p.map((v,i)=>Math.floor((v-model.origin[i])/cell+1e-6));
        if(q.some((v,i)=>v<0||v>=model.size[i]))continue;
        const id=data[q[0]+q[2]*model.size[0]+q[1]*model.size[0]*model.size[2]];if(id)set(x,y,z,id,numericId,nativePalette?.[q[0]+model.size[0]*(q[1]+model.size[1]*q[2])]??0);
      }
    }
    for(const lamp of prefab.lights??[]){const p=mul(base,lamp.position).map((v,i)=>v+origin[i]);lights.push({...lamp,id:placement.id+'/'+lamp.id,position:p,anchor:mul(base,lamp.anchor??lamp.position).map((v,i)=>v+origin[i])});}
    for(const sign of prefab.signs??[]){const p=mul(base,sign.position).map((v,i)=>v+origin[i]);signs.push({...sign,text:placement.signText??sign.text,x:p[0],y:p[1],z:p[2],rotation:(placement.rotation?.[1]??0)*Math.PI/180,style:'park-enamel'});}
  }
  world.foundation=foundation;world.terrainColumns=terrain;world.terrainVersion=1;
  world.assetInstances=instances;world.assetShapes=shapes;world.assetOwners=owners;
  if(nativePaletteRecords.size){world.nativePaletteCells=nativePaletteCells;world.nativePaletteRecords=nativePaletteRecords;}
  world.sourceShapeAt=(x,y,z)=>shapes.get(owners.get(chunkOf(x,y,z))?.[localIndex(x,y,z)])??null;
  world.shapeAt=(x,y,z)=>world.getId(x,y,z)?world.sourceShapeAt(x,y,z):null;
  world.palette=Object.fromEntries(Object.entries(palette.materials).map(([id,m])=>[id,Number.parseInt(m.color.slice(1),16)]));
  world.materialProfiles=palette.materials;world.mapId=scene.id;world.bounds=scene.bounds;world.floorAt=()=>0;world.gravity=9.81;world.respawn=scene.points.middle;
  for(const [key,c]of world.chunks){c.revision++;world.dirty.add(key);world.lightDirty.add(key);world.supportDirty.add(key);}
  world.revision++;let snapshot=null;
  if(buildSurfaces){const surfaces=new Map();for(const [key,c]of world.chunks)if(c.count)surfaces.set(key,packVoxelSurfaces(meshChunk(world,c),c));world.voxelSurfaces=surfaces;world.initialChunks=world.chunks;snapshot=world.snapshot();}
  return {world,snapshot,scene,lights,signs,stats:{...assets.stats,instances:instances.size,shapes:shapes.size,voxels:world.count,ownershipBytes:[...owners.values()].reduce((n,a)=>n+a.byteLength,0)}};
}
