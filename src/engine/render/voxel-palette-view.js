import * as THREE from '../../../vendor/three.module.js';
import {styleVoxelMaterial} from '../../voxel-material.js';
import {buildNativePaletteGeometry} from '../../native-palette-geometry.js';

export function createVoxelPaletteMaterials(palette,cellSize){
 const bank=Array(Object.keys(palette).reduce((n,i)=>Math.max(n,Number(i)),255)+1).fill(null);
 for(const [key,p]of Object.entries(palette)){
  const m=new THREE.MeshStandardMaterial({roughness:p.roughness,metalness:p.metalness,opacity:p.opacity,transparent:p.opacity<1,depthWrite:p.opacity>=1,side:p.opacity<1?THREE.DoubleSide:THREE.FrontSide});
  m.color.setRGB(p.rgba[0]/255,p.rgba[1]/255,p.rgba[2]/255,THREE.SRGBColorSpace);
  if(p.emission){m.emissive.copy(m.color);m.emissiveIntensity=p.emission;}
  styleVoxelMaterial(m,{cell:cellSize,grain:0,profile:'plain'});bank[Number(key)]=m;
 }return bank;
}
// Uses the same live cells as the rigid collider; cut interiors retain source colour.
export function buildVoxelPaletteFragment(cells,center,cellSize,palette){
 const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];for(const c of cells)for(const [a,k]of ['x','y','z'].entries()){min[a]=Math.min(min[a],c[k]);max[a]=Math.max(max[a],c[k]+1);}
 const size=max.map((v,a)=>v-min[a]),Type=Object.keys(palette).some(i=>Number(i)>255)?Uint16Array:Uint8Array,dense=new Type(size.reduce((a,b)=>a*b,1));
 for(const c of cells)dense[c.x-min[0]+size[0]*(c.y-min[1]+size[1]*(c.z-min[2]))]=c.paletteIndex;
 const geometry=buildNativePaletteGeometry({size},dense,{palette:Object.fromEntries(Object.keys(palette).map(i=>[i,[255,255,255,255]])),paletteAppearance:palette},new Map(Object.keys(palette).map(i=>[Number(i),Number(i)])));
 const scale=cellSize/.1;geometry.scale(scale,scale,scale);geometry.translate(min[0]*cellSize-center.x,min[1]*cellSize-center.y,min[2]*cellSize-center.z);geometry.deleteAttribute('color');return geometry;
}
