import {worldPoint} from '../../rigid-fracture.js';

// Each handle applies its own bounded force at its own attachment point.
// Two disagreeing carriers create real torque instead of averaging targets
// into a teleported pose. The same helper is used by local and room authority.
export function stepGrabConstraint(physics,id,grips,dt,options={}){
  const entry=physics?.entries.get(id);
  if(!entry||!grips?.length||physics.isReplica)return {ok:false,reason:'missing'};
  const mass=entry.body.mass(),com=entry.body.worldCom(),velocity=entry.body.linvel(),angular=entry.body.angvel();
  const gravity=physics.voxelWorld.gravity??18,maxForce=options.maxForce??3500;
  const stiffness=options.stiffness??mass*48,damping=options.damping??mass*9;
  const elapsed=Math.max(0,Math.min(.05,Number.isFinite(dt)?dt:0)),applied=[],plans=[];
  for(const grip of grips){
    const anchor=worldPoint(entry,grip.localPoint??entry.center),target=grip.target;
    if(!target||!['x','y','z'].every(k=>Number.isFinite(target[k])))return {ok:false,reason:'target'};
    if(Math.hypot(target.x-anchor.x,target.y-anchor.y,target.z-anchor.z)>(options.maxDistance??4))return {ok:false,reason:'distance'};
    const r={x:anchor.x-com.x,y:anchor.y-com.y,z:anchor.z-com.z};
    const at={x:velocity.x+angular.y*r.z-angular.z*r.y,y:velocity.y+angular.z*r.x-angular.x*r.z,z:velocity.z+angular.x*r.y-angular.y*r.x};
    const force={};for(const axis of ['x','y','z'])force[axis]=((target[axis]-anchor[axis])*stiffness-at[axis]*damping+(axis==='y'?mass*gravity:0))/grips.length;
    const length=Math.hypot(force.x,force.y,force.z),scale=Math.min(1,maxForce/Math.max(length,1e-8))*elapsed;
    const impulse={x:force.x*scale,y:force.y*scale,z:force.z*scale};plans.push({anchor,impulse});
  }
  for(const plan of plans){entry.body.applyImpulseAtPoint(plan.impulse,plan.anchor,true);applied.push(plan);}
  return {ok:true,applied};
}
