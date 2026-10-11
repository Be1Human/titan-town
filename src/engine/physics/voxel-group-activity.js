import {rotateVector} from '../../rigid-fracture.js';

// 1405F91A0 + body APIs 14047FFC0 / 140031330 / 140030990.
// Compare the CURRENT WORLD AABB corners under two poses. This deliberately
// does not substitute a linear-speed threshold or the eight local box corners.
export function cornerDisplacement(bounds,current,previous){
  let distance=0;const inverse={x:-current.rotation.x,y:-current.rotation.y,z:-current.rotation.z,w:current.rotation.w};
  for(const x of [bounds.min.x,bounds.max.x])for(const y of [bounds.min.y,bounds.max.y])for(const z of [bounds.min.z,bounds.max.z]){
    const local=rotateVector({x:x-current.position.x,y:y-current.position.y,z:z-current.position.z},inverse),old=rotateVector(local,previous.rotation);
    distance=Math.max(distance,Math.hypot(x-(old.x+previous.position.x),y-(old.y+previous.position.y),z-(old.z+previous.position.z)));
  }
  return distance;
}
export function updateGroupActivity(members,{specialFlag=()=>false,canSleep=()=>true}={}){
  const factor=Math.max(0,Math.min(2,(members.length-8)*.2));let active=false;
  for(const member of members){
    const threshold=(1+factor)*.02*(specialFlag(member)? .3:1);
    let activity=member.activity??60;
    if(!member.previousPose||cornerDisplacement(member.bounds,member.pose,member.previousPose)>threshold)activity=Math.min(60,activity+5);
    if(activity>=2){activity--;active=true;}else if(member.velocity)for(let i=0;i<member.velocity.length;i++)member.velocity[i]*=.99;
    if(!canSleep(member))active=true;
    member.activity=activity;member.previousPose={position:{...member.pose.position},rotation:{...member.pose.rotation}};
  }
  if(!active)for(const member of members)member.sleep?.();
  return {active,factor,bodyCount:members.length};
}

export function wakeOverlap(tree,bounds,wake){
  const bodies=new Set();tree.query(bounds,shape=>{if(!bodies.has(shape.bodyId)){bodies.add(shape.bodyId);wake(shape);}});return bodies.size;
}
