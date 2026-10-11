import * as THREE from '../vendor/three.module.js';
import {NativeOpaquePass} from './engine/render/native-opaque-pass.js';
import {ShadowGroupBatch} from './engine/render/shadow-group-batch.js';
import {MATERIAL_KEYS} from './voxel-world.js';
import {loadJSONResource} from './json-resource.js';
import {VoxelLightVolume,DynamicVoxelLightVolume,sampleToolLighting} from './voxel-light-volume.js';
import {voxelMaterialBank} from './voxel-material.js';
import {installSoftSun,SUN_ANGULAR_RADIUS,SHADOW_SPAN,SHADOW_RANGE} from './soft-sun.js';
import {DAYLIGHT_LOOK,makeDaylightLUT} from './daylight-look.js';
import {REFERENCE_LOOK,REFERENCE_OUTPUT_GLSL} from './engine/render/reference-look.js';
import {SurfaceBuffer} from './engine/render/surface-buffer.js';
import {packVolumeRegion,PackedVolumeUploader} from './engine/render/packed-volume-upload.js';
import {HUB_NATIVE_LIGHT_GLSL} from './hub-native-light-glsl.js';

const vertex=`varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}`;
const positionCode=`
  uniform sampler2D depthMap;
  uniform mat4 projectionInverse;
  vec3 positionAt(vec2 uv){float d=texture2DLodEXT(depthMap,uv,0.).r;vec4 p=projectionInverse*vec4(uv*2.-1.,d*2.-1.,1.);return p.xyz/p.w;}
`;
// Anime look inside the composite (linear HDR, before distance fog): incident
// light is posterized in log2 stops so bands survive auto exposure, keeping its
// chroma; ink lines come from the Laplacian of inverse view depth (silhouettes,
// steps) and from Ng creases near the camera. Tools render after the composite
// and are never inked. animeParams = (stop width, band softness, ink strength,
// crease strength); animeShade = (shadow tint rgb, tint amount); animeEdge =
// (relative depth jump, crease fade distance, saturation); animeWarm = (lit
// band tint rgb, albedo-edge ink strength); animeHaze = (aerial perspective rgb,
// 1/m density); animeGrade = (overall grade rgb, backlight rim strength);
// animeInkColor = ink multiplier rgb, animeRange = (max bands below the lit
// band, albedo flatten threshold, haze cap); animeInkFade = (start, end) m of
// the ink distance fade. Ink is laid last, after haze and fog, so distance
// never washes lines out; the fade alone removes far-field noise.
export const ANIME_DEFAULTS=Object.freeze({stops:1,softness:.05,ink:.85,crease:.5,inkDepth:.04,creaseFar:24,saturation:1.2,shadowTint:[.7,.8,1.12],tint:.65,
  warm:[1,1,1],edgeInk:0,haze:[.7,.72,.8],hazeDensity:0,hazeMax:0,grade:[1,1,1],rim:0,inkColor:[0,0,0],inkFade:[1e4,2e4],bandFloor:-8,flatten:0});
const ANIME_GLSL=`
  uniform float animeEnabled;uniform vec4 animeParams;uniform vec4 animeShade;uniform vec3 animeEdge;uniform vec2 animeTexel,animeInkFade;
  uniform vec4 animeWarm,animeHaze,animeGrade;uniform vec3 animeInkColor,animeRange,animeSun;uniform float animeLight;
  float animeLuma(vec3 c){return dot(c,vec3(.2126,.7152,.0722));}
  // Cel bands in log2 stops (absolute, so auto exposure does not move them);
  // with bandFloor set they are held to three: floor, floor+1, floor+2. Lit
  // bands lean warm, lower bands toward the cool shadow tint.
  vec3 animeBands(vec3 incident,out float band){
    float l=max(animeLuma(incident),1e-5),s=log2(l)/animeParams.x,b=floor(s);
    float q=b+smoothstep(.5-animeParams.y,.5+animeParams.y,s-b);
    if(animeRange.x>-7.)q=clamp(q,animeRange.x,animeRange.x+2.);
    float t=exp2(q*animeParams.x)/l;band=q;
    float shadow=clamp(-q*.5,0.,1.)*animeShade.w,lit=clamp(q+1.,0.,1.);
    return incident*t*mix(vec3(1.),animeShade.rgb,shadow)*mix(vec3(1.),animeWarm.rgb,lit);
  }
  vec3 animeSaturate(vec3 c,float k){float l=animeLuma(c);return max(mix(vec3(l),c,1.+(animeEdge.z-1.)*k),vec3(0.));}
  // Flat paint: average albedo over same-colour neighbours 3 and 6 px out, so
  // per-voxel jitter flattens while timber/plaster and other edges stay.
  // Performance quality (animeLight) samples only the four 4 px neighbours.
  vec3 animeFlatAlbedo(vec2 uv,vec3 a0){
    if(animeRange.y<=0.)return a0;
    vec3 sum=a0*2.;float total=2.;float l0=animeLuma(a0)+.02;
    for(int i=0;i<8;i++){
      if(animeLight>.5&&i>=4)break;
      float r=animeLight>.5?4.:i<4?3.:6.;vec2 d=(i==0||i==4)?vec2(1.,0.):(i==1||i==5)?vec2(-1.,0.):(i==2||i==6)?vec2(0.,1.):vec2(0.,-1.);
      vec3 a=texture2D(hubAlbedo,uv+d*animeTexel*r).rgb;float w=1.-smoothstep(animeRange.y*.5,animeRange.y,length(a-a0)/l0);
      sum+=a*w;total+=w;
    }
    return sum/total;
  }
  float animeInvDepth(vec2 uv){return 1./max(-viewZAt(uv),.05);}
  float animeInk(vec2 uv,float z){
    if(animeEnabled<.5)return 0.;
    // Silhouettes ink the nearer side of a depth jump, sampled 1.5 px out so
    // the line reads at full resolution; the far side stays clean.
    vec2 t=animeTexel*1.5;float w=1./max(-z,.05);
    float jump=max(max(w-animeInvDepth(uv-vec2(t.x,0.)),w-animeInvDepth(uv+vec2(t.x,0.))),max(w-animeInvDepth(uv-vec2(0.,t.y)),w-animeInvDepth(uv+vec2(0.,t.y))))/w;
    float silhouette=smoothstep(animeEdge.x,animeEdge.x*2.,jump);
    vec3 n=texture2D(hubGeometry,uv).rgb,nx=texture2D(hubGeometry,uv+vec2(t.x,0.)).rgb,ny=texture2D(hubGeometry,uv+vec2(0.,t.y)).rgb;
    float crease=0.,near=1.-smoothstep(animeEdge.y*.5,animeEdge.y,-z);
    if(dot(n,n)>.25&&dot(nx,nx)>.25&&dot(ny,ny)>.25)crease=smoothstep(.35,.75,1.-min(dot(normalize(n),normalize(nx)),dot(normalize(n),normalize(ny))))*near;
    // Paint edges (dark timber on light plaster): a 1 px line on the light
    // side, so beams and panels get a drawn outline.
    float edge=0.;
    if(animeWarm.w>0.&&texture2D(hubGeometry,uv).a>0.){
      vec2 e=animeTexel;float l0=animeLuma(texture2D(hubAlbedo,uv).rgb);
      float lmin=min(animeLuma(texture2D(hubAlbedo,uv+vec2(e.x,0.)).rgb),animeLuma(texture2D(hubAlbedo,uv+vec2(0.,e.y)).rgb));
      if(animeLight<.5)lmin=min(lmin,min(animeLuma(texture2D(hubAlbedo,uv-vec2(e.x,0.)).rgb),animeLuma(texture2D(hubAlbedo,uv-vec2(0.,e.y)).rgb)));
      edge=smoothstep(.45,.65,1.-lmin/max(l0,1e-4))*animeWarm.w*(1.-smoothstep(animeEdge.y,animeEdge.y*2.,-z));
    }
    return clamp(max(max(silhouette,crease*animeParams.w),edge),0.,1.)*animeParams.z;
  }
  vec3 animeInked(vec3 c,float ink,float dist){return c*mix(vec3(1.),animeInkColor,ink*(1.-smoothstep(animeInkFade.x,animeInkFade.y,dist)));}
  // Backlight rim: grazing surfaces lit from behind when looking toward the sun.
  vec3 animeRim(vec3 albedo,vec3 n,vec3 view,float lit){
    if(animeGrade.w<=0.||dot(n,n)<.25)return vec3(0.);
    n=normalize(n);float fresnel=pow(1.-clamp(dot(n,-view),0.,1.),3.),back=pow(max(0.,dot(view,animeSun)),1.5);
    return albedo*animeWarm.rgb*fresnel*back*lit*clamp(dot(n,animeSun)+.35,0.,1.)*animeGrade.w;
  }
  // Aerial perspective toward a lilac haze past 30 m, then the warm grade.
  vec3 animeAir(vec3 c,float dist){
    float k=(1.-exp(-max(0.,dist-30.)*animeHaze.w))*animeRange.z;
    return mix(c,animeHaze.rgb,k)*animeGrade.rgb;
  }
`;
// Independent restatement of the exported dof/focus arithmetic, not a copy of
// the original shaders. Source-bf5da0:1512–1623 and 1986–2011. Scene uniforms,
// original blue-noise payload and original HDR/pass placement remain unknown.
export const DOF_REFERENCE=Object.freeze({focusRadii:[.05,.15],focusStep:.005,focusAdaptation:.2,goldenAngle:2.39996323,radiusStep:.5});
const lensDepthCode=`
  uniform sampler2D depthMap;uniform mat4 projectionInverse;uniform float lensFar,lensNear;
  float lensDepthAt(vec2 uv){float z=texture2DLodEXT(depthMap,uv,0.).r*2.-1.;float viewZ=(projectionInverse[2][2]*z+projectionInverse[3][2])/(projectionInverse[2][3]*z+projectionInverse[3][3]);return max(-viewZ,lensNear)/lensFar;}
`;
const volumeCode=`
  precision highp usampler3D;
  uniform highp usampler3D occupancyMap;
  uniform highp sampler3D materialMap;
  uniform vec3 volumeMin,volumeSize,palette[14],sunDirection;
  uniform sampler2D sunMap;
  uniform mat4 sunMatrix;
  bool insideVolume(vec3 p){return all(greaterThanEqual(p,volumeMin))&&all(lessThan(p,volumeMin+volumeSize));}
  float visibilityAt(vec3 p){
    vec4 s=sunMatrix*vec4(p,1.);s.xyz/=s.w;
    if(any(lessThan(s.xyz,vec3(0.)))||any(greaterThan(s.xyz,vec3(1.))))return 1.;
    return step(s.z-.0006,unpackRGBAToDepth(texture2DLodEXT(sunMap,s.xy,0.)));
  }
  float boundaryDistance(vec3 p,vec3 dir,float cell){
    vec3 grid=floor((p-volumeMin)/cell);
    vec3 edge=volumeMin+(grid+step(vec3(0.),dir))*cell;
    vec3 delta=(edge-p)/dir;
    if(abs(dir.x)<.00001)delta.x=1e5;
    if(abs(dir.y)<.00001)delta.y=1e5;
    if(abs(dir.z)<.00001)delta.z=1e5;
    return max(0.,min(delta.x,min(delta.y,delta.z)));
  }
  // Empty 40 cm blocks skip four cells; occupied blocks inspect exact 10 cm bits.
  vec4 traceLight(vec3 start,vec3 dir,float stepCount,out vec3 hitPosition){
    float travel=0.;vec3 p=start;hitPosition=start;
    for(int i=0;i<32;i++){
      if(float(i)>=stepCount||travel>6.4||!insideVolume(p))break;
      ivec3 block=ivec3(floor((p-volumeMin)/.4));
      uvec2 mask=texelFetch(occupancyMap,block,0).rg;
      bool empty=(mask.x|mask.y)==0u;
      if(!empty){
        ivec3 cell=ivec3(floor((p-volumeMin)/.1));
        uint bit=uint((cell.x&3)+(cell.y&3)*4+(cell.z&3)*16);
        if((mask[int(bit>>5u)]&(1u<<(bit&31u)))!=0u){
          int id=int(texelFetch(materialMap,block,0).r*255.+.5);
          hitPosition=p;return vec4(palette[clamp(id,0,13)],travel+.001);
        }
      }
      float distance=boundaryDistance(p,dir,empty?.4:.1)+.0003;
      travel+=distance;p=start+dir*travel;
    }
    return vec4(0.);
  }
`;
export const DYNAMIC_LIGHT_GLSL=`
  uniform highp usampler3D dynamicMap;
  uniform int dynamicCount,dynamicAtlasSide;uniform float dynamicTraceDistance;uniform mat4 dynamicInverse[8];uniform vec3 dynamicMin[8],dynamicMax[8];uniform float dynamicCell[8];
  vec4 traceDynamicLight(vec3 origin,vec3 direction,out vec3 hitPosition){
    float closest=dynamicTraceDistance>0.?dynamicTraceDistance:6.4;int hitId=0;hitPosition=origin;
    for(int objectIndex=0;objectIndex<8;objectIndex++){
      if(objectIndex>=dynamicCount)break;
      vec3 p=(dynamicInverse[objectIndex]*vec4(origin,1.)).xyz,d=mat3(dynamicInverse[objectIndex])*direction;
      vec3 safeD=vec3(abs(d.x)<1e-8?1e-8:d.x,abs(d.y)<1e-8?1e-8:d.y,abs(d.z)<1e-8?1e-8:d.z);
      vec3 lo=dynamicMin[objectIndex],hi=dynamicMax[objectIndex],a=(lo-p)/safeD,b=(hi-p)/safeD,nt=min(a,b),ft=max(a,b);
      float t=max(0.,max(nt.x,max(nt.y,nt.z))),end=min(closest,min(ft.x,min(ft.y,ft.z))),cellSize=dynamicCell[objectIndex];
      if(t>end)continue;
      for(int stepIndex=0;stepIndex<384;stepIndex++){
        vec3 q=p+d*(t+cellSize*.0001);if(any(lessThan(q,lo))||any(greaterThanEqual(q,hi)))break;
        ivec3 cell=ivec3(floor((q-lo)/cellSize));int id=int(texelFetch(dynamicMap,cell+ivec3(0,0,objectIndex*dynamicAtlasSide),0).r);
        if(id>0){closest=t;hitId=id;hitPosition=origin+direction*t;break;}
        vec3 edge=lo+(vec3(cell)+step(vec3(0.),d))*cellSize,delta=(edge-q)/safeD;
        if(abs(d.x)<1e-8)delta.x=1e20;if(abs(d.y)<1e-8)delta.y=1e20;if(abs(d.z)<1e-8)delta.z=1e20;
        t+=max(0.,min(delta.x,min(delta.y,delta.z)))+cellSize*.0001;if(t>end)break;
      }
    }return hitId>0?vec4(palette[clamp(hitId,0,13)],closest+.001):vec4(0.);
  }
`;

export class LightingPipeline{
  constructor(renderer,camera,daylight){
    const incidentEnvironment=daylight.nativeHub??daylight.voxelEnvironment;
    this.renderer=renderer;this.camera=camera;this.daylight=daylight;this.high=true;
    this.surface=new SurfaceBuffer(renderer,camera);
    this.color=new THREE.WebGLRenderTarget(1,1,{type:THREE.HalfFloatType,samples:2});
    this.color.depthTexture=new THREE.DepthTexture(1,1,THREE.UnsignedIntType);
    // Preserve world depth when foreground clears its own depth buffer.
    this.lit=new THREE.WebGLRenderTarget(1,1,{type:THREE.HalfFloatType});
    this.dofPrepared=new THREE.WebGLRenderTarget(1,1,{depthBuffer:false,type:THREE.HalfFloatType});
    this.dofBlurred=new THREE.WebGLRenderTarget(1,1,{depthBuffer:false,type:THREE.HalfFloatType});
    this.focusTargets=[0,1].map(()=>new THREE.WebGLRenderTarget(1,1,{depthBuffer:false,type:THREE.HalfFloatType}));this.focusIndex=0;this.focusInitialized=false;
    this.focusSeed=new THREE.DataTexture(new Float32Array([1,1,0,1]),1,1,THREE.RGBAFormat,THREE.FloatType);this.focusSeed.needsUpdate=true;
    this.focusUniform={value:this.focusSeed};this.lensDepthUniforms={depthMap:{value:this.color.depthTexture},projectionInverse:{value:camera.projectionMatrixInverse},lensFar:{value:camera.far},lensNear:{value:camera.near}};
    // Lens strength/radius below are a screenshot calibration, not recovered
    // runtime uniforms. The focus/CoC/gather/coverage equations are recovered.
    this.dofParams={enabled:true,focusMin:-1,focusMax:-1,focusScale:.01,maxRadius:12,sharpCenter:true};
    this.indirect=new THREE.WebGLRenderTarget(1,1,{depthBuffer:false,type:THREE.HalfFloatType});
    this.bloom=new THREE.WebGLRenderTarget(1,1,{depthBuffer:false,type:THREE.HalfFloatType});
    this.exposureParams={...REFERENCE_LOOK,colorBalance:[...REFERENCE_LOOK.colorBalance]};
    this.brightness=new THREE.WebGLRenderTarget(256,256,{depthBuffer:false,type:THREE.HalfFloatType,minFilter:THREE.LinearMipmapLinearFilter,generateMipmaps:true});
    this.exposureTargets=[0,1].map(()=>new THREE.WebGLRenderTarget(1,1,{depthBuffer:false,type:THREE.HalfFloatType}));this.exposureIndex=0;
    this.exposureSeed=new THREE.DataTexture(new Float32Array([1,1,1,1]),1,1,THREE.RGBAFormat,THREE.FloatType);this.exposureSeed.needsUpdate=true;
    this.exposureUniform={value:this.exposureSeed};this.lookUniform={value:1};
    const lut=makeDaylightLUT();this.lookLUT=new THREE.Data3DTexture(lut.data,lut.size,lut.size,lut.size);
    this.lookLUT.format=THREE.RGBAFormat;this.lookLUT.type=THREE.UnsignedByteType;
    this.lookLUT.minFilter=this.lookLUT.magFilter=THREE.LinearFilter;
    this.lookLUT.wrapS=this.lookLUT.wrapT=this.lookLUT.wrapR=THREE.ClampToEdgeWrapping;
    this.lookLUT.unpackAlignment=1;this.lookLUT.generateMipmaps=false;this.lookLUT.needsUpdate=true;
    this.volume=new VoxelLightVolume();
    const [w,h,d]=this.volume.size;
    this.occupancy=new THREE.Data3DTexture(this.volume.bits,w,h,d);
    this.occupancy.format=THREE.RGIntegerFormat;this.occupancy.type=THREE.UnsignedIntType;this.occupancy.internalFormat='RG32UI';
    this.materialVolume=new THREE.Data3DTexture(this.volume.materials,w,h,d);this.materialVolume.format=THREE.RedFormat;
    for(const t of [this.occupancy,this.materialVolume]){t.minFilter=t.magFilter=THREE.NearestFilter;t.unpackAlignment=1;t.generateMipmaps=false;t.needsUpdate=true;}
    // CPU-only views remain unbound. copyTextureToTexture then uses texSubImage3D
    // from these arrays instead of trying to copy a texture back onto itself.
    this.volumeUploader=new PackedVolumeUploader(renderer);
    this.uploadBitData=new Uint32Array(8**3*2);this.uploadMaterialData=new Uint8Array(8**3);
    this.uploadBits=new THREE.Data3DTexture(this.uploadBitData,8,8,8);
    this.uploadMaterials=new THREE.Data3DTexture(this.uploadMaterialData,8,8,8);
    const dynamicGL=renderer.getContext?.(),maxAtlasDepth=dynamicGL?dynamicGL.getParameter(dynamicGL.MAX_3D_TEXTURE_SIZE):512;this.dynamicVolume=new DynamicVoxelLightVolume({limit:Math.min(4,Math.floor(maxAtlasDepth/128))});const atlasSide=this.dynamicVolume.side,atlasDepth=atlasSide*this.dynamicVolume.limit;this.dynamicTexture=new THREE.Data3DTexture(this.dynamicVolume.data,atlasSide,atlasSide,atlasDepth);this.dynamicTexture.format=THREE.RedIntegerFormat;this.dynamicTexture.type=THREE.UnsignedByteType;this.dynamicTexture.internalFormat='R8UI';this.dynamicTexture.minFilter=this.dynamicTexture.magFilter=THREE.NearestFilter;this.dynamicTexture.generateMipmaps=false;this.dynamicTexture.unpackAlignment=1;this.dynamicTexture.needsUpdate=true;
    this.dynamicUploadData=new Uint8Array(atlasSide**3);
    this.dynamicUpload=new THREE.Data3DTexture(this.dynamicUploadData,atlasSide,atlasSide,atlasSide);
    this.dynamicUniforms={dynamicMap:{value:this.dynamicTexture},dynamicCount:{value:0},dynamicAtlasSide:{value:atlasSide},dynamicTraceDistance:{value:incidentEnvironment?24:6.4},dynamicInverse:{value:Array.from({length:8},()=>new THREE.Matrix4())},dynamicMin:{value:Array.from({length:8},()=>new THREE.Vector3())},dynamicMax:{value:Array.from({length:8},()=>new THREE.Vector3())},dynamicCell:{value:Array(8).fill(.1)}};
    this.dynamicScale=new THREE.Vector3(1,1,1);
    const bank=voxelMaterialBank(),palette=[new THREE.Color(0),...bank.slice(1).map(m=>m.color.clone())];this.basePalette=palette.map(c=>c.clone());bank.slice(1).forEach(m=>m.dispose());
    this.quadScene=new THREE.Scene();this.quad=new THREE.Mesh(new THREE.PlaneGeometry(2,2));this.quad.frustumCulled=false;this.quadScene.add(this.quad);
    this.screenCamera=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
    this.focusMaterial=new THREE.ShaderMaterial({depthTest:false,depthWrite:false,toneMapped:false,uniforms:{...this.lensDepthUniforms,previousFocus:this.focusUniform,initialized:{value:0}},vertexShader:vertex,fragmentShader:`
      varying vec2 vUv;uniform sampler2D previousFocus;uniform float initialized;${lensDepthCode}
      float harmonicDepth(float extent){float inverseTotal=0.,count=0.,r=0.,a=0.;for(int i=0;i<64;i++){if(r>=extent)break;inverseTotal+=1./(lensDepthAt(vec2(.5)+vec2(cos(a),sin(a))*r)+.00001);count+=1.;r+=.005;a+=2.39996323;}return count/inverseTotal;}
      void main(){float closeRange=harmonicDepth(.05),wideRange=harmonicDepth(.15);vec4 current=vec4(min(closeRange,wideRange),max(closeRange,wideRange),0.,1.);gl_FragColor=mix(texture2DLodEXT(previousFocus,vec2(.5),0.),current,initialized>.5?.2:1.);}`});
    this.dofPrepareMaterial=new THREE.ShaderMaterial({depthTest:false,depthWrite:false,toneMapped:false,uniforms:{...this.lensDepthUniforms,colorMap:{value:this.lit.texture},focusMap:this.focusUniform,focusRange:{value:new THREE.Vector2(-1,-1)},focusScale:{value:this.dofParams.focusScale},sharpCenter:{value:Number(this.dofParams.sharpCenter)}},vertexShader:vertex,fragmentShader:`
      varying vec2 vUv;uniform sampler2D colorMap,focusMap;uniform vec2 focusRange;uniform float focusScale,sharpCenter;${lensDepthCode}
      void main(){vec2 autoRange=texture2DLodEXT(focusMap,vec2(.5),0.).rg*lensFar;float nearFocus=focusRange.x>=0.?focusRange.x:autoRange.x,farFocus=focusRange.y>=0.?focusRange.y:autoRange.y;float inverseDistance=1./(lensDepthAt(vUv)*lensFar);float circle=(min(0.,1./max(nearFocus,.00001)-inverseDistance)+max(0.,1./max(farFocus,.00001)-inverseDistance))*focusScale;if(sharpCenter>.5)circle*=clamp(length(vUv*2.-1.)-.2,0.,1.);gl_FragColor=vec4(texture2DLodEXT(colorMap,vUv,0.).rgb,circle);}`});
    this.dofBlurMaterial=new THREE.ShaderMaterial({depthTest:false,depthWrite:false,toneMapped:false,uniforms:{preparedMap:{value:this.dofPrepared.texture},pixelSize:{value:new THREE.Vector2(1,1)},maxRadius:{value:this.dofParams.maxRadius}},vertexShader:vertex,fragmentShader:`
      varying vec2 vUv;uniform sampler2D preparedMap;uniform vec2 pixelSize;uniform float maxRadius;
      void main(){vec4 center=texture2DLodEXT(preparedMap,vUv,0.);float searchCircle=abs(center.a);vec2 rim=maxRadius*pixelSize;
        for(int i=0;i<8;i++){vec2 d=i==0?vec2(.7,.7):i==1?vec2(.7,-.7):i==2?vec2(-.7,.7):i==3?vec2(-.7,-.7):i==4?vec2(0.,1.):i==5?vec2(0.,-1.):i==6?vec2(1.,0.):vec2(-1.,0.);searchCircle=max(searchCircle,abs(texture2DLodEXT(preparedMap,vUv+rim*d,0.).a));}
        float limit=clamp(searchCircle/pixelSize.x,0.,maxRadius),radius=.5,angle=0.,count=1.,coverage=1.;vec3 accumulated=center.rgb;
        // The original noise-start input is fixed at zero until its actual
        // blue-noise texture/frame seed can be supplied. No temporal parity claim.
        for(int i=0;i<4096;i++){if(radius>=limit)break;radius+=.5/radius;vec4 sampleColor=texture2DLodEXT(preparedMap,vUv+vec2(cos(angle),sin(angle))*pixelSize*radius,0.);float circle=sampleColor.a;if(circle>center.a)circle=clamp(abs(circle),0.,abs(center.a*2.));float sampleRadius=clamp(abs(circle)/pixelSize.x,0.,maxRadius),weight=smoothstep(radius-.5,radius+.5,sampleRadius);accumulated+=accumulated/count*(1.-weight)+sampleColor.rgb*weight;coverage+=coverage/count*(1.-weight)+sampleRadius*weight;count+=1.;angle+=2.39996323;}
        gl_FragColor=vec4(accumulated/count,clamp(coverage/count-1.,0.,1.));}`});
    this.dofCombineMaterial=new THREE.ShaderMaterial({depthTest:false,depthWrite:false,toneMapped:false,uniforms:{sharpMap:{value:this.dofPrepared.texture},blurMap:{value:this.dofBlurred.texture}},vertexShader:vertex,fragmentShader:`varying vec2 vUv;uniform sampler2D sharpMap,blurMap;void main(){vec4 blurred=texture2DLodEXT(blurMap,vUv,0.);gl_FragColor=vec4(mix(texture2DLodEXT(sharpMap,vUv,0.).rgb,blurred.rgb,blurred.a),1.);}`});
    for(const [material,key] of [[this.focusMaterial,'focus'],[this.dofPrepareMaterial,'prepare'],[this.dofBlurMaterial,'gather'],[this.dofCombineMaterial,'combine']])material.customProgramCacheKey=()=>`reference-dof-${key}-v1`;
    this.brightnessMaterial=new THREE.ShaderMaterial({depthTest:false,depthWrite:false,toneMapped:false,uniforms:{colorMap:{value:this.lit.texture}},vertexShader:vertex,fragmentShader:`varying vec2 vUv;uniform sampler2D colorMap;void main(){float b=dot(max(texture2D(colorMap,vUv).rgb,vec3(0.)),vec3(.3,.4,.3));gl_FragColor=vec4(b,b,b,1.);}`});
    this.exposureMaterial=new THREE.ShaderMaterial({depthTest:false,depthWrite:false,toneMapped:false,uniforms:{brightnessMap:{value:this.brightness.texture},previousMap:this.exposureUniform,range:{value:new THREE.Vector2(REFERENCE_LOOK.min,REFERENCE_LOOK.max)},sceneBrightness:{value:REFERENCE_LOOK.sceneBrightness},adaptation:{value:REFERENCE_LOOK.adaptation},overrideExposure:{value:REFERENCE_LOOK.auto?0:REFERENCE_LOOK.exposure}},vertexShader:vertex,fragmentShader:`
      varying vec2 vUv;uniform sampler2D brightnessMap,previousMap;uniform vec2 range;uniform float sceneBrightness,adaptation,overrideExposure;
      void main(){float b=textureLod(brightnessMap,vec2(.5),6.).r*.4;
      b+=(textureLod(brightnessMap,vec2(.25,.25),6.).r+textureLod(brightnessMap,vec2(.75,.25),6.).r+textureLod(brightnessMap,vec2(.25,.75),6.).r+textureLod(brightnessMap,vec2(.75,.75),6.).r)*.15;
      float target=clamp(.5*sceneBrightness/max(b,.00001),range.x,range.y),e=mix(texture2D(previousMap,vec2(.5)).r,target,adaptation);if(overrideExposure>0.)e=overrideExposure;gl_FragColor=vec4(e,e,e,1.);}`});
    this.voxelLight=new THREE.ShaderMaterial({depthTest:false,depthWrite:false,uniforms:{
      ...this.dynamicUniforms,
      ...this.surface.uniforms,
      depthMap:{value:this.color.depthTexture},projectionInverse:{value:camera.projectionMatrixInverse},cameraWorld:{value:camera.matrixWorld},
      cameraView:{value:camera.matrixWorldInverse},
      resolution:{value:new THREE.Vector2()},projectionScale:{value:1},occupancyMap:{value:this.occupancy},materialMap:{value:this.materialVolume},
      volumeMin:{value:new THREE.Vector3(...this.volume.min).multiplyScalar(.1)},volumeSize:{value:new THREE.Vector3(...this.volume.size).multiplyScalar(.4)},palette:{value:palette},
      sunDirection:{value:daylight.direction},sunMap:{value:null},sunMatrix:{value:daylight.sun.shadow.matrix},rayCount:{value:6},stepCount:{value:32},
      hubNativeEnabled:{value:Number(Boolean(incidentEnvironment))},hubAmbient:{value:new THREE.Vector3(...(incidentEnvironment?.ambientColor??[0,0,0]))},
      hubConstant:{value:new THREE.Vector3(...(incidentEnvironment?.constant?.slice(0,3)??[.003,.003,.003]))},hubExponent:{value:incidentEnvironment?.ambientexponent??1.3},
      hubAmbientOcclusionStrength:{value:incidentEnvironment?.ambientOcclusionStrength??1},hubSunShadowStrength:{value:incidentEnvironment?.sunShadowStrength??1},
      hubSun:{value:new THREE.Vector3(...(incidentEnvironment?.cachedSunColor??[0,0,0]))},
      parkPointCount:{value:0},parkPointPosition:{value:Array.from({length:8},()=>new THREE.Vector4())},parkPointColor:{value:Array.from({length:8},()=>new THREE.Vector3())}
    },vertexShader:vertex,fragmentShader:`
      varying vec2 vUv;uniform vec2 resolution;uniform float projectionScale,rayCount,stepCount;uniform mat4 cameraWorld,cameraView;
      uniform sampler2D surfaceNormalMap,surfaceGeometryMap;uniform float surfaceNormalsEnabled,surfaceFar;
      #include <packing>
      ${positionCode}
      ${volumeCode}
      ${DYNAMIC_LIGHT_GLSL}
      ${HUB_NATIVE_LIGHT_GLSL}
      uniform float hubNativeEnabled,hubExponent;uniform vec3 hubAmbient,hubConstant,hubSun;
      uniform float parkPointCount;uniform vec4 parkPointPosition[8];uniform vec3 parkPointColor[8];
      vec3 parkLampIncident(vec3 position,vec3 ng,vec3 n){
        vec3 light=vec3(0.);
        for(int i=0;i<8;i++){if(float(i)>=parkPointCount)break;vec3 offset=parkPointPosition[i].xyz-position;float distance=length(offset),radius=parkPointPosition[i].w;if(distance>=radius||distance<.01)continue;vec3 direction=offset/distance;float cosine=max(0.,dot(n,direction));if(cosine<=0.)continue;float visible=step(distance-.22,hubTraceAmbientStatic(position+ng*.125,direction,distance));float falloff=pow(1.-distance/radius,2.)/(.6+distance*distance);light+=parkPointColor[i]*cosine*falloff*visible;}
        return light;
      }
      void main(){
        if(texture2D(depthMap,vUv).r>.99998){gl_FragColor=vec4(0.,0.,0.,1.);return;}
        vec3 p=positionAt(vUv);vec2 pixel=1./resolution;
        vec3 left=p-positionAt(vUv-vec2(pixel.x,0.)),right=positionAt(vUv+vec2(pixel.x,0.))-p;
        vec3 down=p-positionAt(vUv-vec2(0.,pixel.y)),up=positionAt(vUv+vec2(0.,pixel.y))-p;
        vec3 normal=cross(dot(left,left)<dot(right,right)?left:right,dot(down,down)<dot(up,up)?down:up);
        if(dot(normal,normal)<1e-12){gl_FragColor=vec4(0.,0.,0.,1.);return;}
        vec3 n=normalize(normal);if(dot(n,-p)<0.)n=-n;
        vec3 worldP=(cameraWorld*vec4(p,1.)).xyz,worldNg=normalize(mat3(cameraWorld)*n),worldN=worldNg,geometricViewN=n;
        vec4 surfaceNgDepth=texture2D(surfaceGeometryMap,vUv),surfaceNl=texture2D(surfaceNormalMap,vUv);
        if(surfaceNormalsEnabled>.5&&surfaceNgDepth.a>0.&&surfaceNl.a>.5&&abs(surfaceNgDepth.a*surfaceFar+p.z)<max(.0001,abs(p.z)*.00001)){
          worldNg=normalize(surfaceNgDepth.rgb);worldN=dot(surfaceNl.rgb,surfaceNl.rgb)>1e-12?normalize(surfaceNl.rgb):worldNg;geometricViewN=normalize(mat3(cameraView)*worldNg);
        }
        if(hubNativeEnabled>.5){gl_FragColor=vec4(hubNativeIncidentLight(worldP,worldNg,worldN,hubAmbient,hubConstant,hubExponent,hubSun,rayCount,stepCount,24.)+parkLampIncident(worldP,worldNg,worldN),1.);return;}
        vec3 tangent=normalize(cross(worldN,abs(worldN.y)<.95?vec3(0.,1.,0.):vec3(1.,0.,0.)));
        vec3 bitangent=cross(worldN,tangent),bounce=vec3(0.);float occlusion=0.;
        // A shared stratified basis keeps flat walls spatially coherent. With
        // only 3–6 rays, changing direction at every voxel painted an AO
        // checkerboard onto clean materials, even while the camera stood still.
        float rotation=.65;
        for(int i=0;i<6;i++){
          if(float(i)>=rayCount)break;
          float f=float(i),r=sqrt((f+.5)/rayCount),a=f*2.399963+rotation;
          vec3 dir=tangent*cos(a)*r+bitangent*sin(a)*r+worldN*sqrt(1.-r*r),hit;
          vec4 sampleLight=traceLight(worldP+worldNg*.125,dir,stepCount,hit);
          vec3 dynamicHit;vec4 dynamicLight=traceDynamicLight(worldP+worldNg*.125,dir,dynamicHit);if(dynamicLight.a>0.&&(sampleLight.a==0.||dynamicLight.a<sampleLight.a)){sampleLight=dynamicLight;hit=dynamicHit;}
          if(sampleLight.a>0.){
            // Distant walls supply bounce colour without darkening the whole
            // courtyard. AO is concentrated at actual contact and corners.
            float attenuation=exp(-sampleLight.a*.30);occlusion+=exp(-sampleLight.a*1.5);
            // Approximate one diffuse bounce, without recursive path history.
            float illumination=.12+.75*max(0.,dot(-dir,sunDirection))*visibilityAt(hit-dir*.15);
            bounce+=sampleLight.rgb*illumination*attenuation;
          }
        }
        float voxelAO=clamp(1.-occlusion/rayCount*${DAYLIGHT_LOOK.aoStrength},${DAYLIGHT_LOOK.aoFloor},1.);
        // Short screen-space rays cover detail below the safe volume ray offset.
        float contact=0.,pixelRadius=clamp(.22*projectionScale/max(-p.z,.1),2.,24.);
        for(int i=0;i<8;i++){
          if(float(i)>=rayCount+2.)break;
          float f=float(i),a=f*2.399963;
          vec2 uv=clamp(vUv+vec2(cos(a),sin(a))*sqrt((f+.5)/8.)*pixelRadius/resolution,vec2(.001),vec2(.999));
          vec3 delta=positionAt(uv)-p;float len=length(delta);
          contact+=max(0.,dot(geometricViewN,delta)/max(len,.001)-.08)*(1.-smoothstep(.04,.30,len));
        }
        // Voxel wall steps look like long dark stripes to screen-space AO.
        // Keep this contact term on horizontal surfaces; volume AO shades walls.
        contact*=smoothstep(.1,.6,abs(worldNg.y));
        float direct=visibilityAt(worldP+worldNg*.05)*smoothstep(.02,.25,dot(worldN,sunDirection));
        float shade=clamp(1.-contact*${DAYLIGHT_LOOK.contactStrength},${DAYLIGHT_LOOK.contactFloor},1.)*mix(voxelAO,mix(voxelAO,1.,.55),direct);
        // Dust shafts share the live sun depth, at the same reduced resolution.
        float sunlit=0.;vec3 eye=cameraWorld[3].xyz,view=normalize(worldP-eye);
        for(int i=0;i<4;i++)sunlit+=visibilityAt(mix(eye,worldP,(float(i)+.5)/4.));
        float haze=(1.-exp(-length(p)*.0022))*(.3+.7*pow(max(0.,dot(view,sunDirection)),4.))*sunlit*.25;
        vec3 light=bounce/rayCount*.20+vec3(1.,.87,.65)*haze;
        gl_FragColor=vec4(light,shade);
      }`});
    this.composite=new THREE.ShaderMaterial({depthTest:false,depthWrite:false,uniforms:{colorMap:{value:this.color.texture},lightMap:{value:this.indirect.texture},depthMap:{value:this.color.depthTexture},projectionInverse:{value:camera.projectionMatrixInverse},lightTexel:{value:new THREE.Vector2()},
      hubNativeEnabled:{value:Number(Boolean(incidentEnvironment))},hubAlbedo:{value:this.surface.target.textures[2]},hubEmission:{value:this.surface.target.textures[3]},hubGeometry:{value:this.surface.target.textures[0]},
      cameraWorld:{value:camera.matrixWorld},hubFogColor:{value:new THREE.Vector3(...(incidentEnvironment?.fogColor?.slice(0,3)??[.3,.2,.08]))},
      hubFog:{value:incidentEnvironment?.fog?new THREE.Vector4(incidentEnvironment.fog[0],1/(incidentEnvironment.fog[1]-incidentEnvironment.fog[0]),incidentEnvironment.fog[2],incidentEnvironment.fog[3]):new THREE.Vector4(80,1/120,1,6)},
      ...this.animeUniforms(incidentEnvironment?.anime)},vertexShader:vertex,fragmentShader:`
      varying vec2 vUv;uniform sampler2D colorMap,lightMap,hubAlbedo,hubEmission,hubGeometry;uniform vec2 lightTexel;
      uniform float hubNativeEnabled;uniform vec3 hubFogColor;uniform vec4 hubFog;uniform mat4 cameraWorld;
      ${positionCode}
      // The filter only needs depth, not the full reconstructed position.
      float viewZAt(vec2 uv){float z=texture2DLodEXT(depthMap,uv,0.).r*2.-1.;return (projectionInverse[2][2]*z+projectionInverse[3][2])/(projectionInverse[2][3]*z+projectionInverse[3][3]);}
      ${ANIME_GLSL}
      vec3 hubDistanceFog(vec3 color,vec3 viewPosition){
        float distance=length(viewPosition);vec3 dir=normalize(mat3(cameraWorld)*viewPosition);
        float range=clamp(max(0.,distance-hubFog.x)*hubFog.y,0.,1.);
        float fog=clamp(pow(clamp(1.-dir.y,0.,1.),hubFog.w)*range*range,0.,hubFog.z);
        // Original Classic fog blends in gamma space and returns to linear.
        return pow(mix(pow(max(color,vec3(0.)),vec3(1./2.2)),pow(hubFogColor,vec3(1./2.2)),fog),vec3(2.2));
      }
      void main(){
        vec3 base=texture2D(colorMap,vUv).rgb;
        if(texture2D(depthMap,vUv).r>.99998){gl_FragColor=vec4(hubNativeEnabled>.5?clamp(hubDistanceFog(base,positionAt(vUv)),0.,1.):base,1.);return;}
        float z=viewZAt(vUv),total=0.;vec4 light=vec4(0.);
        // Depth-aware reconstruction prevents light bleeding across wall holes.
        for(int i=0;i<5;i++){
          vec2 offset=vec2(0.);
          if(i==1)offset.x=lightTexel.x;if(i==2)offset.x=-lightTexel.x;
          if(i==3)offset.y=lightTexel.y;if(i==4)offset.y=-lightTexel.y;
          vec2 uv=clamp(vUv+offset,vec2(.001),vec2(.999));
          float weight=exp(-abs(viewZAt(uv)-z)/max(.08,-z*.012))*(i==0?2.:1.);
          light+=texture2D(lightMap,uv)*weight;total+=weight;
        }
        light/=max(total,.001);
        if(hubNativeEnabled>.5&&texture2D(hubGeometry,vUv).a>0.){
          vec3 albedo=texture2D(hubAlbedo,vUv).rgb,emission=texture2D(hubEmission,vUv).rgb,viewP=positionAt(vUv);
          if(animeEnabled<.5){gl_FragColor=vec4(clamp(hubDistanceFog(albedo*light.rgb+emission,viewP),0.,1.),1.);return;}
          float band;vec3 paint=animeFlatAlbedo(vUv,albedo),incident=animeBands(light.rgb,band);
          vec3 view=normalize(mat3(cameraWorld)*viewP);
          vec3 color=paint*incident+emission+animeRim(paint,texture2D(hubGeometry,vUv).rgb,view,clamp(band-animeRange.x-1.,0.,1.));
          float dist=length(viewP);
          color=animeInked(animeAir(animeSaturate(color,1.),dist),animeInk(vUv,z),dist);
          gl_FragColor=vec4(clamp(color,0.,1.),1.);return;
        }
        vec3 color=base*light.a+light.rgb*sqrt(max(base,vec3(.025)));
        // Lit meshes (far wall, giants) are already shaded; keep their stone and skin tones.
        if(animeEnabled>.5){float dist=length(positionAt(vUv));color=animeInked(animeAir(animeSaturate(color,.3),dist),animeInk(vUv,z),dist);}
        gl_FragColor=vec4(color,1.);
      }`});
    this.bloomMaterial=new THREE.ShaderMaterial({depthTest:false,depthWrite:false,toneMapped:false,uniforms:{colorMap:{value:this.lit.texture},texel:{value:new THREE.Vector2()},exposureMap:this.exposureUniform,lookMode:this.lookUniform,referenceThreshold:{value:REFERENCE_LOOK.bloomThreshold},referenceScale:{value:REFERENCE_LOOK.bloomScale}},vertexShader:vertex,fragmentShader:`
      varying vec2 vUv;uniform sampler2D colorMap,exposureMap;uniform vec2 texel;uniform float lookMode,referenceThreshold,referenceScale;
      vec3 extract(vec2 uv,float exposure){
        vec2 d=texel*.25;vec3 c=max(max(texture2DLodEXT(colorMap,uv+d,0.).rgb,texture2DLodEXT(colorMap,uv-d,0.).rgb),max(texture2DLodEXT(colorMap,uv+vec2(d.x,-d.y),0.).rgb,texture2DLodEXT(colorMap,uv+vec2(-d.x,d.y),0.).rgb));
        float l=max(c.r,max(c.g,c.b))+.001;return c*clamp(l-referenceThreshold/clamp(exposure,.01,10.),0.,.5)/l*referenceScale*3.;
      }
      void main(){vec3 light=vec3(0.);float total=0.;
        float exposure=texture2D(exposureMap,vec2(.5)).r;
        for(int x=-1;x<=1;x++)for(int y=-1;y<=1;y++){
          float w=exp(-float(x*x+y*y)*.8);vec3 c=texture2DLodEXT(colorMap,vUv+vec2(float(x),float(y))*texel*3.,0.).rgb;
          float l=max(c.r,max(c.g,c.b));light+=(lookMode>.5?extract(vUv+vec2(float(x),float(y))*texel*3.,exposure):c*max(0.,l-${DAYLIGHT_LOOK.bloomThreshold})/max(l,.001))*w;total+=w;
        }gl_FragColor=vec4(light/total,1.);
      }`});
    this.output=new THREE.ShaderMaterial({depthTest:false,depthWrite:false,uniforms:{colorMap:{value:this.lit.texture},bloomMap:{value:this.bloom.texture},bloomStrength:{value:DAYLIGHT_LOOK.bloomStrength},lookLUT:{value:this.lookLUT},lutSize:{value:lut.size},exposureMap:this.exposureUniform,lookMode:this.lookUniform,referenceGamma:{value:REFERENCE_LOOK.gamma},referenceSaturation:{value:REFERENCE_LOOK.saturation},referenceBalance:{value:new THREE.Vector3(...REFERENCE_LOOK.colorBalance)}},vertexShader:vertex,fragmentShader:`
      precision highp sampler3D;
      varying vec2 vUv;uniform sampler2D colorMap,bloomMap,exposureMap;uniform highp sampler3D lookLUT;uniform float bloomStrength,lutSize,lookMode,referenceGamma,referenceSaturation;uniform vec3 referenceBalance;
      ${REFERENCE_OUTPUT_GLSL}
      void main(){
        vec3 color=texture2D(colorMap,vUv).rgb+texture2D(bloomMap,vUv).rgb*bloomStrength;
        if(lookMode>.5){gl_FragColor=vec4(referenceOutput(color,texture2D(exposureMap,vec2(.5)).r),1.);return;}
        float vignette=smoothstep(.32,.82,length((vUv-.5)*vec2(1.,.85)));color*=1.-vignette*${DAYLIGHT_LOOK.vignetteStrength};
        gl_FragColor=vec4(max(color,vec3(0.)),1.);
        #include <tonemapping_fragment>
        vec3 lutUV=clamp(gl_FragColor.rgb,0.,1.)*((lutSize-1.)/lutSize)+.5/lutSize;
        gl_FragColor.rgb=texture(lookLUT,lutUV).rgb;
        #include <colorspace_fragment>
      }`});
    this.lastUpload=-Infinity;this.lastToolSample=-Infinity;this.toolLighting={sunlight:1,sky:1};
    this.toolFill=new THREE.DirectionalLight(0xffeee0,0);
    this.toolFillSource=new THREE.Vector3(-.4,.5,.4);
    this.toolFillTarget=new THREE.Vector3(.4,-.35,-.75);
    this.stats={volumeBytes:this.volume.bits.byteLength+this.volume.materials.byteLength,updatedBlocks:0,volumeUploadMs:0,uploadedBytes:0,pendingChunks:0,lightResolution:[],look:'reference',lutBytes:lut.data.byteLength,exposureRange:[REFERENCE_LOOK.min,REFERENCE_LOOK.max],surface:this.surface.stats,dof:{...this.dofParams,parameterSource:'screenshot-calibration',bytes:32,cpuMs:0,error:null},anime:this.animeConfig?{...this.animeConfig}:null};this.resize();
    if(daylight.nativeHub){this.setExposure({auto:true,min:daylight.nativeHub.exposure[0],max:daylight.nativeHub.exposure[1],sceneBrightness:daylight.nativeHub.brightness});this.stats.nativeHub=daylight.nativeHub;}
    if(daylight.voxelEnvironment){this.setExposure({auto:true,min:incidentEnvironment.exposure[0],max:incidentEnvironment.exposure[1],sceneBrightness:incidentEnvironment.brightness});this.stats.authoredEnvironment=incidentEnvironment;}
  }
  animeUniforms(config){
    const a={...ANIME_DEFAULTS,...(config??{})};this.animeConfig=config?a:null;
    return {animeEnabled:{value:Number(Boolean(config))},animeParams:{value:new THREE.Vector4(a.stops,a.softness,a.ink,a.crease)},animeShade:{value:new THREE.Vector4(...a.shadowTint,a.tint)},animeEdge:{value:new THREE.Vector3(a.inkDepth,a.creaseFar,a.saturation)},animeTexel:{value:new THREE.Vector2(1,1)},
      animeWarm:{value:new THREE.Vector4(...a.warm,a.edgeInk)},animeHaze:{value:new THREE.Vector4(...a.haze,a.hazeDensity)},animeGrade:{value:new THREE.Vector4(...a.grade,a.rim)},animeInkColor:{value:new THREE.Vector3(...a.inkColor)},animeInkFade:{value:new THREE.Vector2(...a.inkFade)},
      animeRange:{value:new THREE.Vector3(a.bandFloor,a.flatten,a.hazeMax)},animeLight:{value:0},animeSun:{value:(this.daylight.direction??new THREE.Vector3(0,1,0)).clone().normalize()}};
  }
  // Same-camera comparisons toggle the authored look (composite and, when the
  // environment has one, the painted sky); scenes without an
  // `environment.anime` block cannot enable it.
  setAnime(on){
    const u=this.composite.uniforms;u.animeEnabled.value=Number(Boolean(on&&this.animeConfig));this.stats.anime=u.animeEnabled.value?{...this.animeConfig}:null;
    const sky=this.daylight.sky?.material?.uniforms?.animeSky;if(sky&&this.animeConfig)sky.value=u.animeEnabled.value;
    return this;
  }
  setLook(look){if(!['reference','construction'].includes(look))throw new Error('Unknown lighting look');this.lookUniform.value=Number(look==='reference');this.stats.look=look;return this;}
  setDynamicEntries(entries){this.dynamicEntries=entries;return this;}
  setSurfaceNormals(enabled){this.surface.setEnabled(enabled);return this;}
  setDepthOfField(params={}){
    const next={...this.dofParams,...params};if(!['focusMin','focusMax','focusScale','maxRadius'].every(k=>Number.isFinite(next[k]))||![next.focusMin,next.focusMax].every(v=>v===-1||v>0)||next.focusScale<0||next.maxRadius<0||next.maxRadius>64||(next.focusMin>0&&next.focusMax>0&&next.focusMax<next.focusMin))throw new Error('Invalid depth-of-field parameters');
    this.dofParams=next;this.dofPrepareMaterial.uniforms.focusRange.value.set(next.focusMin,next.focusMax);this.dofPrepareMaterial.uniforms.focusScale.value=next.focusScale;this.dofPrepareMaterial.uniforms.sharpCenter.value=Number(Boolean(next.sharpCenter));this.dofBlurMaterial.uniforms.maxRadius.value=next.maxRadius;Object.assign(this.stats.dof,next);return this;
  }
  renderDepthOfField(camera){
    if(!this.dofParams.enabled||this.dofParams.focusScale===0||this.dofParams.maxRadius===0){this.stats.dof.cpuMs=0;return;}
    const started=performance.now();this.lensDepthUniforms.lensFar.value=camera.far;this.lensDepthUniforms.lensNear.value=camera.near;this.lensDepthUniforms.projectionInverse.value=camera.projectionMatrixInverse;
    try{
      const focus=this.focusTargets[this.focusIndex];this.focusMaterial.uniforms.initialized.value=Number(this.focusInitialized);this.pass(this.focusMaterial,focus);this.focusUniform.value=focus.texture;this.focusIndex=1-this.focusIndex;this.focusInitialized=true;
      this.pass(this.dofPrepareMaterial,this.dofPrepared);this.pass(this.dofBlurMaterial,this.dofBlurred);
      // Compile the final blit before it can clear the still-visible sharp
      // world target. A failed lens shader leaves that original target intact.
      this.quad.material=this.dofCombineMaterial;this.renderer.compile?.(this.quadScene,this.screenCamera);
      if(this.renderer.info?.programs?.some(p=>p.diagnostics?.runnable===false&&p.cacheKey?.includes('reference-dof-')))throw new Error('Depth-of-field shader failed to compile');
      this.pass(this.dofCombineMaterial,this.lit);this.stats.dof.error=null;
    }catch(error){this.dofParams.enabled=false;this.stats.dof.enabled=false;this.stats.dof.error=error.message;}
    finally{this.stats.dof.cpuMs=performance.now()-started;}
  }
  updateDynamic(camera){
    const started=performance.now(),report=this.dynamicVolume.update(this.dynamicEntries,camera.position),u=this.dynamicUniforms;u.dynamicCount.value=report.count;let uploaded=0;
    if(!this.dynamicInitialized){this.dynamicTexture.needsUpdate=true;this.dynamicInitialized=true;uploaded=this.dynamicVolume.bytes;}
    else for(const i of report.dirtySlots){const s=this.dynamicVolume.side;this.dynamicUploadData.set(this.dynamicVolume.data.subarray(i*s**3,(i+1)*s**3));this.volumeUploader.copy(this.dynamicUpload,this.dynamicTexture,null,new THREE.Vector3(0,0,i*s));uploaded+=s**3;}
    this.dynamicVolume.slots.forEach((slot,i)=>{u.dynamicInverse.value[i].compose(slot.entry.position,slot.entry.rotation,this.dynamicScale).invert();u.dynamicMin.value[i].set(...slot.localMin);u.dynamicMax.value[i].set(...slot.localMax);u.dynamicCell.value[i]=slot.cellSize;});
    this.stats.dynamicObjects=report.count;this.stats.dynamicSkipped=report.skipped;this.stats.dynamicUploadBytes=uploaded;this.stats.dynamicUploadMs=performance.now()-started;this.stats.dynamicVolumeBytes=this.dynamicVolume.bytes;
  }
  setExposure(params={}){
    const next={...this.exposureParams,...params};if(!['exposure','min','max','gamma','sceneBrightness','adaptation','saturation','bloomThreshold','bloomScale'].every(k=>Number.isFinite(next[k]))||!Array.isArray(next.colorBalance)||next.colorBalance.length!==3||!next.colorBalance.every(n=>Number.isFinite(n)&&n>0)||!(next.gamma>0&&next.min>0&&next.max>=next.min&&next.exposure>0&&next.sceneBrightness>0&&next.adaptation>=0&&next.adaptation<=1&&next.saturation>=0&&next.bloomThreshold>=0&&next.bloomScale>=0))throw new Error('Invalid exposure parameters');
    this.exposureParams=next;const u=this.exposureMaterial.uniforms;u.range.value.set(next.min,next.max);u.sceneBrightness.value=next.sceneBrightness;u.adaptation.value=next.adaptation;u.overrideExposure.value=next.auto?0:next.exposure;
    this.output.uniforms.referenceGamma.value=next.gamma;this.output.uniforms.referenceSaturation.value=next.saturation;this.output.uniforms.referenceBalance.value.set(...next.colorBalance);this.bloomMaterial.uniforms.referenceThreshold.value=next.bloomThreshold;this.bloomMaterial.uniforms.referenceScale.value=next.bloomScale;this.stats.exposureRange=[next.min,next.max];return this;
  }
  setWorld(world){
    this.world=world;
    this.exposureUniform.value=this.exposureSeed;this.exposureIndex=0;
    this.focusUniform.value=this.focusSeed;this.focusIndex=0;this.focusInitialized=false;
    this.volume.bits.fill(0);this.volume.materials.fill(0);this.volume.rebuild(world);
    this.voxelLight.uniforms.palette.value.forEach((color,i)=>{if(i){const override=world.palette?.[MATERIAL_KEYS[i]];if(override!==undefined)color.setHex(override);else color.copy(this.basePalette[i]);}});
    for(const key of world.dressingLightKeys||[])this.volume.updateChunk(world,key);
    for(const key of world.altered)this.volume.updateChunk(world,key);
    world.lightDirty.clear();this.occupancy.needsUpdate=this.materialVolume.needsUpdate=true;
    this.lastUpload=-Infinity;this.lastToolSample=-Infinity;
  }
  update(now,camera,toolScene,toolKey,toolSky,worldLights=[]){
    const world=this.world;
    if(this.daylight.voxelEnvironment){const u=this.voxelLight.uniforms;u.parkPointCount.value=Math.min(8,worldLights.length);worldLights.slice(0,8).forEach((light,i)=>{const p=light.getWorldPosition(new THREE.Vector3());u.parkPointPosition.value[i].set(p.x,p.y,p.z,light.distance);u.parkPointColor.value[i].set(light.color.r,light.color.g,light.color.b).multiplyScalar(light.intensity*.12);});}
    if(world?.lightDirty.size){
      const started=performance.now();let changed=0,uploaded=0,chunks=0;
      for(const key of world.lightDirty){
        const count=this.volume.updateChunk(world,key);changed+=count;world.lightDirty.delete(key);
        if(count){
          const bounds=this.volume.region(key),position=new THREE.Vector3(...bounds.min);
          this.uploadBits.image=packVolumeRegion(this.volume.bits,this.volume.size,2,bounds,this.uploadBitData);
          this.uploadMaterials.image=packVolumeRegion(this.volume.materials,this.volume.size,1,bounds,this.uploadMaterialData);
          this.volumeUploader.copy(this.uploadBits,this.occupancy,null,position);
          this.volumeUploader.copy(this.uploadMaterials,this.materialVolume,null,position);
          uploaded+=bounds.max.reduce((n,v,i)=>n*(v-bounds.min[i]),1)*9;
        }
        if(++chunks>=16||performance.now()-started>=2)break;
      }
      this.lastUpload=now;this.stats.updatedBlocks=changed;this.stats.uploadedBytes=uploaded;this.stats.pendingChunks=world.lightDirty.size;this.stats.volumeUploadMs=performance.now()-started;
    }
    if(world&&now-this.lastToolSample>=100){this.toolLighting=sampleToolLighting(world,camera.position,this.daylight.direction);this.lastToolSample=now;}
    toolKey.position.copy(camera.position).addScaledVector(this.daylight.direction,10);toolKey.target.position.copy(camera.position);
    toolKey.intensity=this.daylight.sun.intensity*(.18+.82*this.toolLighting.sunlight);
    toolSky.color.setHex(DAYLIGHT_LOOK.skyColor);toolSky.groundColor.setHex(DAYLIGHT_LOOK.groundColor);
    toolSky.intensity=DAYLIGHT_LOOK.toolSkyBase+DAYLIGHT_LOOK.toolSkyGain*this.toolLighting.sky;
    toolScene.environment=this.daylight.environment;
    toolScene.environmentIntensity=DAYLIGHT_LOOK.toolEnvironmentBase+DAYLIGHT_LOOK.toolEnvironmentGain*this.toolLighting.sky;
    if(this.toolFill.parent!==toolScene)toolScene.add(this.toolFill,this.toolFill.target);
    this.toolFill.position.copy(this.toolFillSource).applyQuaternion(camera.quaternion).add(camera.position);
    this.toolFill.target.position.copy(this.toolFillTarget).applyQuaternion(camera.quaternion).add(camera.position);
    this.toolFill.intensity=.28+.52*(1.-this.toolLighting.sunlight);
    // The grip receives the same room lamps as the surrounding wall. Fixtures
    // can be disabled by destruction; mirror their live position and intensity.
    this.toolPointLights??=[];
    for(let i=0;i<worldLights.length;i++){
      const source=worldLights[i];let light=this.toolPointLights[i];
      if(!light){light=new THREE.PointLight();this.toolPointLights[i]=light;toolScene.add(light);}
      source.getWorldPosition(light.position);light.color.copy(source.color);
      light.intensity=source.intensity;light.distance=source.distance;light.decay=source.decay;
    }
    for(let i=worldLights.length;i<this.toolPointLights.length;i++)this.toolPointLights[i].intensity=0;
  }
  resize(){
    // Performance quality spends fewer pixels on indirect light, while depth,
    // albedo, tools and the final picture remain at the display resolution.
    const size=this.renderer.getDrawingBufferSize(new THREE.Vector2()),w=size.x,h=size.y,divisor=this.high?(this.daylight.voxelEnvironment?4:3):6;
    this.surface.resize(w,h);
    this.color.setSize(w,h);this.lit.setSize(w,h);this.indirect.setSize(Math.ceil(w/divisor),Math.ceil(h/divisor));this.bloom.setSize(Math.ceil(w/4),Math.ceil(h/4));
    this.dofPrepared.setSize(w,h);this.dofBlurred.setSize(w,h);this.dofBlurMaterial.uniforms.pixelSize.value.set(1/w,1/h);this.stats.dof.bytes=w*h*16+32;
    this.voxelLight.uniforms.resolution.value.set(w,h);this.voxelLight.uniforms.projectionScale.value=h*this.camera.projectionMatrix.elements[5]*.5;
    this.voxelLight.uniforms.rayCount.value=this.high?(this.daylight.voxelEnvironment?4:6):3;this.voxelLight.uniforms.stepCount.value=this.high?32:20;
    this.bloomMaterial.uniforms.texel.value.set(4/w,4/h);this.composite.uniforms.lightTexel.value.set(divisor/w,divisor/h);this.composite.uniforms.animeTexel.value.set(1/w,1/h);this.composite.uniforms.animeLight.value=Number(!this.high);
    // Quality changes sampling work, never the art direction or colour grade.
    this.output.uniforms.bloomStrength.value=DAYLIGHT_LOOK.bloomStrength;this.stats.lightResolution=[Math.ceil(w/divisor),Math.ceil(h/divisor)];
  }
  pass(material,target){this.quad.material=material;this.renderer.setRenderTarget(target);this.renderer.render(this.quadScene,this.screenCamera);}
  render(scene,camera,toolScene,toolCamera,{matricesCurrent=false}={}){
    this.updateDynamic(camera);
    const r=this.renderer,autoMatrices=scene.matrixWorldAutoUpdate,shadow=r.shadowMap,shadowRender=shadow?.render;
    if(this.shadowGroupsEnabled&&shadow){this.shadowGroups??=new ShadowGroupBatch(r,this.surface);this.shadowGroups.beginFrame();const batch=this.shadowGroups;shadow.render=function(lights,currentScene,...args){return lights.length?batch.render(currentScene,()=>shadowRender.call(this,lights,currentScene,...args)):shadowRender.call(this,lights,currentScene,...args);};}
    // The game updates all world/bone transforms before its shadow-dirty
    // check. Reuse those exact matrices for both world passes, rather than
    // letting Three traverse and recompute the entire scene twice again.
    // Standalone callers retain Three's automatic update contract by default.
    if(matricesCurrent)scene.matrixWorldAutoUpdate=false;
    try{const hasSurface=this.surface.render(scene,camera);this.surface.uniforms.surfaceNormalsEnabled.value=Number(hasSurface);
      const nativeOpaque=this.nativeOpaqueEnabled&&hasSurface&&this.composite.uniforms.hubNativeEnabled.value>.5;
      if(nativeOpaque)this.nativeOpaquePass??=new NativeOpaquePass(r,this.surface);
      if(this.nativeOpaquePass)this.nativeOpaquePass.activeMaterialWork=this.activeMaterialWork;
      if(!nativeOpaque||!this.nativeOpaquePass.render(scene,camera,this.color)){r.setRenderTarget(this.color);r.render(scene,camera);}
      this.voxelLight.uniforms.sunMap.value=this.daylight.sun.shadow.map?.texture||null;
      this.pass(this.voxelLight,this.indirect);this.pass(this.composite,this.lit);
    }finally{this.surface.uniforms.surfaceNormalsEnabled.value=0;scene.matrixWorldAutoUpdate=autoMatrices;if(shadow)shadow.render=shadowRender;}
    this.renderDepthOfField(camera);
    r.setRenderTarget(this.lit);const autoClear=r.autoClear;r.autoClear=false;
    try{r.clearDepth();r.render(toolScene,toolCamera);}finally{r.autoClear=autoClear;}
    this.pass(this.brightnessMaterial,this.brightness);const exposure=this.exposureTargets[this.exposureIndex];this.pass(this.exposureMaterial,exposure);this.exposureUniform.value=exposure.texture;this.exposureIndex=1-this.exposureIndex;
    this.pass(this.bloomMaterial,this.bloom);this.pass(this.output,null);
  }
  dispose(){this.shadowGroups?.dispose();this.nativeOpaquePass?.dispose();this.volumeUploader.dispose();this.surface.dispose();for(const t of [this.color,this.lit,this.dofPrepared,this.dofBlurred,...this.focusTargets,this.focusSeed,this.indirect,this.bloom,this.brightness,...this.exposureTargets,this.exposureSeed,this.lookLUT,this.occupancy,this.materialVolume,this.uploadBits,this.uploadMaterials,this.dynamicTexture,this.dynamicUpload])t.dispose();for(const m of [this.voxelLight,this.composite,this.bloomMaterial,this.output,this.brightnessMaterial,this.exposureMaterial,this.focusMaterial,this.dofPrepareMaterial,this.dofBlurMaterial,this.dofCombineMaterial])m.dispose();this.quad.geometry.dispose();this.toolFill.removeFromParent();this.toolFill.target.removeFromParent();this.toolPointLights?.forEach(l=>l.removeFromParent());}
}

export function setupDaylight(renderer,scene){
  installSoftSun();renderer.toneMappingExposure=DAYLIGHT_LOOK.exposure;
  scene.fog=new THREE.FogExp2(DAYLIGHT_LOOK.fogColor,DAYLIGHT_LOOK.fogDensity);
  scene.add(new THREE.HemisphereLight(DAYLIGHT_LOOK.skyColor,DAYLIGHT_LOOK.groundColor,DAYLIGHT_LOOK.skyIntensity));
  const sun=new THREE.DirectionalLight(DAYLIGHT_LOOK.sunColor,DAYLIGHT_LOOK.sunIntensity);sun.position.set(...DAYLIGHT_LOOK.sunPosition);sun.castShadow=true;
  sun.shadow.mapSize.set(4096,4096);Object.assign(sun.shadow.camera,{left:-56,right:56,top:56,bottom:-56,near:1,far:150});
  sun.shadow.bias=-.00008;sun.shadow.normalBias=.012;sun.shadow.radius=SUN_ANGULAR_RADIUS*SHADOW_RANGE/SHADOW_SPAN;scene.add(sun);
  const direction=sun.position.clone().normalize();
  // The user supplied this frame. Sample only the unobstructed upper-left sky;
  // retain the original file and avoid inventing a replacement cloud texture.
  const skyReferenceEnabled={value:0};let refreshEnvironment;
  const skyReference=new THREE.DataTexture(new Uint8Array([0,0,0,255]),1,1);
  skyReference.needsUpdate=true;
  skyReference.colorSpace=THREE.SRGBColorSpace;skyReference.minFilter=THREE.LinearFilter;skyReference.magFilter=THREE.LinearFilter;
  const skyMaterial=new THREE.ShaderMaterial({side:THREE.BackSide,depthWrite:false,uniforms:{skyReference:{value:skyReference},skyReferenceEnabled,skyReferenceExposure:{value:REFERENCE_LOOK.exposure},sunDirection:{value:direction},horizonColor:{value:new THREE.Vector3(...DAYLIGHT_LOOK.skyHorizon)},zenithColor:{value:new THREE.Vector3(...DAYLIGHT_LOOK.skyZenith)}},vertexShader:'varying vec3 direction;void main(){direction=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',fragmentShader:`
    varying vec3 direction;uniform vec3 sunDirection,horizonColor,zenithColor;uniform sampler2D skyReference;uniform float skyReferenceEnabled,skyReferenceExposure;
    void main(){vec3 d=normalize(direction);float h=max(d.y,0.);
      vec3 sky=mix(horizonColor,zenithColor,pow(h,.5));
      float azimuth=atan(d.z,d.x)-atan(sunDirection.z,sunDirection.x);
      float mirrored=1.-abs(atan(sin(azimuth),cos(azimuth)))/3.14159265;
      vec2 referenceUV=vec2(.02+mirrored*.41,.83+clamp(sqrt(h)*1.1,0.,1.)*.16);
      vec3 referenceLinear=texture2D(skyReference,referenceUV).rgb;
      // Inverse of the confirmed exponential output, adapted from the LDR
      // screenshot. Original HDR environment and exposure are not recovered.
      vec3 referenceHDR=-log(max(vec3(.025),vec3(1.)-referenceLinear))/skyReferenceExposure;
      sky=mix(sky,referenceHDR,skyReferenceEnabled*.9);
      if(d.y<0.)sky=mix(vec3(.32,.24,.17),sky,exp(d.y*8.));
      float sun=max(0.,dot(d,sunDirection));sky+=vec3(1.,.78,.47)*pow(sun,32.)*.12;
      sky+=vec3(7.,5.9,4.6)*smoothstep(.99983,.99995,sun);
      gl_FragColor=vec4(sky,1.);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`});
  const sky=new THREE.Mesh(new THREE.SphereGeometry(200,32,16),skyMaterial);sky.frustumCulled=false;scene.add(sky);
  const skyScene=new THREE.Scene();skyScene.add(new THREE.Mesh(new THREE.SphereGeometry(100,24,12),skyMaterial));
  const pmrem=new THREE.PMREMGenerator(renderer);let environment=pmrem.fromScene(skyScene,.07,.1,200,{size:128});
  scene.environment=environment.texture;scene.environmentIntensity=DAYLIGHT_LOOK.environmentIntensity;pmrem.dispose();
  refreshEnvironment=()=>{const generator=new THREE.PMREMGenerator(renderer),next=generator.fromScene(skyScene,.07,.1,200,{size:128});scene.environment=next.texture;environment.dispose();environment=next;generator.dispose();};
  return {sun,direction,get environment(){return scene.environment;}};
}
