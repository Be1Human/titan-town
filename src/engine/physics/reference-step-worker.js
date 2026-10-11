import {executeReferenceStep} from './reference-step-kernel.js';
import {VoxelSolverTasks} from './voxel-solver-tasks.js';
const caches=new Map();let tasks=null,busy=false;
self.onmessage=async event=>{
 const {id,input,states}=event.data;if(busy){self.postMessage({id,error:'Overlapping controller steps'});return;}busy=true;
 try{
  Atomics.store(states,0,2);for(const update of input.cacheUpdates)caches.set(update.id,update.snapshot);
  if(!tasks||tasks.solverBackend!==input.solverBackend||tasks.nearBackend!==input.nearBackend){tasks?.dispose();tasks=new VoxelSolverTasks({solverBackend:input.solverBackend,nearBackend:input.nearBackend});}
  const used=new Set(input.objects.map(o=>o.cacheId));for(const key of caches.keys())if(!used.has(key))caches.delete(key);
  const result=await executeReferenceStep(input,caches,tasks);Atomics.store(states,0,3);Atomics.notify(states,0,1);
  self.postMessage({id,result,finishedAt:performance.timeOrigin+performance.now()},[result.bodyOrdinals.buffer,result.velocity.buffer,result.woken.buffer]);
 }catch(error){Atomics.store(states,0,4);Atomics.notify(states,0,1);self.postMessage({id,error:String(error.message||error)});}
 finally{busy=false;}
};
