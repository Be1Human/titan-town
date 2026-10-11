import {COLLISION_FACE_CLASSES} from './reference-collision-config.js';

// Worker-side collision traversal reads the immutable flattened index directly.
// Do not recreate a TypedArray view for every row on every physics step.
// Row/plane blank ranges, candidate order and edge/corner qualification are
// identical to VoxelCollisionData.forEachCandidate; no contact is simplified.
export function forEachPackedCandidate(lo,hi,allowEdges,visit){
  const g=this.grid,m=g.min,xs=this.xs,offsets=this.offsets;this.stats.scanned=0;
  for(let z=Math.max(0,lo.z-m.z);z<=Math.min(this.depth-1,hi.z-m.z);z++){
    const lowY=Math.max(0,lo.y-m.y,this.planes[z*2]),highY=Math.min(this.height-1,hi.y-m.y,this.height-1-this.planes[z*2+1]);
    for(let y=lowY;y<=highY;y++){
      const row=y+z*this.height,start=offsets[row],end=offsets[row+1],lowX=Math.max(0,lo.x-m.x,this.rows[row*2]),highX=Math.min(this.width-1,hi.x-m.x,this.width-1-this.rows[row*2+1]);
      if(start===end||lowX>highX)continue;
      let low=start,high=end;while(low<high){const mid=(low+high)>>>1;if(xs[mid]<lowX)low=mid+1;else high=mid;}
      const base=z*this.width+y*g.layer;
      for(let k=low;k<end&&xs[k]<=highX;k++){
        const x=xs[k],i=base+x,mask=this.mask[i];this.stats.scanned++;
        if(allowEdges||COLLISION_FACE_CLASSES[mask&63]===3)visit(i,x+m.x,y+m.y,z+m.z,mask);
      }
    }
  }
}
