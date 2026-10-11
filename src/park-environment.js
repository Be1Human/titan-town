import * as THREE from '../vendor/three.module.js';
// Original analytic HDR sky. No game DDS, screenshot texture or imported palette.
export async function setupParkEnvironment(renderer,scene,environmentDefinition){
 const values=environmentDefinition,direction=new THREE.Vector3(...values.sunDirection).normalize();
 const material=new THREE.ShaderMaterial({side:THREE.BackSide,depthWrite:false,toneMapped:false,uniforms:{sunDirection:{value:direction},horizon:{value:new THREE.Vector3(...values.horizonColor)},zenith:{value:new THREE.Vector3(...values.zenithColor)},animeSky:{value:Number(Boolean(values.anime))}},vertexShader:'varying vec3 direction;void main(){direction=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',fragmentShader:`
 varying vec3 direction;uniform vec3 sunDirection,horizon,zenith;uniform float animeSky;
 float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
 float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.)),f.x),f.y);}
 float cloud(vec2 p){return noise(p)*.52+noise(p*2.03+17.)*.27+noise(p*4.1+31.)*.14+noise(p*8.2)*.07;}
 // Painted anime sunset sky: blue zenith over a peach band and an orange glow
 // toward the sun; cumulus on a perspective plane with a hard edge, brush
 // streaks, three cel tones (lit gold, peach, lavender core shadow) from the
 // density gradient toward the sun, and a silver rim near the sun. No ink.
 vec3 animeSkyColor(vec3 d){
  float h=max(0.,d.y),alignment=max(0.,dot(d,sunDirection)),toward=max(0.,dot(normalize(d.xz+vec2(1e-4)),normalize(sunDirection.xz+vec2(1e-4))));
  vec3 top=zenith*vec3(.85,.9,1.1),band=mix(horizon,vec3(1.,.68,.52),.6),glow=vec3(1.1,.6,.34);
  vec3 sky=mix(band,top,smoothstep(.04,.5,h));
  sky=mix(sky,glow,(1.-smoothstep(0.,.18,h))*(.3+.7*toward));
  sky+=vec3(.45,.24,.08)*pow(alignment,6.)+vec3(.12,.06,.02)*alignment*alignment;
  vec2 uv=d.xz/max(.12,h)*.55+vec2(3.,5.),toSun=normalize(sunDirection.xz+vec2(1e-4))*.08;
  float c=cloud(uv)+noise(vec2(uv.x*.7+uv.y*.25,uv.y*3.4))*.07-.035;
  float edge=.5+.3*smoothstep(.6,.95,h)+.2*(1.-smoothstep(.03,.12,h)),mask=smoothstep(edge,edge+.012,c);
  float lit=smoothstep(-.006,.006,c-cloud(uv+toSun)),core=smoothstep(edge+.04,edge+.24,c);
  vec3 cloudColor=mix(vec3(1.,.72,.66),mix(vec3(1.2,1.08,.92),vec3(1.4,1.02,.66),pow(alignment,2.)),lit);
  cloudColor=mix(cloudColor,vec3(.46,.44,.76),core*(1.-lit)*.9);
  cloudColor+=vec3(1.3,.95,.55)*(1.-smoothstep(edge,edge+.05,c))*pow(alignment,4.);
  sky=mix(sky,cloudColor,mask);
  sky+=vec3(6.,4.4,2.6)*smoothstep(.9994,.9997,alignment);
  if(d.y<0.)sky=mix(vec3(.26,.2,.2),glow*.8,exp(d.y*8.));
  return sky;
 }
 void main(){vec3 d=normalize(direction);if(animeSky>.5){gl_FragColor=vec4(animeSkyColor(d),1.);return;}float h=max(0.,d.y);vec3 sky=mix(horizon,zenith,pow(h,.25));float alignment=max(0.,dot(d,sunDirection));sky+=vec3(.35,.15,.035)*pow(alignment,12.);vec2 uv=d.xz/max(.14,h);float clouds=smoothstep(.57,.74,cloud(uv*1.9+vec2(3.,5.)))*smoothstep(.04,.2,h)*(1.-smoothstep(.65,.96,h));vec3 cloudColor=mix(vec3(.42,.46,.5),vec3(.93,.8,.57),pow(alignment,3.));sky=mix(sky,cloudColor,clouds*.65);sky+=vec3(9.,6.6,3.5)*smoothstep(.99975,.99991,alignment);if(d.y<0.)sky=mix(vec3(.14,.17,.11),horizon,exp(d.y*8.));gl_FragColor=vec4(sky,1.);}`});
 const sky=new THREE.Mesh(new THREE.SphereGeometry(250,40,20),material);sky.frustumCulled=false;sky.name='Original park analytic HDR sky';scene.add(sky);scene.fog=null;
 const sun=new THREE.DirectionalLight();sun.color.setRGB(...values.sunColor);sun.intensity=1;sun.position.copy(direction).multiplyScalar(85);sun.castShadow=true;sun.shadow.mapSize.set(4096,4096);Object.assign(sun.shadow.camera,{left:-42,right:42,top:42,bottom:-42,near:1,far:160});sun.shadow.bias=-.00004;sun.shadow.normalBias=.012;scene.add(sun,sun.target);
 const skyScene=new THREE.Scene();skyScene.add(new THREE.Mesh(new THREE.SphereGeometry(200,24,12),material));const pmrem=new THREE.PMREMGenerator(renderer),environment=pmrem.fromScene(skyScene,0,.1,250,{size:128});pmrem.dispose();scene.environment=environment.texture;scene.environmentIntensity=.55;
 return {sun,direction,environment:environment.texture,sky,voxelEnvironment:{id:values.id,authorship:'project-original',ambientColor:values.ambientColor,constant:values.constant,ambientexponent:values.ambientExponent,ambientOcclusionStrength:THREE.MathUtils.clamp(values.ambientOcclusionStrength??1,0,1),sunShadowStrength:THREE.MathUtils.clamp(values.sunShadowStrength??1,0,1),cachedSunColor:values.sunColor,exposure:values.exposure,brightness:values.brightness,fogColor:values.fogColor,fog:values.fog,anime:values.anime??null,pointLightBudget:8}};
}
