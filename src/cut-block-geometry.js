import * as T from '../vendor/three.module.js';

// A closed, flat-shaded chamfered solid: six rectangles, twelve edge strips,
// eight corner triangles. UVs project onto the same six skin faces as a box.
export function cutBlockPolygons(size,bevel){
 const half=size.map(n=>n/2),r=Math.min(bevel,...half.map(n=>n*.45)),polygons=[];
 const face=(axis,sign)=>axis*2+(sign>0?0:1);
 const add=(points,tileFace)=>{
  let normal=new T.Vector3().fromArray(points[1]).sub(new T.Vector3().fromArray(points[0])).cross(new T.Vector3().fromArray(points[2]).sub(new T.Vector3().fromArray(points[0]))).normalize();
  const center=points.reduce((a,p)=>a.map((n,i)=>n+p[i]/points.length),[0,0,0]);
  if(normal.dot(new T.Vector3(...center))<0){points.reverse();normal.negate();}
  polygons.push({points,normal:normal.toArray(),face:tileFace});
 };
 for(let axis=0;axis<3;axis++)for(const sign of [-1,1]){
  const u=(axis+1)%3,v=(axis+2)%3;
  add([[-1,-1],[1,-1],[1,1],[-1,1]].map(([a,b])=>{const p=[0,0,0];p[axis]=sign*half[axis];p[u]=a*(half[u]-r);p[v]=b*(half[v]-r);return p;}),face(axis,sign));
 }
 if(r===0)return polygons;
 for(let axis=0;axis<3;axis++)for(let second=axis+1;second<3;second++)for(const a of [-1,1])for(const b of [-1,1]){
  const along=3-axis-second;
  add([[0,-1],[1,-1],[1,1],[0,1]].map(([which,end])=>{const p=[0,0,0];p[axis]=a*(half[axis]-(which?r:0));p[second]=b*(half[second]-(which?0:r));p[along]=end*(half[along]-r);return p;}),second===2?face(2,b):face(axis,a));
 }
 for(const x of [-1,1])for(const y of [-1,1])for(const z of [-1,1]){
  const signs=[x,y,z];add([0,1,2].map(axis=>half.map((n,i)=>signs[i]*(n-(i===axis?0:r)))),face(2,z));
 }
 return polygons;
}

export function skinFaceUV(point,box,face){
 const p=point.map((n,i)=>n-box.center[i]),[w,h,d]=box.size,[x,y,z]=p;
 const uv=[[(d/2-z)/d,(h/2-y)/h],[(z+d/2)/d,(h/2-y)/h],[(x+w/2)/w,(z+d/2)/d],[(x+w/2)/w,(d/2-z)/d],[(x+w/2)/w,(h/2-y)/h],[(w/2-x)/w,(h/2-y)/h]][face];
 return uv.map(n=>Math.max(0,Math.min(1,n)));
}

export function insideCutBlock(point,size,bevel){
 const h=size.map(n=>n/2),r=Math.min(bevel,...h.map(n=>n*.45)),q=point.map(Math.abs);
 if(q.some((n,i)=>n>h[i]+1e-8))return false;
 for(let a=0;a<3;a++)for(let b=a+1;b<3;b++)if(q[a]+q[b]>h[a]+h[b]-r+1e-8)return false;
 return q.reduce((a,b)=>a+b,0)<=h.reduce((a,b)=>a+b,0)-2*r+1e-8;
}
