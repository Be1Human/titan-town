// Continuous float32 working arrays. A task owns complete dynamic islands;
// fixed partners never join otherwise independent groups or receive writes.
// Layout is project-owned, NOT the native 0xFC/0x130 binary class layout.
const F=Math.fround,ROW=18,BLOCK=ROW*3;
export function packVoxelSolver(bodies,constraints,work,{shared=false}={}){
  const alloc=(Type,n)=>new Type(shared?new SharedArrayBuffer(n*Type.BYTES_PER_ELEMENT):new ArrayBuffer(n*Type.BYTES_PER_ELEMENT));
  const order=[],remap=new Int32Array(bodies.length);for(let i=0;i<bodies.length;i++)if(!bodies[i].mobile)order.push(i);const fixed=order.length;for(const i of work.bodies)order.push(i);order.forEach((old,i)=>remap[old]=i);
  const velocity=alloc(Float32Array,bodies.length*6),mass=alloc(Float32Array,bodies.length),angularMin=alloc(Float32Array,bodies.length*3),angularMax=alloc(Float32Array,bodies.length*3);
  order.forEach((old,i)=>{velocity.set(bodies[old].velocity,i*6);mass[i]=bodies[old].invMass;for(let k=0;k<3;k++){angularMin[i*3+k]=bodies[old].angularMin?.[k]??-Infinity;angularMax[i*3+k]=bodies[old].angularMax?.[k]??Infinity;}});
  const data=alloc(Float32Array,constraints.length*BLOCK),indices=alloc(Int32Array,constraints.length*2),kind=alloc(Uint8Array,constraints.length),cap=alloc(Float32Array,constraints.length),friction=alloc(Float32Array,constraints.length),saturated=alloc(Uint8Array,constraints.length);
  work.constraints.forEach((old,i)=>{
    const c=constraints[old];indices[i*2]=remap[c.aIndex];indices[i*2+1]=remap[c.bIndex];kind[i]=c.kind==='ball'?1:0;cap[i]=c.cap??Infinity;friction[i]=c.friction??0;
    const rows=kind[i]?c.rows:[c.normalRow,...c.tangents];rows.forEach((r,j)=>{const at=i*BLOCK+j*ROW;data.set(r.axis,at);data.set(r.ja,at+3);data.set(r.jb,at+6);data.set(r.ia,at+9);data.set(r.ib,at+12);data[at+15]=r.target;data[at+16]=r.effective;data[at+17]=r.lambda;});
  });
  const groups=work.ranges.map(r=>({...r,bodyStart:r.bodyStart+fixed}));
  return {velocity,mass,angularMin,angularMax,data,indices,kind,cap,friction,saturated,groups,order:Int32Array.from(order),constraintOrder:work.constraints,fixed,shared};
}
export function scheduleVoxelSolverTasks(groups,count=1){
  const tasks=Array.from({length:Math.max(1,count)},(_,id)=>({id,groups:[],work:0}));
  for(const group of groups){let best=tasks[0];for(const task of tasks)if(task.work<best.work)best=task;best.groups.push(group);best.work+=group.bodyCount+group.constraintCount;}
  return tasks.filter(t=>t.groups.length);
}
export function executeVoxelSolverTask(pack,groups){
  const {velocity:v,mass,data:r,indices,kind,cap,friction,saturated}=pack;
  const solve=(c,row,limit,normal)=>{
    const at=c*BLOCK+row*ROW,a=indices[c*2],b=indices[c*2+1],va=a*6,vb=b*6;
    let jv=0;for(let k=0;k<3;k++){jv=F(jv+F(r[at+k]*F(v[va+k]-v[vb+k])));jv=F(jv+F(r[at+3+k]*v[va+3+k]));jv=F(jv-F(r[at+6+k]*v[vb+3+k]));}
    let delta=r[at+16]!==0?F(F(r[at+15]-jv)/r[at+16]):0,lambda=F(r[at+17]+delta);
    const lower=normal?0:-limit;if(lambda<lower||lambda>limit){lambda=Math.max(lower,Math.min(limit,lambda));delta=F(lambda-r[at+17]);if(normal&&lambda>=limit&&Number.isFinite(limit))saturated[c]=1;}
    r[at+17]=lambda;if(!delta)return;
    for(let k=0;k<3;k++){
      if(a>=pack.fixed){v[va+k]+=F(F(r[at+k]*mass[a])*delta);v[va+3+k]+=F(r[at+9+k]*delta);}
      if(b>=pack.fixed){v[vb+k]-=F(F(r[at+k]*mass[b])*delta);v[vb+3+k]-=F(r[at+12+k]*delta);}
    }
  };
  for(const group of groups)for(let iteration=0;iteration<8;iteration++){
    for(let c=group.constraintStart;c<group.constraintStart+group.constraintCount;c++){
      if(kind[c]){for(let j=0;j<3;j++)solve(c,j,Infinity,false);}
      else{solve(c,0,cap[c],true);const limit=F(friction[c]*r[c*BLOCK+17]);solve(c,1,limit,false);solve(c,2,limit,false);}
    }
    // 1405F77E0 clamps each angular component against prepared per-body bounds.
    // Caller-supplied limits are explicit; unknown original defaults are not
    // replaced by a guessed, globally fixed angular-speed cap.
    for(let b=group.bodyStart;b<group.bodyStart+group.bodyCount;b++)for(let k=0;k<3;k++)v[b*6+3+k]=Math.max(pack.angularMin[b*3+k],Math.min(pack.angularMax[b*3+k],v[b*6+3+k]));
  }
}
export function unpackVoxelSolver(pack,bodies,constraints){
  pack.order.forEach((old,i)=>bodies[old].velocity.set(pack.velocity.subarray(i*6,i*6+6)));
  pack.constraintOrder.forEach((old,i)=>{const c=constraints[old],rows=pack.kind[i]?c.rows:[c.normalRow,...c.tangents];rows.forEach((r,j)=>r.lambda=pack.data[i*BLOCK+j*ROW+17]);if(!pack.kind[i]){c.cap=pack.cap[i];c.saturated=Boolean(pack.saturated[i]);}});
}
