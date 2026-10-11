import {placeCargo,removeCargo,validateCargoLayout,cargoLoad,CARGO_MASS} from './courier-layout.js';
import {createOriginalCargo} from './engine/assets/original-cargo.js';
import {CELL} from './voxel-world.js';

const copy=value=>JSON.parse(JSON.stringify(value));
const fail=error=>({ok:false,error});

// Local cargo uses the real rigid body and the shared packing contract. Stowing
// removes exactly one body; unloading admits it before committing inventory.
export class LocalCargo {
  constructor(physics,grab){this.physics=physics;this.grab=grab;this.records=new Map();this.items=[];this.extended=false;}
  reset(definitions=[],{install=true}={}){
    this.items=[];this.extended=false;this.records=new Map(definitions.map(c=>[c.id,{...c,rigidId:`cargo-${c.id}`,mounted:false,stowedBody:null}]));
    if(install)for(const c of this.records.values())if(!this.physics?.entries.has(c.rigidId)){
      const model=createOriginalCargo(c),entry=this.physics?.addPersistent(model.cells,{...model,id:c.rigidId,contactFracture:true});
      if(entry)entry.name=c.name;
    }
  }
  get load(){return cargoLoad(this.items,this.extended,i=>this.records.get(i.id)?.rackKg??CARGO_MASS[i.size]);}
  get rack(){return {items:this.items,extended:this.extended,load:this.load};}
  byRigid(id){return [...this.records.values()].find(c=>c.rigidId===id&&!c.mounted);}
  get held(){return this.byRigid(this.grab.handle?.id);}
  get activeCount(){return [...this.records.values()].filter(c=>c.mounted||this.physics?.entries.has(c.rigidId)).length;}
  nearestHit(origin,raycast,range=2.8){
    const candidates=[...this.records.values()].filter(c=>!c.mounted).map(c=>({c,entry:this.physics?.entries.get(c.rigidId)})).filter(c=>c.entry)
      .map(({c,entry})=>({c,entry,d:Math.hypot(entry.position.x-origin.x,entry.position.y-origin.y,entry.position.z-origin.z)})).sort((a,b)=>a.d-b.d);
    for(const {c,entry,d}of candidates){
      if(d>range||d<.001)continue;
      const direction={x:(entry.position.x-origin.x)/d,y:(entry.position.y-origin.y)/d,z:(entry.position.z-origin.z)/d};
      const hit=raycast(origin,direction,d+.25);
      if((hit?.rigidId??hit?.id)===c.rigidId&&hit.voxel)return {hit,cargo:c};
    }
    return null;
  }
  mount(){
    const c=this.held;if(!c)return fail('先按 E 拿起货箱，再按 F 装到背架');
    try{
      const items=placeCargo(this.items,{id:c.id,size:c.rackSize},this.extended);
      if(cargoLoad(items,this.extended,i=>this.records.get(i.id)?.rackKg??CARGO_MASS[i.size]).overweight)return fail('超过背架 40 kg 承重，请先卸货');
      const e=this.physics.entries.get(c.rigidId);if(!e)return fail('物件已经损坏或不在手上');
      const body={cells:e.cells.map(v=>({...v})),cellSize:e.cellSize,density:e.density,strength:e.strength,revision:e.revision,
        damage:[...e.damage].map(([k,amount])=>[...k.split(',').map(Number),amount])};
      this.grab.release();this.physics.remove(c.rigidId);c.stowedBody=body;c.mounted=true;this.items=items.map(i=>({...i}));
      return {ok:true,cargo:c};
    }catch(e){return fail(e.message);}
  }
  unmount(player,yaw,id=this.items.at(-1)?.id){
    const c=this.records.get(id);if(!c?.mounted||!c.stowedBody)return fail('背架是空的');
    try{
      const items=removeCargo(this.items,id,this.extended),body=c.stowedBody;
      const bounds={};for(const a of ['x','y','z']){const values=body.cells.map(v=>v[a]);bounds[a]={min:Math.min(...values),max:Math.max(...values)+1};}
      const center=Object.fromEntries(['x','y','z'].map(a=>[a,(bounds[a].min+bounds[a].max)*body.cellSize/2]));
      const height=(bounds.y.max-bounds.y.min)*body.cellSize,radius=Math.max(bounds.x.max-bounds.x.min,bounds.z.max-bounds.z.min)*body.cellSize/2;
      let position;
      // Try the front, then diagonally to either side. Check actual solid voxels
      // and other bodies, so a failed unload never loses the stored object.
      for(const offset of [0,-.65,.65]){
        const angle=yaw+offset,p={x:player.x-Math.sin(angle)*.95,y:player.y+.65,z:player.z-Math.cos(angle)*.95};
        const blocked=body.cells.some(v=>this.physics.voxelWorld.getId(Math.floor((p.x+(v.x+.5)*body.cellSize-center.x)/CELL),Math.floor((p.y+(v.y+.5)*body.cellSize-center.y)/CELL),Math.floor((p.z+(v.z+.5)*body.cellSize-center.z)/CELL)));
        if(!blocked&&!this.physics.collides(p.x,p.y-height/2,p.z,height,radius)){position=p;break;}
      }
      if(!position)return fail('前方没有卸货空间，请走到空地再按 G');
      const entry=this.physics.addPersistent(body.cells,{...body,id:c.rigidId,position,contactFracture:true});
      if(!entry)return fail('物理物件数量已满，背架保留原物件，请稍后卸下');
      entry.name=c.name;this.items=items.map(i=>({...i}));c.mounted=false;c.stowedBody=null;
      return {ok:true,cargo:c};
    }catch(e){return fail(e.message);}
  }
  rebind(changes){
    for(const change of changes){const c=this.byRigid(change.oldId);if(!c)continue;
      const child=change.newIds.map(id=>this.physics.entries.get(id)).filter(Boolean).sort((a,b)=>b.cells.length-a.cells.length)[0];
      if(child){c.rigidId=child.id;child.name=c.name;}
    }
  }
  snapshot(){return copy({version:1,extended:this.extended,items:this.items,records:[...this.records.values()]});}
  diagnostics(){return {rack:this.rack,held:this.held?.id??null,objects:[...this.records.values()].map(c=>({id:c.id,name:c.name,size:c.rackSize,kg:c.rackKg,mounted:c.mounted,rigidId:c.rigidId,position:this.physics?.entries.get(c.rigidId)?.position??null,available:c.mounted||Boolean(this.physics?.entries.has(c.rigidId))}))};}
  restore(saved,definitions=[]){
    this.reset(definitions,{install:false});
    // Old saves did not include pickups. Add them once when upgrading a save.
    if(!saved){this.reset(definitions);return;}
    if(saved.version!==1||!Array.isArray(saved.records))throw Error('货物存档无效');
    const items=validateCargoLayout(saved.items,Boolean(saved.extended)),records=new Map(this.records);
    for(const data of saved.records){const original=records.get(data.id);if(!original)continue;records.set(data.id,{...original,rigidId:data.rigidId,mounted:Boolean(data.mounted),stowedBody:data.stowedBody?copy(data.stowedBody):null});}
    for(const item of items){const c=records.get(item.id);if(!c?.mounted||!c.stowedBody?.cells?.length||c.rackSize!==item.size)throw Error('背架存档与货物不一致');}
    for(const c of records.values())if(c.mounted&&!items.some(i=>i.id===c.id))throw Error('背架货物缺少格位');
    if(cargoLoad(items,Boolean(saved.extended),i=>records.get(i.id).rackKg??CARGO_MASS[i.size]).overweight)throw Error('背架存档超重');
    this.records=records;this.items=items.map(i=>({...i}));this.extended=Boolean(saved.extended);
    for(const c of records.values()){if(c.mounted)this.physics?.remove(c.rigidId);else{const e=this.physics?.entries.get(c.rigidId);if(e)e.name=c.name;}}
  }
}
