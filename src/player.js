import {CELL} from './voxel-world.js';
import {worldPoint, sourcePoint, gridCell} from './rigid-fracture.js';

const STEP_HEIGHT=.51;
const GROUND_SNAP=.14;
const PLAYER_RADIUS=.38;
export const PLAYER_CONTROL=Object.freeze({radius:PLAYER_RADIUS,standingHeight:1.82,crouchHeight:1.67,standingEye:1.65,crouchEye:1.50,walkSpeed:4.8,sprintSpeed:7.8,crouchSpeed:2.4,jumpSpeed:6.5,jumpBuffer:.10,coyoteTime:.08,maxStep:1/60});
export function resetPlayerControl(player){delete player._jumpHeld;delete player._jumpBuffer;delete player._groundGrace;player.crouching=false;player.colliderHeight=PLAYER_CONTROL.standingHeight;player.eyeHeight=PLAYER_CONTROL.standingEye;}

function collisionQuery(world,physics,options={}){
  return physics
    ?(x,y,z,height=options.height??PLAYER_CONTROL.standingHeight,radius=PLAYER_RADIUS)=>world.collides(x,y,z,height,radius)||physics.collides(x,y,z,height,radius,options)
    :(x,y,z,height=options.height??PLAYER_CONTROL.standingHeight,radius=PLAYER_RADIUS)=>world.collides(x,y,z,height,radius);
}

function carryWithPlatform(player,world,physics,options){
  const support=player.rigidSupport,entry=support&&physics?.entries?.get(support.id);
  if(!player.grounded||!entry||entry.id===options.excludeId){delete player.rigidSupport;return;}
  if(support.voxel&&!gridCell(entry,support.voxel.x,support.voxel.y,support.voxel.z)){delete player.rigidSupport;return;}
  physics._syncEntry?.(entry);
  const next=worldPoint(entry,support.sourcePoint),delta={x:next.x-support.point.x,y:next.y-support.point.y,z:next.z-support.point.z};
  // A network correction or teleport must not drag the player across the map.
  const distance=Math.hypot(delta.x,delta.y,delta.z);
  if(distance>.75){delete player.rigidSupport;return;}
  const steps=Math.max(1,Math.ceil(distance/.1)),clear=collisionQuery(world,physics,{...options,excludeIds:[entry.id,...(options.excludeIds||[])]});
  for(let i=0;i<steps;i++){
    const trial={x:player.x+delta.x/steps,y:player.y+delta.y/steps,z:player.z+delta.z/steps};
    if(clear(trial.x,trial.y,trial.z)){delete player.rigidSupport;return;}
    Object.assign(player,trial);
  }
  support.point=next;
}

function rememberSupport(player,physics,contact){
  const entry=contact?.id&&physics?.entries?.get(contact.id);
  if(!entry||!player.grounded){delete player.rigidSupport;return;}
  const point={x:player.x,y:player.y,z:player.z};
  player.rigidSupport={id:entry.id,point,sourcePoint:sourcePoint(entry,point),voxel:contact.voxel};
}

function applyPlayerContacts(player,physics,contact,pushes,dt,gravity){
  if(!physics||physics.isReplica||dt<=0)return;
  const mass=Number.isFinite(player.mass)&&player.mass>0?player.mass:65;
  if(player.grounded&&contact?.id){
    const entry=physics.entries?.get(contact.id);
    // Approximate kinematic-character load, once for the selected support.
    // Bound the added COM speed so lightweight chips cannot be driven through
    // a bridge or register a resting player as a high-speed fracture impact.
    if(entry){const impulse=Math.min(mass*gravity*dt,entry.body.mass()*.5);if(impulse>0)physics.impulse(entry.id,{x:0,y:-impulse,z:0},contact.point);}
  }
  for(const [id,push]of pushes){
    const entry=physics.entries?.get(id);if(!entry)continue;
    const length=Math.hypot(push.x,push.z),amount=Math.min(mass*length*.12,entry.body.mass()*.35);
    if(amount>0)physics.impulse(id,{x:push.x/length*amount,y:0,z:push.z/length*amount},push.point);
  }
}

// Fixed-step kinematic movement shared by the local game, authoritative room
// simulation and route/collision tests. Dynamic collision remains opt-in.
export function stepPlayer(player,world,input,yaw,dt,physics=null) {
  const elapsed=Math.max(0,Math.min(.1,Number.isFinite(dt)?dt:0)),count=Math.max(1,Math.ceil(elapsed/PLAYER_CONTROL.maxStep));
  let result={fellInWater:false};
  for(let i=0;i<count;i++){result=stepPlayerSlice(player,world,input,yaw,elapsed/count,physics);if(result.fellInWater)break;}
  return result;
}
function stepPlayerSlice(player,world,input,yaw,dt,physics){
  const queryOptions={excludeId:player.excludeRigidId??(player.carrying?`cargo-${player.carrying}`:undefined)};
  const standing=collisionQuery(world,physics,queryOptions);
  player.crouching=Boolean(input.crouch)||(Boolean(player.crouching)&&standing(player.x,player.y,player.z));
  player.colliderHeight=player.crouching?PLAYER_CONTROL.crouchHeight:PLAYER_CONTROL.standingHeight;
  queryOptions.height=player.colliderHeight;
  const eye=player.crouching?PLAYER_CONTROL.crouchEye:PLAYER_CONTROL.standingEye;
  player.eyeHeight=(player.eyeHeight??PLAYER_CONTROL.standingEye)+(eye-(player.eyeHeight??PLAYER_CONTROL.standingEye))*(1-Math.exp(-18*dt));
  const collides=collisionQuery(world,physics,queryOptions),pushes=new Map();
  const gravity=Number.isFinite(world.gravity)&&world.gravity>=0?world.gravity:18;
  carryWithPlatform(player,world,physics,queryOptions);
  const recordPush=(trial,axis,velocity)=>{
    if(!physics?.collisionContact||physics.isReplica)return;
    const contact=physics.collisionContact(trial.x,trial.y,trial.z,player.colliderHeight,PLAYER_RADIUS,queryOptions);if(!contact)return;
    const push=pushes.get(contact.id)||{x:0,z:0,point:contact.point};
    if(Math.abs(velocity)>Math.abs(push[axis]))push[axis]=velocity;
    pushes.set(contact.id,push);
  };
  const forward=Number(input.forward||0),strafe=Number(input.strafe||0);
  const length=Math.max(1,Math.hypot(forward,strafe)),speed=player.crouching?PLAYER_CONTROL.crouchSpeed:input.sprint?PLAYER_CONTROL.sprintSpeed:PLAYER_CONTROL.walkSpeed;
  const vx=(-Math.sin(yaw)*forward+Math.cos(yaw)*strafe)*speed/length,vz=(-Math.cos(yaw)*forward-Math.sin(yaw)*strafe)*speed/length;
  // Grapple flight keeps its momentum in the air; WASD only nudges it.
  if(input.airInertia&&!player.grounded){player.vx+=vx/speed*4*dt;player.vz+=vz/speed*4*dt;}
  else{const ease=1-Math.exp(-(player.grounded?14:5)*dt);player.vx+=(vx-player.vx)*ease;player.vz+=(vz-player.vz)*ease;}

  for(const axis of ['x','z']){
    const velocity=axis==='x'?'vx':'vz',distance=player[velocity]*dt;
    // Explosion impulses may travel beyond a thin fragment in one step.
    const steps=Math.max(1,Math.ceil(Math.abs(distance)/(CELL*.5))),delta=distance/steps;
    for(let step=0;step<steps;step++){
      const trial={...player,[axis]:player[axis]+delta};
      if(!collides(trial.x,trial.y,trial.z))player[axis]=trial[axis];
      else if(player.grounded){
        // Find the first clear height instead of jumping a full half metre over
        // every tiny curb. Recover the collision tolerance when possible.
        let blocked=0,clear=null;
        for(let h=CELL;h<STEP_HEIGHT;h+=CELL){
          if(collides(trial.x,trial.y+h,trial.z))blocked=h;
          else{clear=h;break;}
        }
        if(clear===null&&!collides(trial.x,trial.y+STEP_HEIGHT,trial.z))clear=STEP_HEIGHT;
        if(clear===null){recordPush(trial,axis,player[velocity]);player[velocity]=0;break;}
        for(let i=0;i<9;i++){
          const mid=(blocked+clear)/2;
          if(collides(trial.x,trial.y+mid,trial.z))blocked=mid;else clear=mid;
        }
        const lifted=trial.y+clear+.025;
        player[axis]=trial[axis];player.y=collides(trial.x,lifted,trial.z)?trial.y+clear:lifted;
        player.vy=0;
      }
      else{recordPush(trial,axis,player[velocity]);player[velocity]=0;break;}
    }
  }

  const bounds=world.bounds;player.x=Math.max(bounds.minX,Math.min(bounds.maxX,player.x));player.z=Math.max(bounds.minZ,Math.min(bounds.maxZ,player.z));
  const wasGrounded=player.grounded;
  if(dt>0){
    if(input.jump&&!player._jumpHeld)player._jumpBuffer=PLAYER_CONTROL.jumpBuffer;
    else player._jumpBuffer=Math.max(0,(player._jumpBuffer??0)-dt);
    player._jumpHeld=Boolean(input.jump);
    player._groundGrace=player.grounded?PLAYER_CONTROL.coyoteTime:Math.max(0,(player._groundGrace??0)-dt);
    if(player._jumpBuffer>0&&player._groundGrace>0){player.vy=PLAYER_CONTROL.jumpSpeed;player.grounded=false;player._jumpBuffer=0;player._groundGrace=0;}
  }
  player.vy-=gravity*dt;
  const oldY=player.y,trialY=oldY+player.vy*dt;
  // Sweep upward as well as downward: a blast or fast fall can cross an
  // entire static slab even at a bounded simulation step.
  let blockedY=null,safeY=oldY;
  const verticalSteps=Math.max(1,Math.ceil(Math.abs(trialY-oldY)/(CELL*.5)));
  for(let i=1;i<=verticalSteps;i++){
    const y=oldY+(trialY-oldY)*i/verticalSteps;
    if(collides(player.x,y,player.z)){blockedY=y;break;}safeY=y;
  }
  const floor=world.floorAt(player.x,player.z);
  // Trace the entire downward step so a fast fall cannot skip a thin plank.
  // The probe starts at the feet, never above an overhead block's top surface.
  const snap=wasGrounded?GROUND_SNAP:.055;
  const supportDrop=Math.max(0,oldY-trialY)+snap+.03;
  const dynamicContact=physics&&player.vy<=0
    ?(physics.supportContact?physics.supportContact(player.x,player.z,oldY+.03,supportDrop,PLAYER_RADIUS,queryOptions):{height:physics.supportHeight(player.x,player.z,oldY+.03,supportDrop,PLAYER_RADIUS,queryOptions)})
    :null;
  const dynamicTop=dynamicContact?.height;
  const validDynamicTop=Number.isFinite(dynamicTop)&&dynamicTop>=floor&&dynamicTop<=oldY+.03
    &&dynamicTop>=trialY-snap&&!collides(player.x,dynamicTop,player.z);
  if(validDynamicTop&&dynamicTop>=trialY){player.y=dynamicTop;player.vy=0;player.grounded=true;}
  else if(trialY<floor&&(blockedY===null||safeY<floor)){player.y=floor;player.vy=0;player.grounded=true;}
  else if(blockedY!==null){
    let safe=safeY,blocked=blockedY;
    for(let i=0;i<9;i++){
      const mid=(safe+blocked)/2;
      if(collides(player.x,mid,player.z))blocked=mid;else safe=mid;
    }
    player.y=safe;player.grounded=player.vy<0;player.vy=0;
  }else{player.y=trialY;player.grounded=false;}

  // Keep feet on voxel tops when crossing small downward steps or landing.
  // Probe a thin layer at foot level rather than the whole player body.
  if(player.vy<=0){
    const snap=wasGrounded||player.grounded?GROUND_SNAP:.055;
    const first=Math.ceil((player.y-.025)/CELL);
    for(let n=first;n*CELL>=player.y-snap-1e-6;n--){
      const top=n*CELL;
      if(top>oldY+.03||top<floor-1e-6)continue;
      if(world.collides(player.x,top-.03,player.z,.04,PLAYER_RADIUS)&&!collides(player.x,top,player.z)){
        player.y=top;player.vy=0;player.grounded=true;break;
      }
    }
    // Rotating bodies are not aligned to CELL. Use their actual top surface,
    // with body clearance checked again after the static-ground snap above.
    if(validDynamicTop&&dynamicTop>=player.y-snap&&dynamicTop<=player.y+.03
      &&!collides(player.x,dynamicTop,player.z)){
      player.y=dynamicTop;player.vy=0;player.grounded=true;
    }
  }
  const retainedContact=validDynamicTop&&player.grounded&&Math.abs(player.y-dynamicTop)<.025?dynamicContact:null;
  rememberSupport(player,physics,retainedContact);
  applyPlayerContacts(player,physics,retainedContact,pushes,dt,gravity);
  if(player.y<-2){delete player.rigidSupport;Object.assign(player,world.respawn||{x:9,y:0,z:12.5},{vy:0,vx:0,vz:0});resetPlayerControl(player);return {fellInWater:true};}
  return {fellInWater:false};
}
