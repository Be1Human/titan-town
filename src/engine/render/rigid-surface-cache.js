import * as THREE from '../../../vendor/three.module.js';
import {fragmentChunks,fragmentChunkGeometry} from './fragment-geometry.js';
import {sliceId} from './fragment-page-mesher.js';
import {styleVoxelGeometry} from '../../voxel-material.js';
import {restoreFragmentGeometry} from './fragment-transfer.js';
const users=new WeakMap();
const retain=g=>users.set(g,(users.get(g)||0)+1);
const release=g=>{const n=(users.get(g)||1)-1;if(n)users.set(g,n);else{users.delete(g);g.dispose();}};
const strides=[1,1024,32];
function sameBoundary(a,b,axis,edge){if(a===b)return true;const base=edge*strides[axis],du=strides[(axis+1)%3],dv=strides[(axis+2)%3];for(let u=0;u<32;u++)for(let v=0;v<32;v++){const i=base+u*du+v*dv;if((a?.data[i]||0)!==(b?.data[i]||0))return false;}return true;}
// A Body owns stable local surface pages. Pages are rendering resources, never
// artificial disconnected physics bodies. Neighbour occupancy is shared, so
// no page boundary emits an internal face or closes an authored air pocket.
export class RigidSurfaceCache{
  constructor(entry,material,prepared,parent,{slices=true}={}){
    this.slices=slices;this.group=new THREE.Group();this.group.name=entry.name||entry.assetIdentity?.sourceShapeIds?.join(' + ')||entry.id;
    this.center={...(parent?.center??entry.center)};this.cellSize=entry.cellSize;this.revision=entry.revision;this.cells=entry.cells;this.material=material;this.meshes=new Map();
    this.dirtyPages=new Set();this.stats={initialPages:0,rebuiltPages:0,localUpdates:0,reusedPages:0,deferredUpdates:0,pendingPages:0};
    this.chunks=prepared?.chunks?new Map(prepared.chunks.map(c=>[c.key,{...c,sourceShapes:new Set(c.sourceShapes)}])):fragmentChunks(entry.cells);
    for(const c of this.chunks.values()){
      let previous;
      if(parent?.cellSize===this.cellSize){
        // Child cells are a proved subset of their parent's component. Equal
        // count in this page and equal shared neighbour layers prove that its
        // original surface is unchanged, even if a distant neighbour is cut.
        let same=(parent.chunks.get(c.key)?.count||0)===c.count;
        for(let axis=0;axis<3&&same;axis++)for(const sign of [-1,1]){const p=[c.x,c.y,c.z];p[axis]+=sign*32;const key=p.join(',');if(!sameBoundary(parent.chunks.get(key),this.chunks.get(key),axis,sign<0?31:0)){same=false;break;}}
        if(same&&!parent.dirtyPages.has(c.key))previous=parent.meshes.get(c.key)?.geometry;}
      if(previous)this.stats.reusedPages++;
      this.addPage(c,previous??(c.geometry?restoreFragmentGeometry(c.geometry):this.build(c)));delete c.geometry;
    }
    this.stats.initialPages=this.meshes.size;this.group.userData.rigidSurfaceCache=this;
  }
  build(c){const dirty=c.dirtySlices??null;c.dirtySlices=null;if(this.slices)c.mesh??={};return styleVoxelGeometry(fragmentChunkGeometry(this.chunks,c,this.center,this.cellSize,c.mesh??null,dirty),{cell:this.cellSize});}
  markSlice(key,axis,positive,slice){const c=this.chunks.get(key);if(c?.mesh)(c.dirtySlices??=new Set()).add(sliceId(axis,positive,slice));}
  addPage(c,geometry){retain(geometry);const mesh=new THREE.Mesh(geometry,this.material);mesh.castShadow=mesh.receiveShadow=true;mesh.name=c.key;mesh.userData.sourceShapeIds=[...c.sourceShapes];this.meshes.set(c.key,mesh);this.group.add(mesh);}
  setMaterial(material){if(this.material===material)return;this.material=material;for(const mesh of this.meshes.values())mesh.material=material;}
  update(entry,{deferGeometry=false}={}){
    const edits=entry.voxelEdits?.filter(e=>e.revision>this.revision&&e.revision<=entry.revision);
    if(this.cells!==(entry.cacheCells??entry.cells)||this.cellSize!==entry.cellSize||!edits?.length||edits[0].revision!==this.revision+1)return false;
    const dirty=new Set();
    for(const edit of edits)for(const p of edit.removed){const x=Math.floor(p.x/32)*32,y=Math.floor(p.y/32)*32,z=Math.floor(p.z/32)*32,key=`${x},${y},${z}`,c=this.chunks.get(key);
      if(!c)throw Error('Missing rigid surface page');const i=(p.x&31)+(p.y&31)*1024+(p.z&31)*32;
      if(c.data[i]){c.data[i]=0;c.count--;dirty.add(key);}
      for(const [axis,origin]of [[0,x],[1,y],[2,z]]){const value=p[['x','y','z'][axis]]&31;
        this.markSlice(key,axis,0,value);this.markSlice(key,axis,1,value);
        if(value>0)this.markSlice(key,axis,1,value-1);if(value<31)this.markSlice(key,axis,0,value+1);
        if(value!==0&&value!==31)continue;const q=[x,y,z];q[axis]=origin+(value===0?-32:32);const k=q.join(',');if(this.chunks.has(k)){dirty.add(k);this.markSlice(k,axis,value===0?1:0,value===0?31:0);}}
    }
    for(const key of dirty)this.dirtyPages.add(key);
    this.stats.localUpdates++;this.revision=entry.revision;this.stats.pendingPages=this.dirtyPages.size;
    if(deferGeometry)this.stats.deferredUpdates++;else this.ensureGeometry();return true;
  }
  // Occupancy is always current. Only the hidden mesh fallback may wait while
  // a compiled, current ray view supplies colour, depth and shadow. Publish
  // exact geometry synchronously before any fallback/backend becomes visible.
  ensureGeometry(){
    for(const key of this.dirtyPages){const c=this.chunks.get(key),mesh=this.meshes.get(key);
      if(c.count){const geometry=this.build(c);if(mesh){release(mesh.geometry);mesh.geometry=geometry;retain(geometry);}else this.addPage(c,geometry);}
      else if(mesh){release(mesh.geometry);mesh.removeFromParent();this.meshes.delete(key);}
      this.dirtyPages.delete(key);this.stats.rebuiltPages++;
    }
    this.stats.pendingPages=this.dirtyPages.size;
  }
  dispose(){for(const mesh of this.meshes.values())release(mesh.geometry);this.meshes.clear();this.chunks.clear();this.dirtyPages.clear();this.group.removeFromParent();}
}
