import * as T from '../vendor/three.module.js';
import {normalizeAppearance,CHARACTER_CELL} from './character-config.js';
import {CREW_SPECS} from './crew-character-specs.js';
import {createRig,createSurfaceBuilder} from './sculpted-worker.js';
import {createCharacterVoxels} from './character-voxels.js';
import {createSlimWorker} from './slim-worker.js';

// The eight identities are authored as volumes from their front/side/back
// sheets. The edit grid is finer than the hairstyle's visible block steps.
const cache=new Map(),LIMIT=16;
const tint=(hex,f)=>'#'+new T.Color(hex).multiplyScalar(f).getHexString();
export function createCrewWorker(input){
 const a=normalizeAppearance(input),spec=CREW_SPECS.find(s=>s.id===a.template);
 if(!spec)throw new Error('Unknown crew character');
 if(spec.id==='crew-01')return createSlimWorker(a);
 const n=Number(spec.number),boot=.20*a.bootSize,hip=boot+.725*a.legLength,top=hip+.45*a.torsoHeight;
 const shoulderX=.1875*a.torsoWidth*a.shoulderWidth+.1375*a.armSize,sy=top-.05,ey=sy-.25*a.armLength,wy=sy-.45*a.armLength;
 const rig=createRig({hip,spine:hip+.225*a.torsoHeight,head:top+.225*a.headHeight,shoulder:[shoulderX,sy,0],elbow:[shoulderX,ey,0],wrist:[shoulderX,wy,0],legX:.1*a.torsoWidth,legTop:hip,knee:boot+.30*a.legLength,ankle:boot*.5});
 const key=JSON.stringify({...a,width:1,height:1});let resource=cache.get(key);
 if(resource){cache.delete(key);cache.set(key,resource);}
 const b=resource?null:createCharacterVoxels(rig);
 // All boxes start on the same .025 lattice, including joint boundaries.
 if(b)for(const part of b.parts)part.origin=part.origin.map(v=>Math.round(v/CHARACTER_CELL)*CHARACTER_CELL);
 const shirt=a.bodyColor,pants=a.outfitColor,hair=a.hairColor,skin=a.faceColor,hand=a.gloveColor,dark='#272a28',ivory='#f0e8d5';
 function box(p,s,c,part='spine'){
  let q=[...p],d=[...s];
  if(part==='head'){
   q=[p[0]*a.headWidth,top+(p[1]-1.375)*a.headHeight,p[2]*Math.sqrt(a.headWidth)];d=[s[0]*a.headWidth,s[1]*a.headHeight,s[2]*Math.sqrt(a.headWidth)];
  }else if(/Shoulder|Elbow|Wrist/.test(part)){
   const sign=part.startsWith('left')?-1:1,glove=part.endsWith('Wrist')?a.gloveSize:1;
   q=[sign*shoulderX+(p[0]-sign*.325)*a.armSize,sy+(p[1]-1.325)*a.armLength,p[2]*a.armSize];d=[s[0]*a.armSize*glove,s[1]*(part.endsWith('Wrist')?glove:a.armLength),s[2]*a.armSize*glove];
  }else if(part.endsWith('Foot')){
   const sign=part.startsWith('left')?-1:1;q=[sign*.1*a.torsoWidth+(p[0]-sign*.1)*a.bootSize,p[1]*a.bootSize,p[2]*a.bootSize];d=s.map(v=>v*a.bootSize);
  }else if(/Hip|Knee/.test(part)){
   const sign=part.startsWith('left')?-1:1;q=[sign*.1*a.torsoWidth+(p[0]-sign*.1)*a.legWidth,boot+(p[1]-.2)*a.legLength,p[2]];d=[s[0]*a.legWidth,s[1]*a.legLength,s[2]];
  }else{q=[p[0]*a.torsoWidth,hip+(p[1]-.925)*a.torsoHeight,p[2]*a.torsoDepth];d=[s[0]*a.torsoWidth,s[1]*a.torsoHeight,s[2]*a.torsoDepth];}
  b.box(q,d,c,part);
 }
 const H=(x,y,z,w,h,d,f=1)=>{if(a.hair==='short'&&(y<1.65||y>2.03))return;box([x,y-(![2,7].includes(n)&&z>=.175&&y>1.65&&y<1.95?.075:0),z],[w,h,d],tint(hair,f),'head');};
 const C=(x,y,z,w,h,d,c=shirt)=>box([x,y,z],[w,h,d],c);
 if(b){
  // Long separated legs, short rectangular torso, broad chin on shoulders.
  C(0,1.1375,0,.375,.475,.275,shirt);
  C(0,.95,0,.375,.125,.275,pants);
  for(const sign of [-1,1]){
   const side=sign<0?'left':'right',x=sign*.1;
   box([x,.7125,0],[.15,.45,.225],pants,side+'Hip');
   box([x,.35,0],[.15,.30,.225],pants,side+'Knee');
   box([x,.1125,.025],[.175,.225,.30],spec.boot,side+'Foot');
   box([x,.075,.075],[.175,.15,.30],tint(spec.boot,.88),side+'Foot');
   const short=[1,6].includes(n),rolled=[2,3,4,7,8].includes(n);
   box([sign*.325,1.20,0],[.15,.25,.225],shirt,side+'Shoulder');
   box([sign*.325,.975,0],[.15,.20,.20],short?skin:shirt,side+'Elbow');
   if(rolled)box([sign*.325,.975,0],[.175,.075,.25],tint(shirt,1.12),side+'Elbow');
   const handPaint=hand==='#efb581'?(n===1?(sign<0?dark:ivory):n===5?spec.boot:hand):hand;
   box([sign*.325,.825,.025],[.15,.15,.225],handPaint,side+'Wrist');
   if([1,5,6].includes(n))box([sign*.325,.8375,.025],[.175,.075,.25],n===1?(sign<0?dark:'#d9d7c8'):n===5?spec.boot:'#4c4235',side+'Wrist');
   if([2,6,8].includes(n))box([x,.2625,0],[.175,.075,.25],tint(pants,1.28),side+'Knee');
  }
  // Costume structure is identity-specific, rather than a colour swap.
  if(a.outfit==='vest'){
   C(0,1.1375,.1575,.375,.475,.05,'#ed711d');C(0,1.1375,-.1575,.375,.475,.05,'#ed711d');
   C(0,1.0125,0,.40,.075,.35,'#d6d8c9');
   for(const sign of [-1,1])for(let j=0;j<4;j++){
    const x=sign*(.1+j*.0125),y=1.10+j*.0625;
    C(x,y,.2,.0625,.075,.025,'#dddcc9');C(x,y,-.2,.0625,.075,.025,'#dddcc9');
   }
   C(0,1.3375,.20,.125,.075,.05,shirt);C(0,1.35,.225,.075,.075,.025,skin);
   C(-.15,.925,.15,.075,.075,.025,'#5c432b');C(.15,.925,.15,.075,.075,.025,'#5c432b');
  }else if(a.outfit==='overalls'){
   C(0,1.075,.15,.375,.25,.05,pants);C(0,1.075,-.15,.375,.25,.05,pants);
   for(const sign of [-1,1]){
    C(sign*.125,1.2375,.175,.075,.275,.05,tint(pants,.94));C(sign*.125,1.2375,-.175,.075,.275,.05,tint(pants,.94));
    C(sign*.125,1.175,.2125,.075,.075,.025,n===2?'#bd9b63':ivory);
   }
   C(0,1.0625,.20,.20,.125,.025,tint(pants,1.10));C(0,1.0875,-.20,.2,.125,.025,tint(pants,1.1));
   C(0,.9375,0,.4,.075,.35,n===2?tint(pants,.9):'#55422f');
   if(n===6)C(0,.9375,.20,.1,.075,.025,'#a7aba4');
   C(0,1.35,.15,.125,.075,.05,skin);
   if(n===5){
    for(const y of [1.0375,.9625,.9])box([.325,y,0],[.20,.05,.25],ivory,'rightElbow');
    for(const y of [.225,.35,.475])box([-.1,y,0],[.20,.05,.275],ivory,'leftKnee');
    for(let j=0;j<3;j++)box([-.15+j*.05,.2875+j*.05,.1375],[.075,.05,.025],ivory,'leftKnee');
   }
  }else if([3,8].includes(n)&&a.outfit==='satchel'){
   C(0,1.1375,.15,.125,.425,.025,'#343734');
   for(const sign of [-1,1]){
    C(sign*.1375,1.1375,.175,.10,.425,.075,shirt);
    C(sign*.1375,1.2875,.225,.075,.10,.025,tint(shirt,1.08));
    C(sign*.1375,1.1375,.225,.075,.075,.025,tint(shirt,1.13));
    C(sign*.1375,.95,.20,.15,.075,.05,tint(shirt,.98));
   }
  }else{
   C(0,1.15,.1625,.05,.375,.025,tint(shirt,.94));
   for(const sign of [-1,1]){
    C(sign*.10,1.3125,.175,.10,.075,.05,tint(shirt,.9));
    C(sign*.125,1.0875,.175,.075,.075,.05,tint(shirt,.86));
   }
   for(const y of [1.05,1.15,1.25])C(0,y,.1875,.025,.025,.025,tint(shirt,.8));
   C(0,1.35,.175,.1,.075,.05,skin);C(0,.925,0,.4,.075,.325,n===7?'#30322e':'#7d5125');
   C(0,.925,.1875,.10,.075,.025,n===7?'#c2c2b7':'#bc812d');
  }
  // Face is part of the volume, not a badge. A broad jaw meets the torso.
  box([0,1.575,0],[.525,.4,.375],skin,'head');
  box([0,1.525,.1875],[.475,.3,.1],skin,'head');
  for(const sign of [-1,1])box([sign*.2875,1.575,.05],[.075,.125,.15],tint(skin,.91),'head');
  const faceY=1.375+(1.5375-1.375)*a.facePosition,wide=.1875*a.eyeSize*a.faceSize,eh=(n===3?.075:.10)*a.eyeSize*a.faceSize;
  for(const sign of [-1,1]){
   const x=sign*.1375*a.eyeSpacing*a.faceSize;
   box([x,faceY,.25],[wide,eh,.05],ivory,'head');
   box([x-sign*.025,faceY,.2875],[wide*.50,eh,.025],a.eyeColor,'head');
   box([x,faceY+eh*.5+.0125,.275],[wide,.025,.05],dark,'head');
   if(n===7)box([x,faceY,.3125],[.025,.025,.025],dark,'head');
  }
  box([0,1.50,.275],[.075,.075,.10],tint(skin,.96),'head');
  const smile=a.expression==='happy',worried=a.expression==='worried',angry=a.expression==='angry',surprised=a.expression==='surprised';
  if(smile){
   box([0,1.425,.275],[n===5?.15:.15,.05,.05],n===5?'#8b3b30':'#ba7f52','head');
   box([0,1.4375,.3125],[.15,.025,.025],ivory,'head');
   if(n!==5)box([0,1.4125,.2875],[.1,.025,.025],ivory,'head');
  }else if(surprised)box([0,1.425,.275],[.05,.075,.025],'#664638','head');
  else{
   box([0,1.4375,.275],[.075,.025,.025],'#966440','head');
   if(worried||angry||n===3)for(const sign of [-1,1])box([sign*.05,1.4125,.275],[.025,.025,.025],'#966440','head');
  }
  if(worried||angry)for(const sign of [-1,1]){
   for(let j=0;j<3;j++)box([sign*(.0875+j*.025),1.6375+(angry?1:-1)*j*.0125,.275],[.025,.025,.025],dark,'head');
  }
  // Different back volumes, forelocks and side strands for all eight heads.
  if(a.hair!=='none'){
   H(0,1.825,-.025,.60,.30,.425,.98);H(0,1.6375,-.1875,.55,.275,.15,.94);
   for(const sign of [-1,1]){H(sign*.275,1.75,0,.10,.25,.35,.96);H(sign*.275,1.55,-.075,.10,.20,.225,.94);}
   if(n===1){
    H(.0375,2.0375,.025,.225,.225,.325,1.03);H(0,1.8875,.175,.375,.225,.125);
    H(-.15,1.8375,.225,.15,.225,.15,.97);H(.175,1.80,.225,.15,.175,.15,.96);
    H(-.275,1.9375,0,.15,.125,.30,.93);H(-.35,1.8625,.025,.15,.075,.275,.92);
    H(-.35,1.775,.05,.125,.075,.25,.9);H(.225,1.925,-.05,.15,.20,.30,.98);
    H(0,1.925,-.275,.25,.15,.10);H(.1,1.775,-.275,.325,.15,.10,.95);H(0,1.55,-.275,.325,.125,.1,.94);
   }else if(n===2){
    H(0,1.925,.15,.35,.10,.20,1.08);H(0,1.8375,.25,.30,.10,.15,1.05);
    H(0,1.75,.275,.375,.125,.1);H(-.175,1.6875,.25,.1,.175,.125);H(.2,1.70,.2,.1,.175,.15);
    for(const sign of [-1,1]){
     H(sign*.325,2.0,-.025,.25,.175,.225);H(sign*.3625,1.9375,0,.225,.20,.30,1.06);
     H(sign*.325,2.1,-.05,.15,.10,.15,1.12);H(sign*.4125,1.85,-.025,.15,.1,.225,.92);
     H(sign*.25,1.50,.20,.075,.275,.10,.97);
    }
    H(0,1.875,-.2875,.30,.175,.10,1.03);H(0,1.7,-.2875,.35,.175,.10,.97);H(0,1.5,-.225,.25,.15,.125,.92);
   }else if(n===3){
    H(0,2.0625,-.025,.125,.225,.225,1.13);H(.10,1.9625,.1,.125,.225,.25,1.07);
    H(0,1.875,.25,.25,.125,.15);H(-.175,1.825,.225,.15,.20,.15,.95);H(.175,1.75,.225,.15,.15,.15,1.02);
    for(const sign of [-1,1]){
     H(sign*.25,1.9375,-.025,.15,.20,.275,1.08);H(sign*.325,1.8375,.0,.125,.175,.25,.97);
     H(sign*.35,1.75,-.025,.15,.10,.175);H(sign*.25,1.5375,.225,.075,.30,.10,.96);
    }
    H(0,1.8875,-.2875,.3,.15,.1,1.04);H(0,1.7375,-.3,.20,.175,.125);H(.05,1.55,-.2625,.225,.175,.125,.93);
   }else if(n===4){
    H(-.075,2.0625,.075,.25,.225,.30,1.08);H(0,1.975,.2,.25,.225,.20,1.08);
    H(-.125,1.8375,.25,.20,.225,.15);H(-.20,1.725,.275,.20,.225,.15,1.03);
    H(-.3,1.6875,.175,.175,.075,.20);H(.2125,1.875,.125,.15,.225,.225,1.04);
    H(.275,1.725,.175,.10,.125,.15);H(.275,1.50,.20,.075,.225,.10,.99);
    H(-.25,1.9375,-.1,.15,.175,.25);H(.275,1.825,-.125,.15,.15,.275,.96);
    H(0,1.925,-.2875,.25,.15,.125,1.06);H(0,1.775,-.3,.375,.175,.10);H(.025,1.575,-.2625,.30,.225,.125,.93);
   }else if(n===5){
    H(0,2.0,-.025,.25,.10,.30,1.08);H(0,1.925,.20,.225,.15,.175,1.05);
    H(0,1.8375,.275,.25,.125,.125);H(.0375,1.7375,.2875,.125,.175,.125,.99);
    for(const sign of [-1,1]){
     H(sign*.225,1.9375,0,.15,.125,.35);H(sign*.3,1.825,.05,.15,.15,.325,.97);
     H(sign*.325,1.7375,.075,.125,.15,.30);H(sign*.25,1.55,.175,.1,.20,.175,.94);
    }
    H(0,1.85,-.2875,.35,.15,.125,1.06);H(0,1.675,-.3,.35,.175,.10,.95);H(0,1.5375,-.225,.3,.15,.125,.92);
   }else if(n===6){
    H(.025,2.05,.025,.25,.125,.30,1.10);H(-.1375,1.9875,0,.15,.125,.325,1.04);
    H(.05,1.8375,.25,.125,.20,.125);H(-.15,1.7875,.25,.15,.175,.125,1.02);H(.2,1.7375,.225,.10,.175,.15,.98);
    for(const sign of [-1,1]){H(sign*.325,1.925,.025,.15,.10,.25);H(sign*.325,1.8,.05,.125,.175,.275,1.05);H(sign*.25,1.55,.15,.10,.225,.225,.93);}
    H(.05,1.925,-.2875,.25,.125,.125,1.08);H(-.025,1.725,-.2875,.2,.275,.125);H(0,1.5,-.225,.2,.10,.175,.92);
   }else if(n===7){
    H(0,1.9625,0,.30,.125,.325,1.03);H(0,1.825,.225,.4,.225,.125);
    H(-.275,1.675,.225,.10,.325,.125,.96);H(.275,1.75,.175,.10,.25,.175,.97);
    H(-.325,1.7375,-.025,.10,.275,.35,.93);H(.325,1.7125,0,.10,.225,.325,.95);
    H(0,1.775,-.2875,.35,.225,.125,.97);H(0,1.55,-.225,.35,.15,.15,.95);
   }else{
    H(-.075,2.025,.075,.225,.175,.30,1.08);H(.0875,1.9875,0,.225,.175,.325,1.03);
    H(0,1.875,.225,.35,.225,.15,1.02);H(-.175,1.75,.25,.15,.20,.15);H(.2,1.80,.225,.15,.175,.15,.96);
    for(const sign of [-1,1]){
     H(sign*.275,1.65,.225,.075,.45,.125);H(sign*.3125,1.475,.075,.10,.40,.20,.97);
     H(sign*.275,1.225,-.075,.075,.275,.225,.93);H(sign*.25,1.3625,.15,.075,.225,.15,1.03);
     H(sign*.3125,1.825,-.025,.10,.225,.35,.97);
    }
    H(0,1.8625,-.3,.275,.225,.125,1.04);H(0,1.6,-.3125,.35,.35,.125);
    H(0,1.30,-.2625,.20,.30,.125,.94);H(.225,1.3875,-.2125,.125,.325,.125,.92);
   }
  }
  // Worn signature equipment is skinned with the head/torso, not floating.
  if(n===6){
   const frame='#9d9f9b',lens='#383f3d';
   box([0,1.9,.20],[.65,.075,.075],dark,'head');box([0,1.9,-.275],[.65,.075,.05],dark,'head');
   for(const sign of [-1,1]){
    box([sign*.3,1.9,-.025],[.075,.075,.55],dark,'head');
    box([sign*.16,1.9,.3125],[.225,.225,.075],frame,'head');box([sign*.16,1.9,.3625],[.15,.125,.05],lens,'head');
    box([sign*.16,1.8625,.3875],[.125,.025,.025],'#555c59','head');
   }
  }
  if(n===7){
   // Pixel-stepped tilted lid: each slice rises toward the image-left edge.
   for(let j=0;j<8;j++)box([-.2625+j*.075,2.10-j*.025,-.0125],[.075,.05,.55],a.hatColor,'head');
   for(let j=0;j<6;j++)box([-.1875+j*.075,2.1375-j*.025,-.0125],[.075,.05,.40],tint(a.hatColor,.93),'head');
   box([.025,2.175,0],[.15,.075,.1],tint(a.hatColor,.90),'head');
  }
  if(n===8||a.outfit==='satchel'&&n!==3){
   for(let j=0;j<11;j++)for(const z of [.225,-.2])C(.1875-j*.0375,1.35-j*.0375,z,.075,.075,.05,'#3c3b31');
   C(-.225,.825,.075,.15,.25,.175,'#83572f');C(-.225,.9375,.075,.175,.075,.2,'#936234');
   C(-.225,.8625,.1875,.05,.075,.025,'#ae7b40');
  }
  if(a.hat!=='none'){
   const y=2.10,w=.725*a.hatWidth;
   box([0,y,0],[w,.05,.575],a.hatColor,'head');box([0,y+.1,0],[w*.75,.175*a.hatHeight,.45],a.hatColor,'head');
  }
  b.apply(a.voxelEdits);resource={parts:b.parts,geometry:b.finish(),references:0,retained:true};cache.set(key,resource);
  if(cache.size>LIMIT){const oldest=cache.keys().next().value,old=cache.get(oldest);cache.delete(oldest);old.retained=false;if(!old.references)old.geometry.dispose();}
 }
 resource.references++;
 const material=new T.MeshStandardMaterial({vertexColors:true,roughness:1}),mesh=new T.SkinnedMesh(resource.geometry,material),group=new T.Group();mesh.name=spec.id;mesh.castShadow=true;mesh.receiveShadow=true;mesh.frustumCulled=false;mesh.add(rig.bones.root);group.add(mesh);group.updateMatrixWorld(true);
 const skeleton=new T.Skeleton(rig.list);mesh.bind(skeleton);
 const attachments={};for(const side of ['left','right']){const g=new T.Group();g.position.set(0,-.0375,.0625);rig.bones[side+'Wrist'].add(g);attachments[side+'Hand']=g;}
 const props=[],sig=a.prop==='signature';
 function propMesh(side,build){const pb=createSurfaceBuilder(rig);const P=(x,y,z,w,h,d,c,angle=0)=>pb.box([x,y,z],[w,h,d],new T.Color(c),rig.skin('root'),[0,0,angle]);build(P);const p=new T.Mesh(pb.finish(),material);p.castShadow=true;p.userData.hand=side;attachments[side+'Hand'].add(p);props.push(p);return p;}
 const driver=P=>{P(0,-.10,.025,.075,.175,.075,'#b94625');P(0,-.265,.025,.025,.20,.025,'#acb1b0');P(0,-.365,.025,.05,.05,.025,'#b8bcba');};
 const parcel=P=>{P(0,-.04,.10,.275,.275,.225,'#b38b52');P(0,.07,.105,.3,.05,.25,'#c9a166');P(0,-.035,.23,.275,.025,.025,'#977244');P(0,.00,.24,.075,.05,.025,'#79562f');P(-.09,-.065,.24,.025,.175,.025,'#be965b');};
 let propSide='left';
 if(sig&&n===1)propMesh('left',P=>{
  P(0,.025,.10,.15,.15,.10,'#dcaf25');P(0,.025,.1675,.075,.075,.025,dark);P(0,.1125,.10,.075,.025,.075,dark);P(-.0625,-.075,.10,.025,.075,.075,dark);
  P(-.025,-.175,.105,.025,.225,.025,'#e4c63a');P(-.0625,-.30,.105,.10,.025,.025,'#e4c63a',-.7);P(-.0625,-.3625,.105,.1,.025,.025,'#e4c63a',.7);P(-.0875,-.425,.105,.075,.025,.025,'#e4c63a',-.7);P(-.1125,-.45,.105,.05,.05,.05,'#464643');
 });
 else if(sig&&n===2){propMesh('left',parcel);propMesh('right',parcel);}
 else if(sig&&n===3){propSide='right';propMesh('right',P=>{
  P(0,-.025,.125,.125,.175,.125,'#dedfd9');P(0,.0625,.125,.10,.025,.1,'#725033');P(-.1,-.025,.125,.025,.10,.025,'#e9e9df');P(-.075,.025,.125,.05,.025,.025,'#e9e9df');P(-.075,-.075,.125,.05,.025,.025,'#e9e9df');
  for(const [x,y,z,s]of [[-.025,.125,.15,.04],[.025,.20,.125,.05],[.075,.2625,.125,.04]])P(x,y,z,s,s,s,'#744725');
 });propMesh('left',driver);}
 else if(sig&&n===4)propMesh('left',P=>{P(.20,.025,.1,.425,.325,.05,'#afa17d');P(.20,.025,.1375,.025,.325,.025,'#9b9071');P(.225,.20,.10,.075,.05,.075,'#373a38');P(.05,.125,.15,.075,.025,.025,'#726d5b');});
 else if(sig&&n===5)propMesh('left',P=>{
  const original=P;P=(x,y,z,...args)=>original(x,y+.175,z,...args);
  // A square-stepped ring has a real empty centre, including the side view.
  for(const [x,y,w,h]of [[0,.1125,.15,.075],[0,-.1125,.15,.075],[-.1125,0,.075,.15],[.1125,0,.075,.15],[-.075,.075,.075,.075],[.075,.075,.075,.075],[-.075,-.075,.075,.075],[.075,-.075,.075,.075]])P(x,y,.1,w,h,.075,'#e3d1a5');
  P(-.1,-.20,.1,.05,.15,.025,'#ebdfba');P(-.15,-.275,.1,.1,.05,.025,'#ebdfba');P(-.1875,-.3125,.1,.075,.10,.025,'#ebdfba');
 });
 else if(sig&&n===6)propMesh('left',P=>{
  // Tool spans both hands; open jaws remain holes, not a grey rectangle.
  const angle=.28,rotate=(x,y)=>[x*Math.cos(angle)-y*Math.sin(angle),x*Math.sin(angle)+y*Math.cos(angle)];
  const B=(x,y,w,h,c)=>{const p=rotate(x,y);P(p[0],p[1],.1,w,h,.075,c,angle);};
  B(.20,0,.60,.075,'#aaaead');B(.20,.025,.55,.025,'#b9bdbb');
  for(const [x,s]of [[-.15,-1],[.55,1]]){B(x,0,.1,.225,'#a3a8a6');B(x+s*.0875,.10,.175,.075,'#b2b7b4');B(x+s*.0875,-.10,.175,.075,'#a4aaa7');}
 });
 else if(sig&&n===7)propMesh('left',P=>{
  P(0,-.265,.05,.225,.225,.225,'#b93929');P(0,-.365,.05,.225,.025,.225,'#ab3227');
  for(const z of [-.075,.175])P(0,-.1375,z,.25,.05,.025,'#cd4230');for(const x of [-.125,.125])P(x,-.1375,.05,.025,.05,.225,'#cf4431');
  for(const x of [-.10,.10])P(x,-.05,.05,.025,.20,.025,dark);P(0,.05,.05,.2,.025,.025,dark);
 });
 else if(sig&&n===8)propMesh('left',P=>{
  P(.025,.0125,.10,.125,.125,.125,dark);P(.025,.0125,.175,.1,.1,.025,'#dbc343');P(.025,.0125,.195,.075,.075,.025,'#fff3bd');P(.025,-.10,.08,.05,.15,.075,dark);P(.025,-.10,.125,.025,.05,.025,'#d9b729');
 });
 else if(a.prop==='ingot')propMesh('left',P=>P(0,0,.1,.24,.11,.13,'#d6ad36'));
 else if(a.prop==='clipboard')propMesh('left',P=>{P(0,0,.05,.22,.29,.03,'#705133');P(0,0,.075,.18,.24,.01,'#e5ddbf');});
 else if(a.prop==='tape')propMesh('left',P=>{P(0,0,.05,.11,.09,.07,a.hatColor);P(0,-.1,.05,.025,.18,.01,'#c5bc8e');});
 else propMesh('left',P=>{P(0,-.03,0,.04,.4,.04,'#8d653b');P(0,-.20,0,.24,.13,.13,'#515659');});
 const prop=props[0],rest=rig.list.map(b=>b.position.clone());
 function animate(time=0,amount=0){const t=Number.isFinite(time)?time:0,k=T.MathUtils.clamp(Number.isFinite(amount)?amount:0,0,1);rig.list.forEach((bone,i)=>{bone.rotation.set(0,0,0);bone.position.copy(rest[i]);});
  for(const sign of [-1,1]){const side=sign<0?'left':'right',v=Math.sin(t*3.7)*sign*k;rig.bones[side+'Hip'].rotation.x=v*.6;rig.bones[side+'Knee'].rotation.x=Math.max(0,-v)*.85;rig.bones[side+'Foot'].rotation.x=-Math.max(0,-v)*.25;rig.bones[side+'Shoulder'].rotation.x=-v*.55;rig.bones[side+'Elbow'].rotation.x=-Math.abs(v)*.35;}
  rig.bones.spine.rotation.z=Math.sin(t*3.7)*k*.025;
 }
 function signaturePose(action='signature'){
  const B=rig.bones;
  B.leftShoulder.rotation.z=-.32;B.rightShoulder.rotation.z=.32;
  if(!sig)return;
  if(n===1&&action==='signature'||n===5){B.leftShoulder.rotation.z=-.65;B.leftElbow.rotation.z=-2.30;B.leftShoulder.rotation.x=-.12;B.rightShoulder.rotation.z=.60;B.rightElbow.rotation.z=-1.35;}
  else if(n===2){B.leftShoulder.rotation.x=-.45;B.rightShoulder.rotation.x=-.5;B.leftElbow.rotation.x=-.35;B.rightElbow.rotation.x=-.30;}
  else if(n===3){B.rightShoulder.rotation.x=-.75;B.rightElbow.rotation.x=-.75;}
  else if(n===4||n===6){B.leftShoulder.rotation.z=-.2;B.rightShoulder.rotation.z=.2;B.leftShoulder.rotation.x=-.3;B.rightShoulder.rotation.x=-.3;B.leftElbow.rotation.x=-1.1;B.rightElbow.rotation.x=-1.1;B.leftElbow.rotation.z=.4;B.rightElbow.rotation.z=-.4;}
  else if(n===7){B.leftShoulder.rotation.z=-.10;if(action==='signature')B.rightShoulder.rotation.z=Math.PI/2;}
  else if(n===8){B.leftShoulder.rotation.x=-.35;B.leftElbow.rotation.x=-1.8;B.leftShoulder.rotation.z=-.15;B.leftElbow.rotation.z=.8;if(action==='signature'){B.rightShoulder.rotation.x=-.35;B.rightElbow.rotation.x=-1.8;B.rightShoulder.rotation.z=.15;B.rightElbow.rotation.z=-.8;}B.head.rotation.z=-.04;}
 }
 function alignProps(action){
  if(!sig)return;group.updateMatrixWorld(true);
  // Tools retain their upright orientation while wrists bend. Their actual
  // anchor is a hand (or the midpoint between two hands), never the head.
  for(const p of props){p.position.set(0,0,0);p.quaternion.identity();
   if(!['signature','apose'].includes(action))continue;
   p.quaternion.copy(p.parent.getWorldQuaternion(new T.Quaternion()).invert().multiply(group.getWorldQuaternion(new T.Quaternion())));
   if(n===4||n===6){
    const l=attachments.leftHand.getWorldPosition(new T.Vector3()),r=attachments.rightHand.getWorldPosition(new T.Vector3());
    const target=l.add(r).multiplyScalar(.5);target.add(group.localToWorld(new T.Vector3(-.20,0,.035)).sub(group.getWorldPosition(new T.Vector3())));
    p.position.copy(p.parent.worldToLocal(target));
   }
  }
 }
 function setPropsVisible(visible){for(const p of props)p.visible=!!visible&&a.prop!=='none';}
 setPropsVisible(true);animate();group.updateMatrixWorld(true);skeleton.update();
 let disposed=false;
 const metrics={variant:'block',template:a.template,cellSize:CHARACTER_CELL,sourceVoxelSize:.075,cells:resource.parts.reduce((sum,p)=>sum+p.cells.size,0),triangles:resource.geometry.index.count/3,vertices:resource.geometry.attributes.position.count,propTriangles:props.reduce((s,p)=>s+p.geometry.index.count/3,0),drawCalls:1+(a.prop==='none'?0:props.length),bones:16,skinned:true};
 return{group,mesh,prop,extraProps:props.slice(1),bones:rig.bones,skeleton,attachments,propSide,propAttachment:attachments[propSide+'Hand'],metrics,parts:resource.parts,rigPoints:rig.points,animate,signaturePose,alignProps,setPropsVisible,
  dispose(){if(disposed)return;disposed=true;resource.references--;if(!resource.references&&!resource.retained)resource.geometry.dispose();for(const p of props){p.geometry.dispose();p.removeFromParent();}material.dispose();skeleton.dispose();group.removeFromParent();}};
}
