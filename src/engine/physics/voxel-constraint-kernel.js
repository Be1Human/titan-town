// Reconstructed narrow mechanisms, not recovered class declarations.
// 1405F80A0 / 14051FAA0: only mobile partners add dynamic graph edges.
// 1405FD110: contiguous body/constraint ranges; 1405F7AE0: eight iterations.
export function groupConstraints(mobile,constraints){
  const adjacency=Array.from(mobile,()=>[]),labels=new Int32Array(mobile.length).fill(-1);
  for(const c of constraints)if(mobile[c.a]&&mobile[c.b]){adjacency[c.a].push(c.b);adjacency[c.b].push(c.a);}
  const bodies=[],ranges=[];
  for(let seed=0;seed<mobile.length;seed++)if(mobile[seed]&&labels[seed]<0){
    const group=ranges.length,start=bodies.length,stack=[seed];labels[seed]=group;
    while(stack.length){const b=stack.pop();bodies.push(b);for(const n of adjacency[b])if(labels[n]<0){labels[n]=group;stack.push(n);}}
    ranges.push({bodyStart:start,bodyCount:bodies.length-start,constraintStart:0,constraintCount:0});
  }
  const rows=Array.from(ranges,()=>[]);
  constraints.forEach((c,i)=>{const group=labels[c.a]>=0?labels[c.a]:labels[c.b];if(group>=0)rows[group].push(i);});
  const ordered=[];rows.forEach((row,i)=>{ranges[i].constraintStart=ordered.length;ranges[i].constraintCount=row.length;for(const index of row)ordered.push(index);});
  return {labels,bodies:Int32Array.from(bodies),constraints:Int32Array.from(ordered),ranges};
}

// 1405FDF80: preserve the unclamped division delta. Computing new-old in
// every branch is not float32-equivalent to the source's unclamped branch.
export function accumulateNormalImpulse(old,target,jv,effective,cap){
  const f=Math.fround;let delta=effective!==0?f(f(target-jv)/effective):0,lambda=f(old+delta),limited=false;
  if(lambda<0||lambda>cap){lambda=lambda<0?0:cap;delta=f(lambda-old);limited=true;}
  return {lambda,delta,limited};
}
export function accumulateFrictionImpulse(old,target,jv,effective,friction,normalLambda){
  const f=Math.fround,limit=f(friction*normalLambda);let delta=effective!==0?f(f(target-jv)/effective):0,lambda=f(old+delta),limited=false;
  if(lambda<-limit||lambda>limit){lambda=Math.max(-limit,Math.min(limit,lambda));delta=f(lambda-old);limited=true;}
  return {lambda,delta,limited};
}
export function solveConstraintGroups(work,solveRow,prepareGroup=()=>{},finishGroup=()=>{}){
  for(const range of work.ranges){prepareGroup(range);for(let iteration=0;iteration<8;iteration++)for(let i=range.constraintStart;i<range.constraintStart+range.constraintCount;i++)solveRow(work.constraints[i],iteration);finishGroup(range);}
}
