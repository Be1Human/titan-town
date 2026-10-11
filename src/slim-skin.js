import * as T from '../vendor/three.module.js';
import {sampleSkin} from './skin-layout.js';
import {sourceSkinUV} from './skin-clothing.js';
export const SKIN_SIZE=512;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const tint=(hex,f)=>{const n=parseInt(hex.slice(1),16);return '#'+[n>>16,(n>>8)&255,n&255].map(v=>clamp(Math.round(v*f),0,255).toString(16).padStart(2,'0')).join('');};

// Inner skin atlas for the named body solids. Clothing uses its separate
// native 64x64 outer layer; nearest sampling and gutters keep base faces crisp.
export function createSlimSkin(a,boxes,shapes=boxes){
 const data=new Uint8Array(SKIN_SIZE*SKIN_SIZE*4),tiles=[];
 function put(x,y,color){const n=parseInt(color.slice(1),16),at=((SKIN_SIZE-1-y)*SKIN_SIZE+x)*4;data.set([n>>16,(n>>8)&255,n&255,255],at);}
 function pixel(name,face,x,y,w,h){
  const front=face===4,back=face===5,top=face===2,bottom=face===3;
  const patch=(Math.imul(Math.floor(x/2)+11,73856093)^Math.imul(Math.floor(y/3)+7,19349663)^Math.imul(face+name.length,83492791))>>>0;
  const speck=patch%9===0?-.018:patch%11===0?.016:0;
  let color=a.faceColor;
  if(name==='head'){
   x=Math.floor(x*32/w);y=Math.floor(y*32/h);w=h=32;
   let hair=a.hair!=='none';const fringe=a.hair==='short'?10:15;
   if(front){
    hair=hair&&(y<fringe||x<4&&y<h-3||x>=w-4&&y<h-4||x>=4&&x<10&&y<fringe+5||x>=10&&x<14&&y<fringe+2||x>=19&&x<25&&y<fringe+4||x>=25&&x<28&&y<fringe+8);
    if(hair&&front&&x>=15&&x<=18&&y>=13)hair=false;
    color=hair?a.hairColor:a.faceColor;
    const ey=clamp(Math.round(21*a.facePosition),18,24),ew=clamp(Math.round(7*a.eyeSize*a.faceSize),4,9),eh=clamp(Math.round(4*a.eyeSize),2,5),gap=Math.round(7*a.eyeSpacing);
    for(const cx of [w/2-gap,w/2+gap])if(y>=ey&&y<ey+eh&&Math.abs(x-cx)<ew/2)return x>=cx?tint(a.eyeColor,y===ey?.9:1.1):'#f8efdf';
    if(y===ey-1&&[w/2-gap,w/2+gap].some(cx=>Math.abs(x-cx)<ew/2))return tint(a.hairColor,.64);
    const my=h-3;
    if(a.expression==='surprised'&&y>=my-2&&y<=my&&x>=14&&x<=17)return '#654236';
    if(a.expression==='happy'&&y===my-1&&x>=12&&x<=19)return '#fff0da';
    if(a.expression==='happy'&&y===my&&x>=14&&x<=17)return '#b57c60';
    if(a.expression==='happy'&&y===my-2&&(x===11||x===20))return '#80533c';
    if(!['happy','surprised'].includes(a.expression)&&y===my-1&&x>=13&&x<=18)return '#80533c';
   }else if(top||back)color=hair?a.hairColor:a.faceColor;
   else if(bottom)color=a.faceColor;
   else{const nearFace=face===0?x<Math.ceil(w*.3):x>=Math.floor(w*.7);color=hair&&(!nearFace||y<fringe+2)?a.hairColor:a.faceColor;}
   if(a.hat!=='none'&&y<3)color=a.hatColor;
   if(hair&&color===a.hairColor){const lock=Math.floor(x/4),stripe=(lock*13+Math.floor(y/7)*7+face*3)%6;return tint(color,[.82,.93,1,1.08,1.15,.97][stripe]);}
   return color;
  }
  if(name==='spine'){
   color=a.bodyColor;
   if(a.outfit==='vest'){
    color='#f47929';if(top)color=a.bodyColor;
    else if(!bottom){
     if(front&&y<5&&x>=6&&x<=9)color=a.bodyColor;
     if(front&&y<2&&x>=7&&x<=8)color=a.faceColor;
     const stripe=y<10?3:4;
     if((front||back)&&y>=1&&y<h-4&&(x===stripe||x===stripe+1||x===w-stripe-2||x===w-stripe-1)||y===h-4||y===h-3)color='#e1dfc9';
     if(!front&&!back&&y<h-4)color='#ec7026';
    }
   }else if(a.outfit==='overalls'&&(y>h*.38||front&&(x<4||x>=w-4)))color=a.outfitColor;
   return tint(color,1+speck);
  }
  if(name.endsWith('Shoulder')){
   const sleeve=Math.round(h*.36),cuff=clamp(Math.round(7*a.gloveSize),4,10);
   if(top||y<sleeve)color=a.bodyColor;
   else if(bottom||y>=h-3)color='#343734';
   else if(y>=h-cuff)color=a.gloveColor==='#efb581'?'#d7d9ce':a.gloveColor;
   if(y>=sleeve-3&&y<sleeve)color=tint(a.bodyColor,y===sleeve-3?1.1:.95);
   if(front&&y>=h-5&&y<h-3&&(x===0||x===w-1))color='#343734';
   return tint(color,1+speck);
  }
  color=a.outfitColor;const boot=clamp(Math.round(9*a.bootSize),4,14);
  if(bottom||y>=h-boot)color=y>=h-2?'#925a29':'#77491f';
  if(!top&&!bottom&&y===h-boot)color='#965d2d';
  if(!top&&!bottom&&y===h-3)color='#aa6c31';
  if(y<2&&(face===0||face===1||front&&(name==='leftHip'&&x<2||name==='rightHip'&&x>=w-2)))color='#65462c';
  if(front&&y>=2&&y<h-boot&&(name==='leftHip'&&x===w-1||name==='rightHip'&&x===0))color=tint(color,.89);
  return tint(color,1+speck);
 }
 for(const [row,b]of boxes.entries()){
  const [w,h,d]=b.pixels,dimensions=[[d,h],[d,h],[w,d],[w,d],[w,h],[w,h]],faces=[];
  for(let face=0;face<6;face++){
   const [width,height]=dimensions[face],t={x:(row%3)*144+(face%3)*48+1,y:Math.floor(row/3)*96+Math.floor(face/3)*48+1,width,height,face,name:b.name};faces.push(t);
   for(let y=-1;y<=height;y++)for(let x=-1;x<=width;x++){
    const px=clamp(x,0,width-1),py=clamp(y,0,height-1),range=b.skinRange||[0,1];
    const mapping=sourceSkinUV(b,face,(px+.5)/width,(py+.5)/height),{name,u}=mapping;
    const side=face!==2&&face!==3,fullHeight=side?height/(range[1]-range[0]):height,sy=side?py+range[0]*fullHeight:py;
    const cutCap=b.skinRange&&(face===2&&range[0]>.0||face===3&&range[1]<1);
    const v=mapping.v;
    const color=a.skin!=='rookie'||a.customSkin?sampleSkin(name,cutCap?4:face,u,v,a.customSkin,'base'):pixel(name,cutCap?4:face,px,cutCap?v*40:sy,width,cutCap?40:fullHeight);
    put(t.x+x,t.y+y,color);
   }
  }tiles.push(faces);
 }
 // Compact network edit packets repaint texels instead of adding/deleting boxes.
 for(const [part,cx,cy,cz,paint]of a.voxelEdits){
  if(paint===null)continue;const owner=boxes.find(b=>b.part===part);if(!owner)continue;
  for(const b of shapes.filter(b=>b.part===part)){
  const cell=.025,p=[cx,cy,cz].map((n,i)=>owner.center[i]+(n+.5)*cell),lo=b.center.map((v,i)=>v-b.size[i]/2),hi=b.center.map((v,i)=>v+b.size[i]/2);
  if(p.some((v,i)=>v<lo[i]-cell/2||v>hi[i]+cell/2))continue;
  for(let face=0;face<6;face++){
   const axis=face<2?0:face<4?1:2;if(Math.abs(p[axis]-(face%2===0?hi[axis]:lo[axis]))>cell*1.01)continue;
   const uv=face===0?[(hi[2]-p[2])/b.size[2],(hi[1]-p[1])/b.size[1]]:face===1?[(p[2]-lo[2])/b.size[2],(hi[1]-p[1])/b.size[1]]:face===2?[(p[0]-lo[0])/b.size[0],(p[2]-lo[2])/b.size[2]]:face===3?[(p[0]-lo[0])/b.size[0],(hi[2]-p[2])/b.size[2]]:face===4?[(p[0]-lo[0])/b.size[0],(hi[1]-p[1])/b.size[1]]:[(hi[0]-p[0])/b.size[0],(hi[1]-p[1])/b.size[1]];
   const bounds=b.skinBounds||b,skinLo=bounds.center.map((v,i)=>v-bounds.size[i]/2),skinHi=bounds.center.map((v,i)=>v+bounds.size[i]/2),mappedFace=b.faceOverride??face;
   const projected=mappedFace===0?[(skinHi[2]-p[2])/bounds.size[2],(skinHi[1]-p[1])/bounds.size[1]]:mappedFace===1?[(p[2]-skinLo[2])/bounds.size[2],(skinHi[1]-p[1])/bounds.size[1]]:mappedFace===2?[(p[0]-skinLo[0])/bounds.size[0],(p[2]-skinLo[2])/bounds.size[2]]:mappedFace===3?[(p[0]-skinLo[0])/bounds.size[0],(skinHi[2]-p[2])/bounds.size[2]]:mappedFace===4?[(p[0]-skinLo[0])/bounds.size[0],(skinHi[1]-p[1])/bounds.size[1]]:[(skinHi[0]-p[0])/bounds.size[0],(skinHi[1]-p[1])/bounds.size[1]];
   uv[0]=clamp(projected[0],0,1);uv[1]=clamp(projected[1],0,b.detail==='fringe'?.40:1);
   const t=tiles[b.row??boxes.indexOf(b)][mappedFace],uAxis=mappedFace<2?2:0,vAxis=mappedFace<2||mappedFace>3?1:2,du=cell/bounds.size[uAxis]/2,dv=cell/bounds.size[vAxis]/2;
   // A sculpt-grid cell can span several skin texels. Paint its projected
   // footprint, so the clicked pixel is coloured even between grid centres.
   const x0=clamp(Math.floor((uv[0]-du)*t.width),0,t.width-1),x1=clamp(Math.ceil((uv[0]+du)*t.width)-1,0,t.width-1),y0=clamp(Math.floor((uv[1]-dv)*t.height),0,t.height-1),y1=clamp(Math.ceil((uv[1]+dv)*t.height)-1,0,t.height-1);
   for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)put(t.x+x,t.y+y,paint);
  }
  }
 }
 const texture=new T.DataTexture(data,SKIN_SIZE,SKIN_SIZE,T.RGBAFormat);texture.colorSpace=T.SRGBColorSpace;texture.magFilter=T.NearestFilter;texture.minFilter=T.NearestFilter;texture.generateMipmaps=false;texture.needsUpdate=true;texture.name='slim-worker-pixel-skin';
 function sample(u,v){const x=clamp(Math.floor(u*SKIN_SIZE),0,SKIN_SIZE-1),y=clamp(Math.floor(v*SKIN_SIZE),0,SKIN_SIZE-1),at=(y*SKIN_SIZE+x)*4;return '#'+[...data.slice(at,at+3)].map(n=>n.toString(16).padStart(2,'0')).join('');}
 return{texture,tiles,sample,data,width:SKIN_SIZE,height:SKIN_SIZE};
}
