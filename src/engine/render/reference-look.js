// Independently expressed reference operators. These defaults are this
// project's art preset; scene brightness and the Three light-unit bridge are
// tuned by eye.
export const REFERENCE_LOOK=Object.freeze({exposure:1.65,auto:false,min:1,max:5,sceneBrightness:1,adaptation:.05,gamma:1,saturation:1,colorBalance:[1,1,1],bloomThreshold:1.7,bloomScale:1});
export function referenceOutput(rgb,{exposure=1,gamma=1,saturation=1,colorBalance=[1,1,1]}={}){
  const c=rgb.map(v=>Math.max(0,v)*Math.min(100,Math.max(.001,exposure))),l=c[0]*.3+c[1]*.5+c[2]*.2;
  return c.map((v,i)=>Math.pow(1-Math.exp(-Math.max(0,l+(v-l)*saturation)*colorBalance[i]),1/(2.2*gamma)));
}
export function referenceExposure(brightness,last,{min=.65,max=1.7,sceneBrightness=1,adaptation=.05,override=0}={}){
  const target=Math.min(max,Math.max(min,.5*sceneBrightness/Math.max(brightness,1e-5)));
  return override>0?override:last+(target-last)*adaptation;
}
export function referenceBloom(rgb,exposure,threshold=1.7,scale=1){
  const l=Math.max(...rgb)+.001,t=threshold/Math.min(10,Math.max(.01,exposure));return rgb.map(v=>v*Math.min(.5,Math.max(0,l-t))/l*scale*3);
}
export const REFERENCE_OUTPUT_GLSL=`
vec3 referenceOutput(vec3 color,float exposure){
  color=max(color,vec3(0.))*clamp(exposure,.001,100.);
  float l=dot(color,vec3(.3,.5,.2));
  vec3 balanced=max(mix(vec3(l),color,referenceSaturation),vec3(0.))*referenceBalance;
  return pow(1.-exp(-balanced),vec3(1./(2.2*referenceGamma)));
}`;
