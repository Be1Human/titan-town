// Camera space looks down -Z. The hammer face and its impact arc follow that axis.
export const HAMMER_DURATION=.58;
export const HAMMER_IMPACT=.23;
const poses=[
  [0,     .32,-.36,-.85, .10,-.18, .18],
  [.13,   .40,-.23,-.70, .58,-.28,-.12],
  [.23,   .025,-.32,-1.10,-.45, .02, .06],
  [.32,   .03,-.38,-1.02,-.85, .04, .10],
  [.58,   .32,-.36,-.85, .10,-.18, .18]
];
export function hammerPose(time=0){
  const t=Math.min(HAMMER_DURATION,Math.max(0,time));
  let i=0;while(i<poses.length-2&&t>poses[i+1][0])i++;
  const a=poses[i],b=poses[i+1],v=(t-a[0])/(b[0]-a[0]),s=v*v*(3-2*v);
  const p=a.slice(1).map((n,j)=>n+(b[j+1]-n)*s);
  return {x:p[0],y:p[1],z:p[2],rx:p[3],ry:p[4],rz:p[5]};
}
export function crossesHammerImpact(previous,next){return previous<HAMMER_IMPACT&&next>=HAMMER_IMPACT;}
