import {staticPaletteHandoff,prepareStaticPaletteHandoff} from '../assets/static-palette-handoff.js';
// Support analysis only proposes a handoff. The authority keeps every static
// voxel until the corresponding persistent body and collision have been made.
const clock=()=>globalThis.performance?.now?.()??Date.now();
const cellKey=cell=>`${cell?.x},${cell?.y},${cell?.z}:${cell?.mat}`;

function fingerprint(cells){
  // Order-independent lookup; exact comparison below resolves hash collisions.
  let sum=0,xor=0,first='';
  for(const cell of cells){
    const key=cellKey(cell);if(!first||key<first)first=key;
    let hash=2166136261;for(let i=0;i<key.length;i++)hash=Math.imul(hash^key.charCodeAt(i),16777619);
    sum=(sum+hash)>>>0;xor^=hash;
  }
  return `${cells.length}:${first}:${sum}:${xor>>>0}`;
}
function sameCells(a,b){
  if(a.length!==b.length)return false;
  if(a.every((cell,index)=>cellKey(cell)===cellKey(b[index])))return true;
  const keys=new Set(a.map(cellKey));return keys.size===a.length&&b.every(cell=>keys.has(cellKey(cell)));
}
function rejection(physics,error){
  if(error)return {reason:'runtime',retryable:true,message:error.message??String(error)};
  if(!physics?.addPersistent)return {reason:'runtime',retryable:true,message:'Persistent physics is not ready'};
  const failure=physics.lastAdmissionFailure??physics.admissionFailure;
  return failure?{...failure,reason:failure.reason??'admission-failed',retryable:Boolean(failure.retryable)}:
    {reason:'admission-failed',retryable:false};
}
function releasePreparation(job){
  job.physicsToken?.owner?.cancelPersistentPreparation?.(job.physicsToken); job.physicsToken=null;
  job.visualToken?.owner?.cancel(job.visualToken);job.visualToken=null;job.visualIterator=null;
}
function commitGroup(world,physics,cells,failure,prepared=null){
  if(!prepared){
    if(!Array.isArray(cells)||!cells.length||cells.some(cell=>!cell||![cell.x,cell.y,cell.z].every(Number.isSafeInteger)||typeof cell.mat!=='string'))return {rejection:{reason:'invalid',retryable:false}};
    if(cells.some(cell=>world.get(cell.x,cell.y,cell.z)!==cell.mat))return {stale:true};
  }
  // Collect immutable asset provenance before creating or removing anything.
  let identity=prepared?.identity??null;
  if(!prepared&&world.sourceShapeAt){
    const sources=new Map();for(const cell of cells){const shape=world.sourceShapeAt(cell.x,cell.y,cell.z);if(shape)sources.set(shape.shapeId,shape);}
    identity={origin:'static-collapse',sourceShapeIds:[...sources.keys()],shapeDefinitions:[...sources.values()],instanceIds:[...new Set([...sources.values()].map(s=>s.instanceId))],assetIds:[...new Set([...sources.values()].map(s=>s.assetId))]};
  }
  let entry;
  try{if(prepared?.token)entry=physics.commitPreparedPersistent(prepared.token);else{const source=world.sourceShapeAt?cells.map(c=>{const shape=world.sourceShapeAt(c.x,c.y,c.z);return shape?{...c,sourceShape:shape.numericId}:c;}):cells;
    const prop=prepared?.prop??staticPaletteHandoff(world,source);entry=physics?.addPersistent(prop.cells,{palette:prop.palette,failure:failure??null});}}
  catch(error){return {rejection:rejection(physics,error)};}
  if(!entry)return {rejection:rejection(physics)};
  if(identity)entry.assetIdentity={bodyId:entry.id,...identity};
  if(prepared?.visual)entry.preparedVisual={geometry:prepared.visual,cells:entry.cells,revision:entry.revision,cellSize:entry.cellSize||.1};
  if(world.removeCells)world.removeCells(cells);else for(const cell of cells)world.set(cell.x,cell.y,cell.z,null);
  return {entry,cells,failure:failure??null};
}

// Ownership transfer is opt-in: worker messages already belong exclusively to
// their receiver. The default enqueue API still takes an immediate snapshot.
function* prepareGroup(world,job){
  const sources=new Map(),cells=job.owned?[]:job.cells;
  for(let i=0;i<job.cells.length;i++){
    const cell=job.cells[i];
    if(!cell||![cell.x,cell.y,cell.z].every(Number.isSafeInteger)||typeof cell.mat!=='string')return {rejection:{reason:'invalid',retryable:false}};
    if(world.get(cell.x,cell.y,cell.z)!==cell.mat)return {stale:true};
    const shape=world.sourceShapeAt?.(cell.x,cell.y,cell.z);if(shape)sources.set(shape.shapeId,shape);
    if(job.owned)cells.push({...cell,...(shape?{sourceShape:shape.numericId}:{})});else if(shape)cell.sourceShape=shape.numericId;
    if((i+1)%256===0)yield 'source-validation';
  }
  const prop=yield* prepareStaticPaletteHandoff(world,cells);
  return {cells,prop,identity:world.sourceShapeAt?{origin:'static-collapse',sourceShapeIds:[...sources.keys()],shapeDefinitions:[...sources.values()],instanceIds:[...new Set([...sources.values()].map(s=>s.instanceId))],assetIds:[...new Set([...sources.values()].map(s=>s.assetId))]}:null};
}

// Compatibility entry point for server/synchronous callers. It has no body
// count/minimum-fragment policy; the physical runtime returns the real reason.
export function commitStaticCollapse(world,physics,groups,failures=[]){
  const entries=[],rejected=[],rejectedDetails=[],stale=[];
  for(let index=0;index<groups.length;index++){
    const cells=groups[index];if(!cells?.length)continue;
    const result=commitGroup(world,physics,cells,failures[index]);
    if(result.stale){stale.push(index);continue;}
    if(result.rejection){rejected.push(index);rejectedDetails.push({index,...result.rejection});continue;}
    entries.push(result);
  }
  return {entries,rejected,rejectedDetails,stale};
}

export class CollapseQueue{
  constructor({now=clock,retryDelayMs=250,maxRetryDelayMs=4000}={}){
    this.now=now;this.retryDelayMs=retryDelayMs;this.maxRetryDelayMs=maxRetryDelayMs;
    this.epoch=undefined;this.jobs=[];this.terminal=new Map();this.pendingCells=0;this.ownedKeys=new WeakMap();this.ownedSequence=0;this.proposals=new Map();
  }
  get length(){return this.jobs.length;}
  get hasPending(){return this.jobs.length>0;}
  // A current worker analysis can replace a weakened proposal with new
  // components. Cancel superseded preparations, never their authoritative cells.
  retainWorkerProposals(proposalIds,{epoch=this.epoch,geometryRevision}={}){
    if(epoch!==this.epoch||!Array.isArray(proposalIds))return 0;
    const active=new Set(proposalIds);let retired=0;
    this.jobs=this.jobs.filter(job=>{
      if(!job.proposalId||!this.proposals.has(job.key)||active.has(job.proposalId)||geometryRevision<job.geometryRevision)return true;
      releasePreparation(job);this.pendingCells-=job.cells.length;this.proposals.delete(job.key);retired++;return false;
    });return retired;
  }
  // The worker checked the exact original cells/materials and no additions.
  // Reconfirm by stable ID rather than cloning a million unchanged cell objects.
  reconfirm(proposalIds,{epoch=this.epoch,geometryRevision,revision,disjointBatch}={}){
    const result={confirmed:0,unknown:[]};if(epoch!==this.epoch)return result;
    for(const id of proposalIds){const job=this.proposals.get(`proposal:${id}`);if(!job){result.unknown.push(id);continue;}
      if(geometryRevision<job.geometryRevision)continue;
      if(job.validationRevision!==undefined)job.validationRevision=geometryRevision;
      job.geometryRevision=geometryRevision;job.revision=revision;job.disjointBatch=disjointBatch;result.confirmed++;
    }return result;
  }
  clear(epoch=this.epoch){
    const dropped=this.jobs.length;for(const job of this.jobs)releasePreparation(job);this.jobs=[];this.terminal.clear();this.proposals.clear();this.ownedKeys=new WeakMap();this.pendingCells=0;this.epoch=epoch;return dropped;
  }
  // disjointBatch is a proof token from our support worker's sequential
  // extraction, never inferred from file, AABB, body or render-page identity.
  enqueue(groups,failures=[],{epoch=this.epoch,geometryRevision,revision,proposalIds=[],disjointBatch=null,owned=false}={}){
    const result={queued:0,duplicates:0,ignored:0,stale:[],remaining:this.length};
    if(this.epoch===undefined)this.epoch=epoch;
    if(epoch!==this.epoch){result.stale=groups.map((_,index)=>index);return result;}
    for(let index=0;index<groups.length;index++){
      const source=groups[index];if(!source?.length){result.ignored++;continue;}
      const proposalId=proposalIds[index]??null;
      if(owned&&!proposalId&&!this.ownedKeys.has(source))this.ownedKeys.set(source,`owned:${++this.ownedSequence}`);
      const key=owned?(proposalId?`proposal:${proposalId}`:this.ownedKeys.get(source)):fingerprint(source);
      const terminal=this.terminal.get(key);
      if(terminal&&terminal.geometryRevision===geometryRevision&&(owned||sameCells(terminal.cells,source))){result.duplicates++;continue;}
      const existing=owned?this.proposals.get(key):this.jobs.find(job=>job.key===key&&sameCells(job.cells,source));
      if(existing){
        // A fresh support result can reconfirm an unchanged piece after another
        // part of the world changed. Never replace it with an older result.
        if(geometryRevision!==undefined&&(existing.geometryRevision===undefined||geometryRevision>=existing.geometryRevision)){
          existing.geometryRevision=geometryRevision;existing.revision=revision;existing.index=index;
          existing.proposalId=proposalId;existing.failure=failures[index]??null;existing.disjointBatch=disjointBatch;
        }
        result.duplicates++;continue;
      }
      const cells=owned?source:source.map(cell=>({...cell}));
      const job={cells,owned,failure:failures[index]??null,index,proposalId,key,epoch,geometryRevision,revision,disjointBatch,attempts:0,retryAt:0};
      this.jobs.push(job);if(owned)this.proposals.set(key,job);
      this.pendingCells+=cells.length;result.queued++;
    }
    result.remaining=this.length;return result;
  }
  process(world,physics,{epoch=this.epoch,budgetMs=3,visuals=null,allowCommit=true,commitOnly=false}={}){
    const started=this.now(),entries=[],rejected=[],rejectedDetails=[],stale=[],staleDetails=[],deferred=[];
    const limit=Number.isFinite(budgetMs)?Math.max(0,budgetMs):3;
    let inspected=0,attempted=0,prepareMs=0,commitMs=0;
    // Each queued piece is visited at most once per frame. A single collider
    // cook is atomic and may itself exceed the budget; elapsedMs records that.
    const count=this.jobs.length;
    for(let n=0;n<count&&this.jobs.length;n++){
      if(inspected>0&&this.now()-started>=limit)break;
      const job=this.jobs.shift();inspected++;
      if(epoch!==job.epoch||(job.geometryRevision!==undefined&&job.geometryRevision!==world.geometryRevision)){
        releasePreparation(job);stale.push(job.index);staleDetails.push({index:job.index,proposalId:job.proposalId,reason:epoch!==job.epoch?'epoch':'geometry-revision'});this.pendingCells-=job.cells.length;this.proposals.delete(job.key);continue;
      }
      if(job.retryAt>this.now()){
        deferred.push({index:job.index,proposalId:job.proposalId,reason:job.lastRejection?.reason,retryAt:job.retryAt});this.jobs.push(job);continue;
      }
      const beforeRevision=world.geometryRevision;
      const progressive=job.cells.length>=2048&&physics?.beginPersistentPreparation&&physics?.advancePersistentPreparation&&physics?.commitPreparedPersistent;
      if(commitOnly&&(!job.groupReady||job.validationRevision!==world.geometryRevision||(progressive&&job.physicsToken?.state!=='ready')||(progressive&&visuals&&!['ready','failed'].includes(job.visualToken?.state)))){deferred.push({index:job.index,proposalId:job.proposalId,reason:'await-preparation'});this.jobs.push(job);continue;}
      let result,prepared=null;
      if(job.owned||progressive){
        const prepareStarted=this.now();
        // Our earlier handoffs can change the global revision. Revalidate
        // source occupancy so overlapping proposals cannot duplicate bodies.
        if(job.validationRevision!==world.geometryRevision){releasePreparation(job);job.validationRevision=world.geometryRevision;job.groupIterator=null;job.groupReady=null;job.commitDeferred=false;}
        if(!job.groupReady){
          job.groupIterator??=prepareGroup(world,job);let steps=0;
          try{do{const next=job.groupIterator.next();steps++;if(next.done){job.groupReady=next.value;break;}}while(steps<256&&this.now()-started<limit);}
          catch(error){job.groupReady={rejection:{reason:'runtime',retryable:true,message:error.message??String(error)}};}
        }
        if(job.groupReady?.stale||job.groupReady?.rejection)result=job.groupReady;
        else if(job.groupReady){
          if(job.owned){job.cells=job.groupReady.cells;job.owned=false;}
          if(progressive){
            job.physicsToken??=physics.beginPersistentPreparation(job.groupReady.prop.cells,{palette:job.groupReady.prop.palette,failure:job.failure});
            const progress=physics.advancePersistentPreparation(job.physicsToken,{budgetMs:Math.max(0,limit-(this.now()-started)),now:this.now,maxSteps:256});
            if(progress.failure){result={rejection:progress.failure};releasePreparation(job);}
            else if(progress.done)prepared={identity:job.groupReady.identity,prop:job.groupReady.prop,token:job.physicsToken};
            else job.preparationStage=progress.stage;
          }else prepared={identity:job.groupReady.identity,prop:job.groupReady.prop};
        }
        if(!result&&prepared&&progressive&&visuals){
          if(!job.visualToken){
            const shape=job.physicsToken.prepared.shape,center={};for(const axis of ['x','y','z'])center[axis]=(shape.min[axis]+shape.max[axis])*(job.physicsToken.options.cellSize||.1)/2;
            try{job.visualIterator??=visuals.prepare(shape.cells,center,job.physicsToken.options.cellSize||.1,job.physicsToken.prepared.palette);
              let steps=0;do{const next=job.visualIterator.next();steps++;if(next.done){job.visualToken=next.value;break;}}while(steps<256&&this.now()-started<limit);
            }catch(error){job.visualToken={state:'failed',error:error.message};visuals.fail(job.visualToken,error.message);}
          }
          if(!job.visualToken||visuals.poll(job.visualToken)==='waiting'){prepared=null;job.preparationStage=job.visualToken?'visual-worker':'visual-packing';}
          else if(job.visualToken.state==='ready')prepared.visual=job.visualToken.geometry;
        }
        prepareMs+=this.now()-prepareStarted;
        if(!result&&!prepared){deferred.push({index:job.index,proposalId:job.proposalId,reason:'preparing',stage:job.preparationStage??'source-validation'});this.jobs.push(job);continue;}
        if(!result&&!commitOnly&&progressive&&this.now()-started>=limit&&job.physicsToken?.state==='ready'&&!job.commitDeferred){job.commitDeferred=true;deferred.push({index:job.index,proposalId:job.proposalId,reason:'prepared'});this.jobs.push(job);continue;}
      }
      if(!result&&!allowCommit){deferred.push({index:job.index,proposalId:job.proposalId,reason:'solver-barrier'});this.jobs.push(job);continue;}
      if(!result){const commitStarted=this.now();result=commitGroup(world,physics,job.cells,job.failure,prepared);commitMs+=this.now()-commitStarted;}
      job.attempts++;attempted++;
      if(result.stale){releasePreparation(job);stale.push(job.index);staleDetails.push({index:job.index,proposalId:job.proposalId,reason:'source-cells'});this.pendingCells-=job.cells.length;this.proposals.delete(job.key);continue;}
      if(result.rejection){
        const detail={index:job.index,proposalId:job.proposalId,attempts:job.attempts,...result.rejection};
        rejected.push(job.index);rejectedDetails.push(detail);
        if(detail.retryable){
          if(!job.physicsToken){job.groupIterator=null;job.groupReady=null;}
          job.lastRejection=result.rejection;job.retryAt=this.now()+Math.min(this.maxRetryDelayMs,this.retryDelayMs*2**Math.min(12,job.attempts-1));
          detail.retryAt=job.retryAt;this.jobs.push(job);
        }else{
          releasePreparation(job);this.pendingCells-=job.cells.length;this.terminal.set(job.key,job);this.proposals.delete(job.key);
        }
        continue;
      }
      entries.push({...result,index:job.index,proposalId:job.proposalId});this.pendingCells-=job.cells.length;this.proposals.delete(job.key);
      // Our own handoff changes the global revision, but does not invalidate
      // the other disjoint proposals proved against that same world state.
      for(const other of this.jobs)if(other.geometryRevision===beforeRevision){
        other.geometryRevision=world.geometryRevision;
        if(job.disjointBatch&&other.disjointBatch===job.disjointBatch&&other.validationRevision===beforeRevision)other.validationRevision=world.geometryRevision;
      }
      for(const other of this.terminal.values())if(other.geometryRevision===beforeRevision)other.geometryRevision=world.geometryRevision;
    }
    return {entries,rejected,rejectedDetails,stale,staleDetails,deferred,remaining:this.length,pendingCells:this.pendingCells,attempted,prepareMs,commitMs,elapsedMs:this.now()-started};
  }
}
