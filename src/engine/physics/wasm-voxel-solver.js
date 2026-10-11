import {solverWasmBase64} from './packed-voxel-solver-binary.js';
let compiled;
const fields=['velocity','mass','angularMin','angularMax','data','indices','kind','cap','friction','saturated'];
export async function createWasmVoxelSolver(){
 compiled??=WebAssembly.compile(Uint8Array.from(atob(solverWasmBase64),c=>c.charCodeAt(0)));
 const instance=await WebAssembly.instantiate(await compiled);return new WasmVoxelSolver(instance);
}
class WasmVoxelSolver {
 constructor(instance){this.exports=instance.exports;this.memory=instance.exports.memory;this.heap=Number(instance.exports.__heap_base.value);this.stats={};}
 execute(pack,groups){
  const started=performance.now(),pointers={},align=n=>Math.ceil(n/16)*16;let end=align(this.heap);
  for(const g of groups)if(g.bodyStart<pack.fixed||g.bodyStart+g.bodyCount>pack.velocity.length/6||g.constraintStart<0||g.constraintStart+g.constraintCount>pack.saturated.length)throw Error('Invalid WASM solver island range');
  for(const field of fields){pointers[field]=end;end=align(end+pack[field].byteLength);}const groupAt=end;end+=groups.length*16;
  if(end>this.memory.buffer.byteLength)this.memory.grow(Math.ceil((end-this.memory.buffer.byteLength)/65536));
  let bytesIn=0;for(const field of fields){const input=pack[field];new Uint8Array(this.memory.buffer,pointers[field],input.byteLength).set(new Uint8Array(input.buffer,input.byteOffset,input.byteLength));bytesIn+=input.byteLength;}
  const ranges=new Uint32Array(this.memory.buffer,groupAt,groups.length*4);groups.forEach((g,i)=>ranges.set([g.bodyStart,g.bodyCount,g.constraintStart,g.constraintCount],i*4));const copiedAt=performance.now();
  this.exports.solve(...fields.map(f=>pointers[f]),groupAt,groups.length,pack.fixed);const solvedAt=performance.now();
  const velocity=new Float32Array(this.memory.buffer,pointers.velocity,pack.velocity.length),data=new Float32Array(this.memory.buffer,pointers.data,pack.data.length),saturated=new Uint8Array(this.memory.buffer,pointers.saturated,pack.saturated.length);let bytesOut=0;
  // Parallel workers own complete disjoint mobile islands. Never copy the
  // entire snapshot back: that would overwrite another worker's body results.
  for(const g of groups){pack.velocity.set(velocity.subarray(g.bodyStart*6,(g.bodyStart+g.bodyCount)*6),g.bodyStart*6);bytesOut+=g.bodyCount*24;for(let c=g.constraintStart;c<g.constraintStart+g.constraintCount;c++){for(let j=0;j<3;j++)pack.data[c*54+j*18+17]=data[c*54+j*18+17];pack.saturated[c]=saturated[c];bytesOut+=13;}}
  this.stats={backend:'wasm-f32',copyInMs:copiedAt-started,kernelMs:solvedAt-copiedAt,copyOutMs:performance.now()-solvedAt,bytesIn,bytesOut,memoryBytes:this.memory.buffer.byteLength,totalMs:performance.now()-started};return this.stats;
 }
}
