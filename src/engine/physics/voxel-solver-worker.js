import {executeVoxelSolverTask} from './packed-voxel-solver.js';
import {executeNearTask} from './voxel-near-tasks.js';
const nearCaches=new Map();
let wasmError=null,wasmKernel=null;const kernelPromise=new URL(self.location.href).searchParams.get('solver')==='wasm'?import('./wasm-voxel-solver.js').then(m=>m.createWasmVoxelSolver()).then(kernel=>(wasmKernel=kernel)).catch(error=>{wasmError=String(error.message||error);return null;}):null;
let wasmNearError=null,wasmNearKernel=null;const nearPromise=new URL(self.location.href).searchParams.get('near')==='wasm'?import('./wasm-voxel-near.js').then(m=>m.createWasmVoxelNear()).then(kernel=>(wasmNearKernel=kernel)).catch(error=>{wasmNearError=String(error.message||error);return null;}):null;
self.onmessage=async event=>{
  const {id,pack,groups,states,slot}=event.data,started=performance.now();
  try{
    Atomics.store(states,slot,2);
    let result=null;
    if(event.data.kind==='near'){
      for(const update of event.data.cacheUpdates||[])nearCaches.set(update.id,update.snapshot);
      const used=new Set(),objects=event.data.objects.map(o=>{if(o.cache)return o;used.add(o.cacheId);const cache=nearCaches.get(o.cacheId);if(!cache||cache.revision!==o.cacheRevision)throw Error('Missing current near cache '+o.cacheId);return {...o,cache};});
      for(const key of nearCaches.keys())if(!used.has(key))nearCaches.delete(key);
      const kernel=nearPromise&&!wasmNearError?await nearPromise:null;if(kernel)try{result=kernel.execute(objects,event.data.pairs,event.data.dt);}catch(error){wasmNearError=String(error.message||error);}if(!result)result=executeNearTask(objects,event.data.pairs,event.data.dt,{packed:true});
    }
    let wasm=null;if(!result){const kernel=kernelPromise&&!wasmError?await kernelPromise:null;if(kernel)try{wasm=kernel.execute(pack,groups);}catch(error){wasmError=String(error.message||error);}if(!wasm)executeVoxelSolverTask(pack,groups);}
    Atomics.store(states,slot,3);Atomics.notify(states,slot,1);
    const transfer=result?.packet?[result.packet.pairs.buffer,result.packet.values.buffer]:[];
    self.postMessage({id,ms:performance.now()-started,finishedAt:performance.timeOrigin+performance.now(),wasm,wasmError,wasmNearError,wasmHeapBytes:wasmKernel?.memory.buffer.byteLength??0,wasmNearHeapBytes:wasmNearKernel?.memory.buffer.byteLength??0,...result},transfer);
  }catch(error){Atomics.store(states,slot,4);Atomics.notify(states,slot,1);self.postMessage({id,error:String(error.message||error)});}
};
