import {referenceMaterialFor} from '../core/reference-materials.js';
import {COLLISION_FACE_CLASSES} from './reference-collision-config.js';

// Source mechanisms: 140105E60 (physical occupancy + six exposed faces),
// 140106600 (saturated slice/row blank ranges). Project storage is x/z/y;
// range-table rows are indexed y + height*z. Never reinterpret its axes.
export const COLLISION_OCCUPIED=0x80;
export const COLLISION_FACE_MASK=0x3f;
const directions=[[-1,0,0,1],[1,0,0,2],[0,-1,0,4],[0,1,0,8],[0,0,-1,16],[0,0,1,32]];
const EMPTY_ROW=new Uint32Array(0);

export class VoxelCollisionData {
  constructor(grid,materialAt,{defer=false,outsidePhysical=()=>false}={}) {
    this.grid=grid;this.materialAt=materialAt;
    this.outsidePhysical=outsidePhysical;
    this.width=grid.width;this.height=grid.max.y-grid.min.y;this.depth=grid.depth;
    this.mask=new Uint8Array(grid.data.length);
    this.planes=new Uint8Array(2*this.depth);this.rows=new Uint8Array(2*this.height*this.depth);
    // Exact index of the source table's edge/corner candidates. This is an
    // implementation acceleration, not a recovered native buffer layout.
    // Rows retain the native z/y/x visit order; target lookup still reads mask.
    this.featureRows=new Array(this.height*this.depth);this.featureBytes=0;
    // Target queries must include flat faces (class 2), in addition to source
    // edge/corner candidates. Both indices derive from the SAME live mask.
    this.surfaceRows=new Array(this.height*this.depth);this.surfaceIndexBytes=0;
    this.revision=-1;this.contentRevision=0;this.stats={occupied:0,surface:0,rebuilds:0,updatedCells:0,scanned:0};
    if(!defer)for(const _ of this.prepare()){}
  }
  get byteLength(){return this.mask.byteLength+this.planes.byteLength+this.rows.byteLength+this.featureBytes+this.surfaceIndexBytes;}
  index(x,y,z){
    if(x<0||y<0||z<0||x>=this.width||y>=this.height||z>=this.depth)return -1;
    return x+z*this.width+y*this.grid.layer;
  }
  coordinates(i){return [i%this.width,Math.floor(i/this.grid.layer),Math.floor(i/this.width)%this.depth];}
  physical(i){return i>=0&&this.grid.data[i]!==0&&referenceMaterialFor(this.materialAt(i)).physical;}
  _write(i){
    const old=this.mask[i];let value=0;
    if(this.physical(i)){
      value=COLLISION_OCCUPIED;const [x,y,z]=this.coordinates(i);
      for(const [dx,dy,dz,bit]of directions){const j=this.index(x+dx,y+dy,z+dz),solid=j>=0?this.physical(j):this.outsidePhysical(x+dx+this.grid.min.x,y+dy+this.grid.min.y,z+dz+this.grid.min.z);if(!solid)value|=bit;}
    }
    this.mask[i]=value;this.stats.occupied+=Boolean(value&128)-Boolean(old&128);this.stats.surface+=Boolean(value&63)-Boolean(old&63);
  }
  _row(y,z){
    const start=z*this.width+y*this.grid.layer;let a=0,b=this.width-1;
    while(a<this.width&&!this.grid.data[start+a])a++;
    while(b>=0&&!this.grid.data[start+b])b--;
    const row=2*(y+z*this.height);this.rows[row]=Math.min(255,a);this.rows[row+1]=Math.min(255,this.width-1-b);
  }
  _plane(z){
    let a=0,b=this.height-1;
    const empty=y=>{const start=z*this.width+y*this.grid.layer;for(let x=0;x<this.width;x++)if(this.grid.data[start+x])return false;return true;};
    while(a<this.height&&empty(a))a++;while(b>=0&&empty(b))b--;
    this.planes[z*2]=Math.min(255,a);this.planes[z*2+1]=Math.min(255,this.height-1-b);
  }
  _features(y,z){
    const row=y+z*this.height,start=z*this.width+y*this.grid.layer,xs=[],surface=[];
    for(let x=0;x<this.width;x++){const category=COLLISION_FACE_CLASSES[this.mask[start+x]&63];if(category)surface.push(x);if(category&0xfd)xs.push(x);}
    this.featureBytes-=this.featureRows[row]?.byteLength||0;
    this.featureRows[row]=xs.length?Uint32Array.from(xs):EMPTY_ROW;this.featureBytes+=this.featureRows[row].byteLength;
    this.surfaceIndexBytes-=this.surfaceRows[row]?.byteLength||0;this.surfaceRows[row]=surface.length?Uint32Array.from(surface):EMPTY_ROW;this.surfaceIndexBytes+=this.surfaceRows[row].byteLength;
  }
  *prepare(batch=512){
    // All physical-neighbour decisions read the current source volume, not
    // partially populated mask bytes. No source voxel is modified.
    let work=0;
    for(let i=0;i<this.mask.length;i++){this._write(i);if(++work>=batch){work=0;yield 'collision-faces';}}
    for(let z=0;z<this.depth;z++){
      for(let y=0;y<this.height;y++){this._row(y,z);this._features(y,z);if(++work>=batch){work=0;yield 'collision-ranges';}}
      this._plane(z);yield 'collision-ranges';
    }
    this.stats.rebuilds++;this.contentRevision++;return this;
  }
  update(removedIndices){
    const touched=new Set(),rows=new Set(),planes=new Set(),featureRows=new Set();
    for(const i of removedIndices){if(i<0||i>=this.mask.length)continue;const [x,y,z]=this.coordinates(i);
      touched.add(i);rows.add(y+z*this.height);planes.add(z);
      for(const [dx,dy,dz]of directions){const j=this.index(x+dx,y+dy,z+dz);if(j>=0)touched.add(j);}
    }
    for(const i of touched){this._write(i);const [,y,z]=this.coordinates(i);featureRows.add(y+z*this.height);}
    for(const row of featureRows)this._features(row%this.height,Math.floor(row/this.height));
    for(const row of rows)this._row(row%this.height,Math.floor(row/this.height));
    for(const z of planes)this._plane(z);
    this.stats.updatedCells+=touched.size;
    this.contentRevision++;
  }
  refreshFaces(indices){
    const rows=new Set();for(const i of indices)if(i>=0&&i<this.mask.length){this._write(i);const [,y,z]=this.coordinates(i);rows.add(y+z*this.height);}
    for(const row of rows)this._features(row%this.height,Math.floor(row/this.height));this.stats.updatedCells+=indices.length;this.contentRevision++;
  }
  forEachCandidate(lo,hi,allowEdges,visit){
    const g=this.grid,m=g.min;this.stats.scanned=0;
    for(let z=Math.max(0,lo.z-m.z);z<=Math.min(this.depth-1,hi.z-m.z);z++){
      const lowY=Math.max(0,lo.y-m.y,this.planes[z*2]),highY=Math.min(this.height-1,hi.y-m.y,this.height-1-this.planes[z*2+1]);
      for(let y=lowY;y<=highY;y++){
        const row=y+z*this.height,xs=this.featureRows[row],lowX=Math.max(0,lo.x-m.x,this.rows[row*2]),highX=Math.min(this.width-1,hi.x-m.x,this.width-1-this.rows[row*2+1]);
        if(!xs?.length||lowX>highX)continue;
        // Binary search is only a skip over already-proven ineligible cells.
        let low=0,high=xs.length;while(low<high){const mid=(low+high)>>>1;if(xs[mid]<lowX)low=mid+1;else high=mid;}
        const start=z*this.width+y*g.layer;
        for(let k=low;k<xs.length&&xs[k]<=highX;k++){
          const x=xs[k],i=start+x,mask=this.mask[i];this.stats.scanned++;
          if(allowEdges||COLLISION_FACE_CLASSES[mask&63]===3)visit(i,x+m.x,y+m.y,z+m.z,mask);
        }
      }
    }
  }
  forEachSurface(lo,hi,visit){
    const g=this.grid,m=g.min;this.stats.scanned=0;
    for(let z=Math.max(0,lo.z-m.z);z<=Math.min(this.depth-1,hi.z-m.z);z++){
      const lowY=Math.max(0,lo.y-m.y,this.planes[z*2]),highY=Math.min(this.height-1,hi.y-m.y,this.height-1-this.planes[z*2+1]);
      for(let y=lowY;y<=highY;y++){
        const row=2*(y+z*this.height),lowX=Math.max(0,lo.x-m.x,this.rows[row]),highX=Math.min(this.width-1,hi.x-m.x,this.width-1-this.rows[row+1]);
        let i=lowX+z*this.width+y*g.layer;
        for(let x=lowX;x<=highX;x++,i++){this.stats.scanned++;if(this.mask[i]&63)visit(i,x+m.x,y+m.y,z+m.z,this.mask[i]);}
      }
    }
  }
}

export function collisionDataForEntry(entry){
  let cache=entry.collisionData;
  if(!cache||cache.grid!==entry.grid){cache=new VoxelCollisionData(entry.grid,i=>entry.cells[entry.grid.data[i]-1]?.mat);cache.revision=entry.revision;entry.collisionData=cache;return cache;}
  if(cache.revision===entry.revision)return cache;
  const edits=(entry.voxelEdits||[]).filter(e=>e.revision>cache.revision);
  if(edits.length&&edits[0].revision===cache.revision+1&&edits.at(-1).revision===entry.revision){
    const g=entry.grid,indices=[];
    for(const edit of edits)for(const c of edit.removed)indices.push(c.x-g.min.x+(c.z-g.min.z)*g.width+(c.y-g.min.y)*g.layer);
    cache.update(indices);cache.revision=entry.revision;return cache;
  }
  cache=new VoxelCollisionData(entry.grid,i=>entry.cells[entry.grid.data[i]-1]?.mat);cache.revision=entry.revision;entry.collisionData=cache;return cache;
}
