const cache=new WeakMap();
// Material banks describe all author palette entries. Only groups intersecting
// this drawRange submit triangles. Cache IDs, never material objects or values.
export function activeMaterialIndices(geometry){
 const total=geometry.index?.count??geometry.attributes.position?.count??0,start=Math.max(0,geometry.drawRange.start),end=Math.min(total,start+geometry.drawRange.count),groups=geometry.groups,old=cache.get(geometry);
 if(old&&old.total===total&&old.start===start&&old.end===end&&old.groups.length===groups.length*3&&groups.every((g,i)=>old.groups[i*3]===g.start&&old.groups[i*3+1]===g.count&&old.groups[i*3+2]===g.materialIndex))return old.indices;
 const used=new Set();for(const g of groups)if(Math.min(end,g.start+g.count)>Math.max(start,g.start))used.add(g.materialIndex);
 const indices=[...used];cache.set(geometry,{total,start,end,groups:groups.flatMap(g=>[g.start,g.count,g.materialIndex]),indices});return indices;
}
