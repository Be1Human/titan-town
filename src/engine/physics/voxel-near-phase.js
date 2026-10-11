import {COLLISION_FACE_CLASSES,REFERENCE_NEAR} from './reference-collision-config.js';
import {intersectionCellRange} from './voxel-intersection-range.js';
import {preparedSourcePose,preparedRelativePose,transposeMatrix,matrixVectorInto,matrixPointInto,preparedSourcePoint as sourcePoint} from './reference-transform-matrices.js';

const dot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z;
const inverse=q=>({x:-q.x,y:-q.y,z:-q.z,w:q.w});
function clipToFaces(v,mask){
  if((v.x<0&&!(mask&1))||(v.x>0&&!(mask&2)))v.x=0;
  if((v.y<0&&!(mask&4))||(v.y>0&&!(mask&8)))v.y=0;
  if((v.z<0&&!(mask&16))||(v.z>0&&!(mask&32)))v.z=0;return v;
}
const vector=()=>({x:0,y:0,z:0});
// Preserve the exact expression order of rigid-fracture's quaternion helpers.
// Only scratch ownership changes; persistent contact data is copied below.
function rotateInto(out,v,q){const tx=2*(q.y*v.z-q.z*v.y),ty=2*(q.z*v.x-q.x*v.z),tz=2*(q.x*v.y-q.y*v.x);out.x=v.x+q.w*tx+q.y*tz-q.z*ty;out.y=v.y+q.w*ty+q.z*tx-q.x*tz;out.z=v.z+q.w*tz+q.x*ty-q.y*tx;return out;}
function worldInto(out,object,x,y,z,scratch){scratch.x=x-object.center.x;scratch.y=y-object.center.y;scratch.z=z-object.center.z;rotateInto(out,scratch,object.rotation);out.x+=object.position.x;out.y+=object.position.y;out.z+=object.position.z;return out;}
function sourceInto(out,object,p,inverseRotation,scratch){scratch.x=p.x-object.position.x;scratch.y=p.y-object.position.y;scratch.z=p.z-object.position.z;rotateInto(out,scratch,inverseRotation);out.x+=object.center.x;out.y+=object.center.y;out.z+=object.center.z;return out;}
function localRange(object,bounds,margin){
  const lo={x:Infinity,y:Infinity,z:Infinity},hi={x:-Infinity,y:-Infinity,z:-Infinity};
  for(const x of [bounds.min.x-margin,bounds.max.x+margin])for(const y of [bounds.min.y-margin,bounds.max.y+margin])for(const z of [bounds.min.z-margin,bounds.max.z+margin]){
    const p=sourcePoint(object,{x,y,z});for(const axis of ['x','y','z']){lo[axis]=Math.min(lo[axis],Math.floor(p[axis]/object.cellSize));hi[axis]=Math.max(hi[axis],Math.floor(p[axis]/object.cellSize));}
  }return {lo,hi};
}
// 1400AE130 steady-motion branch, 1400AF740 dual queries (edges on/off).
// No cube SAT and no arbitrary per-body contact cap. Candidate normals are
// masked in BOTH local volumes before source-normal normalization and dedup.
// Alternate-pose semantics are explicit caller input. The project supplies
// a motion prediction; original Body +0x78/+0x84 update ordering is still
// tracked separately rather than labelled as a proven "previous" pose.
export function prepareNearPair(first,second,dt){
  const va=first.velocity??{x:0,y:0,z:0},vb=second.velocity??{x:0,y:0,z:0},fast=Math.hypot(va.x-vb.x,va.y-vb.y,va.z-vb.z)*dt>REFERENCE_NEAR.fastDisplacement;
  return {fast,ranges:[[first,second],[second,first]].map(([a,b])=>fast?localRange(a,b.bounds,REFERENCE_NEAR.searchRadius):intersectionCellRange(a,b))};
}
export function collectVoxelContacts(first,second,{dt=0,stats={scanned:0,tested:0,contacts:0},prepared=null,transforms='matrix',onContact=null,indexedTargets=true}={}){
  const query=prepared||prepareNearPair(first,second,dt),fast=query.fast;
  const contacts=[];let emitted=0;
  const emit=(i,j,outward,center,penetration,reverse,fastContact)=>{
    const nx=reverse?outward.x:-outward.x,ny=reverse?outward.y:-outward.y,nz=reverse?outward.z:-outward.z,px=center.x+outward.x*REFERENCE_NEAR.contactOffset,py=center.y+outward.y*REFERENCE_NEAR.contactOffset,pz=center.z+outward.z*REFERENCE_NEAR.contactOffset,indexA=reverse?j:i,indexB=reverse?i:j;
    if(onContact)onContact(indexA,indexB,nx,ny,nz,px,py,pz,penetration,fastContact);
    else contacts.push({a:first,b:second,indexA,indexB,normal:{x:nx,y:ny,z:nz},point:{x:px,y:py,z:pz},penetration,materialA:first.materialAt?.(indexA),materialB:second.materialAt?.(indexB),sourceShapeA:first.sourceAt?.(indexA),sourceShapeB:second.sourceAt?.(indexB),...(fastContact?{fast:true}:{})});emitted++;
  };
  const run=(a,b,allowEdges,reverse)=>{
    // Native steady query intersects BOTH oriented local boxes before integer
    // traversal (14051DD80/14051E7B0). The predicted-pose fast fallback stays
    // conservative until original alternate-pose orchestration is recovered.
    const range=query.ranges[reverse?1:0];if(!range)return;
    const g=b.cache.grid,m=g.min,s=b.cellSize,invA=inverse(a.rotation),invB=inverse(b.rotation),alternateA=a.alternatePose?{...a,...a.alternatePose}:null,alternateB=b.alternatePose?{...b,...b.alternatePose}:null,invAlternateB=alternateB?inverse(alternateB.rotation):null;
    const matrixMode=transforms==='matrix',poseA=matrixMode?preparedSourcePose(a):null,poseB=matrixMode?preparedSourcePose(b):null,relative=matrixMode?preparedRelativePose(a,b):null,backward=matrixMode?transposeMatrix(relative.matrix):null,alternateRelative=matrixMode&&alternateA&&alternateB?preparedRelativePose(alternateA,alternateB):null;
    const centerA=vector(),centerB=vector(),local=vector(),endpoint=vector(),alternateWorld=vector(),scratch=vector(),difference=vector(),towardSource=vector(),worldTowardSource=vector(),towardTarget=vector(),outward=vector(),normals=[];
    a.cache.forEachCandidate(range.lo,range.hi,allowEdges,(i,x,y,z,maskA)=>{
      const categoryA=COLLISION_FACE_CLASSES[maskA&63];if(!(categoryA&0xfd)||(categoryA===1&&!allowEdges))return;
      const ax=(x+.5)*a.cellSize,ay=(y+.5)*a.cellSize,az=(z+.5)*a.cellSize;
      if(matrixMode){matrixPointInto(centerA,poseA,ax,ay,az);matrixPointInto(local,relative,ax,ay,az);}else{worldInto(centerA,a,ax,ay,az,scratch);sourceInto(local,b,centerA,invB,scratch);}normals.length=0;
      if(fast&&alternateA&&alternateB){
        if(matrixMode)matrixPointInto(endpoint,alternateRelative,ax,ay,az);else{worldInto(alternateWorld,alternateA,ax,ay,az,scratch);sourceInto(endpoint,alternateB,alternateWorld,invAlternateB,scratch);}
        const motion=Math.hypot(local.x-endpoint.x,local.y-endpoint.y,local.z-endpoint.z);
        if(motion>REFERENCE_NEAR.searchRadius){
          const steps=Math.max(1,Math.trunc(motion/REFERENCE_NEAR.separationMargin));
          for(let k=1;k<=steps;k++){
            const t=k/steps,bx=Math.floor(((1-t)*local.x+t*endpoint.x)/s),by=Math.floor(((1-t)*local.y+t*endpoint.y)/s),bz=Math.floor(((1-t)*local.z+t*endpoint.z)/s);
            if(bx<m.x||by<m.y||bz<m.z||bx>=g.max.x||by>=g.max.y||bz>=g.max.z)continue;
            const j=bx-m.x+(bz-m.z)*g.width+(by-m.y)*g.layer,maskB=b.cache.mask[j],categoryB=COLLISION_FACE_CLASSES[maskB&63];
            if(!categoryB||(categoryA===1&&categoryB!==1))continue;
            towardSource.x=local.x-(bx+.5)*s;towardSource.y=local.y-(by+.5)*s;towardSource.z=local.z-(bz+.5)*s;clipToFaces(towardSource,maskB);
            if(matrixMode)matrixVectorInto(towardTarget,backward,-towardSource.x,-towardSource.y,-towardSource.z);else{rotateInto(worldTowardSource,towardSource,b.rotation);scratch.x=-worldTowardSource.x;scratch.y=-worldTowardSource.y;scratch.z=-worldTowardSource.z;rotateInto(towardTarget,scratch,invA);}clipToFaces(towardTarget,maskA);const length=Math.hypot(towardTarget.x,towardTarget.y,towardTarget.z);if(!length)continue;
            scratch.x=towardTarget.x/length;scratch.y=towardTarget.y/length;scratch.z=towardTarget.z/length;if(matrixMode)matrixVectorInto(outward,poseA.matrix,scratch.x,scratch.y,scratch.z);else rotateInto(outward,scratch,a.rotation);
            emit(i,j,outward,centerA,-REFERENCE_NEAR.fastSeparation,reverse,true);stats.tested++;
          }
        }
      }
      const loX=Math.max(m.x,Math.floor((local.x-REFERENCE_NEAR.searchRadius)/s)),hiX=Math.min(g.max.x-1,Math.floor((local.x+REFERENCE_NEAR.searchRadius)/s)),loY=Math.max(m.y,Math.floor((local.y-REFERENCE_NEAR.searchRadius)/s)),hiY=Math.min(g.max.y-1,Math.floor((local.y+REFERENCE_NEAR.searchRadius)/s)),loZ=Math.max(m.z,Math.floor((local.z-REFERENCE_NEAR.searchRadius)/s)),hiZ=Math.min(g.max.z-1,Math.floor((local.z+REFERENCE_NEAR.searchRadius)/s));
      for(let by=loY;by<=hiY;by++)for(let bz=loZ;bz<=hiZ;bz++){
        // Skip only masks the original category test already rejects. Class 1
        // sources require class 1 targets; the full surface index also retains
        // flat-face targets for class 3. Preserve ascending x and all arithmetic.
        let xs=null,k=loX,end=hiX+1;
        if(indexedTargets&&(b.cache.surfaceRows||b.cache.surfaceOffsets)){
          const row=by-m.y+(bz-m.z)*b.cache.height,rows=categoryA===1?b.cache.featureRows:b.cache.surfaceRows,offsets=categoryA===1?b.cache.offsets:b.cache.surfaceOffsets;
          xs=rows?rows[row]:categoryA===1?b.cache.xs:b.cache.surfaceXs;k=rows?0:offsets[row];end=rows?xs.length:offsets[row+1];
          let high=end;while(k<high){const mid=(k+high)>>>1;if(xs[mid]<loX-m.x)k=mid+1;else high=mid;}
        }
        for(;k<end;k++){
          const bx=xs?xs[k]+m.x:k;if(bx>hiX)break;const j=bx-m.x+(bz-m.z)*g.width+(by-m.y)*g.layer;
          const maskB=b.cache.mask[j],categoryB=COLLISION_FACE_CLASSES[maskB&63];if(!categoryB||(categoryA===1&&categoryB!==1))continue;stats.tested++;
          const bcx=(bx+.5)*s,bcy=(by+.5)*s,bcz=(bz+.5)*s;difference.x=local.x-bcx;difference.y=local.y-bcy;difference.z=local.z-bcz;
          if(dot(difference,difference)>=REFERENCE_NEAR.distanceSquared)continue;
          towardSource.x=difference.x;towardSource.y=difference.y;towardSource.z=difference.z;clipToFaces(towardSource,maskB);if(!dot(towardSource,towardSource))continue;
          if(matrixMode)matrixVectorInto(towardTarget,backward,-towardSource.x,-towardSource.y,-towardSource.z);else{rotateInto(worldTowardSource,towardSource,b.rotation);scratch.x=-worldTowardSource.x;scratch.y=-worldTowardSource.y;scratch.z=-worldTowardSource.z;rotateInto(towardTarget,scratch,invA);}clipToFaces(towardTarget,maskA);const length=Math.hypot(towardTarget.x,towardTarget.y,towardTarget.z);if(!(length>0))continue;
          scratch.x=towardTarget.x/length;scratch.y=towardTarget.y/length;scratch.z=towardTarget.z/length;if(matrixMode)matrixVectorInto(outward,poseA.matrix,scratch.x,scratch.y,scratch.z);else rotateInto(outward,scratch,a.rotation);
          if(normals.some(n=>dot(n,outward)>REFERENCE_NEAR.normalSimilarity))continue;normals.push({...outward});
          if(matrixMode)matrixPointInto(centerB,poseB,bcx,bcy,bcz);else worldInto(centerB,b,bcx,bcy,bcz,scratch);const delta={x:centerB.x-centerA.x,y:centerB.y-centerA.y,z:centerB.z-centerA.z};
          emit(i,j,outward,centerA,REFERENCE_NEAR.separationMargin-dot(delta,outward),reverse,false);
        }
      }
    });stats.scanned+=a.cache.stats.scanned;
  };
  run(first,second,true,false);run(second,first,false,true);stats.contacts+=emitted;return contacts;
}
