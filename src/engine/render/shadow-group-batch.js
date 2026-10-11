import * as THREE from '../../../vendor/three.module.js';
import {isPositionPreservingVoxelHook} from '../../voxel-material.js';
import {isLocalVoxelShadowHook} from './voxel-raycast.js';

const shadowKeys=['side','shadowSide','wireframe','wireframeLinewidth','linewidth','alphaTest','alphaToCoverage','alphaHash','map','alphaMap','clipShadows','clippingPlanes','clipIntersection','displacementMap','displacementScale','displacementBias'];
const defaultBefore=THREE.Object3D.prototype.onBeforeShadow,defaultAfter=THREE.Object3D.prototype.onAfterShadow;
function eligible(m,surface){const hook=surface?.materials?.get(m)?.originalCompile??m?.onBeforeCompile;return m?.isMeshStandardMaterial&&m.visible&&!m.transparent&&m.opacity===1&&!m.wireframe&&!m.alphaToCoverage&&!m.alphaHash&&m.alphaTest===0&&!m.map&&!m.alphaMap&&!m.displacementMap&&(hook===THREE.Material.prototype.onBeforeCompile||isPositionPreservingVoxelHook(hook));}

// A scalar material draws the full active index span. Never use that route
// unless visible groups cover that span EXACTLY ONCE. Geometry remains original.
function coverage(geometry,cache){
 const total=geometry.index?.count??geometry.attributes.position?.count,start=Math.max(0,geometry.drawRange.start),end=Math.min(total,start+geometry.drawRange.count),groups=geometry.groups;if(!Number.isFinite(end)||end<=start||!groups.length)return false;
 const old=cache.get(geometry);if(old&&old.total===total&&old.start===start&&old.end===end&&old.groups.length===groups.length*3&&groups.every((g,i)=>old.groups[i*3]===g.start&&old.groups[i*3+1]===g.count&&old.groups[i*3+2]===g.materialIndex))return old.valid;
 const ranges=groups.map(g=>[Math.max(start,g.start),Math.min(end,g.start+g.count)]).filter(([a,b])=>b>a).sort((a,b)=>a[0]-b[0]);let cursor=start,valid=ranges.length>1;
 for(const [a,b]of ranges){if(a!==cursor||a%3||b%3){valid=false;break;}cursor=b;}valid&&=cursor===end;
 cache.set(geometry,{total,start,end,groups:groups.flatMap(g=>[g.start,g.count,g.materialIndex]),valid});return valid;
}
export function equivalentShadowMaterial(object,surface,cache=new WeakMap()){
 if(!object.isMesh||!Array.isArray(object.material)||object.customDepthMaterial!==undefined||object.customDistanceMaterial!==undefined||object.onBeforeShadow!==defaultBefore||object.onAfterShadow!==defaultAfter||!coverage(object.geometry,cache))return null;
 const materials=object.material,start=object.geometry.drawRange.start,end=Math.min(object.geometry.index?.count??object.geometry.attributes.position.count,start+object.geometry.drawRange.count);let common=null;
 for(const group of object.geometry.groups){if(group.start>=end||group.start+group.count<=start)continue;const m=materials[group.materialIndex];if(!eligible(m,surface))return null;if(!common)common=m;else if(shadowKeys.some(key=>m[key]!==common[key]))return null;}
 return common;
}

// Scoped submission optimization. Stock shadow depth/distance programs, current
// poses, full original indices, cut/ray casters and map resolution stay intact.
export class ShadowGroupBatch {
 constructor(renderer,surface){this.renderer=renderer;this.surface=surface;this.cache=new WeakMap();this.stats={objects:0,groupsSaved:0,callbackFallback:false};}
 beginFrame(){this.stats.objects=0;this.stats.groupsSaved=0;this.stats.callbackFallback=false;}
 render(scene,run){
  const shadow=this.renderer.shadowMap;if(!shadow?.enabled||(!shadow.autoUpdate&&!shadow.needsUpdate))return run();
  const candidates=[];let unsafe=false;const vsm=shadow.type===THREE.VSMShadowMap;
  scene.traverseVisible(object=>{
   if(!object.castShadow&&!(vsm&&object.receiveShadow))return;
   if(object.onAfterShadow!==defaultAfter||(object.onBeforeShadow!==defaultBefore&&!isLocalVoxelShadowHook(object.onBeforeShadow))){unsafe=true;return;}
   const common=equivalentShadowMaterial(object,this.surface,this.cache);if(common)candidates.push([object,object.material,common]);
  });
  // Unknown callbacks may mutate another caster during traversal. Preserve
  // their complete source ordering; recognized ray hooks update only own uniforms.
  if(unsafe){this.stats.callbackFallback=true;return run();}
  try{for(const [object,materials,common]of candidates){object.material=common;this.stats.objects++;this.stats.groupsSaved+=Math.max(0,object.geometry.groups.length-1);}return run();}
  finally{for(const [object,materials]of candidates)object.material=materials;}
 }
 dispose(){this.cache=new WeakMap();}
}
