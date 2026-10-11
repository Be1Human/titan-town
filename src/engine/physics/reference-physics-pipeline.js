import {CELL,CHUNK,MATERIAL_KEYS,chunkOf} from '../../voxel-world.js';
import {sourcePoint,worldPoint,gridCell,rotateVector} from '../../rigid-fracture.js';
import {VoxelCollisionData,collisionDataForEntry} from './voxel-collision-data.js';
import {VoxelBroadPhase} from './voxel-broad-phase.js';
import {collectVoxelContacts} from './voxel-near-phase.js';
import {makeBodyWork,fixedBodyWork,prepareContactConstraint,prepareBallConstraint,solveVoxelRows,solveVoxelRowsAsync,integrateBodyWork} from './voxel-row-solver.js';
import {VoxelSolverTasks} from './voxel-solver-tasks.js';
import {ReferenceStepTasks} from './reference-step-tasks.js';
import {updateGroupActivity} from './voxel-group-activity.js';
import {contactBreakageCap,referenceMaterialFor} from '../core/reference-materials.js';

// Runtime reconstruction of verified pipeline stages, with explicit project
// glue for geometry/units. Rapier is retained as a body/query compatibility
// store, not called as the contact generator or constraint solver in this path.
// Complete original flags, joints and alternate-pose orchestration still require
// separate work; this route stays opt-in until those validations pass.
export class ReferencePhysicsPipeline {
  constructor(physics){this.physics=physics;this.broad=new VoxelBroadPhase();this.staticCache=new Map();this.activity=new Map();this.pendingDamage=[];this.damageHead=0;this.queuedDamage=new Set();this.jointKinds=new Map();this.externalMutationRevision=0;this.tasks=new VoxelSolverTasks({solverBackend:physics.solverBackend,nearBackend:physics.nearBackend});this.busy=false;this.stats={pipeline:'reference-voxel-v1',iterations:8};}
  reset(){this.staticCache.clear();this.activity.clear();this.pendingDamage=[];this.damageHead=0;this.queuedDamage.clear();}
  activate(entry){if(this.writingBodies)return;this.externalMutationRevision++;if(entry.body.isSleeping())this.activity.delete(entry.id);else{const state=this.activity.get(entry.id);if(state)state.activity=60;}}
  dispose(){this.disposed=true;this.tasks.dispose();this.stepTasks?.dispose();}
  hasCompletedJobs(){return this.tasks.hasCompletedJobs()||Boolean(this.stepTasks?.hasCompletedJobs());}
  _staticObjects(){
    const objects=[],p=this.physics,needed=p.terrainNeeds;
    for(const key of this.staticCache.keys())if(!needed.has(key))this.staticCache.delete(key);
    for(const key of needed.keys()){
      const chunk=p.voxelWorld.chunks.get(key);if(!chunk?.count)continue;
      let record=this.staticCache.get(key);
      if(!record||record.chunk!==chunk){
        const min={x:chunk.x,y:chunk.y,z:chunk.z},max={x:chunk.x+CHUNK,y:chunk.y+CHUNK,z:chunk.z+CHUNK},grid={min,max,width:CHUNK,depth:CHUNK,layer:CHUNK*CHUNK,data:chunk.data};
        const materialAt=i=>MATERIAL_KEYS[grid.data[i]],cache=new VoxelCollisionData(grid,materialAt,{outsidePhysical:(x,y,z)=>{const mat=p.voxelWorld.get(x,y,z);return Boolean(mat)&&referenceMaterialFor(mat).physical;}});
        record={chunk,revision:chunk.revision,raw:chunk.data.slice(),cache,materialAt};this.staticCache.set(key,record);
      }else if(record.revision!==chunk.revision){
        const changed=[];for(let i=0;i<chunk.data.length;i++)if(record.raw[i]!==chunk.data[i]){changed.push(i);record.raw[i]=chunk.data[i];}
        record.cache.update(changed);record.revision=chunk.revision;
      }
      const directions=[[-1,0,0],[1,0,0],[0,-1,0],[0,1,0],[0,0,-1],[0,0,1]];
      const neighbors=directions.map(([x,y,z])=>{const c=p.voxelWorld.chunks.get(chunkOf(chunk.x+x*CHUNK,chunk.y+y*CHUNK,chunk.z+z*CHUNK));return{chunk:c,revision:c?.revision};});
      if(record.neighbors)for(let side=0;side<6;side++)if(record.neighbors[side].chunk!==neighbors[side].chunk||record.neighbors[side].revision!==neighbors[side].revision){
        const indices=[];for(let a=0;a<CHUNK;a++)for(let b=0;b<CHUNK;b++){
          const x=side<2?(side?31:0):a,y=side>=2&&side<4?(side===3?31:0):side<2?a:b,z=side>=4?(side===5?31:0):side<2?b:side<4?b:a;
          indices.push(x+z*CHUNK+y*CHUNK*CHUNK);
        }record.cache.refreshFaces(indices);
      }
      record.neighbors=neighbors;
      // A cache page is storage, not a filled 32^3 physical Shape. Use the
      // real occupied bounds for the native steady OBB intersection. Keep
      // conservative broad/fast bounds until alternate-pose work is complete.
      if(record.physicalRevision!==record.cache.contentRevision){
        let minX=CHUNK,minY=CHUNK,minZ=CHUNK,maxX=-1,maxY=-1,maxZ=-1;
        for(let i=0;i<record.cache.mask.length;i++)if(record.cache.mask[i]&128){const x=i%CHUNK,y=Math.floor(i/(CHUNK*CHUNK)),z=Math.floor(i/CHUNK)%CHUNK;minX=Math.min(minX,x);minY=Math.min(minY,y);minZ=Math.min(minZ,z);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);maxZ=Math.max(maxZ,z);}
        record.localBounds=maxX<0?null:{min:{x:(chunk.x+minX)*CELL,y:(chunk.y+minY)*CELL,z:(chunk.z+minZ)*CELL},max:{x:(chunk.x+maxX+1)*CELL,y:(chunk.y+maxY+1)*CELL,z:(chunk.z+maxZ+1)*CELL}};
        record.physicalRevision=record.cache.contentRevision;
      }
      if(!record.localBounds)continue;
      const center={x:(chunk.x+16)*CELL,y:(chunk.y+16)*CELL,z:(chunk.z+16)*CELL};
      const rotation={x:0,y:0,z:0,w:1};objects.push({id:'terrain-'+key,bodyId:'static-world',entry:null,collider:p.terrain.get(key)?.collider,cache:record.cache,materialAt:record.materialAt,sourceAt:i=>p.voxelWorld.assetOwners?.get(key)?.[i],cellSize:CELL,center,position:center,rotation,alternatePose:{position:center,rotation},velocity:{x:0,y:0,z:0},friction:.9,localBounds:record.localBounds,bounds:{min:{x:chunk.x*CELL,y:chunk.y*CELL,z:chunk.z*CELL},max:{x:(chunk.x+CHUNK)*CELL,y:(chunk.y+CHUNK)*CELL,z:(chunk.z+CHUNK)*CELL}}});
    }
    return objects;
  }
  _dynamicObject(entry,dt=0){
    const velocity=entry.body.isSleeping()?{x:0,y:0,z:0}:{...entry.body.linvel()},angular=entry.body.angvel(),q=entry.rotation,h=dt*.5;
    const rotation={x:q.x+h*(angular.x*q.w+angular.y*q.z-angular.z*q.y),y:q.y+h*(-angular.x*q.z+angular.y*q.w+angular.z*q.x),z:q.z+h*(angular.x*q.y-angular.y*q.x+angular.z*q.w),w:q.w+h*(-angular.x*q.x-angular.y*q.y-angular.z*q.z)},norm=Math.hypot(rotation.x,rotation.y,rotation.z,rotation.w);for(const axis of ['x','y','z','w'])rotation[axis]/=norm;
    const com=entry.body.worldCom(),offset=rotateVector(entry.massProperties.localCenterOfMass,rotation),position={x:com.x+velocity.x*dt-offset.x,y:com.y+velocity.y*dt-offset.y,z:com.z+velocity.z*dt-offset.z};
    const physicalBounds=entry.bounds,bounds={min:{...physicalBounds.min},max:{...physicalBounds.max}};
    // Sweep the actual occupied AABB under the alternate pose; stable source
    // storage is not used as a permanent, oversized collision bound.
    const alternate={...entry,position,rotation};for(const x of [entry.occupiedBounds.min.x,entry.occupiedBounds.max.x])for(const y of [entry.occupiedBounds.min.y,entry.occupiedBounds.max.y])for(const z of [entry.occupiedBounds.min.z,entry.occupiedBounds.max.z]){const p=worldPoint(alternate,{x:x*entry.cellSize,y:y*entry.cellSize,z:z*entry.cellSize});for(const axis of ['x','y','z']){bounds.min[axis]=Math.min(bounds.min[axis],p[axis]);bounds.max[axis]=Math.max(bounds.max[axis],p[axis]);}}
    const localBounds={min:{},max:{}};for(const end of ['min','max'])for(const axis of ['x','y','z'])localBounds[end][axis]=entry.occupiedBounds[end][axis]*entry.cellSize;
    return{id:entry.id,bodyId:entry.id,entry,collider:entry.collider,cache:collisionDataForEntry(entry),materialAt:i=>entry.cells[entry.grid.data[i]-1]?.mat,sourceAt:i=>entry.cells[entry.grid.data[i]-1]?.sourceShape,cellSize:entry.cellSize,center:entry.center,position:entry.position,rotation:entry.rotation,alternatePose:{position,rotation},velocity,bounds,localBounds,friction:.8};
  }
  _prepareContactSet(objects,staticObjects,excludedPairs,dt){
    const pairs=[],seen=new Set(),contacts=[],stats={scanned:0,tested:0,contacts:0};let wakes=0;
    const collect=()=>{
      this.broad.update({staticObjects,active:objects.filter(o=>!o.entry.body.isSleeping()),sleeping:objects.filter(o=>o.entry.body.isSleeping())});
      let wakeCount=0;
      for(const [a,b]of this.broad.collect({qualify:(a,b)=>!excludedPairs.has([a.id,b.id].sort().join('|'))})){
        const key=a.id<b.id?a.id+'|'+b.id:b.id+'|'+a.id;if(seen.has(key))continue;seen.add(key);pairs.push([a,b]);
        const local=collectVoxelContacts(a,b,{stats,dt});for(const c of local)contacts.push(c);
        if(local.length)for(const object of [a,b])if(object.entry?.body.isSleeping()){object.entry.body.wakeUp();this.activity.delete(object.id);wakeCount++;}
      }
      wakes+=wakeCount;return wakeCount;
    };
    while(collect()){} // Newly active neighbors enter THIS step, not next frame.
    return {pairs,contacts,stats,wakes};
  }
  _epoch(){const p=this.physics;return{world:p.world,geometry:p.voxelWorld.geometryRevision,structure:p.structureRevision,external:this.externalMutationRevision};}
  _valid(epoch){const p=this.physics;return!this.disposed&&p.referencePipeline===this&&epoch.world===p.world&&epoch.geometry===p.voxelWorld.geometryRevision&&epoch.structure===p.structureRevision&&epoch.external===this.externalMutationRevision;}
  *_contactStages(objects,staticObjects,excludedPairs,dt,epoch){
    const pairs=[],seen=new Set(),contacts=[],stats={scanned:0,tested:0,contacts:0},taskRounds=[];let wakes=0;
    while(true){
      this.broad.update({staticObjects,active:objects.filter(o=>!o.entry.body.isSleeping()),sleeping:objects.filter(o=>o.entry.body.isSleeping())});
      const next=[];for(const pair of this.broad.collect({qualify:(a,b)=>!excludedPairs.has([a.id,b.id].sort().join('|'))})){
        const [a,b]=pair,key=a.id<b.id?a.id+'|'+b.id:b.id+'|'+a.id;if(!seen.has(key)){seen.add(key);next.push(pair);pairs.push(pair);}
      }
      if(!next.length)break;
      this.writingBodies=false;const result=yield{kind:'near',pairs:next,dt};this.writingBodies=true;
      if(!this._valid(epoch))return {cancelled:true};
      taskRounds.push(result.tasks);for(const key of ['scanned','tested','contacts'])stats[key]+=result.stats[key];let roundWakes=0;
      for(let i=0;i<next.length;i++){
        const local=result.byPair[i];for(const contact of local)contacts.push(contact);
        if(local.length)for(const object of next[i])if(object.entry?.body.isSleeping()){object.entry.body.wakeUp();this.activity.delete(object.id);roundWakes++;}
      }
      wakes+=roundWakes;if(!roundWakes)break;
    }
    return {pairs,contacts,stats,wakes,taskRounds};
  }
  *_stepStages(dt,{asyncNear=false}={}){
    this.writingBodies=true;try{
    const p=this.physics,start=performance.now();
    const staticObjects=this._staticObjects(),objects=[...p.entries.values()].map(e=>this._dynamicObject(e,dt));
    const joints=[],excludedPairs=new Set();p.world.impulseJoints.forEach(joint=>{
      if(joint.type()!==5&&this.jointKinds.get(joint.handle)!=='ball')throw new Error('Reference pipeline has not implemented joint type '+joint.type());
      const bodyA=joint.body1(),bodyB=joint.body2(),entryA=p.bodyHandles.get(bodyA.handle),entryB=p.bodyHandles.get(bodyB.handle);
      if(!joint.contactsEnabled()&&entryA&&entryB)excludedPairs.add([entryA.id,entryB.id].sort().join('|'));
      if(entryA?.body.isSleeping()&&entryB&&!entryB.body.isSleeping())entryA.body.wakeUp();
      if(entryB?.body.isSleeping()&&entryA&&!entryA.body.isSleeping())entryB.body.wakeUp();
      joints.push({joint,bodyA,bodyB,entryA,entryB});
    });
    const nativePoint=(body,anchor)=>{const r=rotateVector(anchor,body.rotation()),pos=body.translation();return{x:pos.x+r.x,y:pos.y+r.y,z:pos.z+r.z};};
    const cacheDone=performance.now(),epoch=this._epoch();let collection,bodyWork,constraints,groups,nearDone,controllerResult;
    if(asyncNear&&p.wholeStepMode){
      const allStates=objects.map(o=>makeBodyWork(o.entry,p.gravity,dt)),jointInputs=joints.map(({joint,bodyA,bodyB,entryA,entryB})=>({aId:entryA?.id??null,bId:entryB?.id??null,pointA:nativePoint(bodyA,joint.anchor1()),pointB:nativePoint(bodyB,joint.anchor2())}));
      this.writingBodies=false;controllerResult=yield{kind:'step',objects,staticObjects,excludedPairs,bodyStates:allStates,joints:jointInputs,dt,solverBackend:p.solverBackend,nearBackend:p.nearBackend};this.writingBodies=true;
      if(!this._valid(epoch))return {cancelled:true};
      for(const ordinal of controllerResult.woken){const entry=objects[ordinal].entry;entry.body.wakeUp();this.activity.delete(entry.id);}
      bodyWork=[fixedBodyWork()];controllerResult.bodyOrdinals.forEach((ordinal,i)=>{const state=allStates[ordinal];state.velocity.set(controllerResult.velocity.subarray(i*6,i*6+6));bodyWork.push(state);});
      const allObjects=[...objects,...staticObjects];constraints=controllerResult.damage.map(c=>({...c,a:allObjects[c.a],b:allObjects[c.b],normalRow:{lambda:c.lambda},saturated:true}));groups=controllerResult.groups;
      collection={stats:controllerResult.stats,wakes:controllerResult.stats.wakes,taskRounds:controllerResult.stats.nearTasks};nearDone=performance.now();
    }else{
      collection=asyncNear?yield* this._contactStages(objects,staticObjects,excludedPairs,dt,epoch):this._prepareContactSet(objects,staticObjects,excludedPairs,dt);nearDone=performance.now();if(collection.cancelled)return collection;
      bodyWork=[fixedBodyWork()];const indices=new Map();for(const object of objects)if(!object.entry.body.isSleeping()){indices.set(object.id,bodyWork.length);bodyWork.push(makeBodyWork(object.entry,p.gravity,dt));}
      constraints=[];for(const contact of collection.contacts){const a=indices.get(contact.a.id)||0,b=indices.get(contact.b.id)||0;if(!a&&!b)continue;const c=prepareContactConstraint(contact,bodyWork[a],bodyWork[b],dt);c.aIndex=a;c.bIndex=b;constraints.push(c);}
      for(const {joint,bodyA,bodyB,entryA,entryB}of joints){const a=entryA?indices.get(entryA.id)||0:0,b=entryB?indices.get(entryB.id)||0:0;if(!a&&!b)continue;const c=prepareBallConstraint(bodyWork[a],bodyWork[b],nativePoint(bodyA,joint.anchor1()),nativePoint(bodyB,joint.anchor2()),dt);c.aIndex=a;c.bIndex=b;constraints.push(c);}
      this.writingBodies=false;groups=yield{kind:'solve',bodyWork,constraints};this.writingBodies=true;if(!this._valid(epoch))return {cancelled:true};
    }
    const solveDone=performance.now();
    for(let i=1;i<bodyWork.length;i++)integrateBodyWork(bodyWork[i],dt);
    p.world.propagateModifiedBodyPositionsToColliders();p._refreshWorkset(true);
    for(const range of groups.ranges){
      const members=[];
      for(let i=range.bodyStart;i<range.bodyStart+range.bodyCount;i++){
        const state=bodyWork[groups.bodies[i]],entry=state.entry;let activity=this.activity.get(entry.id);
        if(!activity){activity={activity:60};this.activity.set(entry.id,activity);}
        Object.assign(activity,{id:entry.id,bounds:entry.bounds,pose:{position:entry.position,rotation:entry.rotation},velocity:state.velocity,sleep:()=>entry.body.sleep()});members.push(activity);
      }
      updateGroupActivity(members);
      for(const member of members){const entry=p.entries.get(member.id);if(entry&&!entry.body.isSleeping()){const v=member.velocity;entry.body.setLinvel({x:v[0],y:v[1],z:v[2]},false);entry.body.setAngvel({x:v[3],y:v[4],z:v[5]},false);}}
    }
    for(const id of this.activity.keys())if(!p.entries.has(id))this.activity.delete(id);
    const seenDamage=new Set();
    for(const c of constraints)if(c.saturated&&Number.isFinite(c.cap)&&c.normalRow.lambda>=c.cap){
      for(const [object,index,cap]of [[c.a,c.indexA,c.capA],[c.b,c.indexB,c.capB]]){
        if(!object.entry||!Number.isFinite(cap))continue;
        const cell=object.entry.cells[object.entry.grid.data[index]-1];if(!cell)continue;const key=object.id+'/'+cell.x+','+cell.y+','+cell.z;if(seenDamage.has(key)||this.queuedDamage.has(key))continue;seenDamage.add(key);this.queuedDamage.add(key);
        this.pendingDamage.push({key,id:object.id,cell:{...cell},localPoint:sourcePoint(object,c.point),force:c.normalRow.lambda/dt*p.contactSettings.contactForceScale,cap:contactBreakageCap(cell.mat,object.entry.strength),speed:c.speed});
      }
    }
    this._damage();
    const end=performance.now();this.stats={pipeline:controllerResult?'reference-controller-v1':'reference-voxel-v1',iterations:8,cacheMs:cacheDone-start,nearMs:controllerResult?.stats.nearWallMs??nearDone-cacheDone,solveMs:controllerResult?controllerResult.stats.rowPrepareCpuMs+controllerResult.stats.solveWallMs:solveDone-nearDone,writebackMs:end-solveDone,pairs:controllerResult?.stats.pairs??collection.pairs.length,scanned:collection.stats.scanned,tested:collection.stats.tested,contacts:controllerResult?.stats.contacts??collection.contacts.length,constraints:controllerResult?.stats.constraints??constraints.length,islands:groups.ranges.length,wakes:collection.wakes,pendingDamage:this.pendingDamage.length-this.damageHead,collisionCacheBytes:objects.reduce((n,o)=>n+o.cache.byteLength,0)+staticObjects.reduce((n,o)=>n+o.cache.byteLength,0),stepMs:end-start,tasks:groups.tasks,nearTasks:collection.taskRounds,controller:controllerResult?.controller,controllerStages:controllerResult?.stats};
    }finally{this.writingBodies=false;}
  }
  step(dt){const stages=this._stepStages(dt);let result=stages.next();if(!result.done){const {bodyWork,constraints}=result.value;result=stages.next(solveVoxelRows(bodyWork,constraints));}return result.value;}
  async stepAsync(dt){
    if(this.busy)throw new Error('Overlapping reference physics steps');this.busy=true;let retries=0;
    try{while(!this.disposed){
      const stages=this._stepStages(dt,{asyncNear:true});let result=stages.next();
      while(!result.done){const job=result.value;let value;if(job.kind==='step'){this.stepTasks??=new ReferenceStepTasks();value=await this.stepTasks.execute(job);}else value=job.kind==='near'?await this.tasks.executeNear(job.pairs,job.dt):await solveVoxelRowsAsync(job.bodyWork,job.constraints,this.tasks);result=stages.next(value);}
      if(!result.value?.cancelled){this.stats.retries=retries;return true;}
      if(this.disposed||this.physics.referencePipeline!==this)return false;
      retries++;this.physics._flushDirtyPoses();this.physics._refreshWorkset();this.physics._terrainAroundBodies(dt);
    }return false;}catch(error){if(this.disposed||this.physics.referencePipeline!==this)return false;throw error;}finally{this.busy=false;this.writingBodies=false;}
  }
  _damage(){
    const p=this.physics;let processed=0;
    // Bounded execution keeps unapplied damage in a real queue. Never silently
    // discard the rest because this frame reached its task budget.
    while(this.damageHead<this.pendingDamage.length&&processed<p.contactSettings.maxContactFracturesPerStep){
      const item=this.pendingDamage[this.damageHead++];this.queuedDamage.delete(item.key);const entry=p.entries.get(item.id);if(!entry||!gridCell(entry,item.cell.x,item.cell.y,item.cell.z))continue;
      const point=worldPoint(entry,item.localPoint),ratio=item.force/item.cap;if(!(ratio>1))continue;
      const radius=Math.min(p.contactSettings.maximumContactRadius,entry.cellSize*(1.25+Math.sqrt(Math.min(16,ratio-1))*.5));
      const result=p.destroySphere(point,radius,1,'contact',{id:entry.id,contactForce:item.force});processed++;
      result.contact={...item,point,radius,mode:'limitedConstraint',material:item.cell.mat,impactSpeed:item.speed};p.fractureEvents.push(result);p.contactEvents.push(result.contact);if(result.changes.length)p.contactFractures++;
      for(const change of result.changes)for(let i=this.damageHead;i<this.pendingDamage.length;i++){const pending=this.pendingDamage[i];if(pending.id!==change.oldId)continue;const child=change.newIds.map(id=>p.entries.get(id)).find(e=>e&&gridCell(e,pending.cell.x,pending.cell.y,pending.cell.z));if(child){this.queuedDamage.delete(pending.key);pending.id=child.id;pending.key=child.id+'/'+pending.cell.x+','+pending.cell.y+','+pending.cell.z;this.queuedDamage.add(pending.key);}}
    }
    if(this.damageHead>1024&&this.damageHead*2>this.pendingDamage.length){this.pendingDamage=this.pendingDamage.slice(this.damageHead);this.damageHead=0;}
  }
}
