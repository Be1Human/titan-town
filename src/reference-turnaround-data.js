import {REFERENCE_PEOPLE} from './reference-people-data.js';

// Keep the source face, clothes and limb grid; rebuild the hair in all three
// projections instead of extruding the silhouette from the front image.
function reconstruct(source,female){
 const hair=female?63:245,cells=new Map(source.voxels.filter(c=>c[3]!==hair&&!(c[2]===19&&c[3]===71)).map(c=>[c.slice(0,3).join(','),c]));
 function box(x0,x1,y0,y1,z0,z1){for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++)for(let z=z0;z<=z1;z++)cells.set([x,y,z].join(','),[x,y,z,hair]);}
 // Crown, broad middle layer and projecting three-cell forelock.
 box(13,19,14,18,24,25);box(14,18,14,18,26,26);
 box(15,17,14,17,27,28);box(15,17,13,13,26,28);
 box(14,18,13,13,24,25);
 if(female){
  // Symmetric layered bangs with an open five-cell-wide eye strip.
  box(13,19,13,13,23,23);box(16,16,13,13,22,22);
  box(13,13,13,16,21,24);box(19,19,13,16,21,24);
  box(13,13,13,14,18,20);box(19,19,13,14,18,20);
  box(12,12,13,14,19,20);box(20,20,13,14,19,20);
  // The back view has long hair and a stepped, tapering end, not a flat cap.
  box(13,19,17,18,19,24);box(14,18,17,19,17,21);
  box(15,17,18,19,16,18);box(16,16,18,19,15,16);
  // Recessed side layers make the silhouette readable from the side too.
  box(12,12,14,16,23,25);box(20,20,14,16,23,25);
 }else{
  box(13,13,14,17,20,24);box(19,19,14,17,21,24);
  box(14,18,18,18,20,24);box(13,19,17,17,21,25);
  box(14,14,13,13,23,23);box(17,18,13,13,23,23);
  // Connected, offset locks on the left: no detached floating cube.
  box(12,13,14,16,24,26);box(11,12,13,14,24,25);
  box(12,12,13,14,22,23);
 }
 const voxels=[...cells.values()].sort((a,b)=>a[2]-b[2]||a[1]-b[1]||a[0]-b[0]);
 return {...source,guide:'generated-reference-turnaround',voxelCount:voxels.length,voxels};
}
export const TURNAROUND_PEOPLE=Object.freeze({male:reconstruct(REFERENCE_PEOPLE.male,false),female:reconstruct(REFERENCE_PEOPLE.female,true)});
