// The verified MakeHole material contract is shared by static and dynamic
// targets. Weapon hole sizes and pellet distribution have not been recovered
// from the native game: these explicit calibration values are not "exact".
export const TOOL_POLICY_ID = 'reference-material-cut-v1';
export const TOOL_POLICY = Object.freeze({
  hammer: Object.freeze({radii:Object.freeze([.30,0,0]),range:3.2,penetration:.18,impulseSpeed:.55,maxImpulse:140}),
  shotgun: Object.freeze({radii:Object.freeze([.105,.065,0]),range:20,penetration:.025,pellets:9,spread:.075,impulseSpeed:.07,maxImpulse:140}),
  explosion: Object.freeze({radii:Object.freeze([3.15,2.2,1.1])})
});
export const TOOL_POLICY_EVIDENCE = Object.freeze({
  materialCut:'Verified soft/medium/hard classification, category 3 exclusion and radius ordering.',
  shotgunRange:'20 is the source tools.lua default range setting.',
  shotgunSpread:'.075 is the source toolutilities.lua campaign setting.',
  holeSizes:'Project calibration; original per-tool cutting radii have not been recovered.',
  pellets:'Project calibration; original count and native distribution remain unverified.',
  impulse:'Project mass-scaled point impulse and cap shared by host and single-player; original tool impulse is unverified.'
});

export function toolHoleRadii(kind, radius) {
  const policy=TOOL_POLICY[kind];if(!policy)throw new Error(`Unknown tool cut: ${kind}`);
  const scale=radius===undefined?1:Math.max(0,Number.isFinite(radius)?radius/policy.radii[0]:0);
  return policy.radii.map(r=>r*scale);
}
export function cutStaticForTool(world,point,kind,options={}) {
  return world.makeHole(point,toolHoleRadii(kind,options.radius),{seed:options.seed??0,noise:0});
}
export function cutRigidForTool(physics,point,kind,options={}) {
  return physics.makeHole(point,toolHoleRadii(kind,options.radius),{id:options.id,seed:options.seed??0,noise:0});
}

export function applyToolHitImpulse(physics,hit,direction,kind) {
  const policy=TOOL_POLICY[kind],entry=physics?.entries.get(hit?.rigidId??hit?.id);
  if(!entry||!policy?.impulseSpeed)return 0;
  const impulse=Math.min(policy.maxImpulse,entry.body.mass()*policy.impulseSpeed);
  physics.impulse(entry.id,{x:direction.x*impulse,y:direction.y*impulse,z:direction.z*impulse},hit.point);
  return impulse;
}

// Same seed and view direction produce the same ray bundle in both modes.
// This is a reproducible project distribution, not the unknown native RNG.
export function shotgunDirections(yaw,pitch,seed=0) {
  let state=Number.isFinite(seed)?seed>>>0:0;
  const random=()=>{state=(state+0x6d2b79f5)>>>0;let n=state;n=Math.imul(n^(n>>>15),n|1);n^=n+Math.imul(n^(n>>>7),n|61);return((n^(n>>>14))>>>0)/4294967296;};
  const sy=Math.sin(yaw),cy=Math.cos(yaw),sp=Math.sin(pitch),cp=Math.cos(pitch);
  const forward={x:-sy*cp,y:sp,z:-cy*cp},right={x:cy,y:0,z:-sy},up={x:sy*sp,y:cp,z:cy*sp};
  const rays=[forward];
  for(let i=1;i<TOOL_POLICY.shotgun.pellets;i++){
    const angle=random()*Math.PI*2,radius=Math.sqrt(random())*Math.tan(TOOL_POLICY.shotgun.spread),a=Math.cos(angle)*radius,b=Math.sin(angle)*radius;
    const v={x:forward.x+right.x*a+up.x*b,y:forward.y+right.y*a+up.y*b,z:forward.z+right.z*a+up.z*b},n=Math.hypot(v.x,v.y,v.z);
    rays.push({x:v.x/n,y:v.y/n,z:v.z/n});
  }
  return rays;
}
