import * as T from '../vendor/three.module.js';

// Rounded chin and shallow crown corners. All source UVs stay on the box;
// geometry alone changes, including painted outer-layer shells.
function ramp(t,e){
 t=Math.max(0,Math.min(1,t));
 // Straight middle slope with tangent-continuous, rounded joins at both ends.
 const amount=t<e?t*t/(2*e*(1-e)):t>1-e?1-(1-t)**2/(2*e*(1-e)):(t-e/2)/(1-e);
 const derivative=t<=0||t>=1?0:t<e?t/(e*(1-e)):t>1-e?(1-t)/(e*(1-e)):1/(1-e);
 return {amount,derivative};
}
function profile(y,box){
 const h=box.size[1],span=h*box.jaw.height,chin=ramp((span-(y+h/2))/span,box.jaw.rounding??.2);
 const c=box.crown,cspan=c?h*c.height:1,crown=c?ramp((cspan-(h/2-y))/cspan,c.rounding??.3):{amount:0,derivative:0};
 return {
  scale:1-box.jaw.inset*chin.amount-(c?.inset??0)*crown.amount,
  slope:box.jaw.inset*chin.derivative/span-(c?.inset??0)*crown.derivative/cspan,
  depth:1-(box.jaw.depthInset??0)*chin.amount-(c?.depthInset??0)*crown.amount,
  depthSlope:(box.jaw.depthInset??0)*chin.derivative/span-(c?.depthInset??0)*crown.derivative/cspan,
 };
}
export function jawPoint(point,box){
 if(!box.jaw)return [...point];
 const p=point.map((n,i)=>n-box.center[i]),{scale,depth}=profile(p[1],box);
 p[0]*=scale;p[2]*=depth;return p.map((n,i)=>n+box.center[i]);
}
export function unwarpJawPoint(point,box){
 if(!box.jaw)return [...point];
 const p=point.map((n,i)=>n-box.center[i]),{scale,depth}=profile(p[1],box);
 p[0]/=scale;p[2]/=depth;return p.map((n,i)=>n+box.center[i]);
}
export function jawNormal(point,normal,box){
 if(!box.jaw)return [...normal];
 const p=point.map((n,i)=>n-box.center[i]),{scale,slope,depth,depthSlope}=profile(p[1],box);
 return new T.Vector3(normal[0]/scale,normal[1]-normal[0]*p[0]*slope/scale-normal[2]*p[2]*depthSlope/depth,normal[2]/depth).normalize().toArray();
}
function ticks(half,count,radius){
 const values=Array.from({length:count+1},(_,i)=>-half+2*half*i/count);
 for(const s of [-1,1])for(const k of [.3,1,2])values.push(s*(half-radius*k));
 return [...new Set(values.map(n=>Number(n.toFixed(10))))].sort((a,b)=>a-b);
}
export function softJawPolygons(box){
 const half=box.size.map(n=>n/2),r=Math.min(box.jaw.radius,...half.map(n=>n*.2));
 const axes=half.map((h,i)=>ticks(h,box.jaw.segments[i],r)),polygons=[];
 axes[1]=[...new Set([...axes[1],...[0,.08,.16,.2,.4,.6,.8,.84,.92,1].map(t=>Number((-half[1]+box.size[1]*box.jaw.height*t).toFixed(10)))])].sort((a,b)=>a-b);
 if(box.crown)axes[1]=[...new Set([...axes[1],...[0,.1,.2,.3,.5,.7,.8,.9,1].map(t=>Number((half[1]-box.size[1]*box.crown.height*t).toFixed(10)))])].sort((a,b)=>a-b);
 for(let axis=0;axis<3;axis++)for(const sign of [-1,1]){
  const u=(axis+1)%3,v=(axis+2)%3;
  for(let i=0;i<axes[u].length-1;i++)for(let j=0;j<axes[v].length-1;j++){
   let source=[[i,j],[i+1,j],[i+1,j+1],[i,j+1]].map(([a,b])=>{
    const p=[0,0,0];p[axis]=sign*half[axis];p[u]=axes[u][a];p[v]=axes[v][b];return p;
   });
   if(sign<0)source.reverse();
   const normals=[],points=source.map(p=>{
    const core=p.map((n,k)=>Math.max(-half[k]+r,Math.min(half[k]-r,n))),direction=new T.Vector3(...p.map((n,k)=>n-core[k])).normalize();
    const rounded=core.map((n,k)=>n+direction.getComponent(k)*r),world=rounded.map((n,k)=>n+box.center[k]);
    normals.push(jawNormal(world,direction.toArray(),box));return jawPoint(world,box).map((n,k)=>n-box.center[k]);
   });
   polygons.push({points,sourcePoints:source,normals,face:axis*2+(sign>0?0:1)});
  }
 }
 return polygons;
}
export function insideSoftJaw(point,box){
 const {scale,depth}=profile(point[1],box),p=[point[0]/scale,point[1],point[2]/depth],half=box.size.map(n=>n/2),r=box.jaw.radius;
 const q=p.map((n,i)=>Math.abs(n)-half[i]+r);
 return Math.hypot(...q.map(n=>Math.max(0,n)))+Math.min(Math.max(...q),0)<=r+1e-8;
}
