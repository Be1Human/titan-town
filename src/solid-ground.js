import {CHUNK,STRIDE,MATERIAL_IDS,chunkOf,localIndex} from './voxel-world.js';

export const TERRAIN_VERSION=1;

// The importer records the lowest sand/floor surface, independently of the
// façade fixing heights. Stop at the lowest existing voxel in each column:
// a ceiling or upper floor must never fill a passage beneath it.
export function groundColumns(world,runs){
  const columns=new Int16Array(STRIDE*STRIDE).fill(-1);
  let offset=0;
  for(let i=0;i<runs.length;i+=2){columns.fill(runs[i+1],offset,offset+runs[i]);offset+=runs[i];}
  const lowest=new Int16Array(STRIDE*STRIDE).fill(256);
  for(const c of world.chunks.values())for(let z=0;z<CHUNK;z++)for(let x=0;x<CHUNK;x++){
    const column=c.x+x+512+(c.z+z+512)*STRIDE;
    if(lowest[column]<=c.y)continue;
    for(let y=0;y<CHUNK&&c.y+y<lowest[column];y++)if(c.data[x+z*32+y*1024]){lowest[column]=c.y+y;break;}
  }
  // The imported foundation includes only upward concrete/sand/floor faces.
  // Stone and brick stairs and some plaster floors have no height entry.
  // Recognize their *lowest* original slab only when a player fits above it;
  // filling stops at its first solid voxel, preserving every cavity above.
  const candidates=new Int16Array(STRIDE*STRIDE).fill(-1);
  for(let z=0;z<STRIDE;z++)for(let x=0;x<STRIDE;x++){
    const column=x+z*STRIDE,low=lowest[column];
    if(columns[column]>=0){columns[column]=Math.min(columns[column],low);continue;}
    if(low===256)continue;
    const vx=x-512,vz=z-512;let top=low;
    while(top+1<256&&world.getId(vx,top+1,vz))top++;
    const thickness=top-low+1;
    if(thickness<2||thickness>6||top>120||top+17>=256)continue;
    let clear=true;
    for(let y=top+1;y<=top+17;y++)if(world.getId(vx,y,vz)){clear=false;break;}
    if(!clear)continue;
    // Broad high plaster roofs can cover open passages. Extend high slabs only
    // where the imported ground map confirms a nearby floor at that height.
    const material=world.getId(vx,top,vz);
    if(top>80&&(material===MATERIAL_IDS.plaster||material===MATERIAL_IDS.concrete)){
      let besideGround=false;
      for(let dz=-10;dz<=10&&!besideGround;dz++)for(let dx=-10;dx<=10;dx++){
        const nx=x+dx,nz=z+dz;if(nx<0||nx>=STRIDE||nz<0||nz>=STRIDE)continue;
        const nearby=columns[nx+nz*STRIDE];
        if(nearby>=0&&Math.abs(nearby-top)<=12){besideGround=true;break;}
      }
      if(!besideGround)continue;
    }
    candidates[column]=top;
  }
  // A standing area must be wider than a thin façade trim or isolated prop.
  // Small height changes within the neighbourhood include playable stairs.
  for(let z=2;z<STRIDE-2;z++)for(let x=2;x<STRIDE-2;x++){
    const column=x+z*STRIDE,top=candidates[column];if(top<0)continue;
    let neighbours=0;
    for(let dz=-2;dz<=2;dz++)for(let dx=-2;dx<=2;dx++)if(dx||dz){
      const other=candidates[column+dx+dz*STRIDE];if(other>=0&&Math.abs(other-top)<=5)neighbours++;
    }
    if(neighbours>=8)columns[column]=lowest[column];
  }
  return columns;
}

// Bulk initialization/migration only. Normal destruction still uses set(),
// so meshes, lighting, collision and support all see the same solid voxels.
export function fillGround(world,columns,{migrate=false}={}){
  const changed=new Set(),dirty=new Set(),id=MATERIAL_IDS.concrete;
  let added=0;
  for(let z=-512;z<512;z++)for(let x=-512;x<512;x++){
    const top=columns[x+512+(z+512)*STRIDE];
    for(let y=0;y<top;y+=CHUNK){
      const c=world.getChunk(chunkOf(x,y,z),true),end=Math.min(CHUNK,top-y),base=localIndex(x,0,z);
      let count=0;
      for(let dy=0;dy<end;dy++)if(!c.data[base+dy*1024]){
        // A prop can overlap the original underside. Do not replace a prop
        // deleted in an old save with concrete; copy only baseline ground.
        if(migrate&&world.initialChunks&&world.getOriginalId(x,y+dy,z)!==id)continue;
        c.data[base+dy*1024]=id;count++;
      }
      if(count){c.count+=count;added+=count;changed.add(c.key);}
    }
  }
  for(const key of changed){
    const c=world.chunks.get(key);
    world.snapshotCache.delete(key);world.supportDirty.add(key);
    // Neighbours can lose an exposed face even when their own bytes are intact.
    for(const [dx,dy,dz] of [[0,0,0],[-32,0,0],[32,0,0],[0,-32,0],[0,32,0],[0,0,-32],[0,0,32]]){
      const x=c.x+dx,y=c.y+dy,z=c.z+dz;
      if(x<-512||x>=512||y<0||y>=256||z<-512||z>=512)continue;
      const k=chunkOf(x,y,z);dirty.add(k);world.dirty.add(k);world.lightDirty.add(k);world.altered.add(k);
    }
  }
  world.count+=added;if(added)world.revision++;
  world.terrainColumns=columns;world.terrainVersion=TERRAIN_VERSION;
  return {added,changed,dirty};
}

export function restoreLevelSnapshot(world,snapshot){
  world.restore(snapshot);
  const migrated=(snapshot.terrainVersion??0)<TERRAIN_VERSION;
  if(migrated&&world.terrainColumns){
    const altered=world.altered;
    world.altered=new Set(altered);fillGround(world,world.terrainColumns,{migrate:true});
    // The added ground belongs to the new intact baseline, not to the save's
    // destruction. Retain only the player's actual cuts in source partitions.
    world.altered=altered;
  }
  return migrated;
}
