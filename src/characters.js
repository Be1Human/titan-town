import * as THREE from '../vendor/three.module.js';
import {CELL} from './voxel-world.js';
import {stepPlayer} from './player.js';
import {stepDebris} from './debris-physics.js';
import {normalizeAppearance} from './character-config.js';
import {createWorkerVisual} from './worker-visual.js';
import {roleAppearance} from './game-character-profiles.js';
import {gameCharacterScale} from './character-scale.js';

// Gameplay state is independent of the shared fine-voxel skinned visual.
export const DEFAULT_CHARACTERS=Object.freeze([
  {id:'patrol',name:'现场质检员',role:'patrol',x:8.4,y:3.02,z:-8.6,yaw:0,speed:.55,route:[[8.4,-8.6],[9.5,-11],[10.2,-8.6]]},
  {id:'mechanic',name:'橙衣维修工',role:'mechanic',x:8.7,y:2.92,z:-20,yaw:Math.PI,speed:.4,route:[[8.7,-20],[8.7,-22]]},
  {id:'porter',name:'仓库搬运工',role:'porter',x:-24,y:6.22,z:-31,yaw:.2,speed:.48,route:[[-24,-31],[-24,-33]]},
  {id:'scout',name:'测量员',role:'scout',x:-4,y:3.22,z:-9.4,yaw:Math.PI/2,speed:.38,route:[[-4,-9.4],[-6,-9.4]]},
  {id:'medic',name:'设备维修员',role:'medic',x:6.9,y:9.32,z:44.4,yaw:Math.PI,speed:.36,route:[[6.9,44.4],[5.9,43.4]]},
]);

const MODEL_ORIGIN=.95;
function modelData(definition,appearanceTransform=value=>value){
  const fallback=roleAppearance(definition.role);
  const appearance=normalizeAppearance(appearanceTransform(normalizeAppearance(definition.appearance,fallback))),visual=createWorkerVisual(appearance,{worldScale:gameCharacterScale(appearance)});
  const offset=new THREE.Vector3(0,-MODEL_ORIGIN,0),bounds=visual.bounds.clone().translate(offset),carryBounds=visual.propBounds?.clone().translate(offset);
  visual.group.matrixAutoUpdate=false;
  return{appearance,visual,bounds,bodyHalfY:Math.max(.16,bounds.max.z+.01),carryOffset:carryBounds?.getCenter(new THREE.Vector3()),carrySize:carryBounds?.getSize(new THREE.Vector3())};
}

function groundedPosition(world,definition){
  // Probe a little beyond the model footprint. Sloped BSP floors have several
  // voxel heights within a single boot, so a centre-only ray starts inside them.
  for(const radius of [0,.6,1.2,1.8])for(let i=0;i<(radius?8:1);i++){
    const x=definition.x+Math.cos(i*Math.PI/4)*radius,z=definition.z+Math.sin(i*Math.PI/4)*radius;
    let y=-Infinity;
    for(const dx of [-.3,0,.3])for(const dz of [-.3,0,.3]){
      const hit=world.raycast({x:x+dx,y:definition.y+1.3,z:z+dz},{x:0,y:-1,z:0},3);
      if(hit)y=Math.max(y,hit.point.y+.025);
    }
    if(Number.isFinite(y)&&!world.collides(x,y,z,1.97,.32))return{x,y,z};
    const floor=world.floorAt?.(x,z)??0;
    if(!Number.isFinite(y)&&Math.abs(definition.y-floor)<1.5&&!world.collides(x,floor,z,1.97,.32))return{x,y:floor,z};
  }
  return null;
}

function rotatedSamples(xs,ys,zs,yaw){
  const samples=[],c=Math.cos(yaw),s=Math.sin(yaw);
  for(const x of xs)for(const y of ys)for(const z of zs)samples.push({x:x*c+z*s,y,z:z*c-x*s});
  return samples;
}
function bodySamples(state){
  const {min,max}=state.bounds;
  // At the final forward fall, local +Z is the underside, and local Y lies along Z.
  const half=CELL*.5;
  return rotatedSamples([min.x+half,max.x-half],[-state.bodyHalfY+half,-min.z-half],[min.y+half,0,max.y-half],state.yaw);
}
function carrySamples(state,yaw){
  const size=state.carrySize;
  const extent=[size.x,size.y,size.z].map(value=>Math.max(0,value*.5-CELL*.5));
  return rotatedSamples([-extent[0],extent[0]],[-extent[1],extent[1]],[-extent[2],extent[2]],yaw);
}
function savedBody(body){return body?{position:body.position.toArray(),vx:body.vx,vy:body.vy,vz:body.vz,rest:body.rest}:null;}
function restoredBody(record,position,samples,halfY){
  const valid=Array.isArray(record?.position)&&record.position.length===3&&record.position.every(Number.isFinite);
  return{position:valid?new THREE.Vector3().fromArray(record.position):position,vx:Number.isFinite(record?.vx)?record.vx:0,vy:Number.isFinite(record?.vy)?record.vy:0,vz:Number.isFinite(record?.vz)?record.vz:0,samples,halfY,rest:Boolean(record?.rest)};
}

export function createCharacterSystem(scene,initialWorld,definitions=DEFAULT_CHARACTERS,{appearanceTransform=value=>value}={}){
  let world=initialWorld,sourceDefinitions=definitions??DEFAULT_CHARACTERS,mesh=null,states=[],poseDirty=false;
  const root=new THREE.Matrix4(),pivot=new THREE.Matrix4(),carryRoot=new THREE.Matrix4();
  const q=new THREE.Quaternion(),euler=new THREE.Euler(),scale=new THREE.Vector3(1,1,1),v=new THREE.Vector3(),ray=new THREE.Ray(),box=new THREE.Box3(),inverse=new THREE.Matrix4(),hitPoint=new THREE.Vector3();
  const system={get characters(){return states;},get mesh(){return mesh;},get stats(){return{actors:states.length,drawCalls:states.reduce((n,s)=>n+s.visual.metrics.drawCalls,0),triangles:states.reduce((n,s)=>n+s.visual.metrics.triangles+(s.appearance.prop!=='none'?s.visual.metrics.propTriangles:0),0)};},get world(){return world;},setWorld(nextWorld){world=nextWorld;return system;},reset,setAppearance,update,syncVisuals,raycast,hit,blast,snapshot,restore,dispose};

  function modelRoot(state){
    if(state.down){
      const t=Math.min(1,state.fallAge/.24),tilt=t*t*(3-2*t)*Math.PI/2;
      q.setFromEuler(euler.set(0,state.yaw,0));q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),tilt));
      root.compose(state.body.position,q,scale);
    }else{
      q.setFromEuler(euler.set(Math.sin(state.flinch*20)*state.flinch*.15,state.yaw,0));
      root.compose(v.set(state.x,state.y+.95+Math.sin(state.phase*2)*state.walk*.022,state.z),q,scale);
    }
    return root;
  }
  function sync(){
    if(!mesh)return;
    for(const state of states){
      modelRoot(state);
      pivot.makeTranslation(0,-MODEL_ORIGIN,0);state.visual.group.matrix.multiplyMatrices(root,pivot);state.visual.group.matrixWorldNeedsUpdate=true;
      state.visual.setPose({phase:state.phase,walk:state.walk,time:state.time,down:state.down});
      if(state.carry){
        const center=state.visual.propLocalBounds.getCenter(v);
        q.setFromEuler(euler.set(0,state.carry.yaw,0));carryRoot.compose(state.carry.body.position,q,state.visual.propScale);
        pivot.makeTranslation(-center.x,-center.y,-center.z);carryRoot.multiply(pivot);
        const prop=state.visual.prop;prop.matrixAutoUpdate=false;prop.matrix.copy(carryRoot);prop.matrixWorldNeedsUpdate=true;
      }
    }
    mesh.updateMatrixWorld(true);
  }
  function reset(nextDefinitions=sourceDefinitions,nextWorld=world){
    world=nextWorld;sourceDefinitions=nextDefinitions??DEFAULT_CHARACTERS;
    for(const state of states)state.visual.dispose();states=[];
    for(const [index,definition]of sourceDefinitions.entries()){
      const position=groundedPosition(world,definition);if(!position)continue;
      const role=definition.role||'patrol';
      states.push({...definition,...position,id:definition.id||`extra-${index}`,role,name:definition.name||role,yaw:definition.yaw||0,health:100,down:false,body:null,carry:null,fallAge:0,flinch:0,vx:0,vy:0,vz:0,grounded:true,time:index*.67,phase:index,walk:0,wait:1.3+index*.35,routeIndex:0,...modelData({...definition,role},appearanceTransform),home:{...position}});
    }
    rebuildMesh();return system;
  }
  function rebuildMesh(){
    if(!mesh){mesh=new THREE.Group();mesh.name='sandbox-character-extras';scene.add(mesh);}
    for(const state of states){mesh.add(state.visual.group);if(state.carry)state.visual.detachProp(mesh);}
    mesh.count=states.length;sync();
  }
  function setAppearance(id,appearance){
    const actor=states.find(s=>s.id===id);if(!actor)return false;
    actor.visual.dispose();Object.assign(actor,modelData({...actor,appearance},appearanceTransform));
    if(actor.body){actor.body.samples=bodySamples(actor);actor.body.halfY=actor.bodyHalfY;actor.body.rest=false;}
    // A changed cosmetic prop starts in hand; a downed actor drops the new prop.
    actor.carry=null;if(actor.down)releaseProp(actor,{x:0,z:0},0);
    rebuildMesh();return true;
  }
  // The skinned pose is display-only. Fixed-step callers may defer it to one
  // syncVisuals() per drawn frame; gameplay queries use the state directly.
  function syncVisuals(){if(!poseDirty)return false;poseDirty=false;sync();return true;}
  function update(dt,{syncVisuals:immediate=true}={}){
    dt=Math.max(0,Math.min(.1,dt));if(!dt)return;
    for(const state of states){
      state.time+=dt;state.flinch=Math.max(0,state.flinch-dt);
      if(state.carry)stepDebris(state.carry.body,world,dt,CELL);
      if(state.down){
        state.fallAge+=dt;stepDebris(state.body,world,dt,CELL);
        state.x=state.body.position.x;state.y=state.body.position.y-.27;state.z=state.body.position.z;continue;
      }
      let forward=0;
      state.wait=Math.max(0,state.wait-dt);
      const route=state.route||[];
      if(!state.wait&&route.length){
        const target=route[state.routeIndex%route.length],dx=target[0]-state.x,dz=target[1]-state.z,d=Math.hypot(dx,dz);
        if(d<.22){state.routeIndex=(state.routeIndex+1)%route.length;state.wait=1.6+(state.routeIndex%3)*.65;}
        else{
          const targetYaw=Math.atan2(dx,dz),delta=Math.atan2(Math.sin(targetYaw-state.yaw),Math.cos(targetYaw-state.yaw));state.yaw+=delta*Math.min(1,dt*4);
          // The player mover faces -Z; these model faces look toward +Z.
          forward=-(state.speed??.45)/4.8;
          const aheadX=state.x+Math.sin(state.yaw)*.65,aheadZ=state.z+Math.cos(state.yaw)*.65;
          const ground=world.raycast({x:aheadX,y:state.y+.5,z:aheadZ},{x:0,y:-1,z:0},1.2);
          if(!ground&&(world.floorAt?.(aheadX,aheadZ)??0)<state.y-.65){forward=0;state.routeIndex=(state.routeIndex+1)%route.length;state.wait=.9;}
        }
      }
      const oldX=state.x,oldZ=state.z;
      stepPlayer(state,world,{forward},state.yaw,dt);
      const distance=Math.hypot(state.x-oldX,state.z-oldZ);state.walk+=(Number(distance>.002)-state.walk)*Math.min(1,dt*7);state.phase+=distance*12;
      if(forward&&distance<.001){state.wait=.8;state.routeIndex=(state.routeIndex+1)%Math.max(1,route.length);}
    }
    if(immediate){poseDirty=false;sync();}else poseDirty=true;
  }
  function raycast(origin,direction,maxDistance=60){
    if(maxDistance<0||Math.hypot(direction.x,direction.y,direction.z)<1e-8)return null;
    let nearest=null;
    for(const state of states){
      if(state.down)continue;
      inverse.copy(modelRoot(state)).invert();ray.origin.copy(origin);ray.direction.copy(direction).normalize();ray.applyMatrix4(inverse);
      box.copy(state.bounds);
      if(!ray.intersectBox(box,hitPoint))continue;
      hitPoint.applyMatrix4(root);const distance=hitPoint.distanceTo(origin);
      if(distance>maxDistance||(nearest&&distance>=nearest.distance))continue;
      nearest={type:'character',id:state.id,character:state,distance,point:hitPoint.clone(),normal:new THREE.Vector3().copy(direction).normalize().negate()};
    }
    return nearest;
  }
  function hit(target,{damage=40,direction={x:0,y:0,z:1},force=3}={}){
    const id=typeof target==='string'?target:target?.id??target?.character?.id,state=states.find(item=>item.id===id);
    if(!state)return false;
    const length=Math.hypot(direction.x,direction.y,direction.z)||1,dx=direction.x/length,dz=direction.z/length;
    state.flinch=.3;state.health=Math.max(0,state.health-Math.max(0,damage));
    if(!state.down&&state.health<=0){
      releaseProp(state,{x:dx,z:dz},force);
      state.down=true;state.fallAge=0;state.walk=0;
      state.body={position:new THREE.Vector3(state.x,state.y+.95,state.z),vx:dx*force,vy:Math.max(.7,force*.28),vz:dz*force,halfY:state.bodyHalfY,samples:bodySamples(state),rest:false};
    }else if(state.down){state.body.vx+=dx*force*.6;state.body.vz+=dz*force*.6;state.body.vy+=force*.15;state.body.rest=false;}
    else{state.vx+=dx*force*.35;state.vz+=dz*force*.35;state.wait=.6;}
    sync();return true;
  }
  function releaseProp(state,direction,force){
    if(!state.carrySize)return;
    state.visual.detachProp(mesh);
    const offset=state.carryOffset,c=Math.cos(state.yaw),s=Math.sin(state.yaw);
    state.carry={yaw:state.yaw,body:{position:new THREE.Vector3(state.x+offset.x*c+offset.z*s,state.y+MODEL_ORIGIN+offset.y,state.z+offset.z*c-offset.x*s),vx:direction.x*force*1.12-c*1.2+s*.7,vy:1+force*.22,vz:direction.z*force*1.12+s*1.2+c*.7,halfY:state.carrySize.y*.5,samples:carrySamples(state,state.yaw),rest:false}};
  }
  function blast(point,radius=7,power=1){
    const affected=[];if(radius<=0||power<=0)return affected;
    for(const state of states){
      const target={x:state.x,y:state.y+(state.down ? .35 : 1),z:state.z},direction={x:target.x-point.x,y:target.y-point.y,z:target.z-point.z},distance=Math.hypot(direction.x,direction.y,direction.z);
      if(distance>=radius)continue;
      const obstacle=distance>.3&&world.raycast(target,{x:-direction.x,y:-direction.y,z:-direction.z},distance-.25),falloff=(1-distance/radius)*(obstacle ? .14 : 1);
      if(falloff<=0)continue;
      hit(state.id,{damage:160*power*falloff,direction,force:Math.min(11,2+9*power*falloff)});affected.push(state.id);
    }
    return affected;
  }
  function snapshot(){return states.map(state=>({id:state.id,visualVersion:2,appearance:{...state.appearance},x:state.x,y:state.y,z:state.z,yaw:state.yaw,health:state.health,down:state.down,routeIndex:state.routeIndex,time:state.time,body:savedBody(state.body),carry:state.carry?{yaw:state.carry.yaw,body:savedBody(state.carry.body)}:null}));}
  function restore(saved){
    if(!Array.isArray(saved))return;
    for(const record of saved){
      const state=states.find(item=>item.id===record.id);if(!state||!['x','y','z','yaw','health'].every(key=>Number.isFinite(record[key])))continue;
      if(record.appearance){state.visual.dispose();Object.assign(state,modelData({...state,appearance:record.appearance},appearanceTransform));}
      Object.assign(state,{x:record.x,y:record.y,z:record.z,yaw:record.yaw,health:Math.max(0,Math.min(100,record.health)),down:Boolean(record.down),routeIndex:Math.max(0,Math.floor(record.routeIndex||0)),time:Number.isFinite(record.time)?record.time:0,vx:0,vy:0,vz:0,fallAge:1});
      state.carry=null;state.visual.attachProp();
      if(state.down){
        state.body=restoredBody(record.body,new THREE.Vector3(state.x,state.y+.29,state.z),bodySamples(state),state.bodyHalfY);state.body.restRevision=world.revision;
        if(state.carrySize){
          const carry=record.carry,yaw=Number.isFinite(carry?.yaw)?carry.yaw:state.yaw;
          state.carry={yaw,body:restoredBody(carry?.body,new THREE.Vector3(state.x+Math.sin(yaw)*.8,state.y+.6,state.z+Math.cos(yaw)*.8),carrySamples(state,yaw),state.carrySize.y*.5)};
          state.carry.body.restRevision=world.revision;
          // Older saves included the carried box in the body's collision
          // thickness; let that body settle again using its ordinary profile.
          if(!carry||record.visualVersion!==2){state.body.rest=false;state.carry.body.rest=false;}
        }
        if(record.visualVersion!==2)state.body.rest=false;
      }else state.body=null;
    }rebuildMesh();
  }
  function dispose(){for(const state of states)state.visual.dispose();if(mesh)scene.remove(mesh);states=[];mesh=null;}
  return reset(sourceDefinitions,world);
}
