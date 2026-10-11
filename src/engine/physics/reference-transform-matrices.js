// 1405ECB00: column-major quaternion matrix with 2 / squared norm.
// float32=true preserves the recovered scalar expression's rounding points;
// runtime author-coordinate adaptation uses double precision explicitly.
export function referenceRotationMatrix(q,{float32=false}={}){
  const F=float32?Math.fround:x=>x,x=F(q.x),y=F(q.y),z=F(q.z),w=F(q.w),zz=F(z*z),xx=F(x*x),yy=F(y*y),xy2=F(xx+yy),norm=F(F(F(w*w)+zz)+xy2);
  if(!(norm>0)||!Number.isFinite(norm))throw Error('Invalid reference quaternion');
  const factor=F(2/norm),m=new (float32?Float32Array:Float64Array)(9);
  m[0]=F(1-F(F(zz+yy)*factor));m[4]=F(1-F(F(zz+xx)*factor));m[8]=F(1-F(xy2*factor));
  m[1]=F(F(F(x*y)+F(w*z))*factor);m[2]=F(F(F(z*x)-F(w*y))*factor);
  m[3]=F(F(F(x*y)-F(w*z))*factor);m[5]=F(F(F(w*x)+F(z*y))*factor);
  m[6]=F(F(F(w*y)+F(z*x))*factor);m[7]=F(F(F(z*y)-F(w*x))*factor);return m;
}
export function matrixVectorInto(out,m,x,y,z){out.x=x*m[0]+y*m[3]+z*m[6];out.y=x*m[1]+y*m[4]+z*m[7];out.z=x*m[2]+y*m[5]+z*m[8];return out;}
export function matrixPointInto(out,transform,x,y,z){matrixVectorInto(out,transform.matrix,x,y,z);out.x+=transform.position.x;out.y+=transform.position.y;out.z+=transform.position.z;return out;}
export function transposeMatrix(m){return Float64Array.from([m[0],m[3],m[6],m[1],m[4],m[7],m[2],m[5],m[8]]);}
// 14002D3D0 expression/accumulation order, used by 140069720.
export function referenceMultiplyQuaternion(a,b,{float32=false}={}){
  const F=float32?Math.fround:x=>x,ax=F(a.x),ay=F(a.y),az=F(a.z),aw=F(a.w),bx=F(b.x),by=F(b.y),bz=F(b.z),bw=F(b.w);
  return{x:F(F(F(F(bz*ay)-F(by*az))+F(aw*bx))+F(bw*ax)),y:F(F(F(F(bx*az)-F(bz*ax))+F(aw*by))+F(bw*ay)),z:F(F(F(F(by*ax)-F(bx*ay))+F(aw*bz))+F(bw*az)),w:F(F(bw*aw)-F(F(F(by*ay)+F(bx*ax))+F(bz*az)))};
}
// 140030D40 inverse vector formula. Caller pose quaternions are unit rotations.
export function referenceInverseVector(q,p,{float32=false}={}){
  const F=float32?Math.fround:x=>x,x=F(q.x),y=F(q.y),z=F(q.z),w=F(q.w),px=F(p.x),py=F(p.y),pz=F(p.z),tw=F(w+w),scale=F(F(tw*w)-1),sum=F(F(F(py*y)+F(px*x))+F(pz*z)),twice=F(sum+sum);
  return{x:F(F(F(px*scale)-F(F(F(pz*y)-F(py*z))*tw))+F(twice*x)),y:F(F(F(py*scale)-F(F(F(px*z)-F(pz*x))*tw))+F(twice*y)),z:F(F(F(pz*scale)-F(F(F(py*x)-F(px*y))*tw))+F(twice*z))};
}
const poseCache=new WeakMap();
export function preparedSourcePose(object){
  const q=object.rotation,c=object.center,p=object.position,old=poseCache.get(object),values=[q.x,q.y,q.z,q.w,c.x,c.y,c.z,p.x,p.y,p.z];
  if(old&&values.every((n,i)=>n===old.values[i]))return old.transform;
  const matrix=referenceRotationMatrix(q),offset=matrixVectorInto({},matrix,c.x,c.y,c.z),transform={matrix,inverse:transposeMatrix(matrix),position:{x:p.x-offset.x,y:p.y-offset.y,z:p.z-offset.z}};
  poseCache.set(object,{values,transform});return transform;
}
// The runtime's stable author coordinates can have a nonzero centre/minimum.
// Fold those origins into affine translation once. Relative rotation is the
// conjugate target quaternion times source quaternion, then normalized matrix
// preparation as in 140069720/1405ECB00. Equal rotations therefore give exact
// identity axes instead of residual cross-axis terms from matrix products.
export function preparedRelativePose(source,target){
  const a=preparedSourcePose(source),b=preparedSourcePose(target),q=target.rotation,relative=referenceMultiplyQuaternion({x:-q.x,y:-q.y,z:-q.z,w:q.w},source.rotation),matrix=referenceRotationMatrix(relative);
  const length=Math.hypot(q.x,q.y,q.z,q.w),unit={x:q.x/length,y:q.y/length,z:q.z/length,w:q.w/length};
  const position=referenceInverseVector(unit,{x:a.position.x-b.position.x,y:a.position.y-b.position.y,z:a.position.z-b.position.z});return{matrix,position};
}
export function preparedWorldPoint(object,p){return matrixPointInto({},preparedSourcePose(object),p.x,p.y,p.z);}
export function preparedSourcePoint(object,p){const t=preparedSourcePose(object);return matrixVectorInto({},t.inverse,p.x-t.position.x,p.y-t.position.y,p.z-t.position.z);}
