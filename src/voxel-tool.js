import * as THREE from '../vendor/three.module.js';
import {VoxelWorld,CELL,chunkOf,localIndex} from './voxel-world.js';
import {meshChunk} from './mesher.js';
import {styleVoxelMaterial} from './voxel-material.js';

export const TOOL_CELL=.008;
const Y_OFFSET=96;
function contains(geometry,p){
  const a=geometry.parameters;
  if(geometry.type==='CylinderGeometry'){
    if(Math.abs(p.y)>a.height/2)return false;
    const t=p.y/a.height+.5,r=a.radiusBottom*(1-t)+a.radiusTop*t;return p.x*p.x+p.z*p.z<=r*r;
  }
  if(geometry.type==='CapsuleGeometry'){
    const y=Math.max(0,Math.abs(p.y)-a.length/2);return p.x*p.x+p.z*p.z+y*y<=a.radius*a.radius;
  }
  if(geometry.type==='TorusGeometry'){
    const r=Math.hypot(p.x,p.y)-a.radius;let angle=Math.atan2(p.y,p.x);if(angle<0)angle+=Math.PI*2;
    return r*r+p.z*p.z<=a.tube*a.tube&&angle<=a.arc;
  }
  return geometry.boundingBox.containsPoint(p);
}

// Assemble the existing tool primitives on a small, object-local grid once.
// Animation and grip transforms remain on the returned root group.
export function voxelizeTool(model,{cell=TOOL_CELL,woodAxis='y'}={}){
  model.updateWorldMatrix(true,true);const rootInverse=model.matrixWorld.clone().invert(),world=new VoxelWorld(),materials=[null],ids=new Map(),point=new THREE.Vector3();
  model.traverse(part=>{
    if(!part.isMesh)return;
    const material=part.material;let id=ids.get(material);
    if(!id){id=materials.length;if(id>13)throw Error('Too many tool palette materials');ids.set(material,id);materials.push(styleVoxelMaterial(material.clone(),{cell,wood:material.userData.voxelWood??(material.roughness>.8&&material.color.r>material.color.b*1.2),woodAxis,grain:.035}));}
    part.geometry.computeBoundingBox();const matrix=rootInverse.clone().multiply(part.matrixWorld),inverse=matrix.clone().invert(),bounds=part.geometry.boundingBox.clone().applyMatrix4(matrix);
    for(let y=Math.floor(bounds.min.y/cell);y<Math.ceil(bounds.max.y/cell);y++)for(let z=Math.floor(bounds.min.z/cell);z<Math.ceil(bounds.max.z/cell);z++)for(let x=Math.floor(bounds.min.x/cell);x<Math.ceil(bounds.max.x/cell);x++){
      point.set((x+.5)*cell,(y+.5)*cell,(z+.5)*cell).applyMatrix4(inverse);if(!contains(part.geometry,point))continue;
      const yy=y+Y_OFFSET;if(yy<0||yy>=256)throw Error('Tool exceeds voxel grid');
      const chunk=world.getChunk(chunkOf(x,yy,z),true),i=localIndex(x,yy,z);if(!chunk.data[i]){chunk.count++;world.count++;}chunk.data[i]=id;
    }
  });
  const root=new THREE.Group();root.position.copy(model.position);root.quaternion.copy(model.quaternion);root.scale.copy(model.scale);
  const chunks=[];let triangles=0,vertices=0;
  for(const chunk of world.chunks.values()){
    const data=meshChunk(world,chunk);if(!data.indices.length)continue;
    for(let i=0;i<data.positions.length;i+=3){data.positions[i]=data.positions[i]/CELL*cell;data.positions[i+1]=(data.positions[i+1]/CELL-Y_OFFSET)*cell;data.positions[i+2]=data.positions[i+2]/CELL*cell;}
    chunks.push({...data,vertexOffset:vertices});vertices+=data.positions.length/3;triangles+=data.indices.length/3;
  }
  // The tool is static geometry. Storage chunks do not need individual draws;
  // share vertices in one buffer and collect its indices by palette material.
  const positions=new Float32Array(vertices*3),normals=new Float32Array(vertices*3),indices=new Uint32Array(triangles*3),geometry=new THREE.BufferGeometry();
  for(const data of chunks){positions.set(data.positions,data.vertexOffset*3);normals.set(data.normals,data.vertexOffset*3);}
  let cursor=0;
  for(let materialIndex=1;materialIndex<materials.length;materialIndex++){
    const start=cursor;
    for(const data of chunks)for(const g of data.groups)if(g.materialIndex===materialIndex)for(let i=g.start;i<g.start+g.count;i++)indices[cursor++]=data.indices[i]+data.vertexOffset;
    if(cursor>start)geometry.addGroup(start,cursor-start,materialIndex);
  }
  geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));geometry.setAttribute('normal',new THREE.BufferAttribute(normals,3));geometry.setIndex(new THREE.BufferAttribute(indices,1));
  geometry.computeBoundingSphere();root.add(new THREE.Mesh(geometry,materials));
  root.userData={cell,voxels:world.count,triangles};return root;
}
