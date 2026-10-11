import {normalizeAppearance,appearanceKey} from './character-config.js';

// The outline is sampled at 2.5 cm. Adjacent cells stay tightly joined when
// merged; there are no inset blocks or long artificial gaps in the body.
const CELL=.025,CACHE_LIMIT=24;
const modelCache=new Map();
const styledMaterials=new WeakSet();
const color=hex=>parseInt(hex.slice(1),16);
const tint=(rgb,factor)=>[16,8,0].reduce((result,shift)=>result|(Math.max(0,Math.min(255,Math.round(((rgb>>shift)&255)*factor)))<<shift),0);
const COAL=0x403b35,BOOT=0x4b453c,CREAM=0xf4dfac,STEEL=0x7f8584;
function radiusAt(y){
  const belly=.490*Math.sqrt(Math.max(0,1-Math.abs((y-.755)/.625)**(y<.755?3.2:2)));
  const hood=.360*Math.sqrt(Math.max(0,1-((y-1.345)/.400)**2));
  // A smooth union keeps the shoulders continuous where the hood meets the
  // round abdomen. The hood has a dome, rather than a tapering triangular tip.
  const blend=Math.max(0,.050-Math.abs(belly-hood));
  return Math.max(belly,hood)+blend*blend/.200;
}
function depthAt(x,y){
  const radius=radiusAt(y);if(!radius||Math.abs(x)>=radius)return 0;
  return radius*.77*Math.sqrt(Math.max(0,1-(x/radius)**2));
}
function frontCell(x,y){
  const qx=(Math.floor(x/CELL)+.5)*CELL,qy=(Math.floor(y/CELL)+.5)*CELL;
  return Math.floor(depthAt(qx,qy)/CELL+.5)*CELL;
}
function roundRect(x,y,rx,ry,round=.045){
  const dx=Math.max(0,Math.abs(x)-(rx-round)),dy=Math.max(0,Math.abs(y)-(ry-round));
  return Math.abs(x)<=rx&&Math.abs(y)<=ry&&dx*dx+dy*dy<=round*round;
}

function builder(cell=CELL){
  const limbs=new Map();
  const key=(x,y,z)=>`${x},${y},${z}`;
  function volume(min,max,inside,paint,limb='body',surface='fabric'){
    let cells=limbs.get(limb);if(!cells){cells=new Map();limbs.set(limb,cells);}
    for(let y=Math.floor(min[1]/cell);y<Math.ceil(max[1]/cell);y++)for(let z=Math.floor(min[2]/cell);z<Math.ceil(max[2]/cell);z++)for(let x=Math.floor(min[0]/cell);x<Math.ceil(max[0]/cell);x++){
      const px=(x+.5)*cell,py=(y+.5)*cell,pz=(z+.5)*cell;
      if(!inside(px,py,pz))continue;
      // The static shell owns cells at shoulders/hips. Clipping dynamic limbs
      // there prevents two coplanar voxel skins from competing in depth, while
      // the short limbs still meet the body without an artificial gap.
      if(limb!=='body'&&limb!=='accessory'&&limbs.get('body')?.has(key(x,y,z)))continue;
      const value=typeof paint==='function'?paint(px,py,pz):paint;if(value===null)continue;
      const rgb=typeof value==='number'?value:value.color,kind=typeof value==='number'?surface:value.surface||surface;
      cells.set(key(x,y,z),{x,y,z,color:rgb,surface:kind,signature:`${rgb}/${kind}`});
    }
  }
  function box(p,s,rgb,limb='body',surface='fabric'){
    const min=p.map((v,i)=>v-s[i]/2),max=p.map((v,i)=>v+s[i]/2);
    volume(min,max,()=>true,rgb,limb,surface);
  }
  function ellipsoid(p,r,rgb,limb='body',surface='fabric',clip=()=>true){
    volume(p.map((v,i)=>v-r[i]),p.map((v,i)=>v+r[i]),(x,y,z)=>((x-p[0])/r[0])**2+((y-p[1])/r[1])**2+((z-p[2])/r[2])**2<=1&&clip(x,y,z),rgb,limb,surface);
  }
  function tube(a,b,ra,rb,rgb,limb='body',surface='fabric'){
    const delta=b.map((v,i)=>v-a[i]),length=delta.reduce((sum,v)=>sum+v*v,0),radius=Math.max(ra,rb);
    volume(a.map((v,i)=>Math.min(v,b[i])-radius),a.map((v,i)=>Math.max(v,b[i])+radius),(x,y,z)=>{
      const point=[x,y,z],t=Math.max(0,Math.min(1,point.reduce((sum,v,i)=>sum+(v-a[i])*delta[i],0)/length)),r=ra+(rb-ra)*t;
      return point.reduce((sum,v,i)=>sum+(v-a[i]-delta[i]*t)**2,0)<=r*r;
    },rgb,limb,surface);
  }
  function merge(appearance){
    const result=[];
    for(const [limb,cells]of limbs){
      const same=(x,y,z,signature)=>cells.get(key(x,y,z))?.signature===signature;
      for(const start of cells.values()){
        if(!cells.has(key(start.x,start.y,start.z)))continue;
        const {x,y,z,signature}=start;let w=1,d=1,h=1;
        while(same(x+w,y,z,signature))w++;
        growDepth:while(true){for(let xx=0;xx<w;xx++)if(!same(x+xx,y,z+d,signature))break growDepth;d++;}
        growHeight:while(true){for(let zz=0;zz<d;zz++)for(let xx=0;xx<w;xx++)if(!same(x+xx,y+h,z+zz,signature))break growHeight;h++;}
        for(let yy=0;yy<h;yy++)for(let zz=0;zz<d;zz++)for(let xx=0;xx<w;xx++)cells.delete(key(x+xx,y+yy,z+zz));
        result.push({color:start.color,p:[(x+w/2)*cell*appearance.width,(y+h/2)*cell*appearance.height,(z+d/2)*cell*appearance.width],s:[w*cell*appearance.width,h*cell*appearance.height,d*cell*appearance.width],limb,surface:start.surface});
      }
    }
    return result;
  }
  return{volume,box,ellipsoid,tube,merge};
}

function eyesAndMouth(b,a){
  const size=a.faceSize,front=frontCell(0,1.295)+.003;
  for(const side of [-1,1]){
    const x=side*.145*size,eyeFront=frontCell(x,1.395)+.005;
    b.ellipsoid([x,1.395,eyeFront],[.026,.028,.019],COAL,'body','rubber');
    if(a.expression==='angry'||a.expression==='worried'){
      const slope=a.expression==='angry'?-side:side;
      for(let i=-1;i<=1;i++){const xx=x+i*.020,yy=1.453+i*.011*slope;b.box([xx,yy,frontCell(xx,yy)+.006],[.025,.013,.016],COAL,'body','rubber');}
    }
  }
  if(a.expression==='surprised'){
    b.ellipsoid([0,1.275,front],[.026,.036,.015],0x814a3c,'body','skin');
    b.box([0,1.251,front+.012],[.025,.017,.018],0xcc8a73,'body','skin');
  }else if(a.expression==='happy'){
    b.box([0,1.27,front],[.060,.014,.024],COAL,'body','rubber');
    for(const side of [-1,1])b.box([side*.036,1.283,front],[.017,.028,.024],COAL,'body','rubber');
  }else if(a.expression==='worried'){
    b.box([0,1.286,front],[.051,.014,.024],COAL,'body','rubber');
    for(const side of [-1,1])b.box([side*.032,1.275,front],[.016,.021,.024],COAL,'body','rubber');
  }else b.box([0,1.275,front],[.056,.014,.024],COAL,'body','rubber');
}

function headwear(b,a,hat){
  if(a.hat==='hardhat'){
    b.volume([-.555,1.47,-.475],[.555,1.59,.475],(x,y,z)=>{
      const radius=(x/.555)**2+(z/.475)**2,height=1.555-.050*radius;
      return radius<=1&&y<=height+.026&&y>=height-.026;
    },tint(hat,.985),'body','plastic');
    b.ellipsoid([0,1.555,-.015],[.490,.365,.415],(x,y,z)=>({color:Math.abs(x)<.045?tint(hat,1.035):Math.abs(Math.abs(x)-.25)<.018?tint(hat,.965):hat,surface:'plastic'}),'body','plastic',(x,y,z)=>y>=1.555);
    for(let z=-.325;z<=.325;z+=CELL){const y=1.555+.365*Math.sqrt(Math.max(0,1-(z+.015)**2/.415**2));b.box([0,y+.007,z],[.075,.027,CELL],tint(hat,1.045),'body','plastic');}
  }else if(a.hat==='cap'){
    b.ellipsoid([0,1.56,-.025],[.375,.265,.325],hat,'body','fabric',(x,y,z)=>y>=1.55);
    b.volume([-.40,1.505,.04],[.40,1.585,.535],(x,y,z)=>{
      const radius=(x/.40)**2+((z-.20)/.335)**2,height=1.568-.035*radius;
      return radius<=1&&y>=height-.018&&y<=height+.018;
    },tint(hat,.93),'body','fabric');
    b.ellipsoid([0,1.825,-.025],[.045,.025,.045],tint(hat,1.04),'body','fabric');
  }
}

function outfitDetails(b,a,outfit){
  if(a.outfit==='overalls'){
    for(const side of [-1,1]){
      b.box([side*.255,.998,frontCell(side*.255,.998)+.016],[.045,.045,.027],0xcfac61,'body','metal');
    }
    b.box([0,.835,.395],[.26,.19,.035],tint(outfit,.94));
    b.box([0,.939,.406],[.28,.028,.036],tint(outfit,1.10));
  }else if(a.outfit==='satchel'){
    for(let i=0;i<20;i++){
      const t=i/19,x=-.345+.69*t,y=.57+.67*t,z=frontCell(x,y)+.013;
      b.box([x,y,z],[.068,.070,.033],tint(outfit,.82),'body','leather');
    }
    b.volume([-.24,.41,.33],[.13,.73,.52],(x,y,z)=>roundRect(x+.055,y-.57,.19,.16,.04),outfit,'body','leather');
    b.box([-.055,.664,.522],[.35,.095,.04],tint(outfit,1.10),'body','leather');
    b.box([-.055,.582,.548],[.075,.065,.035],0xcaa266,'body','metal');
  }
}

function armsAndFeet(b,a,body,glove,outfit){
  const size=a.armSize;
  for(const side of [-1,1]){
    const limb=side<0?'leftArm':'rightArm',leg=side<0?'leftLeg':'rightLeg';
    const holding=a.prop==='ingot'||a.prop==='clipboard',hammer=a.prop==='hammer'&&side<0,raised=a.prop==='tape'&&side>0,hip=a.prop==='hammer'&&side>0;
    const hand=[side*(holding?.365:hammer?.615:raised?.585:hip?.510:.505),holding?.88:hammer?1.105:raised?1.15:hip?.845:.795,holding?.445:hammer?.215:raised?.28:hip?.19:.12];
    const shoulder=[side*.380,1.105,-.01],elbow=[side*(holding?.475:hammer?.530:raised?.535:hip?.575:.51),holding?.965:hammer?1.05:raised?1.025:hip?.98:.955,holding?.18:hammer?.11:raised?.14:.045];
    const wrist=[hand[0]-side*.030,hand[1]+(hammer?-.018:.055),hand[2]-.045];
    b.tube(shoulder,elbow,.115*size,.110*size,body,limb);
    b.tube(elbow,wrist,.110*size,.105*size,body,limb);
    const surface=a.outfit==='satchel'?'leather':'fabric';
    b.ellipsoid(hand,[.145*size,.145*size,.142*size],glove,limb,surface);
    // A single curled finger pad and a separate inward thumb read as a mitten,
    // rather than a circular shoulder plate glued onto the torso.
    b.ellipsoid([hand[0],hand[1]-.055,hand[2]+.067],[.125*size,.097*size,.095*size],glove,limb,surface);
    b.ellipsoid([hand[0]-side*.105,hand[1]-.005,hand[2]+.093],[.064*size,.082*size,.060*size],tint(glove,.985),limb,surface);
    if(a.outfit==='satchel')for(let i=0;i<3;i++)b.box([hand[0]+(i-1)*.055,hand[1]+.075,hand[2]+.12],[.037,.038,.027],0x726759,limb,'leather');
    const pant=a.outfit==='overalls'?outfit:body;
    b.ellipsoid([side*.225,.177,.005],[.116,.108,.13],pant,leg);
    b.volume([side*.225-.13,0,-.12],[side*.225+.13,.125,.215],(x,y,z)=>roundRect(x-side*.225,z-.0475,.13,.1675,.04)&&y<.125-.025*Math.max(0,(Math.abs(x-side*.225)-.075)/.055),BOOT,leg,'rubber');
  }
}

function handProp(b,a){
  const limb='accessory';
  if(a.prop==='hammer'){
    b.box([.64,.655,.185],[.075,1.025,.075],0x98724c,limb,'wood');
    b.box([.621,.655,.23],[.022,1.0,.018],0xb79467,limb,'wood');
    b.volume([.425,.035,.025],[.855,.315,.35],(x,y,z)=>roundRect(x-.64,y-.175,.215,.14,.035),STEEL,limb,'metal');
    for(const x of [.47,.81])b.box([x,.175,.188],[.04,.255,.335],0x6b7271,limb,'metal');
    b.box([.64,.325,.186],[.145,.050,.145],0x606666,limb,'metal');
  }else if(a.prop==='ingot'){
    const angle=-.30,c=Math.cos(angle),s=Math.sin(angle);
    b.volume([-.32,.76,.35],[.29,1.26,.69],(x,y,z)=>{
      const xx=x*c+(y-1.0)*s,yy=-x*s+(y-1.0)*c,half=.20-.035*(yy/.145+.5);
      return Math.abs(yy)<.145&&Math.abs(xx)<half&&Math.abs(z-.51)<.125;
    },(x,y,z)=>({color:y>1.12?0xffde63:z>.60?0xf4c33a:0xe5ad25,surface:'metal'}),limb,'metal');
  }else if(a.prop==='clipboard'){
    b.volume([-.24,.62,.50],[.24,1.22,.585],(x,y,z)=>roundRect(x,y-.92,.235,.295,.025),0x89694a,limb,'wood');
    b.box([0,.942,.602],[.35,.395,.025],0xeee2bf,limb,'paper');
    for(let i=0;i<3;i++)b.box([-.018,1.055-i*.07,.625],[.19-(i%2)*.05,.018,.02],0x998f73,limb,'paper');
    b.volume([-.09,1.168,.575],[.09,1.282,.637],(x,y,z)=>Math.abs(x)>.037||y<1.206||y>1.254,STEEL,limb,'metal');
  }else if(a.prop==='tape'){
    b.volume([.45,.995,.31],[.80,1.345,.49],(x,y,z)=>{const r=Math.hypot(x-.625,y-1.17);return r<.175&&r>.082;},(x,y,z)=>({color:z>.455?CREAM:0xcbb685,surface:'paper'}),limb,'paper');
    b.box([.745,.665,.414],[.080,.96,.07],CREAM,limb,'paper');
    for(let i=0;i<9;i++)b.box([.762,.25+i*.075,.46],[.035,.015,.018],0x9f8658,limb,'paper');
    b.volume([.68,.035,.34],[.99,.29,.49],(x,y,z)=>{const r=Math.hypot(x-.835,y-.165);return r<.135&&r>.083&&!(x<.78&&y>.18);},CREAM,limb,'paper');
  }
}

export function buildCharacterParts(input){
  const a=normalizeAppearance(input),key=appearanceKey(a),cached=modelCache.get(key);
  if(cached){modelCache.delete(key);modelCache.set(key,cached);return cached;}
  const b=builder(),features=builder(CELL/3),body=color(a.bodyColor),face=color(a.faceColor),outfit=color(a.outfitColor);
  b.volume([-.5,.125,-.385],[.5,1.75,.385],(x,y,z)=>{
    const radius=radiusAt(y);return radius>0&&(x/radius)**2+(z/(radius*.77))**2<=1;
  },(x,y,z)=>{
    const front=depthAt(x,y),surface=z>=front-CELL*1.6;
    // The face is an in-place colour change of the existing hood surface. No
    // planar overlay can form a protruding rectangular face plate.
    if(roundRect(x,y-1.355,.286*a.faceSize,.177*a.faceSize,.067)&&z>0&&surface)return{color:face,surface:'skin'};
    if(a.outfit==='overalls'){
      if(y<.63||(Math.abs(x)<.23&&y<1.025&&surface))return outfit;
      if(Math.abs(x)>.205&&Math.abs(x)<.285&&y>.84&&y<1.27&&surface)return outfit;
    }
    if(a.outfit==='vest'&&surface&&Math.abs(x)>.205&&Math.abs(x)<.345&&y>.87&&y<1.22)return{color:(y>1.095&&y<1.145)||(y>.905&&y<.945)?0xc8c8b2:outfit,surface:'fabric'};
    return body;
  });
  eyesAndMouth(features,a);outfitDetails(b,a,outfit);headwear(b,a,color(a.hatColor));armsAndFeet(b,a,body,color(a.gloveColor),outfit);handProp(b,a);
  const parts=b.merge(a).concat(features.merge(a));
  for(const part of parts){if(a.prop==='hammer'&&part.limb==='accessory')part.p[0]*=-1;Object.freeze(part.p);Object.freeze(part.s);Object.freeze(part);}
  Object.freeze(parts);modelCache.set(key,parts);if(modelCache.size>CACHE_LIMIT)modelCache.delete(modelCache.keys().next().value);
  return parts;
}

export function characterRig(input){
  const a=normalizeAppearance(input),point=(x,y,z)=>[x*a.width,y*a.height,z*a.width];
  return{pivots:{leftArm:point(-.38,1.105,-.01),rightArm:point(.38,1.105,-.01),leftLeg:point(-.225,.225,.005),rightLeg:point(.225,.225,.005)},height:(a.hat==='hardhat'?1.975:a.hat==='cap'?1.85:1.75)*a.height};
}

// Keep a quiet, even micro-voxel finish on merged blocks in both the game and
// appearance preview. No THREE/DOM dependency is needed to install the hook.
export function styleCharacterMaterial(material){
  if(styledMaterials.has(material))return material;
  const previous=material.onBeforeCompile,previousKey=material.customProgramCacheKey?.bind(material);
  const baseKey=previousKey?.()||'';styledMaterials.add(material);
  material.userData??={};material.userData.characterVoxelStyle={cell:CELL,grain:.035};
  material.onBeforeCompile=function(shader,...args){
    previous?.call(this,shader,...args);
    shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 characterVoxelPosition;')
      .replace('#include <begin_vertex>',`#include <begin_vertex>
        characterVoxelPosition=position;
        #ifdef USE_INSTANCING
          characterVoxelPosition=(instanceMatrix*vec4(position,1.0)).xyz;
        #endif
      `);
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>
      varying vec3 characterVoxelPosition;
      float characterGrain(vec3 p){p=fract(p*.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);}
    `).replace('#include <color_fragment>',`#include <color_fragment>
      vec3 characterGrid=characterVoxelPosition/${CELL.toFixed(3)};
      vec3 characterFace=abs(normalize(cross(dFdx(characterVoxelPosition),dFdy(characterVoxelPosition))));
      vec2 characterUV=characterFace.z>characterFace.x&&characterFace.z>characterFace.y?characterGrid.xy:characterFace.y>characterFace.x?characterGrid.xz:characterGrid.zy;
      vec2 characterWidth=max(fwidth(characterUV),vec2(.0001));
      float characterDetail=1.0-smoothstep(.55,1.6,max(characterWidth.x,characterWidth.y));
      vec2 characterEdge=min(fract(characterUV),1.0-fract(characterUV));
      float characterSeam=1.0-smoothstep(.008,.035,min(characterEdge.x,characterEdge.y));
      float characterTone=floor(characterGrain(floor(characterGrid+.001))*5.0)/4.0;
      diffuseColor.rgb*=1.0+((characterTone-.5)*.035-characterSeam*.018)*characterDetail;
    `);
  };
  material.customProgramCacheKey=()=>`${baseKey}-rounded-character-v2-${CELL}`;
  material.needsUpdate=true;return material;
}
