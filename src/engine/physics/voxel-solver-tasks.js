import {scheduleVoxelSolverTasks,executeVoxelSolverTask} from './packed-voxel-solver.js';
import {collectVoxelContacts} from './voxel-near-phase.js';
import {collisionTaskSnapshot,collisionSnapshotBytes,nearObjectSnapshot,scheduleNearTasks,packNearTaskPairs,hydrateNearResults,prepareSmallNearBatch,nearTaskResults} from './voxel-near-tasks.js';

// Reusable solver-job slots; bounded admission, main-thread fallback, atomic
// completion and a barrier before writeback. Worker count is project policy,
// not an assertion about the original pool's still-unknown configured size.
export class VoxelSolverTasks {
  constructor({workers=Math.min(4,Math.max(1,(globalThis.navigator?.hardwareConcurrency||2)-1)),solverBackend='js',nearBackend='js'}={}){
    this.enabled=typeof Worker!=='undefined'&&globalThis.crossOriginIsolated===true&&typeof SharedArrayBuffer!=='undefined';
    this.workerCount=this.enabled?workers:0;this.slots=[];this.nextId=1;this.disposed=false;this.stats={threads:0,mode:'synchronous'};this.snapshots=new WeakMap();this.snapshotIds=new WeakMap();this.nextSnapshotId=1;
    this.solverBackend=solverBackend==='wasm'?'wasm':'js';
    this.nearBackend=nearBackend==='wasm'?'wasm':'js';
  }
  _slot(){
    let slot=this.slots.find(s=>!s.pending);if(slot)return slot;
    if(this.slots.length>=this.workerCount)return null;
    const url=new URL('./voxel-solver-worker.js',import.meta.url);if(this.solverBackend==='wasm')url.searchParams.set('solver','wasm');if(this.nearBackend==='wasm')url.searchParams.set('near','wasm');const worker=new Worker(url,{type:'module'});slot={worker,pending:null,cacheIds:new Set()};
    worker.onmessage=event=>{const pending=slot.pending;if(!pending||pending.id!==event.data.id)return;slot.pending=null;slot.wasmHeapBytes=event.data.wasmHeapBytes??slot.wasmHeapBytes??0;slot.wasmNearHeapBytes=event.data.wasmNearHeapBytes??slot.wasmNearHeapBytes??0;if(event.data.error)pending.reject(new Error(event.data.error));else pending.resolve({...event.data,replyLagMs:Math.max(0,performance.timeOrigin+performance.now()-event.data.finishedAt)});};
    worker.onerror=event=>{const pending=slot.pending;slot.pending=null;worker.terminate();slot.worker=null;pending?.reject(new Error(event.message||'Solver worker failed'));};
    this.slots.push(slot);return slot;
  }
  async execute(pack){
    if(this.disposed)throw new Error('Solver task pool disposed');
    const started=performance.now(),tasks=scheduleVoxelSolverTasks(pack.groups,this.workerCount||1),states=this.enabled?new Int32Array(new SharedArrayBuffer(tasks.length*4)):null,promises=[];let mainMs=0,queued=0;
    tasks.forEach((task,index)=>{
      // Tiny tasks and full queues execute here. Their islands retain all
      // rows and all eight iterations; this does not drop or sleep bodies.
      const slot=this.enabled&&task.work>=64?this._slot():null;
      if(!slot?.worker){const t=performance.now();executeVoxelSolverTask(pack,task.groups);mainMs+=performance.now()-t;return;}
      const id=this.nextId++;Atomics.store(states,index,1);queued++;
      promises.push(new Promise((resolve,reject)=>{slot.pending={id,resolve,reject,states,index};slot.worker.postMessage({id,pack,groups:task.groups,states,slot:index});}).then(result=>{if(Atomics.load(states,index)!==3)throw new Error('Solver completion barrier failed');return result;}));
    });
    const results=await Promise.allSettled(promises);const failure=results.find(r=>r.status==='rejected');
    if(failure){this.dispose();throw failure.reason;}
    const times=results.map(r=>r.value.ms),wasm=results.map(r=>r.value.wasm).filter(Boolean);this.stats={threads:queued,records:this.slots.length,executed:tasks.length,mode:queued?'workers':'synchronous',solverBackend:this.solverBackend,wasmJobs:wasm.length,wasmKernelTotalMs:wasm.reduce((n,w)=>n+w.kernelMs,0),wasmCopyTotalMs:wasm.reduce((n,w)=>n+w.copyInMs+w.copyOutMs,0),wasmMemoryBytes:wasm.reduce((n,w)=>n+w.memoryBytes,0),wasmResidentBytes:this.slots.reduce((n,s)=>n+(s.wasmHeapBytes||0),0),wasmError:results.map(r=>r.value.wasmError).find(Boolean)??null,mainMs,workerCpuTotalMs:times.reduce((a,b)=>a+b,0),workerCpuMaxMs:Math.max(0,...times),replyLagMaxMs:Math.max(0,...results.map(r=>r.value.replyLagMs)),wallMs:performance.now()-started};
    return this.stats;
  }
  async executeNear(pairs,dt){
    if(this.disposed)throw new Error('Near-phase task pool disposed');
    // Small local batches and a full queue retain current-thread completion.
    // A forced extra main job was measured and withdrawn: lower final near
    // time did not improve the entire dense-pile observation on this client.
    const started=performance.now(),small=prepareSmallNearBatch(pairs,dt),jobs=scheduleNearTasks(pairs,small.inline?1:this.workerCount||1),states=this.enabled?new Int32Array(new SharedArrayBuffer(jobs.length*4)):null,results=[],promises=[],stats={scanned:0,tested:0,contacts:0};
    let mainMs=0,mainJobs=0,queued=0,copiedBytes=0,snapshotMs=0,cacheUpdatesCount=0;const usedSnapshots=new Set(),objectSnapshots=new Map();
    const addStats=s=>{for(const key of ['scanned','tested','contacts'])stats[key]+=s[key];};
    const snapshotFor=cache=>{
      if(cache.taskSnapshot){usedSnapshots.add(cache.taskSnapshot);return cache.taskSnapshot;}
      let snapshot=this.snapshots.get(cache);if(!snapshot||snapshot.revision!==cache.contentRevision){const start=performance.now();snapshot=collisionTaskSnapshot(cache,{shared:true});snapshotMs+=performance.now()-start;this.snapshots.set(cache,snapshot);copiedBytes+=collisionSnapshotBytes(snapshot);}usedSnapshots.add(snapshot);return snapshot;
    };
    for(let index=0;index<jobs.length;index++){
      const job=jobs[index],slot=this.enabled&&!small.inline&&job.work>=64?this._slot():null;
      if(!slot?.worker){mainJobs++;const t=performance.now();for(const ordinal of job.pairs){const [a,b]=pairs[ordinal],contacts=collectVoxelContacts(a,b,{dt,stats,prepared:small.prepared?.[ordinal]});results.push({index:ordinal,contacts});}mainMs+=performance.now()-t;continue;}
      const objects=[],ids=new Map(),objectIndex=o=>{let value=ids.get(o);if(value===undefined){value=objects.length;ids.set(o,value);let snapshot=objectSnapshots.get(o);if(!snapshot){snapshot=nearObjectSnapshot(o,snapshotFor(o.cache));objectSnapshots.set(o,snapshot);}objects.push(snapshot);}return value;};
      const taskPairs=packNearTaskPairs(job.pairs,pairs,objectIndex),cacheUpdates=[],usedIds=new Set(),wireObjects=objects.map(o=>{const snapshot=o.cache;let cacheId=this.snapshotIds.get(snapshot);if(cacheId===undefined){cacheId=this.nextSnapshotId++;this.snapshotIds.set(snapshot,cacheId);}usedIds.add(cacheId);if(!slot.cacheIds.has(cacheId)){slot.cacheIds.add(cacheId);cacheUpdates.push({id:cacheId,snapshot});}return {...o,cache:undefined,cacheId,cacheRevision:snapshot.revision};}),id=this.nextId++;cacheUpdatesCount+=cacheUpdates.length;slot.cacheIds=usedIds;Atomics.store(states,index,1);queued++;
      promises.push(new Promise((resolve,reject)=>{slot.pending={id,resolve,reject,states,index};slot.worker.postMessage({id,kind:'near',objects:wireObjects,cacheUpdates,pairs:taskPairs,dt,states,slot:index},[taskPairs.buffer]);}).then(result=>{if(Atomics.load(states,index)!==3)throw Error('Near-phase completion barrier failed');return result;}));
    }
    const settled=await Promise.allSettled(promises),failure=settled.find(r=>r.status==='rejected');
    if(failure){this.disable();const retry=await this.executeNear(pairs,dt);retry.tasks={...retry.tasks,mode:'failure-fallback',error:String(failure.reason?.message||failure.reason)};return retry;}
    for(const r of settled){for(const result of nearTaskResults(r.value))results.push(result);addStats(r.value.stats);}const times=settled.map(r=>r.value.ms);
    const byPair=hydrateNearResults(pairs,results),snapshotBytes=[...usedSnapshots].reduce((n,s)=>n+collisionSnapshotBytes(s),0);
    const workerStages=settled.map(r=>r.value);
    return {byPair,stats,tasks:{mode:queued?'workers':'synchronous',inlineSmall:small.inline,estimatedVisits:small.estimatedVisits,threads:queued,records:this.slots.length,executed:jobs.length,mainJobs,mainMs,snapshotMs,copiedBytes,snapshotBytes,cacheUpdates:cacheUpdatesCount,nearBackend:this.nearBackend,wasmNearJobs:workerStages.filter(s=>s.wasmNear).length,wasmNearKernelTotalMs:workerStages.reduce((n,s)=>n+(s.wasmNear?.kernelMs||0),0),wasmNearRangeTotalMs:workerStages.reduce((n,s)=>n+(s.wasmNear?.rangeCpuMs||0),0),wasmNearBindTotalMs:workerStages.reduce((n,s)=>n+(s.wasmNear?.bindCpuMs||0),0),wasmNearOutputTotalMs:workerStages.reduce((n,s)=>n+(s.wasmNear?.outputCpuMs||0),0),wasmNearCopiedBytes:workerStages.reduce((n,s)=>n+(s.wasmNear?.copiedBytes||0),0),wasmNearCacheBytes:workerStages.reduce((n,s)=>n+(s.wasmNear?.cacheBytes||0),0),wasmNearResidentBytes:this.slots.reduce((n,s)=>n+(s.wasmNearHeapBytes||0),0),wasmNearError:workerStages.map(s=>s.wasmNearError).find(Boolean)??null,workerCpuTotalMs:times.reduce((a,b)=>a+b,0),workerCpuMaxMs:Math.max(0,...times),readerCpuTotalMs:workerStages.reduce((n,s)=>n+s.readerMs,0),readerCpuMaxMs:Math.max(0,...workerStages.map(s=>s.readerMs)),queryCpuTotalMs:workerStages.reduce((n,s)=>n+s.queryMs,0),queryCpuMaxMs:Math.max(0,...workerStages.map(s=>s.queryMs)),readerViews:workerStages.reduce((n,s)=>n+s.readerViews,0),replyLagMaxMs:Math.max(0,...workerStages.map(s=>s.replyLagMs)),wallMs:performance.now()-started}};
  }
  hasCompletedJobs(){return this.slots.some(s=>s.pending?.states&&Atomics.load(s.pending.states,s.pending.index)>=3);}
  dispose(){this.disposed=true;for(const slot of this.slots){slot.worker?.terminate();slot.pending?.reject(new Error('Physics task cancelled'));slot.pending=null;}this.slots=[];this.snapshots=new WeakMap();this.snapshotIds=new WeakMap();}
  disable(){this.dispose();this.enabled=false;this.workerCount=0;this.disposed=false;}
}
