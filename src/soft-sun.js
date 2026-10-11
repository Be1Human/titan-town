import * as THREE from '../vendor/three.module.js';

export const SUN_ANGULAR_RADIUS=.025;
export const SHADOW_SPAN=112,SHADOW_RANGE=149,SHADOW_SIZE=4096;
export const sunPenumbra=distance=>Math.max(SHADOW_SPAN/SHADOW_SIZE,Math.min(1.8,Math.max(0,distance)*SUN_ANGULAR_RADIUS));

// Three's stock PCFSoft path ignores light.shadow.radius. Search actual blocker
// depth, then filter over an area proportional to blocker/receiver separation.
// Only our orthographic directional sun casts this type of shadow.
export function installSoftSun(){
  let code=THREE.ShaderChunk.shadowmap_pars_fragment;if(code.includes('voxelSoftSun'))return;
  const helper=`
    float voxelSoftSun(sampler2D map,vec2 size,vec3 coord,float angularScale){
      float center=unpackRGBAToDepth(texture2D(map,coord.xy));
      float count=center<coord.z-.00012?1.:0.,blocker=center*count;
      for(int i=0;i<8;i++){
        float f=float(i),a=f*2.399963;vec2 offset=vec2(cos(a),sin(a))*sqrt((f+.5)/8.)*.014;
        float d=unpackRGBAToDepth(texture2D(map,clamp(coord.xy+offset,vec2(0.),vec2(1.))));
        if(d<coord.z-.00012){blocker+=d;count+=1.;}
      }
      if(count==0.)return 1.;
      float radius=clamp((coord.z-blocker/count)*angularScale,1./size.x,.016);
      float visibility=0.;
      for(int i=0;i<12;i++){
        float f=float(i),a=f*2.399963+.7;
        vec2 offset=vec2(cos(a),sin(a))*sqrt((f+.5)/12.)*radius;
        visibility+=texture2DCompare(map,clamp(coord.xy+offset,vec2(0.),vec2(1.)),coord.z);
      }
      return visibility/12.;
    }
  `;
  const marker='float getShadow( sampler2D';
  if(!code.includes(marker))throw new Error('Unsupported Three.js shadow chunk');
  code=code.replace(marker,helper+'\n\t'+marker);
  const start=code.indexOf('#elif defined( SHADOWMAP_TYPE_PCF_SOFT )',code.indexOf(marker));
  const end=code.indexOf('#elif defined( SHADOWMAP_TYPE_VSM )',start);
  if(start<0||end<0)throw new Error('Unsupported Three.js PCF branch');
  THREE.ShaderChunk.shadowmap_pars_fragment=code.slice(0,start)+`#elif defined( SHADOWMAP_TYPE_PCF_SOFT )\n shadow=voxelSoftSun(shadowMap,shadowMapSize,shadowCoord.xyz,shadowRadius);\n\t\t`+code.slice(end);
}
