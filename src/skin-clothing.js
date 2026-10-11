import * as T from '../vendor/three.module.js';
import {jawPoint,jawNormal} from './soft-jaw-geometry.js';
import {skinPixels,skinSlim,skinFace} from './skin-layout.js';

export const CLOTHING_THICKNESS=.012;
export function sourceSkinUV(box,face,u,v){
 let name=box.skinName||box.name;
 const range=box.skinRange||[0,1];
 if(box.role==='pelvis'){
  if(face<2)name=face===0?'rightHip':'leftHip';
  else{name=(u<.5)!==(face===5)?'leftHip':'rightHip';u=(u*2)%1;}
 }
 const cut=box.skinRange&&(face===2&&range[0]>0||face===3&&range[1]<1);
 // The exposed underside of a wide hip bridge belongs to its waist row,
 // not the first bare-thigh row below it. Keep all other joint caps unchanged.
 const end=box.role==='pelvis'?range[1]-1e-7:range[1];
 return {name,face:cut?4:face,u,v:face===2||face===3?(cut?(face===2?range[0]:end):v):range[0]+v*(range[1]-range[0])};
}

// A single batched, closed shell. Transparent source texels create no solid;
// hole boundaries have side walls rather than a transparent inflated cube.
export function createSkinClothing(a,boxes,boneIndex){
 const rgba=a.skin==='rookie'&&!a.customSkin?new Uint8ClampedArray(16384):skinPixels(a.customSkin);
 const data=new Uint8Array(16384);for(let y=0;y<64;y++)data.set(rgba.subarray(y*256,(y+1)*256),(63-y)*256);
 const texture=new T.DataTexture(data,64,64,T.RGBAFormat);texture.colorSpace=T.SRGBColorSpace;texture.magFilter=texture.minFilter=T.NearestFilter;texture.generateMipmaps=false;texture.needsUpdate=true;
 const pos=[],normals=[],uv=[],indices=[],skinIndex=[],weight=[],tags=[],ranges=[];let texels=0;
 const slim=skinSlim(a.customSkin);
 function quad(points,normal,coords,b){
  const n=new T.Vector3(...points[1]).sub(new T.Vector3(...points[0])).cross(new T.Vector3(...points[2]).sub(new T.Vector3(...points[0])));
  if(n.dot(new T.Vector3(...normal))<0){points=[...points].reverse();coords=[...coords].reverse();}
  const at=pos.length/3;for(let i=0;i<4;i++){pos.push(...jawPoint(points[i],b));normals.push(...jawNormal(points[i],normal,b));uv.push(...coords[i]);skinIndex.push(boneIndex[b.bone||b.name],0,0,0);weight.push(1,0,0,0);tags.push(b.part);}indices.push(at,at+1,at+2,at,at+2,at+3);
 }
 function point(b,face,u,v,t){
  const [w,h,d]=b.size.map(n=>n+2*t),p=[
   [w/2,h/2-v*h,d/2-u*d],[-w/2,h/2-v*h,-d/2+u*d],
   [-w/2+u*w,h/2,-d/2+v*d],[-w/2+u*w,-h/2,d/2-v*d],
   [-w/2+u*w,h/2-v*h,d/2],[w/2-u*w,h/2-v*h,-d/2],
  ][face];return p.map((n,i)=>n+b.center[i]);
 }
 for(const b of boxes){const start=pos.length/3;
  for(let face=0;face<6;face++){
   const range=b.skinRange||[0,1];
   // Internal elbow/knee/waist caps are not clothing surfaces.
   if(b.skinRange&&(face===2&&range[0]>0||face===3&&range[1]<1))continue;
   const mapping=sourceSkinUV(b,face,.5,.5),rect=skinFace(mapping.name,face,slim,true);
   const cols=b.role==='pelvis'&&face>1?rect[2]*2:rect[2],rows=Math.max(1,Math.round(rect[3]*(face<2||face>3?range[1]-range[0]:1))),mask=[],pixels=[];
   for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){
    const s=sourceSkinUV(b,face,(x+.5)/cols,(y+.5)/rows),[rx,ry,rw,rh]=skinFace(s.name,s.face,slim,true),px=rx+Math.min(rw-1,Math.floor(s.u*rw)),py=ry+Math.min(rh-1,Math.floor(s.v*rh));
    pixels.push([(px+.5)/64,1-(py+.5)/64]);mask.push(rgba[(py*64+px)*4+3]>0);
   }
   const axis=face<2?0:face<4?1:2,sign=face%2===0?1:-1,n=[0,0,0];n[axis]=sign;
   const t=b.outerThickness??(b.name==='head'?.016:CLOTHING_THICKNESS);
   for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){const cell=y*cols+x;if(!mask[cell])continue;texels++;
    const corners=[[x/cols,y/rows],[(x+1)/cols,y/rows],[(x+1)/cols,(y+1)/rows],[x/cols,(y+1)/rows]],outer=corners.map(([u,v])=>point(b,face,u,v,t)),inner=outer.map(p=>p.map((v,i)=>v-(i===axis?sign*t:0))),coords=Array.from({length:4},()=>pixels[cell]);
    quad(outer,n,coords,b);quad(inner,n.map(v=>-v),coords,b);
    const neighbours=[[x,y-1],[x+1,y],[x,y+1],[x-1,y]];
    for(let edge=0;edge<4;edge++){const [nx,ny]=neighbours[edge];if(nx>=0&&nx<cols&&ny>=0&&ny<rows&&mask[ny*cols+nx])continue;
     const next=(edge+1)%4,wall=[inner[edge],inner[next],outer[next],outer[edge]],center=wall.reduce((p,q)=>p.map((v,i)=>v+q[i]/4),[0,0,0]),mid=outer.reduce((p,q)=>p.map((v,i)=>v+q[i]/4),[0,0,0]);
     const wn=new T.Vector3(...center).sub(new T.Vector3(...mid));wn.setComponent(axis,0);wn.normalize();quad(wall,wn.toArray(),coords,b);
    }
   }
  }
  ranges.push({name:b.name,part:b.part,detail:'clothing',start,count:pos.length/3-start});
 }
 const geometry=new T.BufferGeometry();for(const[name,array,size,Type]of [['position',pos,3,T.Float32BufferAttribute],['normal',normals,3,T.Float32BufferAttribute],['uv',uv,2,T.Float32BufferAttribute],['skinIndex',skinIndex,4,T.Uint16BufferAttribute],['skinWeight',weight,4,T.Float32BufferAttribute],['characterPart',tags,1,T.Uint8BufferAttribute]])geometry.setAttribute(name,new Type(array,size));
 geometry.setIndex(indices);geometry.computeBoundingBox();geometry.computeBoundingSphere();geometry.userData.partRanges=ranges;geometry.userData.clothing=true;
 return {geometry,texture,texels,thickness:CLOTHING_THICKNESS,atlas:{data,width:64,height:64},dispose(){geometry.dispose();texture.dispose();}};
}
