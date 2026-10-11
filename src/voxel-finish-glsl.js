// Shared mesh/DDA pigment finish, using centered object-local metre coordinates.
// Confirmed reference: source-bf5da0.glsl-hlsl 3209, 3369-3372, 3556-3575
// selects integer face coordinates, repeats them every 256 cells, and multiplies
// palette colour by albedo mixed with white at per-object texture strength.
// The original 4x8 atlas pixels, palette assignments, textureParams offsets and
// each object's textureTile strength are NOT recovered here. Patterns below are
// independently authored, calibrated to the supplied hub close-ups, not that atlas.
// Grain is the already scaled voxelStyle.grain value.
// Profiles encode appearance only, independently of physical material classes.
export const VOXEL_FINISH_PROFILE_IDS=Object.freeze({plain:0,wood:1,brick:2,plaster:3,stone:3,roof:3,concrete:4,rust:5});
export const VOXEL_FINISH_COLOR_GLSL=`
  #ifndef CREW_VOXEL_FINISH_COLOR
  #define CREW_VOXEL_FINISH_COLOR
  float voxelHash(vec3 p){p=fract(p*.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);}
  float voxelField(vec2 p){
    vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
    return mix(mix(voxelHash(vec3(i,31.)),voxelHash(vec3(i+vec2(1.,0.),31.)),f.x),mix(voxelHash(vec3(i+vec2(0.,1.),31.)),voxelHash(vec3(i+vec2(1.,1.),31.)),f.x),f.y);
  }
  vec3 voxelFinishColor(vec3 baseColor,vec3 sourcePoint,vec3 sourceFace,float cell,float grain,float finishProfile,float woodAxis){
    vec3 face=normalize(sourceFace),sourceCell=floor(sourcePoint/cell-face*.15);
    vec2 surface=abs(face.x)>.5?sourcePoint.yz:abs(face.y)>.5?sourcePoint.xz:sourcePoint.xy;
    vec2 faceCell=abs(face.x)>.5?sourceCell.yz:abs(face.y)>.5?sourceCell.xz:sourceCell.xy;
    vec2 atlasCell=mod(faceCell,vec2(256.));
    vec2 pixel=max(fwidth(surface/cell),vec2(.0001));
    float detail=1.-smoothstep(.30,1.05,max(pixel.x,pixel.y));
    // Derivatives are evaluated before palette-driven profile branches; DDA
    // neighbouring fragments may select different material/axis values.
    vec2 timberUV=abs(face.x)>.5?sourcePoint.zy:sourcePoint.xy;
    float endFace=abs(face.y);
    if(woodAxis<.5){timberUV=abs(face.y)>.5?sourcePoint.zx:sourcePoint.yx;endFace=abs(face.x);}
    else if(woodAxis>1.5){timberUV=abs(face.y)>.5?sourcePoint.xz:sourcePoint.yz;endFace=abs(face.z);}
    timberUV=mix(timberUV,surface,endFace);
    float timberPixel=max(fwidth(timberUV.x),.0005);
    vec2 masonryUV=surface;
    vec2 masonrySize=max(vec2(cell),floor(vec2(.5,.2)/cell+.5)*cell);
    float masonryCourse=floor(masonryUV.y/masonrySize.y);
    masonryUV.x+=mod(masonryCourse,2.)*masonrySize.x*.5;
    vec2 masonryPixel=max(fwidth(masonryUV),vec2(.0005));
    vec2 slabPixel=max(fwidth(surface),vec2(.0005));
    float cellNoise=voxelHash(vec3(atlasCell,37.)),tone=floor(cellNoise*5.)/4.;
    // Adjacent cells share a broad colour field, avoiding a checkerboard of
    // unrelated tiles. Sampling on the source grid keeps the clusters voxel aligned.
    float cluster=voxelField(floor(atlasCell/2.)*.5);
    float authoredAlbedo=.25+.75*mix(tone,cluster,.35);
    // Wood side grain is longitudinal in the supplied close-ups. Keep random
    // per-cell pigment strongest on end cuts, instead of masking the fibres.
    float pigmentStrength=(finishProfile>.5&&finishProfile<1.5)?mix(.25,1.,endFace):1.;
    float shade=mix(1.,authoredAlbedo,grain*detail*pigmentStrength);
    if(finishProfile>2.5&&finishProfile<4.5){
      float surfaceAge=voxelField(floor(surface/cell)*cell*.55);
      shade*=mix(1.,.78+.22*surfaceAge,detail*.35);
    }
    if(finishProfile>.5&&finishProfile<1.5){
      float boardWidth=max(cell,floor((cell<.02?.045:.24)/cell+.5)*cell);
      float timberBoard=floor(timberUV.x/boardWidth);
      float timberEdge=min(fract(timberUV.x/boardWidth),1.-fract(timberUV.x/boardWidth))*boardWidth;
      float timberSeam=1.-smoothstep(.002-timberPixel,.002+timberPixel,timberEdge);
      float timberTone=voxelHash(vec3(timberBoard,0.,19.));
      float timberFibre=voxelHash(vec3(floor(timberUV.x/cell),floor(timberUV.y/(cell*6.)),7.));
      shade*=mix(1.,.25+.75*mix(timberTone,timberFibre,.65),grain*detail*(1.-endFace));
      shade*=1.-timberSeam*.055*detail*(1.-endFace);
    }else if(finishProfile>1.5&&finishProfile<2.5){
      vec2 masonryTile=floor(masonryUV/masonrySize);
      vec2 masonryEdge=min(fract(masonryUV/masonrySize),1.-fract(masonryUV/masonrySize))*masonrySize;
      float masonryJoint=max(1.-smoothstep(.009-masonryPixel.x,.009+masonryPixel.x,masonryEdge.x),1.-smoothstep(.009-masonryPixel.y,.009+masonryPixel.y,masonryEdge.y));
      shade*=mix(1.,.72+.28*voxelHash(vec3(masonryTile,23.)),detail);
      baseColor=mix(baseColor,vec3(.26,.23,.18),masonryJoint*.5*detail);
    }else if(finishProfile>3.5&&finishProfile<4.5){
      shade-=step(.993,cellNoise)*.012*detail;
      // Slab joints are a construction feature on horizontal concrete ground,
      // never a grid stamped onto every wall or painted object.
      if(face.y>.5){
        float slabSize=max(cell,floor(.9/cell+.5)*cell);
        vec2 slabEdge=min(fract(surface/slabSize),1.-fract(surface/slabSize))*slabSize;
        float slabJoint=max(1.-smoothstep(.003-slabPixel.x,.003+slabPixel.x,slabEdge.x),1.-smoothstep(.003-slabPixel.y,.003+slabPixel.y,slabEdge.y));
        shade*=1.-slabJoint*.035*detail;
      }
    }else if(finishProfile>4.5&&finishProfile<5.5){
      float rustIsland=voxelField(floor(surface/cell)*cell*.7);
      baseColor=mix(baseColor,baseColor*vec3(1.045,.97,.94),smoothstep(.58,.76,rustIsland)*.16);
    }
    return baseColor*shade;
  }
  #endif
`;

// surfaceHeight uses the same metre scale as viewPoint. The caller should fade
// its height with pixel footprint, before neighbouring voxel seams alias.
// This string has no THREE/DOM dependency, so character previews can share it.
export const VOXEL_SHOULDER_NORMAL_GLSL=`
  #ifndef CREW_VOXEL_SHOULDER_NORMAL
  #define CREW_VOXEL_SHOULDER_NORMAL
  vec3 voxelShoulderNormal(vec3 viewPoint,vec3 faceNormal,float surfaceHeight){
    vec3 screenX=dFdx(viewPoint),screenY=dFdy(viewPoint);
    vec3 acrossX=cross(screenY,faceNormal),acrossY=cross(faceNormal,screenX);
    float voxelDet=dot(screenX,acrossX);
    vec3 heightGradient=sign(voxelDet)*(dFdx(surfaceHeight)*acrossX+dFdy(surfaceHeight)*acrossY);
    return normalize(max(abs(voxelDet),1e-12)*faceNormal-heightGradient);
  }
  #endif
`;
