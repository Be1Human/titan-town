import * as THREE from '../../../vendor/three.module.js';
import {MATERIAL_KEYS} from '../../voxel-world.js';
import {VOXEL_SHOULDER_NORMAL_GLSL,VOXEL_FINISH_COLOR_GLSL,VOXEL_FINISH_PROFILE_IDS} from '../../voxel-finish-glsl.js';
import {packVolumeRegion,PackedVolumeUploader} from './packed-volume-upload.js';
const localShadowHooks=new WeakSet();
export const isLocalVoxelShadowHook=hook=>localShadowHooks.has(hook);

// Independent implementation: palette indices remain exact at the finest level;
// coarser levels contain occupancy, never averaged palette colours.
export function buildObjectVolume(cells,{cellSize=.1,center={x:0,y:0,z:0},maxVoxels=1048576}={}){
  if(!cells.length||!(cellSize>0))throw new Error('Empty or invalid object volume');
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(const c of cells)for(let a=0;a<3;a++){const v=c[['x','y','z'][a]];if(!Number.isInteger(v))throw new Error('Voxel coordinates must be integers');min[a]=Math.min(min[a],v);max[a]=Math.max(max[a],v+1);}
  const size=max.map((v,a)=>Math.ceil((v-min[a])/4)*4),count=size.reduce((a,b)=>a*b,1);
  if(count>maxVoxels)throw new Error('Object volume exceeds raycast allocation budget');
  const data=new Uint8Array(count),index=(x,y,z,s)=>x+s[0]*(y+s[1]*z);
  for(const c of cells){const id=c.paletteIndex??MATERIAL_KEYS.indexOf(c.mat);if(id<1||id>255)throw new Error('Invalid voxel palette index');data[index(c.x-min[0],c.y-min[1],c.z-min[2],size)]=id;}
  const levels=[{data,size}];
  for(let level=1;level<=2;level++){
    const previous=levels[level-1],s=previous.size.map(v=>v/2),out=new Uint8Array(s.reduce((a,b)=>a*b,1));
    for(let z=0;z<s[2];z++)for(let y=0;y<s[1];y++)for(let x=0;x<s[0];x++){
      let n=0;for(let dz=0;dz<2;dz++)for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++)n+=Number(previous.data[index(x*2+dx,y*2+dy,z*2+dz,previous.size)]!==0);
      out[index(x,y,z,s)]=level===1?Number(n>0):n;
    }levels.push({data:out,size:s});
  }
  return {levels,min,cellSize,localMin:min.map((v,a)=>v*cellSize-center[['x','y','z'][a]]),localMax:max.map((v,a)=>v*cellSize-center[['x','y','z'][a]]),bytes:levels.reduce((n,l)=>n+l.data.byteLength,0)};
}

export function removeObjectVoxels(volume,removed){
  const bounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]},level=volume.levels[0];let count=0;
  for(const c of removed){const p=['x','y','z'].map((k,a)=>c[k]-volume.min[a]);
    if(p.some((v,a)=>v<0||v>=level.size[a]))throw Error('Cut outside object volume');
    const i=p[0]+level.size[0]*(p[1]+level.size[1]*p[2]);if(!level.data[i])continue;level.data[i]=0;count++;
    for(let a=0;a<3;a++){bounds.min[a]=Math.min(bounds.min[a],p[a]);bounds.max[a]=Math.max(bounds.max[a],p[a]+1);}}
  if(!count)return {count,regions:[]};const regions=[bounds];
  for(let l=1;l<volume.levels.length;l++){const previous=volume.levels[l-1],out=volume.levels[l],last=regions[l-1];
    const r={min:last.min.map(v=>Math.floor(v/2)),max:last.max.map(v=>Math.ceil(v/2))};regions.push(r);
    for(let z=r.min[2];z<r.max[2];z++)for(let y=r.min[1];y<r.max[1];y++)for(let x=r.min[0];x<r.max[0];x++){
      let n=0;for(let dz=0;dz<2;dz++)for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++)n+=Number(previous.data[x*2+dx+previous.size[0]*(y*2+dy+previous.size[1]*(z*2+dz))]!==0);
      out.data[x+out.size[0]*(y+out.size[1]*z)]=l===1?Number(n>0):n;}}
  return {count,regions};
}

// CPU oracle used by deterministic hit/depth tests, independent of GPU stepping.
export function traceObjectVolume(volume,origin,direction,maxDistance=Infinity){
  const len=Math.hypot(...direction);if(!len)return null;const d=direction.map(v=>v/len),lo=volume.localMin,hi=volume.localMax;
  let enter=-Infinity,exit=Infinity,normal=[0,0,0];
  for(let a=0;a<3;a++){
    if(Math.abs(d[a])<1e-12){if(origin[a]<lo[a]||origin[a]>=hi[a])return null;continue;}
    let t0=(lo[a]-origin[a])/d[a],t1=(hi[a]-origin[a])/d[a];if(t0>t1)[t0,t1]=[t1,t0];
    if(t0>enter){enter=t0;normal=[0,0,0];normal[a]=-Math.sign(d[a]);}exit=Math.min(exit,t1);
  }
  if(exit<Math.max(0,enter))return null;
  let t=Math.max(0,enter),p=origin.map((v,a)=>Math.floor((v+d[a]*(t+volume.cellSize*1e-6)-lo[a])/volume.cellSize));
  const next=p.map((v,a)=>d[a]?(lo[a]+(v+Number(d[a]>0))*volume.cellSize-origin[a])/d[a]:Infinity),delta=d.map(v=>v?volume.cellSize/Math.abs(v):Infinity),s=volume.levels[0].size;
  for(let i=0;i<4096&&t<=Math.min(exit,maxDistance);i++){
    if(p.every((v,a)=>v>=0&&v<s[a])){const id=volume.levels[0].data[p[0]+s[0]*(p[1]+s[1]*p[2])];if(id)return {id,distance:t,normal,cell:[...p],point:origin.map((v,a)=>v+d[a]*t)};}
    const a=next[0]<=next[1]&&next[0]<=next[2]?0:next[1]<=next[2]?1:2;t=next[a];next[a]+=delta[a];p[a]+=Math.sign(d[a]);normal=[0,0,0];normal[a]=-Math.sign(d[a]);
  }return null;
}

const declarations=`
varying vec3 objectProxyPoint;
uniform highp usampler3D objectVoxels,objectOccupancy2,objectOccupancy4;
uniform vec3 objectMin,objectMax,objectCamera,objectDirection;
uniform float objectCell,objectOrthographic;
uniform mat4 objectModel,objectModelView,objectProjection;
uniform mat3 objectNormalMatrix;
vec3 objectHitPoint,objectHitNormal,objectViewPoint;
vec4 objectWorldPoint;int objectPalette;float objectDepth;
bool objectTrace(){
  vec3 dir=objectOrthographic>.5?objectDirection:normalize(objectProxyPoint-objectCamera);
  vec3 origin=objectOrthographic>.5?objectProxyPoint-dir*length(objectMax-objectMin)*2.:objectCamera;
  vec3 safeDir=vec3(abs(dir.x)<1e-8?1e-8:dir.x,abs(dir.y)<1e-8?1e-8:dir.y,abs(dir.z)<1e-8?1e-8:dir.z);
  vec3 a=(objectMin-origin)/safeDir,b=(objectMax-origin)/safeDir,nearT=min(a,b),farT=max(a,b);
  float entry=max(nearT.x,max(nearT.y,nearT.z)),endT=min(farT.x,min(farT.y,farT.z));
  if(endT<max(entry,0.))return false;
  int axis=nearT.x>=nearT.y&&nearT.x>=nearT.z?0:nearT.y>=nearT.z?1:2;
  objectHitNormal=vec3(0.);objectHitNormal[axis]=-sign(dir[axis]);float t=max(entry,0.);
  for(int stepIndex=0;stepIndex<1024;stepIndex++){
    vec3 point=origin+dir*(t+objectCell*.0001);
    if(any(lessThan(point,objectMin))||any(greaterThanEqual(point,objectMax)))return false;
    ivec3 cell=ivec3(floor((point-objectMin)/objectCell));
    float scale=4.;uint occupied=texelFetch(objectOccupancy4,cell/4,0).r;
    if(occupied!=0u){scale=2.;occupied=texelFetch(objectOccupancy2,cell/2,0).r;}
    if(occupied!=0u){scale=1.;uint id=texelFetch(objectVoxels,cell,0).r;if(id!=0u){objectPalette=int(id);objectHitPoint=origin+dir*t;return true;}}
    vec3 grid=floor((point-objectMin)/(objectCell*scale));
    vec3 edge=objectMin+(grid+step(vec3(0.),dir))*objectCell*scale;
    vec3 delta=(edge-point)/safeDir;
    if(abs(dir.x)<1e-8)delta.x=1e20;if(abs(dir.y)<1e-8)delta.y=1e20;if(abs(dir.z)<1e-8)delta.z=1e20;
    axis=delta.x<=delta.y&&delta.x<=delta.z?0:delta.y<=delta.z?1:2;
    t+=max(delta[axis],0.)+objectCell*.0001;
    objectHitNormal=vec3(0.);objectHitNormal[axis]=-sign(dir[axis]);if(t>endT)return false;
  }return false;
}
`;
const hitCode=`if(!objectTrace())discard;
objectWorldPoint=objectModel*vec4(objectHitPoint,1.);
objectViewPoint=-(objectModelView*vec4(objectHitPoint,1.)).xyz;
vec4 objectClip=objectProjection*vec4(-objectViewPoint,1.);
objectDepth=objectClip.z/objectClip.w*.5+.5;
if(objectDepth<0.||objectDepth>1.)discard;gl_FragDepth=objectDepth;`;

export function createVoxelRaycastView({cells,center,cellSize=.1,materials,woodAxis}){
  // Transmission/sorted transparency needs a separate multi-hit pass. Keep
  // those shapes on the original mesh backend until that pass is available.
  if(cells.some(c=>{const m=materials[c.paletteIndex??MATERIAL_KEYS.indexOf(c.mat)];return !m||m.transparent||m.transmission>0;}))throw new Error('Raycast backend currently supports opaque palette materials');
  const volume=buildObjectVolume(cells,{center,cellSize});if(volume.levels[0].size.reduce((n,v)=>n+v,0)>1000)throw new Error('Object exceeds traversal budget');
  const extent=volume.localMax.map((v,a)=>v-volume.localMin[a]),axes=[0,1,2].sort((a,b)=>extent[b]-extent[a]);
  // Long boards/logs use their source volume's long axis. Callers can retain
  // the original axis explicitly when a cut creates a short fragment.
  const inferredAxis=extent[axes[0]]>=2*Math.max(extent[axes[1]],cellSize)?['x','y','z'][axes[0]]:undefined;
  const finishAxis=woodAxis??inferredAxis;
  const textures=volume.levels.map(({data,size})=>{
    const t=new THREE.Data3DTexture(data,...size);t.format=THREE.RedIntegerFormat;t.type=THREE.UnsignedByteType;t.internalFormat='R8UI';t.minFilter=t.magFilter=THREE.NearestFilter;t.unpackAlignment=1;t.generateMipmaps=false;t.needsUpdate=true;return t;
  });
  const uniforms={objectVoxels:{value:textures[0]},objectOccupancy2:{value:textures[1]},objectOccupancy4:{value:textures[2]},objectMin:{value:new THREE.Vector3(...volume.localMin)},objectMax:{value:new THREE.Vector3(...volume.localMax)},objectCell:{value:cellSize},objectCamera:{value:new THREE.Vector3()},objectDirection:{value:new THREE.Vector3()},objectOrthographic:{value:0},objectModel:{value:new THREE.Matrix4()},objectModelView:{value:new THREE.Matrix4()},objectProjection:{value:new THREE.Matrix4()},objectNormalMatrix:{value:new THREE.Matrix3()}};
  // Colour/physical data keep their original rows. The third row carries the
  // same material finish metadata as the mesh shader, never averaged voxels.
  const palette=new THREE.DataTexture(new Float32Array(256*12),256,3,THREE.RGBAFormat,THREE.FloatType);palette.minFilter=palette.magFilter=THREE.NearestFilter;palette.needsUpdate=true;
  for(let i=1;i<materials.length&&i<256;i++){
    const m=materials[i];if(!m)continue;const style=m.userData.voxelStyle??{},axis=style.wood?(finishAxis??style.woodAxis??'y'):(style.woodAxis??'y');
    palette.image.data.set([m.color.r,m.color.g,m.color.b,m.roughness??.9],i*4);palette.image.data.set([m.metalness??0,m.emissive?.r*(m.emissiveIntensity??1)||0,m.emissive?.g*(m.emissiveIntensity??1)||0,m.emissive?.b*(m.emissiveIntensity??1)||0],(256+i)*4);
    palette.image.data.set([style.grain??0,style.finishProfile??VOXEL_FINISH_PROFILE_IDS[style.profile]??0,Math.max(0,['x','y','z'].indexOf(axis)),style.bevel??0],(512+i)*4);
  }
  uniforms.objectPaletteMap={value:palette};
  const vertexHook=shader=>shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 objectProxyPoint;').replace('#include <begin_vertex>','#include <begin_vertex>\nobjectProxyPoint=position;');
  const material=new THREE.MeshStandardMaterial({color:0xffffff,roughness:.9,side:THREE.BackSide,shadowSide:THREE.BackSide});
  material.onBeforeCompile=shader=>{
    Object.assign(shader.uniforms,uniforms);shader.vertexShader=vertexHook(shader);
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>\n${declarations}\nuniform sampler2D objectPaletteMap;\n${VOXEL_SHOULDER_NORMAL_GLSL}\n${VOXEL_FINISH_COLOR_GLSL}\n#if NUM_DIR_LIGHT_SHADOWS > 0\nuniform mat4 directionalShadowMatrix[NUM_DIR_LIGHT_SHADOWS];\n#endif`)
      .replace('#include <clipping_planes_fragment>',hitCode+'\n#include <clipping_planes_fragment>')
      .replace('#include <map_fragment>',`vec4 objectColor=texelFetch(objectPaletteMap,ivec2(objectPalette,0),0);vec4 objectFinish=texelFetch(objectPaletteMap,ivec2(objectPalette,1),0);vec4 objectStyle=texelFetch(objectPaletteMap,ivec2(objectPalette,2),0);diffuseColor.rgb=voxelFinishColor(objectColor.rgb,objectHitPoint,objectHitNormal,objectCell,objectStyle.r,objectStyle.g,objectStyle.b);totalEmissiveRadiance=objectFinish.gba;`)
      .replace('#include <roughnessmap_fragment>','float roughnessFactor=objectColor.a;')
      .replace('#include <metalnessmap_fragment>','float metalnessFactor=objectFinish.r;')
      .replace('#include <normal_fragment_begin>',`float faceDirection=1.;vec3 normal=normalize(objectNormalMatrix*objectHitNormal);vec3 nonPerturbedNormal=normal;`)
      .replace('#include <normal_fragment_maps>',`vec3 objectGrid=(objectHitPoint-objectMin)/objectCell;vec2 objectFace=abs(objectHitNormal.y)>.5?objectGrid.xz:abs(objectHitNormal.x)>.5?objectGrid.zy:objectGrid.xy;vec2 objectEdge=min(fract(objectFace),1.-fract(objectFace));float objectDetail=1.-smoothstep(.025,.12,max(fwidth(objectFace.x),fwidth(objectFace.y)));float objectHeight=smoothstep(.008,.085,min(objectEdge.x,objectEdge.y))*objectCell*objectStyle.a*objectDetail;normal=voxelShoulderNormal(-objectViewPoint,normal,objectHeight);`)
      .replace('#include <lights_fragment_begin>',THREE.ShaderChunk.lights_fragment_begin.replaceAll('vViewPosition','objectViewPoint').replaceAll('vDirectionalShadowCoord[ i ]','directionalShadowMatrix[ i ] * (objectWorldPoint + vec4(inverseTransformDirection(nonPerturbedNormal,viewMatrix)*directionalLightShadow.shadowNormalBias,0.))'))
      .replace('#include <fog_fragment>',THREE.ShaderChunk.fog_fragment.replaceAll('vFogDepth','objectViewPoint.z'));
  };
  material.customProgramCacheKey=()=> 'object-dda-standard-v2-finish';
  material.userData.surfaceRaycast=true;
  const depth=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking,side:THREE.BackSide});
  depth.onBeforeCompile=shader=>{Object.assign(shader.uniforms,uniforms);shader.vertexShader=vertexHook(shader);shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\n'+declarations).replace('#include <clipping_planes_fragment>',hitCode+'\n#include <clipping_planes_fragment>').replaceAll('vHighPrecisionZW[ 0 ] / vHighPrecisionZW[ 1 ]','objectDepth').replace('0.5 * objectDepth + 0.5','objectDepth');};depth.customProgramCacheKey=()=> 'object-dda-depth-v2';
  const geometry=new THREE.BoxGeometry(...extent);geometry.translate(...volume.localMin.map((v,a)=>v+extent[a]/2));
  const mesh=new THREE.Mesh(geometry,material);mesh.castShadow=mesh.receiveShadow=true;mesh.customDepthMaterial=depth;mesh.userData.voxelRaycast=true;
  const inverse=new THREE.Matrix4();
  const update=(renderer,scene,camera)=>{inverse.copy(mesh.matrixWorld).invert();uniforms.objectCamera.value.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inverse);camera.getWorldDirection(uniforms.objectDirection.value).transformDirection(inverse);uniforms.objectOrthographic.value=Number(camera.isOrthographicCamera===true);uniforms.objectModel.value.copy(mesh.matrixWorld);uniforms.objectModelView.value.multiplyMatrices(camera.matrixWorldInverse,mesh.matrixWorld);uniforms.objectNormalMatrix.value.getNormalMatrix(uniforms.objectModelView.value);uniforms.objectProjection.value.copy(camera.projectionMatrix);};
  mesh.onBeforeRender=update;mesh.onBeforeShadow=(renderer,object,camera,shadowCamera)=>update(renderer,null,shadowCamera);
  localShadowHooks.add(mesh.onBeforeShadow);
  let uploader,uploadRenderer;const stats={voxels:cells.length,bytes:volume.bytes+palette.image.data.byteLength,backend:'raycast',localUpdates:0,uploadBytes:0};
  return {mesh,volume,textures,stats,updateRemoved(removed,renderer){
    const report=removeObjectVoxels(volume,removed);if(!report.count)return report;
    if(uploadRenderer!==renderer){uploader?.dispose();uploader=new PackedVolumeUploader(renderer);uploadRenderer=renderer;}
    for(const [l,region]of report.regions.entries()){
      const target=textures[l];if(!renderer.properties.get(target).__webglTexture){target.needsUpdate=true;continue;}
      const {data,size}=volume.levels[l],length=region.max.reduce((n,v,a)=>n*(v-region.min[a]),1),packed=packVolumeRegion(data,size,1,region,new Uint8Array(length));
      const source=new THREE.Data3DTexture(packed.data,packed.width,packed.height,packed.depth);source.format=target.format;source.type=target.type;source.internalFormat='R8UI';source.unpackAlignment=1;
      try{uploader.copy(source,target,null,new THREE.Vector3(...region.min));stats.uploadBytes+=length;}finally{source.dispose();}
    }
    mesh.userData.shadowRevision=(mesh.userData.shadowRevision||0)+1;stats.voxels-=report.count;stats.localUpdates++;return report;
  },dispose(){uploader?.dispose();geometry.dispose();material.dispose();depth.dispose();palette.dispose();textures.forEach(t=>t.dispose());mesh.removeFromParent();}};
}
