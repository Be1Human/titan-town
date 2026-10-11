import {collisionTaskReader} from './voxel-near-tasks.js';
import {VoxelBroadPhase} from './voxel-broad-phase.js';
import {fixedBodyWork,prepareContactConstraint,prepareBallConstraint,solveVoxelRowsAsync} from './voxel-row-solver.js';
import {REFERENCE_MATERIALS} from '../core/reference-materials.js';

export const STEP_MATERIAL_TYPES=Object.freeze(Object.keys(REFERENCE_MATERIALS));

// A controller task owns broad/near-phase, wake propagation, preparation and
// all eight solver iterations. Geometry edits and native-handle writes remain
// behind the caller's epoch barrier. Nested tasks keep complete pair/island
// ownership; the controller never waits for the rendering thread between them.
export async function executeReferenceStep(input,caches,tasks){
 const start=performance.now(),objects=input.objects.map((o,ordinal)=>{
  const snapshot=caches.get(o.cacheId);if(!snapshot||snapshot.revision!==o.cacheRevision)throw Error('Missing current step collision cache '+o.cacheId);
  return {...o,ordinal,cache:collisionTaskReader(snapshot),materialAt:i=>STEP_MATERIAL_TYPES[snapshot.materialKinds[i]],entry:o.dynamic?o.entry:null};
 }),dynamic=objects.slice(0,input.dynamicCount),statics=objects.slice(input.dynamicCount),excluded=new Set(input.excludedPairs),broad=new VoxelBroadPhase(),seen=new Set(),contacts=[],taskRounds=[],woken=[],stats={scanned:0,tested:0,contacts:0};let pairCount=0;
 const preparedAt=performance.now();
 while(true){
  broad.update({staticObjects:statics,active:dynamic.filter(o=>!o.sleeping),sleeping:dynamic.filter(o=>o.sleeping)});
  const next=[];for(const pair of broad.collect({qualify:(a,b)=>!excluded.has([a.id,b.id].sort().join('|'))})){
   const [a,b]=pair,key=a.id<b.id?a.id+'|'+b.id:b.id+'|'+a.id;if(!seen.has(key)){seen.add(key);next.push(pair);}
  }
  if(!next.length)break;pairCount+=next.length;
  const result=await tasks.executeNear(next,input.dt);taskRounds.push(result.tasks);for(const key of ['scanned','tested','contacts'])stats[key]+=result.stats[key];let wakes=0;
  for(let i=0;i<next.length;i++){const local=result.byPair[i];for(const c of local)contacts.push(c);if(local.length)for(const object of next[i])if(object.dynamic&&object.sleeping){object.sleeping=false;woken.push(object.ordinal);wakes++;}}
  if(!wakes)break;
 }
 const nearAt=performance.now(),bodyWork=[fixedBodyWork()],bodyOrdinals=[],indices=new Map();
 for(const object of dynamic)if(!object.sleeping){const initial=input.bodyStates[object.ordinal];indices.set(object.id,bodyWork.length);bodyOrdinals.push(object.ordinal);bodyWork.push({...initial,velocity:new Float64Array(initial.velocity),mobile:true});}
 const constraints=[];
 for(const contact of contacts){const a=indices.get(contact.a.id)||0,b=indices.get(contact.b.id)||0;if(!a&&!b)continue;const c=prepareContactConstraint(contact,bodyWork[a],bodyWork[b],input.dt);c.aIndex=a;c.bIndex=b;constraints.push(c);}
 for(const joint of input.joints){const a=joint.aId===null?0:indices.get(joint.aId)||0,b=joint.bId===null?0:indices.get(joint.bId)||0;if(!a&&!b)continue;const c=prepareBallConstraint(bodyWork[a],bodyWork[b],joint.pointA,joint.pointB,input.dt);c.aIndex=a;c.bIndex=b;constraints.push(c);}
 const rowsAt=performance.now(),groups=await solveVoxelRowsAsync(bodyWork,constraints,tasks),solveAt=performance.now(),velocity=new Float64Array(bodyOrdinals.length*6);
 bodyOrdinals.forEach((ordinal,i)=>velocity.set(bodyWork[i+1].velocity,i*6));
 const damage=[];for(const c of constraints)if(c.saturated&&Number.isFinite(c.cap)&&c.normalRow.lambda>=c.cap)damage.push({a:c.a.ordinal,b:c.b.ordinal,indexA:c.indexA,indexB:c.indexB,cap:c.cap,capA:c.capA,capB:c.capB,point:c.point,speed:c.speed,lambda:c.normalRow.lambda});
 return {bodyOrdinals:Uint32Array.from(bodyOrdinals),velocity,woken:Uint32Array.from(woken),damage,groups:{ranges:groups.ranges,bodies:groups.bodies,tasks:groups.tasks},stats:{pairs:pairCount,...stats,constraints:constraints.length,islands:groups.ranges.length,wakes:woken.length,controllerPrepareCpuMs:preparedAt-start,nearWallMs:nearAt-preparedAt,rowPrepareCpuMs:rowsAt-nearAt,solveWallMs:solveAt-rowsAt,resultCpuMs:performance.now()-solveAt,wallMs:performance.now()-start,nearTasks:taskRounds,tasks:groups.tasks}};
}
