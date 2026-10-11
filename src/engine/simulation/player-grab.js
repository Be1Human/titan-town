import {sourcePoint,worldPoint,gridCell} from '../../rigid-fracture.js';
import {applyGrabForce} from './grab-system.js';

// A handle belongs to a source voxel, so it survives a moving or split model
// without confusing its visual origin with its center of mass.
export class PlayerGrab {
  constructor(physics){this.physics=physics;this.handle=null;}
  grab(hit,{mode='carry'}={}){
    const entry=this.physics?.entries.get(hit?.rigidId??hit?.id);
    if(!entry||!hit.voxel||hit.distance>2.8)return false;
    this.handle={id:entry.id,localPoint:sourcePoint(entry,hit.point),anchorCell:{...hit.voxel},distance:Math.max(.8,Math.min(mode==='drag'?2.8:2,hit.distance)),mode};
    return true;
  }
  get speedFactor(){const entry=this.physics?.entries.get(this.handle?.id);return entry?Math.max(.35,Math.min(.85,1-entry.body.mass()/800)):1;}
  adjustDistance(delta){if(!this.handle||!Number.isFinite(delta))return false;this.handle.distance=Math.max(.8,Math.min(2.8,this.handle.distance+Math.max(-.3,Math.min(.3,delta))));return true;}
  release(direction){
    const handle=this.handle;this.handle=null;
    const entry=this.physics?.entries.get(handle?.id);
    if(entry&&direction){
      const impulse=Math.min(120,entry.body.mass()*3.6),point=worldPoint(entry,handle.localPoint);
      this.physics.impulse(entry.id,{x:direction.x*impulse,y:direction.y*impulse+impulse*.12,z:direction.z*impulse},point);
    }
  }
  rebind(changes){
    for(const change of changes){
      const handle=this.handle;if(handle?.id!==change.oldId)continue;
      const c=handle.anchorCell;
      const child=change.newIds.map(id=>this.physics.entries.get(id)).find(entry=>entry&&gridCell(entry,c.x,c.y,c.z));
      if(child)handle.id=child.id;else this.release();
    }
  }
  step(origin,direction,dt,holdTarget=null){
    const handle=this.handle;if(!handle)return;
    const entry=this.physics?.entries.get(handle.id),c=handle.anchorCell;
    if(!entry||!gridCell(entry,c.x,c.y,c.z)){this.release();return;}
    const target=holdTarget??{x:origin.x+direction.x*handle.distance,y:origin.y+direction.y*handle.distance,z:origin.z+direction.z*handle.distance};
    const result=applyGrabForce(this.physics,{id:handle.id,localPoint:handle.localPoint,target},dt);
    if(!result.ok)this.release();
  }
}
