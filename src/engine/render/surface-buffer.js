import * as THREE from '../../../vendor/three.module.js';
import {copyMaterialAttributeDefaults,captureMaterialKeys,captureMaterialChanged} from './material-attributes.js';
import {PaletteCaptureBatch} from './palette-capture-batch.js';
import {activeMaterialIndices} from './active-material-indices.js';

// Smooth-normal filter parameters.
export const NORMAL_FILTER_REFERENCE=Object.freeze({radius:3,depthFalloff:.2,startRadius:.5,radiusStep:.3,angleStep:2.399963140487671,depthTolerance:.0001,epsilon:.0001});

export function referenceNormalRadius(depth,far){return 3*Math.max(0,Math.min(1,1-.2*far*depth));}

// A CPU oracle with explicit nearest/clamp sampling. normalData is RGB and
// depthData is normalized view-axis distance, never radial camera distance.
export function smoothNormalPixel(normalData,depthData,width,height,x,y,far){
  const index=y*width+x,depth=depthData[index],sum=Array.from(normalData.slice(index*3,index*3+3)),radius=referenceNormalRadius(depth,far);
  if(radius<=0)return sum;
  for(let i=0;i<9;i++){
    const r=.5+i*.3;if(r>=radius)break;const a=i*NORMAL_FILTER_REFERENCE.angleStep;
    const sx=Math.max(0,Math.min(width-1,Math.floor(x+.5+Math.cos(a)*r))),sy=Math.max(0,Math.min(height-1,Math.floor(y+.5+Math.sin(a)*r))),neighbor=sy*width+sx;
    if(Math.abs(depthData[neighbor]-depth)<.0001){const weight=1-r/radius;for(let c=0;c<3;c++)sum[c]+=normalData[neighbor*3+c]*weight;}
  }
  const scale=1/(Math.hypot(...sum)+.0001);return sum.map(v=>v*scale);
}

const vertex='varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}';
export const SMOOTH_NORMAL_GLSL=`
  varying vec2 vUv;uniform sampler2D geometricMap,rawNormalMap;uniform vec2 resolution;uniform float surfaceFar;
  void main(){
    vec4 ng=texture2DLodEXT(geometricMap,vUv,0.);vec3 center=texture2DLodEXT(rawNormalMap,vUv,0.).rgb;
    if(ng.a<=0.){gl_FragColor=vec4(0.);return;}
    float radius=3.*clamp(1.-.2*surfaceFar*ng.a,0.,1.);
    if(radius<=0.){gl_FragColor=vec4(center,1.);return;}
    vec3 sum=center;
    for(int i=0;i<9;i++){
      float r=.5+float(i)*.3;if(r>=radius)break;float a=float(i)*2.399963140487671;
      vec2 uv=vUv+vec2(cos(a),sin(a))*r/resolution;
      float depth=texture2DLodEXT(geometricMap,uv,0.).a;
      if(depth>0.&&abs(depth-ng.a)<.0001)sum+=texture2DLodEXT(rawNormalMap,uv,0.).rgb*(1.-r/radius);
    }
    gl_FragColor=vec4(sum/(length(sum)+.0001),1.);
  }
`;

const lightingMarkers=['lights_physical_fragment','lights_phong_fragment','lights_lambert_fragment','lights_toon_fragment'];
const surfaceDeclarations=`
  layout(location=1) out highp vec4 surfaceRawNormal;
  layout(location=2) out highp vec4 surfaceAlbedo;
  layout(location=3) out highp vec4 surfaceEmission;
  uniform float surfaceFar;
`;

export function captureSurfaceShader(shader,{raycast=false,basic=false}={}){
  shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\n'+surfaceDeclarations);
  if(basic){
    shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 surfaceViewPoint;').replace('#include <project_vertex>','#include <project_vertex>\nsurfaceViewPoint=mvPosition.xyz;');
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nvarying vec3 surfaceViewPoint;');
  }
  const marker=basic?'#include <specularmap_fragment>':lightingMarkers.map(n=>'#include <'+n+'>').find(n=>shader.fragmentShader.includes(n));
  if(!marker)throw new Error('Unsupported surface shader layout');
  const end=shader.fragmentShader.indexOf(marker);
  const viewPoint=basic?'surfaceViewPoint':raycast?'-objectViewPoint':'-vViewPosition';
  const geometric=raycast?'nonPerturbedNormal':`normalize(cross(dFdx(${viewPoint}),dFdy(${viewPoint})))`;
  const normal=basic?'surfaceNg':'normal';
  shader.fragmentShader=shader.fragmentShader.slice(0,end)+`
    vec3 surfaceNg=${geometric};
    ${basic?'':'if(dot(surfaceNg,nonPerturbedNormal)<0.)surfaceNg=-surfaceNg;'}
    vec3 worldNg=inverseTransformDirection(surfaceNg,viewMatrix),worldNl=inverseTransformDirection(${normal},viewMatrix);
    gl_FragColor=vec4(worldNg,max(-(${viewPoint}).z/surfaceFar,0.));
    surfaceRawNormal=vec4(worldNl,${basic?'1.':raycast?'objectColor.a':'roughnessFactor'});
    surfaceAlbedo=vec4(diffuseColor.rgb,${basic?'0.':raycast?'objectFinish.r':'metalnessFactor'});
    surfaceEmission=vec4(${basic?'vec3(0.)':'totalEmissiveRadiance'},1.);
  }`;
  // Non-PBR materials have no roughness/metalness factors. Keep their captured
  // physical defaults explicit without changing their original forward shader.
  if(!basic&&!shader.fragmentShader.includes('float roughnessFactor')&&!shader.fragmentShader.includes('#include <roughnessmap_fragment>'))shader.fragmentShader=shader.fragmentShader.replace('vec3 surfaceNg=','float roughnessFactor=1.;float metalnessFactor=0.;vec3 surfaceNg=');
  return shader;
}

function supported(material){return material&&(material.isMeshStandardMaterial||material.isMeshPhongMaterial||material.isMeshLambertMaterial||material.isMeshToonMaterial||material.isMeshBasicMaterial)&&!material.transparent&&material.opacity>=1&&!(material.transmission>0)&&material.depthWrite;}

// Current opaque scene contract: Ng.xyz + normalized linear depth (32-bit),
// raw Nl.xyz + roughness, unlit albedo.rgb + metalness, emission.rgb + valid.
// The lighting path stays forward; these MRT surfaces are also usable by later
// reflection/deferred passes. Motion, glass layers and history are not supplied.
export class SurfaceBuffer{
  constructor(renderer,camera){
    this.renderer=renderer;this.camera=camera;this.enabled=true;this.records=new Set();this.materials=new WeakMap();this.size=new THREE.Vector2(1,1);this.renderSerial=0;this.framebufferChecked=false;
    this.target=new THREE.WebGLRenderTarget(1,1,{count:4,type:THREE.HalfFloatType,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter});
    this.target.textures[0].type=THREE.FloatType;
    this.target.textures.forEach((t,i)=>{t.name=['NgLinearDepth','RawNlRoughness','AlbedoMetalness','EmissionValidity'][i];t.colorSpace=THREE.NoColorSpace;t.generateMipmaps=false;});
    this.target.depthTexture=new THREE.DepthTexture(1,1,THREE.UnsignedIntType);
    this.filtered=new THREE.WebGLRenderTarget(1,1,{depthBuffer:false,type:THREE.HalfFloatType,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter});
    this.filtered.texture.name='DepthFilteredNl';
    this.uniforms={surfaceFar:{value:camera.far},surfaceResolution:{value:this.size},surfaceNormalMap:{value:this.filtered.texture},surfaceGeometryMap:{value:this.target.textures[0]},surfaceNormalsEnabled:{value:0}};
    this.filterMaterial=new THREE.ShaderMaterial({depthTest:false,depthWrite:false,toneMapped:false,uniforms:{geometricMap:{value:this.target.textures[0]},rawNormalMap:{value:this.target.textures[1]},resolution:{value:this.size},surfaceFar:this.uniforms.surfaceFar},vertexShader:vertex,fragmentShader:SMOOTH_NORMAL_GLSL});
    this.quad=new THREE.Mesh(new THREE.PlaneGeometry(2,2),this.filterMaterial);this.quad.frustumCulled=false;this.scene=new THREE.Scene();this.scene.add(this.quad);this.screenCamera=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
    this.hiddenMaterial=new THREE.MeshBasicMaterial({visible:false});
    this.contextRestored=()=>{this.framebufferChecked=false;if(this.paletteBatch){this.paletteBatch.enabled=true;this.paletteBatch.stats.error=null;}};renderer.domElement?.addEventListener('webglcontextrestored',this.contextRestored);
    this.clearColor=new THREE.Color();this.stats={mode:'mrt-smoothnormal',resolution:[1,1],bytes:52,capturedObjects:0,skippedObjects:0,materials:0,materialCopies:0,captureCpuMs:0,filterCpuMs:0,totalCpuMs:0,fallbacks:0,error:null};
    const gl=renderer.getContext?.();if(gl&&(gl.getParameter(gl.MAX_DRAW_BUFFERS)<4||!gl.getExtension('EXT_color_buffer_float')))this.disable('Float MRT surfaces unavailable');
  }
  disable(reason){this.enabled=false;this.uniforms.surfaceNormalsEnabled.value=0;this.stats.mode='depth-fallback';this.stats.error=reason;this.stats.fallbacks++;return this;}
  setEnabled(enabled){this.enabled=Boolean(enabled);this.uniforms.surfaceNormalsEnabled.value=0;this.stats.mode=this.enabled?'mrt-smoothnormal':'depth-fallback';return this;}
  resize(w,h){if(this.size.x!==w||this.size.y!==h)this.framebufferChecked=false;this.size.set(w,h);this.target.setSize(w,h);this.filtered.setSize(w,h);this.stats.resolution=[w,h];this.stats.bytes=w*h*52;}
  record(source){
    let record=this.materials.get(source);if(record)return record;
    const originalCompile=source.onBeforeCompile,originalKey=source.customProgramCacheKey,key=source.customProgramCacheKey(),clone=copyMaterialAttributeDefaults(source.clone(),source),basic=source.isMeshBasicMaterial,raycast=source.userData.surfaceRaycast===true;
    record={source,clone,originalCompile,originalKey,key,sourceVersion:source.version,lastRefresh:-1,captureKeys:captureMaterialKeys(clone)};
    clone.toneMapped=false;clone.blending=THREE.NoBlending;clone.onBeforeCompile=(shader,r)=>{originalCompile.call(source,shader,r);shader.uniforms.surfaceFar=this.uniforms.surfaceFar;captureSurfaceShader(shader,{raycast,basic});};
    clone.customProgramCacheKey=()=>key+'-surface-capture-v1';
    if(!basic){
      record.wrapper=(shader,r)=>{
        originalCompile.call(source,shader,r);Object.assign(shader.uniforms,this.uniforms);
        const marker=lightingMarkers.map(n=>'#include <'+n+'>').find(n=>shader.fragmentShader.includes(n));if(!marker)return;
        shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>\nuniform sampler2D surfaceNormalMap,surfaceGeometryMap;uniform vec2 surfaceResolution;uniform float surfaceNormalsEnabled,surfaceFar;`);
        const distance=raycast?'objectViewPoint.z':'vViewPosition.z';
        shader.fragmentShader=shader.fragmentShader.replace(marker,`
          if(surfaceNormalsEnabled>.5){vec2 surfaceUV=gl_FragCoord.xy/surfaceResolution;vec4 surfaceNgDepth=texture2D(surfaceGeometryMap,surfaceUV);vec4 surfaceNl=texture2D(surfaceNormalMap,surfaceUV);
            if(surfaceNgDepth.a>0.&&surfaceNl.a>.5&&dot(surfaceNl.rgb,surfaceNl.rgb)>1e-12&&abs(surfaceNgDepth.a*surfaceFar-${distance})<max(.0001,abs(${distance})*.00001))normal=normalize((viewMatrix*vec4(surfaceNl.rgb,0.)).xyz);
          }\n`+marker);
      };
      source.onBeforeCompile=record.wrapper;source.customProgramCacheKey=()=>key+'-surface-lighting-v1';source.needsUpdate=true;
    }
    record.release=()=>{clone.dispose();this.records.delete(record);this.materials.delete(source);source.removeEventListener('dispose',record.release);if(source.onBeforeCompile===record.wrapper){source.onBeforeCompile=originalCompile;source.customProgramCacheKey=originalKey;source.needsUpdate=true;}};
    source.addEventListener('dispose',record.release);this.records.add(record);this.materials.set(source,record);return record;
  }
  render(scene,camera){
    this.captured=[];
    this.uniforms.surfaceNormalsEnabled.value=0;if(!this.enabled){this.stats.captureCpuMs=this.stats.filterCpuMs=this.stats.totalCpuMs=0;return false;}
    const gl=this.renderer.getContext?.();if(gl?.isContextLost?.()){this.framebufferChecked=false;this.stats.captureCpuMs=this.stats.filterCpuMs=this.stats.totalCpuMs=0;return false;}
    const started=performance.now();this.renderSerial++;this.stats.materialCopies=0;this.paletteBatch?.beginFrame();
    const r=this.renderer,replaced=[],hidden=[],background=scene.background,override=scene.overrideMaterial,target=r.getRenderTarget?.(),autoClear=r.autoClear,clearAlpha=r.getClearAlpha?.()??1,shadowAuto=r.shadowMap?.autoUpdate,shadowNeeds=r.shadowMap?.needsUpdate;
    r.getClearColor?.(this.clearColor);this.uniforms.surfaceFar.value=camera.far;let objects=0,skipped=0;
    try{
      scene.traverseVisible(object=>{
        if(!object.material)return;if(!object.isMesh){hidden.push([object,object.visible]);object.visible=false;skipped++;return;}
        const materials=Array.isArray(object.material)?object.material:[object.material],indices=this.activeMaterialWork&&Array.isArray(object.material)?activeMaterialIndices(object.geometry):materials.map((m,i)=>i),clones=Array(materials.length).fill(this.hiddenMaterial),acceptedSlots=Array(materials.length).fill(false);let accepted=false;
        for(const i of indices){const source=materials[i];if(!supported(source))continue;accepted=true;acceptedSlots[i]=true;const record=this.record(source),clone=record.clone;if(record.lastRefresh!==this.renderSerial){const versionChanged=record.sourceVersion!==source.version;if(versionChanged||captureMaterialChanged(source,clone,record.captureKeys)){clone.copy(source);copyMaterialAttributeDefaults(clone,source);clone.toneMapped=false;clone.blending=THREE.NoBlending;this.stats.materialCopies++;}if(versionChanged){clone.needsUpdate=true;record.sourceVersion=source.version;}record.lastRefresh=this.renderSerial;}clone.visible=source.visible;clones[i]=clone;}
        if(!accepted){hidden.push([object,object.visible]);object.visible=false;skipped++;return;}
        // A mixed transparent/opaque material array keeps unsupported groups
        // invisible only for this prepass. Its forward material array is intact.
        const originalMaterial=object.material,originalGeometry=object.geometry,captureMaterials=Array.isArray(originalMaterial)?clones:clones[0];
        let batch=null;if(this.paletteBatchEnabled){this.paletteBatch??=new PaletteCaptureBatch();try{batch=this.paletteBatch.prepare(object,materials,clones,this);}catch(error){this.paletteBatch.disable(error.message);}}
        replaced.push([object,originalMaterial,originalGeometry,captureMaterials,acceptedSlots]);object.material=batch?.material??captureMaterials;if(batch)object.geometry=batch.geometry;objects++;
      });
      scene.background=null;scene.overrideMaterial=null;r.autoClear=true;r.setClearColor?.(0x000000,0);if(r.shadowMap){r.shadowMap.autoUpdate=false;r.shadowMap.needsUpdate=false;}
      r.setRenderTarget(this.target);if(gl&&!this.framebufferChecked){if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('Incomplete surface MRT framebuffer');this.framebufferChecked=true;}
      r.render(scene,camera);
      const failedBatch=r.info?.programs?.find(p=>p.diagnostics?.runnable===false&&p.cacheKey?.includes('-palette-atlas-v1'));
      if(failedBatch&&this.paletteBatch?.enabled){this.paletteBatch.disable('Palette capture shader failed');for(const [o,m,g,c]of replaced){o.geometry=g;o.material=c;}r.render(scene,camera);}
      const capturedAt=performance.now();this.stats.captureCpuMs=capturedAt-started;
      const failed=r.info?.programs?.find(p=>p.diagnostics?.runnable===false&&p.cacheKey?.includes('-surface-capture-v1')&&!p.cacheKey?.includes('-palette-atlas-v1'));if(failed)throw new Error('Surface capture shader failed to compile');
      r.setRenderTarget(this.filtered);r.render(this.scene,this.screenCamera);this.stats.filterCpuMs=performance.now()-capturedAt;this.stats.capturedObjects=objects;this.stats.skippedObjects=skipped;this.stats.materials=this.records.size;this.stats.error=null;
      this.captured=replaced.map(([object,material,geometry,captures,accepted])=>({object,material,captures,accepted}));this.stats.paletteBatch=this.paletteBatch?.stats;return true;
    }catch(error){if(gl?.isContextLost?.()){this.framebufferChecked=false;return false;}this.disable(error.message);return false;}
    finally{for(const [o,m,g] of replaced){o.material=m;o.geometry=g;}for(const [o,v] of hidden)o.visible=v;scene.background=background;scene.overrideMaterial=override;r.autoClear=autoClear;r.setClearColor?.(this.clearColor,clearAlpha);if(r.shadowMap){r.shadowMap.autoUpdate=shadowAuto;r.shadowMap.needsUpdate=shadowNeeds;}r.setRenderTarget(target??null);this.stats.totalCpuMs=performance.now()-started;}
  }
  dispose(){this.captured=[];this.paletteBatch?.dispose();this.renderer.domElement?.removeEventListener('webglcontextrestored',this.contextRestored);for(const record of [...this.records])record.release();this.target.dispose();this.filtered.dispose();this.filterMaterial.dispose();this.hiddenMaterial.dispose();this.quad.geometry.dispose();}
}
