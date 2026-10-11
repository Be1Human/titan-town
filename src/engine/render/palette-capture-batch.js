import * as THREE from '../../../vendor/three.module.js';
import {copyMaterialAttributeDefaults,materialAttributeDefaultsEqual} from './material-attributes.js';
import {isPositionPreservingVoxelHook} from '../../voxel-material.js';

const stateKeys=['side','depthTest','depthWrite','depthFunc','polygonOffset','polygonOffsetFactor','polygonOffsetUnits','clippingPlanes','clipIntersection','alphaTest','alphaToCoverage','wireframe','flatShading','vertexColors'];
function eligible(m,record){return m?.isMeshStandardMaterial&&!m.transparent&&m.opacity>=1&&m.visible&&m.depthWrite&&!m.map&&!m.alphaMap&&!m.displacementMap&&!m.normalMap&&!m.bumpMap&&!m.roughnessMap&&!m.metalnessMap&&!m.emissiveMap&&!m.alphaToCoverage&&m.alphaTest===0&&isPositionPreservingVoxelHook(record?.originalCompile);}
export function buildPaletteCaptureGeometry(source,materials,accepted){
  if(!source.index||!source.groups.length||Object.keys(source.morphAttributes).length)return null;
  const ids=new Float32Array(source.attributes.position.count).fill(-1),indices=[],start=source.drawRange.start,end=Math.min(source.index.count,start+source.drawRange.count);let sourceGroups=0;
  for(const group of source.groups){if(!accepted[group.materialIndex])continue;const a=Math.max(start,group.start),b=Math.min(end,group.start+group.count);if(a%3||b%3)return null;
    if(b>a)sourceGroups++;for(let i=a;i<b;i++){const v=source.index.array[i];if(ids[v]>=0&&ids[v]!==group.materialIndex)return null;ids[v]=group.materialIndex;indices.push(v);}}
  if(!indices.length)return null;
  const geometry=new THREE.BufferGeometry();for(const [name,attribute]of Object.entries(source.attributes))geometry.setAttribute(name,attribute);
  geometry.setAttribute('capturePaletteIndex',new THREE.BufferAttribute(ids,1));geometry.setIndex(indices);geometry.boundingBox=source.boundingBox?.clone()??null;geometry.boundingSphere=source.boundingSphere?.clone()??null;
  return {geometry,sharedAttributes:Object.keys(source.attributes),sourceGroups};
}
function disposeGeometry(record){for(const name of record.sharedAttributes)delete record.geometry.attributes[name];record.geometry.dispose();}
function shaderBatch(shader,uniforms){
  Object.assign(shader.uniforms,uniforms);
  shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nattribute float capturePaletteIndex;varying float capturePaletteId;').replace('#include <begin_vertex>','#include <begin_vertex>\ncapturePaletteId=capturePaletteIndex;');
  shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nuniform sampler2D capturePaletteMap;varying float capturePaletteId;');
  shader.fragmentShader=shader.fragmentShader.replace('void main() {',`void main() {int captureId=int(capturePaletteId+.5);vec4 captureColor=texelFetch(capturePaletteMap,ivec2(captureId,0),0);vec4 capturePhysical=texelFetch(capturePaletteMap,ivec2(captureId,1),0);vec4 captureStyle=texelFetch(capturePaletteMap,ivec2(captureId,2),0);`);
  shader.fragmentShader=shader.fragmentShader.replace('vec4 diffuseColor = vec4( diffuse, opacity );','vec4 diffuseColor = vec4( captureColor.rgb, opacity );');
  shader.fragmentShader=shader.fragmentShader.replace(/diffuseColor\.rgb=voxelFinishColor\(diffuseColor\.rgb,voxelPoint,voxelNormal,voxelCell,[^;]+;/,'diffuseColor.rgb=voxelFinishColor(diffuseColor.rgb,voxelPoint,voxelNormal,voxelCell,captureStyle.x,captureStyle.y,voxelWoodAxis);');
  shader.fragmentShader=shader.fragmentShader.replace('#include <roughnessmap_fragment>','float roughnessFactor=captureColor.a;').replace('#include <metalnessmap_fragment>','float metalnessFactor=capturePhysical.a;').replace('#include <emissivemap_fragment>','totalEmissiveRadiance=capturePhysical.rgb;');
}

// Capture-only one-draw palette transport. Source geometry/groups/materials,
// author/Shape identities and physics are unchanged outside the scoped pass.
export class PaletteCaptureBatch {
  constructor(){this.enabled=true;this.records=new Set();this.cache=new WeakMap();this.stats={builds:0,drawGroupsSaved:0,batchedObjects:0,materialUploads:0,error:null};}
  beginFrame(){this.stats.drawGroupsSaved=0;this.stats.batchedObjects=0;}
  prepare(object,materials,clones,surface){
    if(!this.enabled||!Array.isArray(object.material)||object.isInstancedMesh||object.isSkinnedMesh||object.userData.voxelRaycast)return null;
    const source=object.geometry;if(!source?.index)return null;const used=[...new Set(source.groups.map(g=>g.materialIndex).filter(i=>materials[i]&&clones[i]?.visible))];if(used.length<2)return null;
    const first=materials[used[0]],style=first.userData.voxelStyle,accepted=materials.map((m,i)=>eligible(m,surface.materials.get(m)));
    if(used.some(i=>!accepted[i]||stateKeys.some(k=>materials[i][k]!==first[k])||['cell','woodAxis','bevel'].some(k=>materials[i].userData.voxelStyle[k]!==style[k]))||!source.attributes.voxelFinishStyle)return null;
    const signature=source.groups.map(g=>`${g.start}:${g.count}:${g.materialIndex}`).join('|')+`/${source.index.version}/${source.drawRange.start}/${source.drawRange.count}/${source.attributes.position.count}/${used.join(',')}`;
    let record=this.cache.get(source);
    if(record&&(record.materials!==materials||record.sourceIndex!==source.index||record.signature!==signature||used.some((i,j)=>record.materialRefs[j]!==materials[i])||Object.keys(source.attributes).length!==record.sharedAttributes.length||Object.entries(source.attributes).some(([k,a])=>record.sourceAttributes[k]!==a))){record.release();record=null;}
    if(!record){const built=buildPaletteCaptureGeometry(source,materials,accepted);if(!built)return null;
      const width=Math.max(256,materials.length),data=new Float32Array(width*12),texture=new THREE.DataTexture(data,width,3,THREE.RGBAFormat,THREE.FloatType);texture.minFilter=texture.magFilter=THREE.NearestFilter;texture.colorSpace=THREE.NoColorSpace;texture.generateMipmaps=false;texture.needsUpdate=true;
      const base=clones[used[0]],material=copyMaterialAttributeDefaults(base.clone(),base),compile=base.onBeforeCompile,key=base.customProgramCacheKey();material.color.setRGB(1,1,1);material.emissive.setRGB(0,0,0);material.emissiveIntensity=1;
      material.onBeforeCompile=(shader,r)=>{compile.call(base,shader,r);shaderBatch(shader,{capturePaletteMap:{value:texture}});};material.customProgramCacheKey=()=>key+'-palette-atlas-v1';
      record={...built,source,sourceIndex:source.index,sourceAttributes:{...source.attributes},materials,materialRefs:used.map(i=>materials[i]),signature,material,texture,data,width,used};
      record.release=()=>{if(record.released)return;record.released=true;source.removeEventListener('dispose',record.release);for(const m of record.materialRefs)m.removeEventListener('dispose',record.release);this.records.delete(record);this.cache.delete(source);disposeGeometry(record);material.dispose();texture.dispose();};source.addEventListener('dispose',record.release);for(const m of record.materialRefs)m.addEventListener('dispose',record.release);this.records.add(record);this.cache.set(source,record);this.stats.builds++;
    }
    const base=clones[used[0]];for(const key of stateKeys)if(record.material[key]!==base[key]){record.material[key]=base[key];record.material.needsUpdate=true;}if(!materialAttributeDefaultsEqual(record.material,base))copyMaterialAttributeDefaults(record.material,base);
    let changed=false;for(const i of used){const m=materials[i],s=m.userData.voxelStyle,values=[m.color.r,m.color.g,m.color.b,m.roughness,m.emissive.r*m.emissiveIntensity,m.emissive.g*m.emissiveIntensity,m.emissive.b*m.emissiveIntensity,m.metalness,Number(s.grain.toFixed(6)),s.finishProfile,['x','y','z'].indexOf(s.woodAxis),s.bevel];
      for(let row=0;row<3;row++)for(let c=0;c<4;c++){const at=(row*record.width+i)*4+c,value=Math.fround(values[row*4+c]);if(record.data[at]!==value){record.data[at]=value;changed=true;}}}
    if(changed){record.texture.needsUpdate=true;this.stats.materialUploads++;}this.stats.drawGroupsSaved+=Math.max(0,record.sourceGroups-1);this.stats.batchedObjects++;return record;
  }
  disable(error){this.enabled=false;this.stats.error=String(error);}
  dispose(){for(const record of [...this.records])record.release();}
}
