import * as THREE from '../../../vendor/three.module.js';
import {isPositionPreservingVoxelHook} from '../../voxel-material.js';
import {activeMaterialIndices} from './active-material-indices.js';
const depthStateKeys=['side','depthTest','depthWrite','depthFunc','polygonOffset','polygonOffsetFactor','polygonOffsetUnits','alphaTest','alphaMap','map','displacementMap','displacementScale','displacementBias','clippingPlanes','clipIntersection','clipShadows','opacity','wireframe','wireframeLinewidth'];
const coverageCache=new WeakMap();
function fullDepthCoverage(geometry){
  const total=geometry.index?.count??geometry.attributes.position.count,start=Math.max(0,geometry.drawRange.start),end=Math.min(total,start+geometry.drawRange.count),groups=geometry.groups;if(end<=start||!groups.length)return false;
  const old=coverageCache.get(geometry);if(old&&old.total===total&&old.start===start&&old.end===end&&old.groups.length===groups.length*3&&groups.every((g,i)=>old.groups[i*3]===g.start&&old.groups[i*3+1]===g.count&&old.groups[i*3+2]===g.materialIndex))return old.valid;
  const intervals=groups.map(g=>[Math.max(start,g.start),Math.min(end,g.start+g.count)]).filter(([a,b])=>b>a).sort((a,b)=>a[0]-b[0]);let cursor=start,valid=true;for(const [a,b]of intervals){if(a!==cursor){valid=false;break;}cursor=b;}valid&&=cursor===end;
  coverageCache.set(geometry,{total,start,end,groups:groups.flatMap(g=>[g.start,g.count,g.materialIndex]),valid});return valid;
}
export function collapseEquivalentDepthGroups(geometry,materials){
  if(!fullDepthCoverage(geometry))return null;let common=null;
  for(const i of activeMaterialIndices(geometry)){const m=materials[i];if(!m?.isMeshDepthMaterial||!m.visible)return null;if(!common)common=m;else if(depthStateKeys.some(k=>common[k]!==m[k]))return null;}return common;
}

// Native incident-light composition already shades opaque albedo/emission
// from SurfaceBuffer. This pass reuses hit depth on single-sample targets;
// multisample targets retain exact geometry/sample coverage via capture
// shaders with colour writes disabled. Unused opaque PBR colour is skipped.
// Uncaptured groups, sky and transparency remain on their original forward
// path; shadow traversal sees all original materials/casters.
export class NativeOpaquePass {
  constructor(renderer,surface){
    this.renderer=renderer;this.surface=surface;this.enabled=true;this.stats={frames:0,opaqueGroups:0,error:null};
    this.hidden=new THREE.MeshBasicMaterial({visible:false});
    this.depthMaterials=new WeakMap();this.depthOwned=new Set();this.depthRecords=new Set();
    this.voxelDepth=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking,colorWrite:false,side:THREE.FrontSide});
    this.voxelDepth.customProgramCacheKey=()=> 'native-opaque-voxel-depth-v1';
    this.material=new THREE.ShaderMaterial({depthTest:true,depthWrite:true,colorWrite:false,toneMapped:false,uniforms:{geometryMap:{value:surface.target.textures[0]},hitDepthMap:{value:surface.target.depthTexture}},vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',fragmentShader:`
      varying vec2 vUv;uniform sampler2D geometryMap,hitDepthMap;
      void main(){float depth=texture2D(geometryMap,vUv).a;if(depth<=0.)discard;
        // Reuse hardware/DDA depth exactly. Reconstructing from linear Ng
        // distance adds another quantization and perturbs incident lighting.
        gl_FragDepth=texture2D(hitDepthMap,vUv).r;gl_FragColor=vec4(0.);
      }`});
    this.material.customProgramCacheKey=()=> 'native-opaque-depth-v1';
    this.scene=new THREE.Scene();this.quad=new THREE.Mesh(new THREE.PlaneGeometry(2,2),this.material);this.quad.frustumCulled=false;this.scene.add(this.quad);this.camera=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
    this.sphere=new THREE.Sphere();this.contextRestored=()=>{this.enabled=true;this.stats.error=null;};renderer.domElement?.addEventListener('webglcontextrestored',this.contextRestored);
  }
  depthFor(source){
    let depth=this.depthMaterials.get(source);if(!depth){depth=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking,colorWrite:false});depth.customProgramCacheKey=()=> 'native-opaque-simple-depth-v1';this.depthMaterials.set(source,depth);this.depthOwned.add(depth);const item={source,depth};item.release=()=>{source.removeEventListener('dispose',item.release);this.depthRecords.delete(item);this.depthOwned.delete(depth);this.depthMaterials.delete(source);depth.dispose();};source.addEventListener('dispose',item.release);this.depthRecords.add(item);}
    for(const key of depthStateKeys)depth[key]=source[key];depth.visible=source.visible;if(depth.userData.sourceVersion!==source.version){depth.needsUpdate=true;depth.userData.sourceVersion=source.version;}return depth;
  }
  render(scene,camera,target){
    if(!this.enabled||!this.surface.captured?.length)return false;
    const r=this.renderer,captured=this.surface.captured,swapped=[],shadow=r.shadowMap,originalShadow=shadow.render,autoClear=r.autoClear,depthOnly=target.samples>0,colourStates=new Map();
    if(captured.some(record=>{const materials=Array.isArray(record.material)?record.material:[record.material],indices=this.activeMaterialWork&&Array.isArray(record.material)?activeMaterialIndices(record.object.geometry):materials.map((m,i)=>i);return indices.some(i=>materials[i]?.alphaToCoverage);})){this.stats.coverageFallback=true;return false;}this.stats.coverageFallback=false;
    // The existing composite treats depth>.99998 as sky and uses forward
    // colour there. Do not omit opaque colour for any possible far surface.
    const cutoff=camera.isPerspectiveCamera?2*camera.near*camera.far/(camera.far+camera.near-(2*.99998-1)*(camera.far-camera.near)):camera.near+(camera.far-camera.near)*.99998;
    for(const {object}of captured){let sphere;if(object.isInstancedMesh||object.isSkinnedMesh){if(!object.boundingSphere)object.computeBoundingSphere?.();sphere=object.boundingSphere;}else{if(!object.geometry.boundingSphere)object.geometry.computeBoundingSphere();sphere=object.geometry.boundingSphere;}if(!sphere)continue;
      this.sphere.copy(sphere).applyMatrix4(object.matrixWorld).applyMatrix4(camera.matrixWorldInverse);if(-this.sphere.center.z+this.sphere.radius>=cutoff){this.stats.farFallback=true;return false;}}
    this.stats.farFallback=false;
    let opaqueGroups=0,simpleDepthGroups=0,captureDepthGroups=0,collapsedDepthGroups=0;
    const selected=new Map();
    const alternatives=[],alternativeNodes=[];
    const hide=()=>{for(const record of captured)record.object.material=selected.get(record.object);for(const item of alternatives){item.ray.visible=false;item.mesh.visible=true;}for(const item of alternativeNodes)item.object.material=this.voxelDepth;};
    const restore=()=>{for(const record of swapped)record.object.material=record.material;for(const item of alternatives){item.ray.visible=item.rayVisible;item.mesh.visible=item.meshVisible;}for(const item of alternativeNodes)item.object.material=item.material;};
    try{
    for(const record of captured){const materials=Array.isArray(record.material)?record.material:[record.material],clones=Array.isArray(record.captures)?record.captures:[record.captures];
      const originalRay=materials.length===1?materials[0]:null,unmodifiedRay=originalRay&&!originalRay.wireframe&&!originalRay.clippingPlanes?.length&&!originalRay.displacementMap&&!originalRay.polygonOffset&&originalRay.depthTest&&originalRay.depthWrite&&originalRay.depthFunc===THREE.LessEqualDepth;
      const mesh=depthOnly&&unmodifiedRay?record.object.userData.nativeDepthMesh:null;
      if(mesh&&!mesh.visible){
        alternatives.push({ray:record.object,mesh,rayVisible:record.object.visible,meshVisible:mesh.visible});mesh.traverse(object=>{if(object.isMesh)alternativeNodes.push({object,material:object.material});});selected.set(record.object,record.material);continue;
      }
      const list=materials.slice(),activeIndices=this.activeMaterialWork&&Array.isArray(record.material)?activeMaterialIndices(record.object.geometry):materials.map((m,i)=>i);
      for(const i of activeIndices){const m=materials[i];if(!record.accepted[i])continue;if(!depthOnly){list[i]=this.hidden;continue;}
        // Voxel finish hooks change colour/normals, not authored positions.
        // Ray proxies and unknown vertex hooks keep their exact capture shader.
        const vertexHook=this.surface.materials?.get(m)?.originalCompile??m.onBeforeCompile;
        if(!record.object.userData.voxelRaycast&&(isPositionPreservingVoxelHook(vertexHook)||vertexHook===THREE.Material.prototype.onBeforeCompile)){
          simpleDepthGroups++;list[i]=this.depthFor(m);continue;
        }
        const clone=clones[i];if(!clone)throw Error('Missing captured depth material');if(!colourStates.has(clone))colourStates.set(clone,clone.colorWrite);clone.colorWrite=false;captureDepthGroups++;list[i]=clone;}
      const collapsed=Array.isArray(record.material)&&depthOnly?collapseEquivalentDepthGroups(record.object.geometry,list):null;if(collapsed)collapsedDepthGroups+=Math.max(0,record.object.geometry.groups.length-1);selected.set(record.object,collapsed??(Array.isArray(record.material)?list:list[0]));}
      for(const record of captured){if(record.object.material!==record.material)throw Error('Opaque material changed after capture');swapped.push(record);opaqueGroups+=record.accepted.filter(Boolean).length;}
      hide();
      const wrapper=function(...args){restore();try{return originalShadow.apply(this,args);}finally{hide();}};shadow.render=wrapper;
      r.setRenderTarget(target);r.autoClear=true;r.render(scene,camera);
      const badDepth=r.info?.programs?.find(p=>p.diagnostics?.runnable===false&&p.cacheKey?.includes('native-opaque-'));if(badDepth)throw Error('Native opaque depth shader failed');
      if(depthOnly){this.stats.frames++;this.stats.opaqueGroups=opaqueGroups;this.stats.simpleDepthGroups=simpleDepthGroups;this.stats.captureDepthGroups=captureDepthGroups;this.stats.collapsedDepthGroups=collapsedDepthGroups;this.stats.exactVoxelDepthObjects=alternatives.length;this.stats.path='multisample-depth-only';this.stats.error=null;return true;}
      // Forward sky/unsupported depth is retained; nearest captured depth
      // fills only where it passes the original less/equal depth test.
      r.autoClear=false;
      r.render(this.scene,this.camera);
      const failed=r.info?.programs?.find(p=>p.diagnostics?.runnable===false&&p.cacheKey?.includes('native-opaque-depth-v1'));if(failed)throw Error('Native opaque depth shader failed');
      this.stats.frames++;this.stats.opaqueGroups=opaqueGroups;this.stats.path='captured-depth-reuse';this.stats.error=null;return true;
    }catch(error){this.enabled=false;this.stats.error=error.message;return false;}
    finally{restore();for(const [material,value]of colourStates)material.colorWrite=value;shadow.render=originalShadow;r.autoClear=autoClear;}
  }
  dispose(){this.renderer.domElement?.removeEventListener('webglcontextrestored',this.contextRestored);for(const item of [...this.depthRecords])item.release();this.voxelDepth.dispose();this.hidden.dispose();this.material.dispose();this.quad.geometry.dispose();}
}
