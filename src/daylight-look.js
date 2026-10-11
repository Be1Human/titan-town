// Scene calibration from the user's hub screenshots, shared by both
// quality modes. These are authored values, not recovered native uniforms.
export const DAYLIGHT_LOOK=Object.freeze({
  id:'hub-reference-evening-v4',exposure:1.65,
  sunColor:0xffce89,sunIntensity:2.25,sunPosition:[-38,12,-28],
  skyColor:0xe2d3ac,groundColor:0x9a784f,skyIntensity:.52,
  environmentIntensity:.32,fogColor:0x8d754c,fogDensity:.0018,
  skyHorizon:[.72,.57,.29],skyZenith:[.31,.34,.27],
  shadowTint:[1,1,1],highlightTint:[1,1,1],
  saturation:1,midtoneGamma:1,lutSize:32,
  toolSkyBase:.18,toolSkyGain:.42,toolEnvironmentBase:.12,toolEnvironmentGain:.26,
  bloomStrength:.08,bloomThreshold:1.8,vignetteStrength:.015,
  aoStrength:.48,aoFloor:.48,contactStrength:.34,contactFloor:.61
});

const clamp=value=>Math.max(0,Math.min(1,value));
const smooth=(low,high,value)=>{const t=clamp((value-low)/(high-low));return t*t*(3-2*t);};

// Inputs and outputs are display-referred *linear* RGB, after ACES but before
// the sRGB transfer. Keeping that placement fixed avoids grading twice when
// the world/foreground are drawn into HDR render targets.
export function gradeDaylightRGB(rgb,look=DAYLIGHT_LOOK){
  const color=rgb.map(clamp),lum=color[0]*.2126+color[1]*.7152+color[2]*.0722;
  const shadow=1-smooth(.06,.46,lum),highlight=smooth(.52,.94,lum);
  const chroma=Math.max(...color)-Math.min(...color);
  const saturation=1+(look.saturation-1)*(1-smooth(.6,1,chroma)*.45);
  return color.map((channel,index)=>{
    const saturated=lum+(channel-lum)*saturation;
    const tint=1+shadow*(look.shadowTint[index]-1)+highlight*(look.highlightTint[index]-1);
    return clamp(Math.pow(Math.max(0,saturated*tint),look.midtoneGamma));
  });
}

// x is red, y is green, z is blue. WebGL trilinear interpolation handles the
// full cube in one lookup; no full-resolution extra render pass is required.
export function makeDaylightLUT(size=DAYLIGHT_LOOK.lutSize){
  if(!Number.isInteger(size)||size<2||size>64)throw new RangeError('LUT size must be an integer between 2 and 64');
  const data=new Uint8Array(size**3*4);
  for(let blue=0;blue<size;blue++)for(let green=0;green<size;green++)for(let red=0;red<size;red++){
    const graded=gradeDaylightRGB([red/(size-1),green/(size-1),blue/(size-1)]);
    const offset=(red+green*size+blue*size*size)*4;
    data[offset]=Math.round(graded[0]*255);data[offset+1]=Math.round(graded[1]*255);data[offset+2]=Math.round(graded[2]*255);data[offset+3]=255;
  }
  return {data,size};
}
