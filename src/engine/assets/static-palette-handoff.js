import {chunkOf,localIndex} from '../../voxel-world.js';
import {MATERIALS} from '../../materials.js';

// Collapse can join cells from multiple resources. Remap their independent
// palette IDs without changing occupancy, material strength, or body grouping.
// Wider mesh palettes keep all colours; the 8-bit ray backend falls back to mesh.
export function staticPaletteHandoff(world,cells){
 if(!world.nativePaletteRecords?.size||!cells.some(c=>world.nativePaletteRecords.has(world.sourceShapeAt?.(c.x,c.y,c.z)?.numericId)))return {cells};
 const palette={},indices=new Map(),result=[];
 for(const c of cells){
  const source=world.sourceShapeAt?.(c.x,c.y,c.z),record=world.nativePaletteRecords.get(source?.numericId),key=chunkOf(c.x,c.y,c.z),index=world.nativePaletteCells?.get(key)?.[localIndex(c.x,c.y,c.z)];
  let p=record?.paletteAppearance?.[index];
  if(!p){const hex=world.palette?.[c.mat]??MATERIALS[c.mat]?.color??0x888888;p={rgba:record?.palette?.[index]??[(hex>>16)&255,(hex>>8)&255,hex&255,255],roughness:.9,metalness:0,opacity:c.mat==='glass'?.5:1,emission:0};}
  const signature=JSON.stringify(p);let id=indices.get(signature);if(!id){id=indices.size+1;if(id>65535)throw Error('Detached palette exceeds mesh colour budget');indices.set(signature,id);palette[id]=p;}
  result.push({...c,paletteIndex:id});
 }return {cells:result,palette};
}

// Same palette policy, yielded for queued large components. The static source
// remains authoritative until the entire body is prepared and admitted.
export function* prepareStaticPaletteHandoff(world,cells){
 let native=false;
 if(world.nativePaletteRecords?.size)for(let i=0;i<cells.length;i++){
  const c=cells[i];
  if(world.nativePaletteRecords.has(world.sourceShapeAt?.(c.x,c.y,c.z)?.numericId)){native=true;break;}
  if((i+1)%256===0)yield 'palette-source';
 }
 if(!native)return {cells};
 const palette={},indices=new Map(),result=[];
 for(let i=0;i<cells.length;i++){
  const c=cells[i],source=world.sourceShapeAt?.(c.x,c.y,c.z),record=world.nativePaletteRecords.get(source?.numericId),key=chunkOf(c.x,c.y,c.z),index=world.nativePaletteCells?.get(key)?.[localIndex(c.x,c.y,c.z)];
  let p=record?.paletteAppearance?.[index];
  if(!p){const hex=world.palette?.[c.mat]??MATERIALS[c.mat]?.color??0x888888;p={rgba:record?.palette?.[index]??[(hex>>16)&255,(hex>>8)&255,hex&255,255],roughness:.9,metalness:0,opacity:c.mat==='glass'?.5:1,emission:0};}
  const signature=JSON.stringify(p);let id=indices.get(signature);if(!id){id=indices.size+1;if(id>65535)throw Error('Detached palette exceeds mesh colour budget');indices.set(signature,id);palette[id]=p;}
  result.push({...c,paletteIndex:id});
  if((i+1)%256===0)yield 'palette';
 }
 return {cells:result,palette};
}
