import * as THREE from '../vendor/three.module.js';
import {chunkOf,localIndex,CELL} from './voxel-world.js';

const WIDTH=1024,HEIGHT=128,SLOTS_PER_LAYER=4;
export class CutMask{
  constructor(world){
    this.world=world;this.slots=new Map();this.capacity=64;
    this.lookup=new THREE.DataTexture(new Float32Array(8192),32,256,THREE.RedFormat,THREE.FloatType);this.lookup.needsUpdate=true;
    this.uniforms={cutChunks:{value:this.lookup},cutVoxels:{value:null}};
    this.allocate();
  }
  allocate(){
    const data=new Uint8Array(this.capacity*32768);
    if(this.texture){data.set(this.texture.image.data);this.texture.dispose();}
    this.texture=new THREE.DataArrayTexture(data,WIDTH,HEIGHT,this.capacity/SLOTS_PER_LAYER);this.texture.format=THREE.RedFormat;this.texture.needsUpdate=true;
    this.fullUpload=true;this.texture.onUpdate=()=>this.fullUpload=false;
    this.uniforms.cutVoxels.value=this.texture;
  }
  update(key){
    const original=this.world.initialChunks?.get(key),current=this.world.chunks.get(key);
    if(!original)return 0;
    let slot=this.slots.get(key);
    if(slot===undefined){
      if(!this.world.altered.has(key))return 0;
      slot=this.slots.size;this.slots.set(key,slot);
      if(slot>=this.capacity){this.capacity*=2;this.allocate();}
      this.lookup.image.data[key]=slot+1;this.lookup.needsUpdate=true;
    }
    const offset=slot*32768,data=this.texture.image.data;
    for(let i=0;i<32768;i++)data[offset+i]=original.data[i]&&!current?.data[i]?255:0;
    if(!this.fullUpload)this.texture.addLayerUpdate(Math.floor(slot/SLOTS_PER_LAYER));
    this.texture.needsUpdate=true;return 32768;
  }
  removedAt(x,y,z){
    const slot=this.slots.get(chunkOf(x,y,z));if(slot===undefined)return false;
    return this.texture.image.data[slot*32768+localIndex(x,y,z)]!==0;
  }
  dispose(){this.texture.dispose();this.lookup.dispose();}
}

export function applyCutShader(shader,uniforms,{voxelAligned=false}={}){
  Object.assign(shader.uniforms,uniforms);
  // With MSAA, a covered edge sample can belong to a triangle whose pixel
  // centre lies outside it. Use a covered interpolation point for the mask;
  // otherwise deleted faces sample a neighbouring voxel and leave thin lines.
  shader.vertexShader=shader.vertexShader.replace('#include <common>',`#include <common>
    attribute float sourceChunk;varying float cutSource;centroid varying vec3 cutPosition;varying vec3 cutNormal;
    ${voxelAligned?'attribute vec3 sourceCellMin,sourceCellMax;varying vec3 cutCellMin,cutCellMax;':''}
  `).replace('#include <begin_vertex>',`#include <begin_vertex>
    cutSource=sourceChunk;cutPosition=(modelMatrix*vec4(position,1.)).xyz;cutNormal=normalize(mat3(modelMatrix)*normal);
    ${voxelAligned?'cutCellMin=sourceCellMin;cutCellMax=sourceCellMax;':''}
  `);
  shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>
    varying float cutSource;centroid varying vec3 cutPosition;varying vec3 cutNormal;
    ${voxelAligned?'varying vec3 cutCellMin,cutCellMax;':''}
    uniform sampler2D cutChunks;uniform highp sampler2DArray cutVoxels;
  `).replace('#include <clipping_planes_fragment>',`#include <clipping_planes_fragment>
    if(cutSource>=0.){
      vec3 cell=floor(cutPosition/${CELL.toFixed(1)}-cutNormal*.25);
      ${voxelAligned?`
      // Float rounding on an exact edge must stay in this face's owning cells,
      // including edges inside a chunk. BSP fallback faces have no such bounds.
      float sourceKey=floor(cutSource+.5);
      vec3 sourceBase=vec3(mod(sourceKey,32.)-16.,floor(sourceKey/1024.),mod(floor(sourceKey/32.),32.)-16.)*32.;
      cell=clamp(cell,sourceBase+floor(cutCellMin+.5),sourceBase+floor(cutCellMax+.5));
      `:''}
      vec3 chunk=floor(cell/32.);float key=chunk.x+16.+(chunk.z+16.)*32.+chunk.y*1024.;
      float slot=texture2D(cutChunks,vec2(mod(key,32.)+.5,floor(key/32.)+.5)/vec2(32.,256.)).r-1.;
      if(slot>=0.){
        vec3 local=mod(cell,32.);float index=local.x+local.z*32.+local.y*1024.;
        vec2 pixel=vec2(mod(index,1024.),mod(slot,4.)*32.+floor(index/1024.));
        if(texture(cutVoxels,vec3((pixel+.5)/vec2(1024.,128.),floor(slot/4.))).r>.5)discard;
      }
    }
  `);
}
