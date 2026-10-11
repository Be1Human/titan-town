import {CELL, DIRS, MATERIAL_KEYS, chunkOf, coordsOf, keyOf, localIndex} from './voxel-world.js';

// One unit of load is approximately one brick voxel. These are gameplay
// capacities per 10 cm support voxel, not engineering material ratings.
const WEIGHT={plaster:.75,stone:1.2,brick:1,concrete:1.4,wood:.55,darkwood:.55,roof:.8,metal:1.6,rust:1.3,dark:1.8,glass:.25,leaf:.1,fuel:1};
const CAPACITY={plaster:12,stone:28,brick:20,concrete:45,wood:11,darkwood:10,roof:16,metal:90,rust:48,dark:110,glass:3,leaf:1,fuel:4};
const MAX_PLANES=10,MAX_COMPONENTS=24,MAX_COMPONENTS_PER_PLANE=3;
const MAX_BODY_CELLS=15000,MAX_TOTAL_EXAMINED=50000;
const MAX_HORIZONTAL_REACH=80,MAX_HEIGHT=80,MAX_HISTORY_CHUNKS=512;
const MAX_PANEL_TRIES=20,MAX_PANEL_THICKNESS=6;
const removedHistory=new WeakMap();

function historyFor(world){
  let history=removedHistory.get(world);
  if(!history){history=new Map();removedHistory.set(world,history);}
  return history;
}
// Restore an already evaluated preparation state without applying its old cuts
// as a new attack. Subsequent attacks still inherit the accumulated weakening.
export function seedStructuralHistory(world,removed){recordRemoved(historyFor(world),removed);}
function recordRemoved(history,positions){
  for(const p of positions){
    if(p.y<0||p.y>=256||p.x<-512||p.x>=512||p.z<-512||p.z>=512)continue;
    const chunk=chunkOf(p.x,p.y,p.z);
    let bits=history.get(chunk);
    if(!bits){
      bits=new Uint8Array(4096);history.set(chunk,bits);
      if(history.size>MAX_HISTORY_CHUNKS)history.delete(history.keys().next().value);
    }
    const index=localIndex(p.x,p.y,p.z);
    bits[index>>3]|=1<<(index&7);
  }
}
function wasRemoved(history,x,y,z){
  const bits=history.get(chunkOf(x,y,z));
  if(!bits)return false;
  const index=localIndex(x,y,z);
  return Boolean(bits[index>>3]&(1<<(index&7)));
}
function pinned(world,p){
  const anchor=world.foundation?.[p.x+512+(p.z+512)*1024]??0;
  return p.y<=anchor;
}
function collectBody(world,seed,plane,center,stats){
  const queue=[keyOf(seed.x,seed.y,seed.z)],seen=new Set(queue),body=[];
  for(let head=0;head<queue.length;head++){
    if(stats.examined>=MAX_TOTAL_EXAMINED||body.length>=MAX_BODY_CELLS)return {body,seen,truncated:true};
    const p=coordsOf(queue[head]);stats.examined++;
    if(pinned(world,p))return {body,seen,pinned:true};
    body.push({...p,mat:MATERIAL_KEYS[world.getId(p.x,p.y,p.z)]});
    for(const [dx,dy,dz] of DIRS){
      const x=p.x+dx,y=p.y+dy,z=p.z+dz;
      if(y<plane||!world.getId(x,y,z))continue;
      if(Math.abs(x-center.x)>MAX_HORIZONTAL_REACH||Math.abs(z-center.z)>MAX_HORIZONTAL_REACH||y-plane>MAX_HEIGHT)return {body,seen,truncated:true};
      const key=keyOf(x,y,z);
      if(!seen.has(key)){seen.add(key);queue.push(key);}
    }
  }
  return {body,seen,truncated:false};
}
function overloadedBody(world,body,plane,history,removedAtPlane){
  if(body.length<12)return null;
  let mass=0,bodyX=0,bodyZ=0,baseCount=0,capacity=0,supportX=0,supportZ=0,supports=0,lost=0;
  for(const p of body){
    const weight=WEIGHT[p.mat]??1;
    mass+=weight;bodyX+=(p.x+.5)*weight;bodyZ+=(p.z+.5)*weight;
    if(p.y!==plane)continue;
    baseCount++;
    const id=world.getId(p.x,plane-1,p.z);
    if(id){
      const strength=CAPACITY[MATERIAL_KEYS[id]]??10;
      capacity+=strength;supports++;supportX+=(p.x+.5)*strength;supportZ+=(p.z+.5)*strength;
    }else if(wasRemoved(history,p.x,plane-1,p.z))lost++;
  }
  const original=supports+lost;
  if(baseCount<3||supports<1||original<3||lost<2||supports/original>.55)return null;
  const centerX=bodyX/mass,centerZ=bodyZ/mass,pivotX=supportX/capacity,pivotZ=supportZ/capacity;
  const eccentricity=Math.hypot(centerX-pivotX,centerZ-pivotZ);
  const effectiveCapacity=capacity/(1+Math.min(.35,eccentricity/12));
  if(mass<=effectiveCapacity*1.05)return null;
  let directionX=centerX-pivotX,directionZ=centerZ-pivotZ;
  if(Math.hypot(directionX,directionZ)<.1){
    let cutX=0,cutZ=0;
    for(const p of removedAtPlane){cutX+=p.x+.5;cutZ+=p.z+.5;}
    directionX=cutX/removedAtPlane.length-pivotX;directionZ=cutZ/removedAtPlane.length-pivotZ;
  }
  const length=Math.hypot(directionX,directionZ)||1;
  return {
    reason:'overloaded',
    direction:{x:directionX/length,y:0,z:directionZ/length},
    pivot:{x:pivotX*CELL,y:plane*CELL,z:pivotZ*CELL},
    load:mass,capacity:effectiveCapacity,supports,originalSupports:original,
  };
}

function sameMaterialRun(world,p,axis,material){
  let low=p[axis],high=p[axis];
  for(let step=1;step<=9;step++){
    const q={...p,[axis]:p[axis]-step};
    if(world.get(q.x,q.y,q.z)!==material)break;
    low=q[axis];
  }
  for(let step=1;step<=9;step++){
    const q={...p,[axis]:p[axis]+step};
    if(world.get(q.x,q.y,q.z)!==material)break;
    high=q[axis];
  }
  return {low,high,length:high-low+1};
}

// A large imported façade may be joined to a roof and distant side walls, so
// a whole-component flood would never isolate it. This fallback extracts one
// thin vertical panel around the damaged span and prices side/top joints as
// finite tension supports. A wider, thicker or unbounded solid is left alone.
function collectPanel(world,cut,plane,history,stats){
  const reject=reason=>{stats.panelRejects[reason]=(stats.panelRejects[reason]||0)+1;if(stats.panelAttempts.length<12)stats.panelAttempts.push({plane,x:cut.x,z:cut.z,reason});return null;};
  let template=null,material=null,normal=null,tangent=null,normalRun=null;
  for(let y=Math.min(255,plane+24);y>=plane;y--){
    const p={x:cut.x,y,z:cut.z};material=world.get(p.x,p.y,p.z);
    if(!material||pinned(world,p))continue;
    const runX=sameMaterialRun(world,p,'x',material),runZ=sameMaterialRun(world,p,'z',material);
    if(runX.length<=MAX_PANEL_THICKNESS&&runZ.length>=8){template=p;normal='x';tangent='z';normalRun=runX;break;}
    if(runZ.length<=MAX_PANEL_THICKNESS&&runX.length>=8){template=p;normal='z';tangent='x';normalRun=runZ;break;}
  }
  if(!template)return reject('noThinWall');
  const center=cut[tangent];let damagedMin=Infinity,damagedMax=-Infinity,damagedCells=0;
  for(let t=center-MAX_HORIZONTAL_REACH;t<=center+MAX_HORIZONTAL_REACH;t++)for(let n=normalRun.low;n<=normalRun.high;n++){
    const x=normal==='x'?n:t,z=normal==='z'?n:t;
    if(wasRemoved(history,x,plane-1,z)){damagedMin=Math.min(damagedMin,t);damagedMax=Math.max(damagedMax,t);damagedCells++;}
  }
  if(damagedCells<6||damagedMax-damagedMin<2)return reject('smallCut');
  let first=center-MAX_HORIZONTAL_REACH;
  let last=center+MAX_HORIZONTAL_REACH;
  const hasWallAt=t=>{
    let present=false;
    for(let n=normalRun.low;n<=normalRun.high;n++){
      const x=normal==='x'?n:t,z=normal==='z'?n:t;
      if(world.get(x,template.y,z)!==material)continue;
      if(plane<=(world.foundation?.[x+512+(z+512)*1024]??0))return false;
      present=true;
    }
    return present;
  };
  let segmentMin=center,segmentMax=center;
  while(segmentMin>first&&hasWallAt(segmentMin-1))segmentMin--;
  while(segmentMax<last&&hasWallAt(segmentMax+1))segmentMax++;
  // Never judge a narrow damaged window as if it were the entire wall foot.
  // If the panel extends past the local search bound, defer collapse.
  if((segmentMin===first&&hasWallAt(first-1))||(segmentMax===last&&hasWallAt(last+1)))return reject('longWall');
  first=segmentMin;last=segmentMax;
  const footprint=[];
  for(let t=first;t<=last;t++)for(let n=normalRun.low;n<=normalRun.high;n++){
    const x=normal==='x'?n:t,z=normal==='z'?n:t;
    if(world.get(x,template.y,z)===material){
      const p={x,y:template.y,z};
      if(plane<=world.foundation?.[x+512+(z+512)*1024])return reject('pinned');
      footprint.push({x,z,t});
    }
  }
  if(footprint.length<12)return reject('smallFootprint');
  let capacity=0,supportX=0,supportZ=0,supports=0,lost=0;
  for(const p of footprint){
    const id=world.getId(p.x,plane-1,p.z);
    if(id){const strength=CAPACITY[MATERIAL_KEYS[id]]??10;capacity+=strength;supports++;supportX+=(p.x+.5)*strength;supportZ+=(p.z+.5)*strength;}
    else if(wasRemoved(history,p.x,plane-1,p.z))lost++;
  }
  const original=supports+lost;
  if(stats.panelSamples.length<6)stats.panelSamples.push({plane,templateY:template.y,material,footprint:footprint.length,supports,lost,damagedCells});
  if(original<8||lost<Math.max(6,Math.ceil(original*.5))||supports/original>.55)return reject('supported');
  const body=[];let top=plane-1,sideContacts=0;
  for(let y=plane;y<=Math.min(255,plane+MAX_HEIGHT);y++){
    if(stats.examined+footprint.length>MAX_TOTAL_EXAMINED||body.length+footprint.length>MAX_BODY_CELLS)return {truncated:true};
    let outside=0;
    if(y>template.y)for(let t=first;t<=last;t++){
      const x0=normal==='x'?normalRun.low-1:t,z0=normal==='z'?normalRun.low-1:t;
      const x1=normal==='x'?normalRun.high+1:t,z1=normal==='z'?normalRun.high+1:t;
      outside+=Boolean(world.getId(x0,y,z0))+Boolean(world.getId(x1,y,z1));
    }
    if(y>template.y&&outside>footprint.length*.2)break;
    let layer=0;
    for(const p of footprint){
      stats.examined++;
      if(world.get(p.x,y,p.z)!==material)continue;
      body.push({x:p.x,y,z:p.z,mat:material});layer++;
      if(p.t===first||p.t===last){
        const x=normal==='x'?p.x:p.t+(p.t===first?-1:1);
        const z=normal==='z'?p.z:p.t+(p.t===first?-1:1);
        sideContacts+=Boolean(world.getId(x,y,z));
      }
    }
    if(layer)top=y;
    if(y>template.y&&layer===0)break;
  }
  if(body.length<12||top<template.y||top-plane+1<6)return reject('shortPanel');
  let load=0,bodyX=0,bodyZ=0,topContacts=0;
  for(const p of body){const weight=WEIGHT[p.mat]??1;load+=weight;bodyX+=(p.x+.5)*weight;bodyZ+=(p.z+.5)*weight;}
  for(const p of footprint)if(world.getId(p.x,top+1,p.z))topContacts++;
  const centerX=bodyX/load,centerZ=bodyZ/load;
  const pivotX=capacity?supportX/capacity:centerX,pivotZ=capacity?supportZ/capacity:centerZ;
  const eccentricity=Math.hypot(centerX-pivotX,centerZ-pivotZ);
  const joints=sideContacts*.3+topContacts*.5;
  const effectiveCapacity=capacity/(1+Math.min(.35,eccentricity/12))+joints;
  if(load<=effectiveCapacity*1.05)return reject('withinCapacity');
  let directionX=centerX-pivotX,directionZ=centerZ-pivotZ;
  if(Math.hypot(directionX,directionZ)<.1){directionX=cut.x+.5-pivotX;directionZ=cut.z+.5-pivotZ;}
  const length=Math.hypot(directionX,directionZ)||1;
  return {body,failure:{reason:'overloaded',direction:{x:directionX/length,y:0,z:directionZ/length},pivot:{x:pivotX*CELL,y:plane*CELL,z:pivotZ*CELL},load,capacity:effectiveCapacity,supports,originalSupports:original,panel:true}};
}

// Called after the current attack has deleted cells. Only damaged interfaces
// are examined; an oversized or anchored component is left untouched.
export function detachOverloaded(world,removed){
  const stats={candidates:0,panelCandidates:0,examined:0,overloaded:0,truncated:0,panelRejects:{},panelSamples:[],panelAttempts:[]};
  const groups=[],failures=[];
  if(!removed?.length)return {groups,failures,stats};
  const history=historyFor(world);recordRemoved(history,removed);
  const byY=new Map();
  for(const p of removed){let positions=byY.get(p.y);if(!positions){positions=[];byY.set(p.y,positions);}positions.push(p);}
  const levels=[...byY.keys()].sort((a,b)=>a-b);
  const chosen=new Set();
  for(let i=0;i<Math.min(MAX_PLANES,levels.length);i++)chosen.add(levels[Math.round(i*(levels.length-1)/Math.max(1,Math.min(MAX_PLANES,levels.length)-1))]);
  const selected=[...chosen].sort((a,b)=>b-a);
  let panelTries=0;
  for(const y of selected){
    const plane=y+1,positions=byY.get(y),checked=new Set(),completeSeen=new Set();
    const stride=Math.max(1,Math.ceil(positions.length/16));
    const beforeGroups=groups.length;let planeCandidates=0;
    // On the imported map a whole-component flood reaches buildings and roof;
    // ordinary disconnections are already handled by detachLocal.
    if(world.count<100000)for(let i=0;i<positions.length&&planeCandidates<MAX_COMPONENTS_PER_PLANE&&stats.candidates<MAX_COMPONENTS&&stats.examined<MAX_TOTAL_EXAMINED;i+=stride){
      const cut=positions[i];
      for(const [dx,dz] of [[0,0],[1,0],[-1,0],[0,1],[0,-1]]){
        if(planeCandidates>=MAX_COMPONENTS_PER_PLANE||stats.candidates>=MAX_COMPONENTS||stats.examined>=MAX_TOTAL_EXAMINED)break;
        const x=cut.x+dx,z=cut.z+dz,key=keyOf(x,plane,z);
        if(checked.has(key)||!world.getId(x,plane,z))continue;
        if(pinned(world,{x,y:plane,z}))continue;
        stats.candidates++;planeCandidates++;
        const result=collectBody(world,{x,y:plane,z},plane,cut,stats);
        for(const seen of result.seen)checked.add(seen);
        if(result.truncated){stats.truncated++;continue;}
        if(result.pinned)continue;
        for(const seen of result.seen)completeSeen.add(seen);
        const failure=overloadedBody(world,result.body,plane,history,positions);
        if(!failure)continue;
        stats.overloaded++;
        groups.push(result.body);failures.push(failure);
        for(const p of result.body)world.set(p.x,p.y,p.z,null);
        recordRemoved(history,result.body);
      }
    }
    if(groups.length>beforeGroups||panelTries>=MAX_PANEL_TRIES||stats.examined>=MAX_TOTAL_EXAMINED)continue;
    const panelStride=Math.max(1,Math.ceil(positions.length/2));
    for(let i=0;i<positions.length&&panelTries<MAX_PANEL_TRIES&&stats.examined<MAX_TOTAL_EXAMINED;i+=panelStride){
      const cut=positions[i];
      if(pinned(world,{x:cut.x,y:plane,z:cut.z}))continue;
      if(completeSeen.has(keyOf(cut.x,plane,cut.z)))continue;
      panelTries++;stats.panelCandidates++;
      const panel=collectPanel(world,cut,plane,history,stats);
      if(panel?.truncated){stats.truncated++;continue;}
      if(!panel)continue;
      stats.overloaded++;
      groups.push(panel.body);failures.push(panel.failure);
      for(const p of panel.body)world.set(p.x,p.y,p.z,null);
      recordRemoved(history,panel.body);
      break;
    }
  }
  return {groups,failures,stats};
}
