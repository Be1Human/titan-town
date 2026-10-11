import {collisionTaskSnapshot,collisionSnapshotBytes,nearObjectSnapshot} from './voxel-near-tasks.js';
import {physicalTypeForMaterial} from '../core/reference-materials.js';
import {STEP_MATERIAL_TYPES,executeReferenceStep} from './reference-step-kernel.js';
import {VoxelSolverTasks} from './voxel-solver-tasks.js';

export class ReferenceStepTasks {
 constructor(){this.enabled=typeof Worker!=='undefined'&&globalThis.crossOriginIsolated===true&&typeof SharedArrayBuffer!=='undefined';this.snapshots=new WeakMap();this.nextCacheId=1;this.nextId=1;this.sent=new Set();this.worker=null;this.pending=null;this.disposed=false;this.stats={mode:'synchronous'};}
 _worker(){
  if(this.worker)return this.worker;const worker=new Worker(new URL('./reference-step-worker.js',import.meta.url),{type:'module'});this.worker=worker;
  worker.onmessage=event=>{const pending=this.pending;if(!pending||pending.id!==event.data.id)return;this.pending=null;if(event.data.error)pending.reject(Error(event.data.error));else pending.resolve({...event.data,replyLagMs:Math.max(0,performance.timeOrigin+performance.now()-event.data.finishedAt)});};
  worker.onerror=event=>{const pending=this.pending;this.pending=null;this.worker=null;worker.terminate();pending?.reject(Error(event.message||'Step controller failed'));};return worker;
 }
 prepare({objects,staticObjects,excludedPairs,bodyStates,joints,dt,solverBackend='js',nearBackend='js'}){
  const started=performance.now(),caches=new Map(),cacheUpdates=[],all=[...objects,...staticObjects];let copiedBytes=0;
  const inputs=all.map(o=>{
   let record=this.snapshots.get(o.cache);if(!record||record.revision!==o.cache.contentRevision){
    const snapshot=collisionTaskSnapshot(o.cache,{shared:this.enabled}),buffer=this.enabled?new SharedArrayBuffer(o.cache.mask.length):new ArrayBuffer(o.cache.mask.length),materialKinds=new Uint8Array(buffer);
    for(let i=0;i<materialKinds.length;i++)if(o.cache.mask[i]&63)materialKinds[i]=STEP_MATERIAL_TYPES.indexOf(physicalTypeForMaterial(o.cache.materialAt(i)));
    snapshot.materialKinds=materialKinds;record={id:record?.id??this.nextCacheId++,snapshot,revision:o.cache.contentRevision};this.snapshots.set(o.cache,record);copiedBytes+=collisionSnapshotBytes(snapshot)+materialKinds.byteLength;
   }
   caches.set(record.id,record.snapshot);const key=record.id+':'+record.revision;if(!this.sent.has(key)){cacheUpdates.push({id:record.id,snapshot:record.snapshot});this.sent.add(key);}
   const pose=nearObjectSnapshot(o,null);delete pose.cache;
   return {...pose,bodyId:o.bodyId,dynamic:Boolean(o.entry),sleeping:o.entry?o.entry.body.isSleeping():false,entry:o.entry?{contactFracture:o.entry.contactFracture,strength:o.entry.strength}:null,friction:o.friction,frictionCombineRule:o.frictionCombineRule,layers:o.layers,mask:o.mask,group:o.group,cacheId:record.id,cacheRevision:record.revision};
  });
  this.sent=new Set(inputs.map(o=>o.cacheId+':'+o.cacheRevision));
  const states=bodyStates.map(s=>({mobile:true,invMass:s.invMass,inertia:s.inertia,com:s.com,velocity:s.velocity,angularMin:s.angularMin,angularMax:s.angularMax}));
  return {input:{objects:inputs,dynamicCount:objects.length,cacheUpdates,bodyStates:states,joints,excludedPairs:[...excludedPairs],dt,solverBackend,nearBackend},caches,prepareCpuMs:performance.now()-started,copiedBytes,snapshotBytes:[...caches.values()].reduce((n,s)=>n+collisionSnapshotBytes(s)+s.materialKinds.byteLength,0)};
 }
 async execute(job){
  if(this.disposed)throw Error('Step controller disposed');if(this.pending)throw Error('Overlapping step tasks');const prepared=this.prepare(job),started=performance.now();let reply;
  if(this.enabled){const id=this.nextId++,states=new Int32Array(new SharedArrayBuffer(4));Atomics.store(states,0,1);
   try{const worker=this._worker();reply=await new Promise((resolve,reject)=>{this.pending={id,resolve,reject,states};try{worker.postMessage({id,input:prepared.input,states});}catch(error){this.pending=null;reject(error);}});if(Atomics.load(states,0)!==3)throw Error('Controller completion barrier failed');}
   catch(error){if(this.disposed)throw error;this.worker?.terminate();this.worker=null;this.enabled=false;this.sent.clear();this.failure=String(error.message||error);}
  }
  if(!reply){this.fallback??=new VoxelSolverTasks();this.fallback.disable();reply={result:await executeReferenceStep(prepared.input,prepared.caches,this.fallback),replyLagMs:0};}
  this.stats={mode:this.enabled?'controller-worker':this.failure?'failure-fallback':'synchronous',error:this.failure??null,prepareCpuMs:prepared.prepareCpuMs,copiedBytes:prepared.copiedBytes,snapshotBytes:prepared.snapshotBytes,replyLagMs:reply.replyLagMs,wallMs:performance.now()-started};return {...reply.result,controller:this.stats};
 }
 hasCompletedJobs(){return Boolean(this.pending&&Atomics.load(this.pending.states,0)>=3);}
 dispose(){this.disposed=true;this.worker?.terminate();this.worker=null;this.pending?.reject(Error('Step controller cancelled'));this.pending=null;this.fallback?.dispose();this.sent.clear();this.snapshots=new WeakMap();}
}
