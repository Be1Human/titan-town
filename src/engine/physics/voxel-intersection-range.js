import {preparedSourcePoint as sourcePoint,preparedWorldPoint as worldPoint} from './reference-transform-matrices.js';
import {REFERENCE_NEAR} from './reference-collision-config.js';
const axes=['x','y','z'];
const empty=()=>({min:{x:Infinity,y:Infinity,z:Infinity},max:{x:-Infinity,y:-Infinity,z:-Infinity}});
const include=(bounds,p)=>{for(const axis of axes){bounds.min[axis]=Math.min(bounds.min[axis],p[axis]);bounds.max[axis]=Math.max(bounds.max[axis],p[axis]);}};
function localBox(object){
  if(object.localBounds)return object.localBounds;
  const g=object.cache.grid,s=object.cellSize;return{min:{x:g.min.x*s,y:g.min.y*s,z:g.min.z*s},max:{x:g.max.x*s,y:g.max.y*s,z:g.max.z*s}};
}
function expand(box){const margin=REFERENCE_NEAR.boxMargin;return{min:{x:box.min.x-margin,y:box.min.y-margin,z:box.min.z-margin},max:{x:box.max.x+margin,y:box.max.y+margin,z:box.max.z+margin}};}
// 14051E7B0: twelve oriented box edges, slab-clipped against the other box;
// both retained endpoints are emitted. Parallel axes are handled explicitly
// rather than relying on the native SSE reciprocal/NaN minps conventions.
export function clipSegmentBox(a,b,box,epsilon=REFERENCE_NEAR.boxEpsilon){
  let enter=-Infinity,exit=Infinity;
  for(const axis of axes){const d=b[axis]-a[axis],lo=box.min[axis]-epsilon,hi=box.max[axis]+epsilon;
    if(d===0){if(a[axis]<lo||a[axis]>hi)return null;continue;}
    const t1=(lo-a[axis])/d,t2=(hi-a[axis])/d;enter=Math.max(enter,Math.min(t1,t2));exit=Math.min(exit,Math.max(t1,t2));
  }
  if(!(enter<exit&&exit>0&&enter<1))return null;
  const start=Math.max(0,enter),end=Math.min(1,exit),point=t=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});return[point(start),point(end)];
}
function edges(box,transform,visit){
  const corners=[];for(let i=0;i<8;i++)corners.push(transform({x:i&1?box.max.x:box.min.x,y:i&2?box.max.y:box.min.y,z:i&4?box.max.z:box.min.z}));
  for(let bit=1;bit<=4;bit<<=1)for(let i=0;i<8;i++)if(!(i&bit))visit(corners[i],corners[i|bit]);
}
// 14051DD80 combines edge intersections in both frames, then takes their
// componentwise bounds in A's local frame. It is NOT the world AABB overlap.
export function orientedIntersectionBounds(a,b){
  const boxA=expand(localBox(a)),boxB=expand(localBox(b)),bounds=empty();
  edges(boxB,p=>sourcePoint(a,worldPoint(b,p)),(p,q)=>{const hit=clipSegmentBox(p,q,boxA);if(hit)for(const point of hit)include(bounds,point);});
  edges(boxA,p=>sourcePoint(b,worldPoint(a,p)),(p,q)=>{const hit=clipSegmentBox(p,q,boxB);if(hit)for(const point of hit)include(bounds,sourcePoint(a,worldPoint(b,point)));});
  return bounds.min.x===Infinity?null:bounds;
}
export function intersectionCellRange(a,b){
  const bounds=orientedIntersectionBounds(a,b);if(!bounds)return null;
  const lo={},hi={};for(const axis of axes){lo[axis]=Math.floor(bounds.min[axis]/a.cellSize);hi[axis]=Math.floor(bounds.max[axis]/a.cellSize);}return{lo,hi};
}
