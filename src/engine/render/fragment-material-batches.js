import {MATERIAL_IDS} from '../../voxel-world.js';
// Chunk seams need not create extra draw calls in one rigid object's surface.
// Reorder opaque triangle indices only; keep every vertex, face, and material.
// Transparent groups retain separate draws and their original relative order.
export function batchFragmentMaterials(geometry,palette){
  const index=geometry.index;if(!index||geometry.groups.length<2)return geometry;
  const buckets=[],byMaterial=new Map();let total=0;
  for(const group of geometry.groups){
    const transparent=palette?(palette[group.materialIndex]?.opacity??1)<1:group.materialIndex===MATERIAL_IDS.glass;
    let bucket=transparent?null:byMaterial.get(group.materialIndex);
    if(!bucket){bucket={materialIndex:group.materialIndex,groups:[],count:0};buckets.push(bucket);if(!transparent)byMaterial.set(group.materialIndex,bucket);}
    bucket.groups.push(group);bucket.count+=group.count;total+=group.count;
  }
  if(buckets.length===geometry.groups.length||total!==index.count)return geometry;
  const next=new index.array.constructor(index.count);let write=0;geometry.clearGroups();
  for(const bucket of buckets){const start=write;for(const group of bucket.groups){next.set(index.array.subarray(group.start,group.start+group.count),write);write+=group.count;}geometry.addGroup(start,bucket.count,bucket.materialIndex);}
  index.array=next;index.needsUpdate=true;return geometry;
}
