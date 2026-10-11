import {VoxelWorld,MATERIAL_IDS,localIndex} from './voxel-world.js';
import {detachOverloaded,seedStructuralHistory} from './structural-support.js';
let world=null,epoch=-1,pending=[],proposalSequence=0,analysisSequence=0;
self.onmessage=({data})=>{
  const started=performance.now();
  if(data.initialize){world=new VoxelWorld();world.foundation=data.foundation;epoch=data.epoch;pending=[];proposalSequence=0;analysisSequence=0;}
  if(!world||epoch!==data.epoch)return;
  if(data.acknowledgements?.length){
    const completed=new Set(data.acknowledgements.filter(item=>['committed','permanent-rejection','stale'].includes(item.status)).map(item=>item.proposalId));
    pending=pending.filter(item=>!completed.has(item.proposalId));
  }
  // Queue acknowledgements do not rerun connectivity, clone chunks or produce
  // a new proposal. Transient physics failures remain in the authority queue.
  if(!Array.isArray(data.chunks))return;
  const removed=[];let hasAddition=false;
  for(const c of data.chunks){
    const old=world.chunks.get(c.key);
    if(old&&!data.initialize)for(let i=0;i<32768;i++){
      if(old.data[i]&&!c.data[i])removed.push({x:c.x+(i&31),y:c.y+(i>>10),z:c.z+((i>>5)&31)});
      if(!old.data[i]&&c.data[i])hasAddition=true;
    }
    world.chunks.set(c.key,c);
  }
  // A preparation save can contain a weakened wall whose asynchronous support
  // check had not finished. Reconstruct those cuts from the original chunks.
  if(data.initialize)for(const original of data.baselineChunks||[]){
    const current=world.chunks.get(original.key);
    for(let i=0;i<32768;i++)if(original.data[i]&&!current?.data[i])removed.push({x:original.x+(i&31),y:original.y+(i>>10),z:original.z+((i>>5)&31)});
  }
  world.count=data.count;
  // Fresh maps use prepared supports; restored snapshots are rechecked.
  // Later deltas include empty chunks so deleted supports stay deleted.
  // The baseline already proves the intact ground is supported. A save only
  // needs to recheck components touching its cuts, not flood the solid earth.
  const disconnected=data.initialize?(data.checkAll?world.detachUnsupported():data.checkInitial?(data.baselineChunks?.length?world.detachLocal(removed):world.detachUnsupported()):[]):world.detachLocal(removed);
  const examined=world.supportStats?.examined??0;
  const settledRestore=data.initialize&&!data.checkInitial;
  if(settledRestore)seedStructuralHistory(world,removed);
  const structural=detachOverloaded(world,settledRestore?[]:removed);
  // A failed load-bearing section can also release a beam or adjoining detail.
  const cascade=structural.groups.length?world.detachLocal(structural.groups.flat()):[];
  const groups=[...disconnected,...structural.groups,...cascade];
  const failures=[...disconnected.map(()=>null),...structural.failures,...cascade.map(()=>null)];
  const newCells=new Set(groups.flat().map(p=>`${p.x},${p.y},${p.z}`));
  const retries=hasAddition?[]:pending.filter(({cells})=>cells.every(p=>world.get(p.x,p.y,p.z)===p.mat&&!newCells.has(`${p.x},${p.y},${p.z}`)));
  // Analysis proposes detachment; only the authority commits after admitting
  // the new collider. Restore the mirror so budget rejection cannot silently
  // erase cells from future support checks. The next actual delta confirms it.
  for(const group of groups)for(const p of group){
    const c=world.getChunk((p.x>>5)+16+((p.z>>5)+16)*32+(p.y>>5)*1024,true),i=localIndex(p.x,p.y,p.z);
    if(!c.data[i]){c.data[i]=MATERIAL_IDS[p.mat];c.count++;}
  }
  world.count=data.count;world.dirty.clear();world.lightDirty.clear();world.supportDirty.clear();world.altered.clear();
  const proposalIds=groups.map(()=>`${epoch}:${++proposalSequence}`);
  pending=groups.map((cells,index)=>({cells,failure:failures[index],proposalId:proposalIds[index]}));
  const known=new Set(data.knownProposalIds??[]),reconfirmed=[];
  for(const retry of retries){pending.push(retry);if(known.has(retry.proposalId))reconfirmed.push(retry.proposalId);else{groups.push(retry.cells);failures.push(retry.failure);proposalIds.push(retry.proposalId);}}
  // Each extraction removes its cells before the next one; retries explicitly
  // exclude newCells. Thus this analysis's groups are pairwise disjoint. The
  // authority can retain prepared siblings across its own successful handoff.
  const disjointBatch=`support:${epoch}:${++analysisSequence}`;
  self.postMessage({revision:data.revision,geometryRevision:data.geometryRevision,epoch,groups,failures,proposalIds,reconfirmed,activeProposalIds:pending.map(p=>p.proposalId),disjointBatch,stats:{ms:performance.now()-started,chunks:data.chunks.length,examined,structural:structural.stats,pending:pending.length,reconfirmed:reconfirmed.length,sentCells:groups.reduce((n,g)=>n+g.length,0)}});
};
