import {collectVoxelContacts,prepareNearPair} from './voxel-near-phase.js';
import {forEachPackedCandidate} from './packed-collision-reader.js';
import {PackedNearResults,unpackNearResults} from './packed-near-results.js';

// Immutable collision-only snapshots. A later cut publishes a NEW snapshot;
// an outstanding job keeps the old buffers alive until its completion barrier.
// Neither native handles, authored cells nor mutable masks cross the worker.
function copyArray(array,shared){const buffer=shared?new SharedArrayBuffer(array.byteLength):new ArrayBuffer(array.byteLength),out=new array.constructor(buffer);out.set(array);return out;}
function flattenRows(rows){const offsets=new Uint32Array(rows.length+1);let length=0;for(let i=0;i<rows.length;i++){offsets[i]=length;length+=rows[i]?.length||0;}offsets[rows.length]=length;const xs=new Uint32Array(length);for(let i=0;i<rows.length;i++)if(rows[i]?.length)xs.set(rows[i],offsets[i]);return{offsets,xs};}
export function collisionTaskSnapshot(cache,{shared=false}={}){
  const g=cache.grid,{offsets,xs}=flattenRows(cache.featureRows),surface=flattenRows(cache.surfaceRows);
  return {grid:{min:{...g.min},max:{...g.max},width:g.width,depth:g.depth,layer:g.layer},height:cache.height,width:cache.width,depth:cache.depth,mask:copyArray(cache.mask,shared),planes:copyArray(cache.planes,shared),rows:copyArray(cache.rows,shared),offsets:copyArray(offsets,shared),xs:copyArray(xs,shared),surfaceOffsets:copyArray(surface.offsets,shared),surfaceXs:copyArray(surface.xs,shared),revision:cache.contentRevision};
}
export function collisionSnapshotBytes(s){return s.mask.byteLength+s.planes.byteLength+s.rows.byteLength+s.offsets.byteLength+s.xs.byteLength+(s.surfaceOffsets?.byteLength||0)+(s.surfaceXs?.byteLength||0);}
export function collisionTaskReader(snapshot){
  return {...snapshot,taskSnapshot:snapshot,stats:{scanned:0},forEachCandidate:forEachPackedCandidate};
}
export function nearObjectSnapshot(object,cache){
  return {id:object.id,cache,cellSize:object.cellSize,center:{...object.center},position:{...object.position},rotation:{...object.rotation},velocity:{...object.velocity},bounds:{min:{...object.bounds.min},max:{...object.bounds.max}},localBounds:object.localBounds?{min:{...object.localBounds.min},max:{...object.localBounds.max}}:null,alternatePose:object.alternatePose?{position:{...object.alternatePose.position},rotation:{...object.alternatePose.rotation}}:null};
}
export function scheduleNearTasks(pairs,workers=1){
  const jobs=Array.from({length:Math.max(1,Math.min(workers,pairs.length))},()=>({pairs:[],work:0}));
  // Whole pairs are independent; each pair's dual-query order stays unchanged.
  for(let index=0;index<pairs.length;index++){
    const [a,b]=pairs[index],work=Math.max(1,((a.cache.featureBytes||a.cache.mask.length)+(b.cache.featureBytes||b.cache.mask.length))/4);
    let job=jobs[0];for(const candidate of jobs)if(candidate.work<job.work)job=candidate;job.pairs.push(index);job.work+=work;
  }
  return jobs.filter(job=>job.pairs.length);
}
// Per-job ordinal/body indices are contiguous transport data. Positions and
// read-only collision snapshots remain separate; no pair is omitted/reordered.
export function packNearTaskPairs(ordinals,pairs,objectIndex){
  const packed=new Uint32Array(ordinals.length*3);let offset=0;
  for(const ordinal of ordinals){const [a,b]=pairs[ordinal];packed[offset++]=ordinal;packed[offset++]=objectIndex(a);packed[offset++]=objectIndex(b);}
  return packed;
}
function candidateUpperBound(cache,range,stopAt){
  if(!range)return 0;if(!cache.featureRows&&!cache.offsets)return cache.mask.length;
  const g=cache.grid,m=g.min;let total=0;
  for(let z=Math.max(0,range.lo.z-m.z);z<=Math.min(cache.depth-1,range.hi.z-m.z);z++){
    const loY=Math.max(0,range.lo.y-m.y,cache.planes[z*2]),hiY=Math.min(cache.height-1,range.hi.y-m.y,cache.height-1-cache.planes[z*2+1]);
    for(let y=loY;y<=hiY;y++){
      const row=y+z*cache.height,xs=cache.featureRows?cache.featureRows[row]:cache.xs,start=cache.featureRows?0:cache.offsets[row],end=cache.featureRows?xs.length:cache.offsets[row+1],loX=Math.max(0,range.lo.x-m.x,cache.rows[row*2]),hiX=Math.min(cache.width-1,range.hi.x-m.x,cache.width-1-cache.rows[row*2+1]);if(start===end||loX>hiX)continue;
      const lowerBound=value=>{let lo=start,hi=end;while(lo<hi){const mid=(lo+hi)>>>1;if(xs[mid]<value)lo=mid+1;else hi=mid;}return lo;};
      total+=lowerBound(hiX+1)-lowerBound(loX);if(total>stopAt)return total;
    }
  }
  return total;
}
export function prepareSmallNearBatch(pairs,dt,{pairLimit=16,candidateLimit=2048}={}){
  if(pairs.length>pairLimit)return {inline:false,prepared:null,estimatedVisits:null};
  const prepared=[];let estimatedVisits=0;
  for(const [a,b]of pairs){const query=prepareNearPair(a,b,dt);prepared.push(query);
    const count=candidateUpperBound(a.cache,query.ranges[0],candidateLimit)+candidateUpperBound(b.cache,query.ranges[1],candidateLimit);
    // Fast samples add work per candidate. This factor is dispatch policy,
    // not a contact/CCD limit; large batches keep the full worker path.
    estimatedVisits+=count*(query.fast?4:1);if(estimatedVisits>candidateLimit)return {inline:false,prepared:null,estimatedVisits};
  }
  return {inline:true,prepared,estimatedVisits};
}
export function executeNearTask(objects,pairs,dt,{packed=false}={}){
  const start=performance.now(),readers=objects.map(o=>({...o,cache:collisionTaskReader(o.cache)})),readerDone=performance.now(),results=[],stats={scanned:0,tested:0,contacts:0};
  const writer=packed?new PackedNearResults():null,onContact=writer?writer.push.bind(writer):null;
  const compact=pairs instanceof Uint32Array,count=compact?pairs.length/3:pairs.length;if(!Number.isInteger(count))throw Error('Invalid near pair transport');
  for(let k=0;k<count;k++){const index=compact?pairs[k*3]:pairs[k].index,a=compact?pairs[k*3+1]:pairs[k].a,b=compact?pairs[k*3+2]:pairs[k].b;
    if(writer){writer.begin(index);collectVoxelContacts(readers[a],readers[b],{dt,stats,onContact});writer.end();}
    else{const contacts=collectVoxelContacts(readers[a],readers[b],{dt,stats}).map(({indexA,indexB,normal,point,penetration,fast})=>({indexA,indexB,normal,point,penetration,...(fast?{fast:true}:{})}));results.push({index,contacts});}
  }
  return {results,packet:writer?.finish(),stats,readerMs:readerDone-start,queryMs:performance.now()-readerDone,readerViews:readers.reduce((n,o)=>n+(o.cache.featureRows?.length||0),0),indexedRows:objects.reduce((n,o)=>n+o.cache.offsets.length-1,0)};
}
export function nearTaskResults(result){return result.packet?unpackNearResults(result.packet):result.results;}
export function hydrateNearResults(pairs,results){
  const byPair=new Array(pairs.length);for(const result of results)byPair[result.index]=result.contacts;
  return Array.from(pairs,([a,b],index)=>{const contacts=byPair[index];if(!contacts)throw Error('Incomplete near-phase result '+index);return contacts.map(c=>({...c,a,b,materialA:a.materialAt(c.indexA),materialB:b.materialAt(c.indexB),sourceShapeA:a.sourceAt?.(c.indexA),sourceShapeB:b.sourceAt?.(c.indexB)}));});
}
