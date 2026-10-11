import {rotateVector} from '../../rigid-fracture.js';
import {accumulateNormalImpulse,accumulateFrictionImpulse,groupConstraints,solveConstraintGroups} from './voxel-constraint-kernel.js';
import {contactBreakageCap} from '../core/reference-materials.js';
import {packVoxelSolver,scheduleVoxelSolverTasks,executeVoxelSolverTask,unpackVoxelSolver} from './packed-voxel-solver.js';

const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const mul=(m,v)=>[m[0]*v[0]+m[1]*v[1]+m[2]*v[2],m[3]*v[0]+m[4]*v[1]+m[5]*v[2],m[6]*v[0]+m[7]*v[1]+m[8]*v[2]];
export function inverseWorldInertia(entry){
  const q=entry.rotation,p=entry.massProperties,i=p.principalAngularInertia,axes=[{x:1,y:0,z:0},{x:0,y:1,z:0},{x:0,y:0,z:1}].map(v=>rotateVector(rotateVector(v,p.angularInertiaLocalFrame),q)),result=new Float64Array(9),keys=['x','y','z'];
  for(let row=0;row<3;row++)for(let col=0;col<3;col++)for(let k=0;k<3;k++)result[row*3+col]+=axes[k][keys[row]]*axes[k][keys[col]]/i[keys[k]];
  return result;
}
export function makeBodyWork(entry,gravity,dt){
  const v=entry.body.linvel(),w=entry.body.angvel(),com=entry.body.worldCom(),force=entry.body.userForce();
  const invMass=entry.body.invMass(),linear=1/(1+dt*entry.body.linearDamping()),angular=1/(1+dt*entry.body.angularDamping());
  return {entry,mobile:true,invMass,inertia:inverseWorldInertia(entry),com:[com.x,com.y,com.z],initialCom:[com.x,com.y,com.z],initialPose:{position:{...entry.position},rotation:{...entry.rotation}},velocity:new Float64Array([(v.x+force.x*invMass*dt)*linear,(v.y-gravity*dt+force.y*invMass*dt)*linear,(v.z+force.z*invMass*dt)*linear,w.x*angular,w.y*angular,w.z*angular])};
}
export const fixedBodyWork=()=>({mobile:false,invMass:0,inertia:new Float64Array(9),com:[0,0,0],velocity:new Float64Array(6)});
function rowFor(a,b,point,axis,target,pointB=point){
  const ra=[point.x-a.com[0],point.y-a.com[1],point.z-a.com[2]],rb=[pointB.x-b.com[0],pointB.y-b.com[1],pointB.z-b.com[2]],ja=cross(ra,axis),jb=cross(rb,axis),ia=mul(a.inertia,ja),ib=mul(b.inertia,jb);
  return {axis,ja,jb,ia,ib,target,lambda:0,effective:a.invMass+b.invMass+dot(ja,ia)+dot(jb,ib)};
}
function velocityAtRow(a,b,row){const va=a.velocity,vb=b.velocity;return row.axis[0]*(va[0]-vb[0])+row.axis[1]*(va[1]-vb[1])+row.axis[2]*(va[2]-vb[2])+row.ja[0]*va[3]+row.ja[1]*va[4]+row.ja[2]*va[5]-row.jb[0]*vb[3]-row.jb[1]*vb[4]-row.jb[2]*vb[5];}
function apply(a,b,row,delta){
  if(!delta)return;const va=a.velocity,vb=b.velocity;
  for(let i=0;i<3;i++){va[i]+=row.axis[i]*a.invMass*delta;vb[i]-=row.axis[i]*b.invMass*delta;va[i+3]+=row.ia[i]*delta;vb[i+3]-=row.ib[i]*delta;}
}
export function prepareContactConstraint(contact,bodyA,bodyB,dt){
  const n=[contact.normal.x,contact.normal.y,contact.normal.z],t1=Math.abs(n[0])>.7?[n[1],-n[0],0]:[0,n[2],-n[1]],length=Math.hypot(...t1);for(let i=0;i<3;i++)t1[i]/=length;
  const t2=cross(n,t1),target=contact.penetration<0?contact.penetration/dt:Math.max(0,contact.penetration-.001)*.2/dt,normal=rowFor(bodyA,bodyB,contact.point,n,target);
  const speed=-velocityAtRow(bodyA,bodyB,normal);
  // Actual material caps enter the normal constraint before iteration.
  // The original branch's complete Shape flags and unit calibration remain
  // unresolved: this route records its project adoption explicitly.
  const capA=contact.a.entry?.contactFracture&&speed>=6?contactBreakageCap(contact.materialA,contact.a.entry.strength):Infinity;
  const capB=contact.b.entry?.contactFracture&&speed>=6?contactBreakageCap(contact.materialB,contact.b.entry.strength):Infinity;
  const fa=contact.a.friction??.8,fb=contact.b.friction??.8,rule=Math.max(contact.a.frictionCombineRule??0,contact.b.frictionCombineRule??0),friction=rule===1?Math.min(fa,fb):rule===2?fa*fb:rule===3?Math.max(fa,fb):(fa+fb)*.5;
  return {...contact,normalRow:normal,tangents:[rowFor(bodyA,bodyB,contact.point,t1,0),rowFor(bodyA,bodyB,contact.point,t2,0)],cap:Math.min(capA,capB),capA,capB,friction,speed,saturated:false};
}
export function solveVoxelRows(bodies,constraints){
  const work=groupConstraints(bodies.map(b=>b.mobile),constraints.map(c=>({a:c.aIndex,b:c.bIndex})));
  const pack=packVoxelSolver(bodies,constraints,work),tasks=scheduleVoxelSolverTasks(pack.groups,1);
  for(const task of tasks)executeVoxelSolverTask(pack,task.groups);unpackVoxelSolver(pack,bodies,constraints);
  work.tasks={executed:tasks.length,threads:0,mode:'synchronous',bytes:pack.data.byteLength+pack.velocity.byteLength+pack.indices.byteLength+pack.cap.byteLength+pack.friction.byteLength};
  return work;
}
export async function solveVoxelRowsAsync(bodies,constraints,tasks){
  const work=groupConstraints(bodies.map(b=>b.mobile),constraints.map(c=>({a:c.aIndex,b:c.bIndex})));
  let pack=packVoxelSolver(bodies,constraints,work,{shared:tasks.enabled});
  try{work.tasks=await tasks.execute(pack);}
  catch(error){
    // Repack the immutable input: never continue from half-written worker
    // velocities or run eight extra iterations over a partially solved result.
    tasks.disable();pack=packVoxelSolver(bodies,constraints,work);for(const task of scheduleVoxelSolverTasks(pack.groups,1))executeVoxelSolverTask(pack,task.groups);
    work.tasks={threads:0,mode:'failure-fallback',error:String(error.message||error)};
  }
  unpackVoxelSolver(pack,bodies,constraints);return work;
}
export function prepareBallConstraint(bodyA,bodyB,pointA,pointB,dt){
  const axes=[[1,0,0],[0,1,0],[0,0,1]],keys=['x','y','z'];
  return {kind:'ball',rows:axes.map((axis,i)=>rowFor(bodyA,bodyB,pointA,axis,(pointB[keys[i]]-pointA[keys[i]])*.2/dt,pointB))};
}
export function integrateBodyWork(state,dt){
  const entry=state.entry,v=state.velocity,q=state.initialPose.rotation,wx=v[3],wy=v[4],wz=v[5],half=dt*.5;
  const next={x:q.x+half*(wx*q.w+wy*q.z-wz*q.y),y:q.y+half*(-wx*q.z+wy*q.w+wz*q.x),z:q.z+half*(wx*q.y-wy*q.x+wz*q.w),w:q.w+half*(-wx*q.x-wy*q.y-wz*q.z)},length=Math.hypot(next.x,next.y,next.z,next.w);for(const key of ['x','y','z','w'])next[key]/=length;
  const com=state.initialCom.map((c,i)=>c+v[i]*dt),offset=rotateVector(entry.massProperties.localCenterOfMass,next),position={x:com[0]-offset.x,y:com[1]-offset.y,z:com[2]-offset.z};
  entry.body.setTranslation(position,false);entry.body.setRotation(next,false);entry.body.setLinvel({x:v[0],y:v[1],z:v[2]},false);entry.body.setAngvel({x:v[3],y:v[4],z:v[5]},false);
}
