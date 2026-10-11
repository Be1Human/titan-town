// Native shader equations: source-bf5da0.glsl-hlsl:55–90 (ambient) and
// 101–121 (sun). Environment values supplied by the decoded Hub0 metadata.
// Integration adapts the existing occupancy volume / bounded static DDA;
// native MAX_AMBIENT_LIGHT_DIST is 24 (embedded shader line 7259). Blue-noise
// texture/history, screenspace
// blocking, jitter, supersparse traversal and temporal accumulation are unknown.
export const HUB_NATIVE_LIGHT_REFERENCE=Object.freeze({
  sunDirection:[-.584506214,.134405181,.800179780],
  sunColor:[.191280812,.081857674,.018172404],
  constantColor:[.003,.003,.003],ambientExponent:1.3,
  ambientColor:[.191280823,.097196462,.033635667],
  nativeMaxAmbient:24,projectRayCount:6,
  // PaletteManager 1400aaef0 creates its colour texture as internal format
  // 0x14. The native format table names 0x14 RGBA8_UNORM_SRGB, 0x13 RGBA8_UNORM.
  // GBuffer texelFetch therefore reads hardware-decoded linear RGB.
  nativePaletteTextureFormat:'RGBA8_UNORM_SRGB (0x14)',
  ambientColorEvidence:'Recovered native CPU ambient reduction, including hub tint; do not divide by pi again',
});

// Include after traceLight, traceDynamicLight and visibilityAt declarations.
// Input colours are linear. This returns incident diffuse light: the caller
// multiplies by the unlit MRT albedo once, and adds MRT emission separately.
// It must replace the generic BRDF composite, not add on top of that lighting.
export const HUB_NATIVE_LIGHT_GLSL=`
  #ifndef HUB_NATIVE_INCIDENT_LIGHT
  #define HUB_NATIVE_INCIDENT_LIGHT
  // Optional authored readability controls. A value of 1 preserves the
  // reference kernel; lower values retain contact while lifting broad shadows.
  uniform float hubAmbientOcclusionStrength,hubSunShadowStrength;
  // Same exact 10 cm occupancy bits as the live lighting volume. Empty 40 cm
  // blocks skip four cells. The loop is extended to cover native 24 m ambient
  // reach instead of the generic traceLight's 6.4 m / 32-step restriction.
  // This remains a project DDA; native screen blocking, jitter and supersparse
  // mip transitions are not represented. An unhit ray returns maxAmbient.
  float hubTraceAmbientStatic(vec3 origin,vec3 direction,float maxAmbient){
    float travel=0.;vec3 p=origin;
    for(int stepIndex=0;stepIndex<384;stepIndex++){
      if(travel>=maxAmbient||!insideVolume(p))break;
      ivec3 block=ivec3(floor((p-volumeMin)/.4));
      uvec2 mask=texelFetch(occupancyMap,block,0).rg;
      bool empty=(mask.x|mask.y)==0u;
      if(!empty){
        ivec3 cell=ivec3(floor((p-volumeMin)/.1));
        uint bit=uint((cell.x&3)+(cell.y&3)*4+(cell.z&3)*16);
        if((mask[int(bit>>5u)]&(1u<<(bit&31u)))!=0u)return travel;
      }
      travel+=boundaryDistance(p,direction,empty?.4:.1)+.0003;
      p=origin+direction*travel;
    }
    return maxAmbient;
  }
  float hubNativeAmbientDistance(vec3 origin,vec3 direction,float stepCount,float maxAmbient){
    vec3 dynamicHit;
    float staticDistance=hubTraceAmbientStatic(origin,direction,maxAmbient);
    vec4 d=traceDynamicLight(origin,direction,dynamicHit);
    float distance=min(maxAmbient,staticDistance);
    if(d.a>0.)distance=min(distance,max(0.,d.a-.001));
    return distance;
  }
  vec3 hubNativeIncidentLight(vec3 position,vec3 geometricNormal,vec3 lightingNormal,
    vec3 ambientColor,vec3 constantColor,float ambientExponent,
    vec3 sunColor,float rayCount,float stepCount,float maxAmbient){
    vec3 n=normalize(lightingNormal),ng=normalize(geometricNormal);
    vec3 tangent=abs(n.z)>.5?vec3(0.,-n.z,n.y):vec3(-n.y,n.x,0.);
    tangent=normalize(tangent-dot(n,tangent)*n);
    vec3 bitangent=cross(n,tangent),ambient=vec3(0.);
    float count=max(1.,min(6.,rayCount));
    // Original cosine hemisphere distribution. Six fixed stratified inputs
    // replace unconfirmed blueNoise2() for coherent walls without history.
    for(int i=0;i<6;i++){
      if(float(i)>=count)break;
      float radialSample=(float(i)+.5)/count,r=sqrt(radialSample);
      float theta=float(i)*2.39996323+.65;
      vec3 direction=tangent*(r*cos(theta))+bitangent*(r*sin(theta))+n*sqrt(max(0.,1.-radialSample));
      float hitDistance=hubNativeAmbientDistance(position+ng*.125,direction,stepCount,maxAmbient);
      float incoming=direction.y*.2+.8;
      float openness=mix(1.,pow(clamp(hitDistance/max(maxAmbient,.0001),0.,1.),ambientExponent),hubAmbientOcclusionStrength);
      ambient+=ambientColor*(incoming*openness);
      ambient+=constantColor*(incoming*max(1.,hitDistance*.25));
    }
    ambient/=count;
    // Native directional kernel multiplies NdotL by a ray visibility. This
    // adaptation uses the existing live shadow-map visibility; native sun
    // spread, max shadow distance and stochastic fade are not reproduced here.
    float incomingSun=max(0.,dot(normalize(sunDirection),n));
    float sunVisibility=mix(1.,visibilityAt(position+ng*.05),hubSunShadowStrength);
    return ambient+sunColor*(sunVisibility*incomingSun);
  }
  #endif
`;
