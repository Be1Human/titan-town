import * as THREE from '../vendor/three.module.js';
const positionPreservingVoxelHooks=new WeakSet();
export const isPositionPreservingVoxelHook=hook=>positionPreservingVoxelHooks.has(hook);
import {CELL,MATERIAL_KEYS,MATERIALS} from './voxel-world.js';
import {VOXEL_SHOULDER_NORMAL_GLSL,VOXEL_FINISH_COLOR_GLSL,VOXEL_FINISH_PROFILE_IDS} from './voxel-finish-glsl.js';

// The first direct-light call in this bundled chunk belongs to point lights.
// Outside their finite range, or at zero intensity, their BRDF adds no light.
const pointLightFragment=THREE.ShaderChunk.lights_fragment_begin.replace(
  'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );',
  'if ( directLight.visible ) RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );'
);

// Constant per-geometry cell/axis values avoid shared StandardMaterial uniform
// refresh hazards. Call when a rigid object's geometry is built or replaced.
export function styleVoxelGeometry(geometry,{cell=CELL,woodAxis}={}){
  if(!geometry.getAttribute('position'))return geometry;
  if(!woodAxis){
    if(!geometry.boundingBox)geometry.computeBoundingBox();
    const size=geometry.boundingBox.getSize(new THREE.Vector3()),order=['x','y','z'].sort((a,b)=>size[b]-size[a]);
    woodAxis=size[order[0]]>=2*size[order[1]]?order[0]:'y';
  }
  const axis=woodAxis==='x'?0:woodAxis==='z'?2:1,previous=geometry.userData.voxelFinishStyle;
  if(previous?.cell===cell&&previous.axis===axis)return geometry;
  const data=new Float32Array(geometry.getAttribute('position').count*2);
  for(let i=0;i<data.length;i+=2){data[i]=cell;data[i+1]=axis;}
  geometry.setAttribute('voxelFinishStyle',new THREE.BufferAttribute(data,2));
  geometry.userData.voxelFinishStyle={cell,axis};return geometry;
}

// Intact faces read as continuous painted/mineral surfaces; voxel contours and
// broken edges provide the silhouette. Only authored material structure (wood
// boards and brick courses) gets seams. These are original procedural finishes.
// Derivative filtering fades the fine pigment and shoulders before aliasing.
export function styleVoxelMaterial(material,{cell=CELL,wood=false,grain=.045,profile=wood?'wood':'plain',woodAxis='y'}={}){
  const timber=wood||profile==='wood';
  const mineral=['plaster','stone','brick','concrete','roof'].includes(profile);
  // Hub close-ups have strong pigment blocks, but no universal bevel grid.
  // This amplitude is screenshot calibration, not a recovered textureTile.z.
  const colorGrain=Math.min(1,Math.max(0,grain)*(timber||mineral?30:8));
  const shoulder=0;
  const finishProfile=VOXEL_FINISH_PROFILE_IDS[timber?'wood':profile]??0;
  const axisIndex=axis=>axis==='x'?0:axis==='z'?2:1;
  material.defaultAttributeValues={...material.defaultAttributeValues,voxelFinishStyle:[cell,axisIndex(woodAxis)]};
  material.map=null;material.normalMap=null;material.roughnessMap=null;
  material.bumpMap=null;
  material.onBeforeCompile=shader=>{
    shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nattribute vec2 voxelFinishStyle;\nvarying vec2 voxelStyleParameters;\nvarying vec3 voxelPoint,voxelFace;')
      .replace('#include <begin_vertex>','#include <begin_vertex>\nvoxelPoint=position;voxelFace=normal;voxelStyleParameters=voxelFinishStyle;');
    shader.fragmentShader=shader.fragmentShader.replace('#include <lights_fragment_begin>',pointLightFragment).replace('#include <common>',`#include <common>
      varying vec3 voxelPoint,voxelFace;
      varying vec2 voxelStyleParameters;
      ${VOXEL_FINISH_COLOR_GLSL}
      ${VOXEL_SHOULDER_NORMAL_GLSL}
    `).replace('#include <map_fragment>',`#include <map_fragment>
      vec3 voxelNormal=normalize(voxelFace);
      // Attribute-less cached faces must never divide by the WebGL zero default.
      float voxelCell=voxelStyleParameters.x>0.?voxelStyleParameters.x:${cell.toFixed(6)};
      float voxelWoodAxis=voxelStyleParameters.x>0.?voxelStyleParameters.y:${axisIndex(woodAxis).toFixed(1)};
      vec2 voxelSurface=abs(voxelNormal.y)>.5?voxelPoint.xz:abs(voxelNormal.x)>.5?voxelPoint.zy:voxelPoint.xy;
      vec2 voxelUV=voxelSurface/voxelCell;
      vec2 voxelPixel=max(fwidth(voxelUV),vec2(.0001));
      float footprint=max(voxelPixel.x,voxelPixel.y);
      float shoulderDetail=1.-smoothstep(.025,.12,footprint);
      vec2 voxelFraction=fract(voxelUV);
      vec2 voxelEdge=min(voxelFraction,1.-voxelFraction);
      float shoulderDistance=min(voxelEdge.x,voxelEdge.y);
      float shoulderMask=smoothstep(.008,.085,shoulderDistance);
      float voxelHeight=shoulderMask*voxelCell*${shoulder.toFixed(6)}*shoulderDetail;
      diffuseColor.rgb=voxelFinishColor(diffuseColor.rgb,voxelPoint,voxelNormal,voxelCell,${colorGrain.toFixed(6)},${finishProfile.toFixed(1)},voxelWoodAxis);
    `).replace('#include <normal_fragment_maps>',`#include <normal_fragment_maps>
      normal=voxelShoulderNormal(-vViewPosition,normal,voxelHeight);
    `);
  };
  material.customProgramCacheKey=()=>`voxel-shoulders-v11-${cell}-${timber}-${colorGrain}-${profile}-${woodAxis}`;
  positionPreservingVoxelHooks.add(material.onBeforeCompile);
  material.userData.voxelStyle={cell,wood:timber,grain:colorGrain,paletteSteps:5,profile,finishProfile,woodAxis,bevel:shoulder,seamFade:[.025,.12],textureEvidence:'voxel-projected multiplicative albedo; original atlas payload and per-object strength unknown'};return material;
}

export function voxelMaterialBank(){
  const roughness={plaster:.95,stone:.96,brick:.94,concrete:.97,roof:.92,wood:.93,darkwood:.94,metal:.64,rust:.94,dark:.8,glass:.14,leaf:.96,fuel:.78};
  const metalness={metal:.4,rust:.06,dark:.08,glass:0,fuel:.04};
  const grain={plaster:.03,stone:.035,brick:.035,concrete:.025,roof:.03,wood:.032,darkwood:.03,metal:.016,rust:.028,dark:.016,glass:.008,leaf:.045,fuel:.02};
  return [null,...MATERIAL_KEYS.slice(1).map(name=>{
    const wood=['wood','darkwood'].includes(name);
    const m=new THREE.MeshStandardMaterial({color:MATERIALS[name].color,roughness:roughness[name]??.9,metalness:metalness[name]??0,side:THREE.DoubleSide});
    return styleVoxelMaterial(m,{wood,profile:wood?'wood':name,grain:grain[name]??.04});
  })];
}
