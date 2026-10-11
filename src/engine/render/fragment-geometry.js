import * as THREE from '../../../vendor/three.module.js';
import {CELL,MATERIAL_KEYS} from '../../voxel-world.js';
import {meshChunk} from '../../mesher.js';
import {meshFragmentPage} from './fragment-page-mesher.js';
const materialIds=new Map(MATERIAL_KEYS.map((key,id)=>[key,id]));
function geometry(data){
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(data.positions,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(data.normals,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(data.uvs,2));g.setIndex(data.indices);
 for(const group of data.groups)g.addGroup(group.start,group.count,group.materialIndex);g.computeBoundingSphere();return g;
}
export function fragmentGeometry(cells,center,cellSize=CELL){
  // Large falling pieces use the same surface merger as the static scene.
  const chunks=new Map();
  for(const p of cells){
    const x=Math.floor(p.x/32)*32,y=Math.floor(p.y/32)*32,z=Math.floor(p.z/32)*32,k=x+','+y+','+z;
    let c=chunks.get(k);if(!c){c={x,y,z,count:0,data:new Uint8Array(32768),bounds:{min:[31,31,31],max:[0,0,0]}};chunks.set(k,c);}
    const a=p.x&31,b=p.y&31,d=p.z&31,min=c.bounds.min,max=c.bounds.max;
    min[0]=Math.min(min[0],a);min[1]=Math.min(min[1],b);min[2]=Math.min(min[2],d);
    max[0]=Math.max(max[0],a);max[1]=Math.max(max[1],b);max[2]=Math.max(max[2],d);
    c.data[a+b*1024+d*32]=MATERIAL_KEYS.indexOf(p.mat);c.count++;
  }
  const merged={positions:[],normals:[],uvs:[],indices:[],groups:[]};
  for(const c of chunks.values()){
    // meshChunk only calls getId outside its current chunk. Resolve its six
    // neighbours once, rather than allocating a string key for every edge cell.
    const neighbors=[chunks.get(`${c.x-32},${c.y},${c.z}`),chunks.get(`${c.x+32},${c.y},${c.z}`),chunks.get(`${c.x},${c.y-32},${c.z}`),chunks.get(`${c.x},${c.y+32},${c.z}`),chunks.get(`${c.x},${c.y},${c.z-32}`),chunks.get(`${c.x},${c.y},${c.z+32}`)];
    const fake={getId:(x,y,z)=>{
      const other=neighbors[x<c.x?0:x>=c.x+32?1:y<c.y?2:y>=c.y+32?3:z<c.z?4:5];
      return other?.data[(x&31)+(y&31)*1024+(z&31)*32]??0;
    }};
    const data=meshChunk(fake,c,{occupiedBounds:c.bounds}),offset=merged.positions.length/3;
    for(let i=0;i<data.positions.length;i+=3)merged.positions.push(data.positions[i]*cellSize/CELL-center.x,data.positions[i+1]*cellSize/CELL-center.y,data.positions[i+2]*cellSize/CELL-center.z);
    merged.normals.push(...data.normals);merged.uvs.push(...data.uvs);
    for(const g of data.groups)merged.groups.push({...g,start:g.start+merged.indices.length});
    for(const index of data.indices)merged.indices.push(index+offset);
  }return geometry(merged);
}

export function fragmentChunks(cells){
  const chunks=new Map();
  for(const p of cells){const x=Math.floor(p.x/32)*32,y=Math.floor(p.y/32)*32,z=Math.floor(p.z/32)*32,key=x+','+y+','+z;
    let c=chunks.get(key);if(!c){c={key,x,y,z,count:0,data:new Uint8Array(32768),bounds:{min:[31,31,31],max:[0,0,0]},sourceShapes:new Set()};chunks.set(key,c);}
    const a=p.x&31,b=p.y&31,d=p.z&31,min=c.bounds.min,max=c.bounds.max;
    if(a<min[0])min[0]=a;if(b<min[1])min[1]=b;if(d<min[2])min[2]=d;
    if(a>max[0])max[0]=a;if(b>max[1])max[1]=b;if(d>max[2])max[2]=d;
    c.data[a+b*1024+d*32]=materialIds.get(p.mat)??-1;c.count++;if(p.sourceShape)c.sourceShapes.add(p.sourceShape);
  }return chunks;
}
export function fragmentChunkGeometry(chunks,c,center,cellSize=CELL,state=null,dirty=null){
  return meshFragmentPage(chunks,c,center,cellSize,state,dirty);
}
