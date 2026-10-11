import * as THREE from '../vendor/three.module.js';
import {CELL} from './voxel-world.js';
import {createTitanModel} from './titan-model.js';

// Giants live outside the voxel occupancy: movement is blocked only by sampled
// world cells, which the giant then smashes at the attack clip's contact frame.
const smooth=t=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);};
const angleTo=(from,to)=>Math.atan2(Math.sin(to-from),Math.cos(to-from));
const ATTACKS={
  punch:{clip:'Punch_Cross',speed:.6,arm:'R'},
  jab:{clip:'Punch_Jab',speed:.6,arm:'L'},
  sweep:{clip:'Sword_Attack',speed:.75},
  clap:{clip:'Push_Loop',length:1.8,contact:1.02,loop:true},
  kick:{clip:'Idle_Loop',length:1.6,contact:.72,loop:true},
  grab:{clip:'PickUp_Table',speed:.5}
};
const CLIMB_SPEED=1.25,WALK=.21,RUN=.4;
// Stealth senses: a head-facing vision cone plus hearing (titans.noise).
export const VISION={cone:55*Math.PI/180,range:34,near:5,gain:.9,decay:.25,lost:2.5,search:7,searchLimit:25,suspicious:4,grabReach:.48,grabHeight:.85};

const o=new THREE.Vector3(),d=new THREE.Vector3(),ab=new THREE.Vector3(),w0=new THREE.Vector3();
// Closest approach between the ray segment [0,max] and segment ab. A ray that
// starts inside the capsule (a held player's eye in the torso) passes through it.
function rayCapsule(origin,dir,max,a,b,r){
  ab.subVectors(b,a);w0.subVectors(origin,a);
  {const C=ab.dot(ab),u=C>0?Math.max(0,Math.min(1,ab.dot(w0)/C)):0;if(Math.hypot(w0.x-ab.x*u,w0.y-ab.y*u,w0.z-ab.z*u)<r)return null;}
  const A=1,B=dir.dot(ab),C=ab.dot(ab),D=dir.dot(w0),E=ab.dot(w0),den=A*C-B*B;
  let s=den>1e-9?(B*E-C*D)/den:0,u=den>1e-9?(A*E-B*D)/den:(C>0?E/C:0);
  s=Math.max(0,Math.min(max,s));u=C>0?Math.max(0,Math.min(1,(s*B+E)/C)):0;
  s=Math.max(0,Math.min(max,u*B-D));
  const px=origin.x+dir.x*s-(a.x+ab.x*u),py=origin.y+dir.y*s-(a.y+ab.y*u),pz=origin.z+dir.z*s-(a.z+ab.z*u),dist=Math.hypot(px,py,pz);
  if(dist>r)return null;
  return Math.max(0,s-Math.sqrt(Math.max(0,r*r-dist*dist)));
}
function raySphere(origin,dir,max,center,r){
  w0.subVectors(center,origin);const s=w0.dot(dir);if(s<0||s>max+r)return null;
  const dist2=w0.lengthSq()-s*s;if(dist2>r*r)return null;return Math.max(0,s-Math.sqrt(r*r-dist2));
}
// Ray against the capsules and nape spheres of `list` items ({id, shape}).
export function raycastTitanShapes(list,origin,direction,maxDistance=60){
  const length=Math.hypot(direction.x,direction.y,direction.z);if(length<1e-8)return null;
  o.set(origin.x,origin.y,origin.z);d.set(direction.x/length,direction.y/length,direction.z/length);
  let nearest=null;
  for(const t of list){
    if(!t.shape)continue;
    const nape=raySphere(o,d,maxDistance,t.shape.nape.point,t.shape.nape.radius*1.15);
    for(const c of t.shape.capsules){
      const s=rayCapsule(o,d,maxDistance,c.start,c.end,c.radius);
      if(s!==null&&s<=maxDistance&&(!nearest||s<nearest.distance))nearest={type:'titan',id:t.id,part:c.part,distance:s};
    }
    if(nape!==null&&nape<=maxDistance&&(!nearest||nape<=nearest.distance+.25+t.shape.nape.radius*.5))nearest={type:'titan',id:t.id,part:'nape',distance:nape};
  }
  if(!nearest)return null;
  nearest.point=o.clone().addScaledVector(d,nearest.distance);nearest.normal=d.clone().negate();
  return nearest;
}

export function createTitanSystem(scene,initialWorld,initialConfig,hooks={}){
  let world=initialWorld,config=initialConfig,titans=[],time=0,senseClock=0,random=1;
  const root=new THREE.Group();root.name='titans';scene?.add(root);
  const rand=()=>{random=(random*16807)%2147483647;return random/2147483647;};
  const groundY=()=>config?.groundY??.3;
  const town=()=>config?.town??{minX:-32,maxX:32,minZ:-32,maxZ:32};
  const inside=t=>{const b=town();return t.x>b.minX&&t.x<b.maxX&&t.z>b.minZ&&t.z<b.maxZ;};
  const system={get titans(){return titans;},reset,update,raycast,hit,blast,snapshot,anchor,anchorPoint,napePoint,noise,calm,dispose,get stats(){return{count:titans.length,alert:titans.reduce((m,t)=>Math.max(m,t.alert??0),0),suspicious:titans.reduce((n,t)=>n+(t.suspicions||0),0),search:titans.reduce((n,t)=>n+(t.searches||0),0),active:titans.filter(t=>t.state!=='down').length,states:titans.map(t=>t.state),smashes:titans.reduce((n,t)=>n+t.smashes,0),grabs:titans.reduce((n,t)=>n+t.grabs,0),downs:titans.reduce((n,t)=>n+t.downs,0),climbs:titans.reduce((n,t)=>n+t.climbs,0),actions:titans.reduce((all,t)=>{for(const [k,v]of Object.entries(t.actions))all[k]=(all[k]||0)+v;return all;},{})};}};

  function spawn(t){
    const climbSpawns=config.climbSpawns??[],climb=climbSpawns.length&&(t.spawnCount+t.index)%2===1;
    t.spawnCount++;t.serial++;
    const base={y:groundY(),goal:null,target:null,lastSeen:null,lostTime:0,alert:0,seen:false,lookTime:0,attack:null,cooldown:.8+t.index*.6,stagger:0,downTime:0,napeHealth:100,stuck:0,speed:0,look:0,climbInfo:null,vy:0,land:0,lastKind:null,repeat:0};
    if(climb){
      const s=climbSpawns[Math.floor(t.spawnCount/2+t.index)%climbSpawns.length];
      Object.assign(t,base,{x:s.x,z:s.z,yaw:Math.atan2(s.dir[0],s.dir[1]),state:'approach',climbSpawn:s});
    }else{
      const s=config.spawns[t.index%config.spawns.length];
      Object.assign(t,base,{x:s.x,z:s.z,yaw:s.yaw??Math.PI,state:'enter',route:[[s.x*.3,town().maxZ+5],[config.breach?.x??0,config.breach?.z??35],[(config.breach?.x??0)+(t.index-1)*2,town().maxZ-4]],routeIndex:0});
    }
    t.model.resetPose();t.model.play('Idle_Loop',{fade:0});
  }
  function reset(nextWorld=world,nextConfig=config){
    world=nextWorld;config=nextConfig;time=0;senseClock=0;random=7919;
    for(const t of titans){root.remove(t.model.group);t.model.dispose();}titans=[];
    if(!config)return system;
    if(!config.rig)throw new Error('巨人缺少骨骼资源 rig');
    for(let i=0;i<(config.count??0);i++){
      const model=createTitanModel(config.rig,i,{height:config.heights?.[i]});root.add(model.group);
      const t={id:'titan-'+i,index:i,height:model.height,model,smashes:0,grabs:0,downs:0,climbs:0,spawnCount:0,serial:0,actions:{}};
      spawn(t);titans.push(t);
    }
    sync(0);return system;
  }
  function solidAt(x,y,z){return Boolean(world.getId(Math.floor(x/CELL),Math.floor(y/CELL),Math.floor(z/CELL)));}
  // Blocking cells in front of the body; also reports which levels and columns are blocked.
  function obstacle(t){
    const h=t.height,fx=Math.sin(t.yaw),fz=Math.cos(t.yaw),rx=fz,rz=-fx;let best=null;const levels=new Set(),columns=new Set();
    for(const reach of [.14,.22])for(const side of [-.15,0,.15])for(const level of [.12,.28,.45,.6,.75,.88]){
      const x=t.x+fx*reach*h+rx*side*h,z=t.z+fz*reach*h+rz*side*h,y=t.y+level*h;
      if(!solidAt(x,y,z))continue;
      levels.add(level);if(level>=.45&&level<=.6)columns.add(side);
      const score=Math.abs(level-.55)+reach*.5;if(!best||score<best.score)best={x,y,z,score,level};
    }
    if(best){best.levels=[...levels].sort();best.wide=columns.size>=2;}
    return best;
  }
  function chooseAttack(t,block){
    const top=Math.max(...block.levels);
    let kind=top<=.28?'kick':block.wide?'clap':block.level>=.6?(t.lastKind==='punch'?'jab':'punch'):'sweep';
    if(kind===t.lastKind&&++t.repeat>=2){kind={kick:'clap',clap:'sweep',sweep:'clap',punch:'sweep',jab:'sweep'}[kind];t.repeat=0;}else if(kind!==t.lastKind)t.repeat=0;
    return kind;
  }
  function pickGoal(t){
    const list=config.targets??[];if(!list.length){const b=town();t.goal={x:b.minX+rand()*(b.maxX-b.minX),z:b.minZ+rand()*(b.maxZ-b.minZ)};return;}
    let pick=list[Math.floor(rand()*list.length)];
    for(let i=0;i<3&&Math.hypot(pick.x-t.x,pick.z-t.z)<8;i++)pick=list[Math.floor(rand()*list.length)];
    t.goal={x:pick.x,z:pick.z,id:pick.id};t.stuck=0;
  }
  const busy=t=>['down','enter','approach','climb','over','drop'].includes(t.state)||t.attack?.kind==='grab';
  // Line of sight from the head to the target's chest through real voxels
  // (and the far wall, which wraps world.raycast).
  function lineOfSight(t,target){
    const head={x:t.x,y:t.y+t.height*.86,z:t.z},chest={x:target.x,y:target.y+1.2,z:target.z},dir={x:chest.x-head.x,y:chest.y-head.y,z:chest.z-head.z},l=Math.hypot(dir.x,dir.y,dir.z);
    if(l<.7)return true;return !world.raycast(head,{x:dir.x/l,y:dir.y/l,z:dir.z/l},l-.6);
  }
  function inCone(t,target){const facing=t.yaw+t.look;return Math.abs(angleTo(facing,Math.atan2(target.x-t.x,target.z-t.z)))<=VISION.cone;}
  function sense(targets,dt){
    for(const t of titans){
      if(busy(t))continue;
      let best=null;
      for(const target of targets){
        if(target.down||target.invulnerable)continue;
        const d=Math.hypot(target.x-t.x,target.z-t.z);if(d>VISION.range||(best&&d>=best.d))continue;
        if(!(d<VISION.near||inCone(t,target)))continue;
        if(lineOfSight(t,target))best={target,d};
      }
      if(best){
        const target=best.target;t.alert=best.d<VISION.near?1:Math.min(1,t.alert+VISION.gain*(1.3-best.d/VISION.range)*dt);
        t.seen=true;t.seenId=target.id;t.lastSeen={x:target.x,y:target.y,z:target.z};t.seenAt=time;t.lostTime=0;
        if(t.alert>=1){t.target=target.id;if(t.state!=='chase'){t.state='chase';t.spotted=(t.spotted||0)+1;hooks.event?.('spot',t,target);}}
        else if(t.state!=='chase'&&t.state!=='search'){if(t.state!=='suspicious')t.suspicions=(t.suspicions||0)+1;t.state='suspicious';t.goal={x:target.x,z:target.z};t.lookTime=VISION.suspicious;}
      }else{t.seen=false;if(t.state!=='chase')t.alert=Math.max(0,t.alert-VISION.decay*dt);}
    }
  }
  // Heard sounds: idle giants walk over to look; chasing giants ignore them.
  function noise(point,radius,kind='noise'){
    const heard=[];
    for(const t of titans){
      if(busy(t)||t.state==='chase')continue;
      if(Math.hypot(point.x-t.x,point.z-t.z)>radius)continue;
      if(t.state!=='suspicious')t.suspicions=(t.suspicions||0)+1;
      t.state='suspicious';t.goal={x:point.x,z:point.z,noise:kind};t.lookTime=VISION.suspicious;t.alert=Math.max(t.alert,.35);heard.push(t.id);
    }
    if(heard.length)hooks.event?.('noise',null,{kind,heard});
    return heard;
  }
  // With a point (respawn): giants within `radius` also walk off to a goal outside
  // it and hold their grabs for `hold` seconds, so nobody camps the safehouse door.
  function calm(point=null,{radius=0,hold=0}={}){for(const t of titans){if(busy(t))continue;t.alert=0;t.target=null;
    const near=point&&Math.hypot(t.x-point.x,t.z-point.z)<radius;
    if(near){t.cooldown=Math.max(t.cooldown,hold);t.state='wander';for(let i=0;i<8;i++){pickGoal(t);if(Math.hypot(t.goal.x-point.x,t.goal.z-point.z)>=radius)break;}}
    else if(['chase','suspicious','search'].includes(t.state)){t.state='wander';pickGoal(t);}}}
  function startAttack(t,point,kind){
    const def=ATTACKS[kind],clip=t.model.clips[def.clip],speed=def.speed??1;
    const impact=def.contact??(t.model.contacts[def.clip]/speed),length=def.length??(clip.duration/speed);
    t.attack={kind,point,age:0,impact,length,done:false};t.lastKind=kind;t.actions[kind]=(t.actions[kind]||0)+1;
    t.model.play(def.clip,{loop:Boolean(def.loop),timeScale:speed,restart:true,fade:.2});
  }
  function startStagger(t,clip='Hit_Chest'){
    if(t.state==='down')return;
    t.stagger=t.model.clips[clip].duration/.5+.15;t.attack=null;t.actions.stagger=(t.actions.stagger||0)+1;
    t.model.play(clip,{loop:false,timeScale:.5,restart:true,fade:.12});
  }
  function locomotion(t){
    const scale=t.model.scale,strides=t.model.strides;
    if(t.speed<.15){t.model.play('Idle_Loop',{timeScale:.7});return;}
    const run=t.state==='chase',clip=run?'Jog_Fwd_Loop':'Walk_Loop';
    t.model.play(clip,{timeScale:Math.max(.08,t.speed/(strides[clip]*scale))}).timeScale=Math.max(.08,t.speed/(strides[clip]*scale));
  }
  function moveToward(t,goal,speed,dt,{block=true}={}){
    const desired=Math.atan2(goal.x-t.x,goal.z-t.z),turn=angleTo(t.yaw,desired);t.yaw+=Math.sign(turn)*Math.min(Math.abs(turn),dt*1.8);
    if(Math.abs(turn)>1.1){t.speed=0;return 'turning';}
    if(block){const hit=obstacle(t);if(hit){t.speed=0;return hit;}}
    const step=speed*dt;let px=t.x+Math.sin(t.yaw)*step,pz=t.z+Math.cos(t.yaw)*step;
    for(const other of titans){if(other===t||other.state==='down')continue;const dx=px-other.x,dz=pz-other.z,d=Math.hypot(dx,dz),min=(t.height+other.height)*.17;if(d<min&&d>1e-4){px+=dx/d*(min-d)*.5;pz+=dz/d*(min-d)*.5;}}
    t.speed=Math.hypot(px-t.x,pz-t.z)/dt;t.x=px;t.z=pz;return null;
  }
  function wallInfo(t){
    const s=t.climbSpawn,dir={x:s.dir[0],y:0,z:s.dir[1]},hit=world.raycast({x:t.x,y:4,z:t.z},dir,24);
    if(!hit)return null;
    const cx=hit.x,cz=hit.z;let top=hit.y;
    while(top<255&&(world.getId(cx,top+1,cz)||world.getId(cx+Math.round(dir.x*3),top+1,cz+Math.round(dir.z*3))))top++;
    // The far wall continues above the voxel wall; giants climb all of it.
    return {face:{x:hit.point.x,z:hit.point.z},top:Math.max((top+1)*CELL,config.climbTop??0),dir};
  }
  function updateClimb(t,dt,byId){
    const s=t.climbSpawn,dir={x:s.dir[0],z:s.dir[1]},h=t.height;
    if(t.state==='approach'){
      t.climbInfo??=wallInfo(t);
      if(!t.climbInfo){t.state='wander';pickGoal(t);return;}
      const f=t.climbInfo.face,stand={x:f.x-dir.x*h*.09,z:f.z-dir.z*h*.09};
      if(Math.hypot(stand.x-t.x,stand.z-t.z)<.35){t.state='climb';t.climbs++;t.actions.climb=(t.actions.climb||0)+1;t.climbClock=0;t.clawClock=.9;t.model.play('Crouch_Idle_Loop',{timeScale:.6,fade:.4});hooks.event?.('climb',t);return;}
      moveToward(t,stand,h*WALK,dt,{block:false});locomotion(t);return;
    }
    if(t.state==='climb'){
      const info=t.climbInfo;t.climbClock+=dt;t.clawClock-=dt;t.speed=0;t.yaw=Math.atan2(dir.x,dir.z);
      t.y=Math.min(info.top,t.y+CLIMB_SPEED*dt);
      const hand=t.y+h*.97;
      if(t.clawClock<=0&&hand>info.top-2.2){
        t.clawClock=1.4;const side=Math.sin(t.climbClock*2.2)>0?1:-1,rx=dir.z,rz=-dir.x;
        const point={x:info.face.x+dir.x*.3+rx*side*h*.12,y:Math.min(info.top+.7,hand),z:info.face.z+dir.z*.3+rz*side*h*.12};
        t.smashes++;t.lastImpact={kind:'claw',time,clipTime:t.climbClock};hooks.smash?.(point,.9,t);
      }
      if(t.y>=info.top-.01){t.state='over';t.overStart={x:t.x,z:t.z};t.model.play('Walk_Loop',{timeScale:.35,fade:.35});}
      return;
    }
    if(t.state==='over'){
      const goal={x:t.x+dir.x*4,z:t.z+dir.z*4};moveToward(t,goal,1.5,dt,{block:false});t.y=t.climbInfo.top;
      if(Math.hypot(t.x-t.overStart.x,t.z-t.overStart.z)>.6+h*.2){t.state='drop';t.vy=0;t.model.play('Jump_Start',{loop:false,timeScale:.8,fade:.2,from:.5});}
      return;
    }
    if(t.state==='drop'){
      if(t.land>0){t.land-=dt;if(t.land<=0){t.state='wander';pickGoal(t);}return;}
      t.vy-=9.81*dt;t.y+=t.vy*dt;t.x+=dir.x*1.2*dt;t.z+=dir.z*1.2*dt;
      if(t.y<=groundY()){t.y=groundY();t.land=t.model.clips.Jump_Land.duration/.7;t.model.play('Jump_Land',{loop:false,timeScale:.7,fade:.12,restart:true});hooks.event?.('land',t,{x:t.x,y:t.y,z:t.z});}
    }
  }
  function loseTarget(t){t.state='search';t.searches=(t.searches||0)+1;t.goal={x:t.lastSeen.x,z:t.lastSeen.z};t.lookTime=VISION.search;t.searchTime=0;t.alert=Math.min(t.alert,.95);t.target=null;}
  function updateAttack(t,dt,byId){
    const a=t.attack;a.age+=dt;t.speed=0;
    // Holding a grabbed player: the arms stay at full reach until the hold runs out or a slash staggers the giant.
    if(a.done&&a.hold>0){a.hold-=dt;a.age=Math.min(a.age,a.impact);}
    if(!a.done&&a.age>=a.impact){
      a.done=true;t.lastImpact={kind:a.kind,time,age:a.age,impact:a.impact,clip:t.model.current,clipTime:t.model.action?.time??null};
      if(a.kind==='grab'){const target=byId.get(a.target);if(target&&!target.down&&!target.invulnerable&&Math.hypot(target.x-t.x,target.z-t.z)<t.height*(VISION.grabReach+.04)){t.grabs++;const held=hooks.grab?.(target,t);if(held>0){a.hold=held;a.age=a.impact;a.point={x:target.x,y:(target.y??t.y)+1,z:target.z};}}}
      else{t.smashes++;hooks.smash?.(a.point,config.smashRadius??1.5,t);}
    }
    if(a.age>=a.length){t.attack=null;t.cooldown=config.smashCooldown??1.6;}
  }
  function update(dt,targets=[]){
    dt=Math.max(0,Math.min(.1,dt));if(!dt||!config)return system;time+=dt;senseClock-=dt;
    if(senseClock<=0){senseClock=.25;sense(targets,.25);}
    const byId=new Map(targets.map(target=>[target.id,target]));
    for(const t of titans){
      t.cooldown=Math.max(0,t.cooldown-dt);
      if(t.state==='down'){t.downTime+=dt;if(t.downTime>=(config.respawnSeconds??28)){spawn(t);hooks.event?.('respawn',t);}continue;}
      if(t.stagger>0){t.stagger-=dt;t.speed=0;continue;}
      if(['approach','climb','over','drop'].includes(t.state)){updateClimb(t,dt,byId);continue;}
      if(t.state==='search')t.searchTime=(t.searchTime||0)+dt;
      if(t.attack){if(t.state==='chase'&&time-(t.seenAt??-Infinity)>VISION.lost)loseTarget(t);updateAttack(t,dt,byId);continue;}
      let goal=null,speed=t.height*WALK;
      if(t.state==='enter'){
        goal={x:t.route[t.routeIndex][0],z:t.route[t.routeIndex][1]};
        if(Math.hypot(goal.x-t.x,goal.z-t.z)<1.2){t.routeIndex++;if(t.routeIndex>=t.route.length){t.state='wander';pickGoal(t);}continue;}
      }else if(t.state==='chase'){
        const target=byId.get(t.target);
        if(!target||target.down){t.state='wander';t.target=null;pickGoal(t);continue;}
        const visible=time-(t.seenAt??-Infinity)<.4;
        // Lost sight: walk to the last sighting and search there.
        if(!visible){t.lostTime+=dt;if(time-(t.seenAt??-Infinity)>VISION.lost){loseTarget(t);continue;}}
        goal=visible?target:t.lastSeen;speed=t.height*RUN;
        const d=Math.hypot(target.x-t.x,target.z-t.z);
        // Reach in through doors and windows: a clear line to a target within reach.
        if(visible&&d<t.height*VISION.grabReach&&target.y<t.y+t.height*VISION.grabHeight&&t.cooldown<=0&&lineOfSight(t,target)){t.yaw=Math.atan2(target.x-t.x,target.z-t.z);startAttack(t,{x:target.x,y:target.y+1,z:target.z},'grab');t.attack.target=target.id;continue;}
      }else if(t.state==='suspicious'||t.state==='search'){
        goal=t.goal;speed=t.height*(t.state==='search'?WALK*1.3:WALK);
        if(t.state==='search'&&!t.seen&&t.searchTime>VISION.searchLimit){t.state='wander';t.alert=0;pickGoal(t);continue;}
        if(!goal||Math.hypot(goal.x-t.x,goal.z-t.z)<2.5){
          t.speed=0;t.lookTime-=dt;
          if(t.lookTime<=0&&!t.seen){t.state='wander';t.alert=0;pickGoal(t);}
          continue;
        }
      }else{
        if(!t.goal)pickGoal(t);goal=t.goal;
        if(Math.hypot(goal.x-t.x,goal.z-t.z)<2.5){
          if(t.cooldown<=0){const fx=Math.sin(t.yaw),fz=Math.cos(t.yaw),kind=rand()<.5?'kick':'clap';startAttack(t,{x:t.x+fx*t.height*.2,y:t.y+t.height*(kind==='kick'?.12:.3),z:t.z+fz*t.height*.2},kind);pickGoal(t);}
          t.speed=0;continue;
        }
      }
      const result=moveToward(t,goal,speed,dt,{block:t.state!=='enter'});
      if(result&&result!=='turning'&&t.cooldown<=0){startAttack(t,result,chooseAttack(t,result));if(++t.stuck>14&&t.state==='wander')pickGoal(t);}
      if(t.state==='wander'&&!inside(t)){const b=town();t.goal={x:Math.max(b.minX+4,Math.min(b.maxX-4,t.x)),z:Math.max(b.minZ+4,Math.min(b.maxZ-4,t.z))};}
    }
    for(const t of titans){
      if(t.state==='down')continue;
      if(t.state==='chase'){const target=byId.get(t.target),want=target?THREE.MathUtils.clamp(angleTo(t.yaw,Math.atan2(target.x-t.x,target.z-t.z)),-1,1):0;t.look+=(want-t.look)*Math.min(1,dt*3);}
      else if(t.state==='suspicious'||t.state==='search'){const want=Math.sin(time*1.8+t.index)*(t.state==='search'?1.15:.9);t.look+=(want-t.look)*Math.min(1,dt*2.5);}
      else{const want=t.state==='wander'||t.state==='enter'?Math.sin(time*(1.4+t.index*.2)+t.index)*(t.speed<.15?.9:.5):0;t.look+=(want-t.look)*Math.min(1,dt*2);}
      if(!t.attack&&t.stagger<=0&&['enter','wander','chase','suspicious','search'].includes(t.state))locomotion(t);
    }
    fleeing(targets,dt);
    sync(dt);return system;
  }
  // Townsfolk run away from the nearest standing giant.
  function fleeing(targets,dt){
    for(const target of targets){
      if(target.kind!=='npc'||target.down||!target.state)continue;
      let near=null;for(const t of titans){if(t.state==='down')continue;const d=Math.hypot(target.x-t.x,target.z-t.z);if(!near||d<near.d)near={t,d};}
      const s=target.state;
      if(near&&near.d<22){
        s.homeRoute??=s.route;s.homeSpeed??=s.speed;
        if(!s.fleeing||s.fleeAge>2.5){const dx=target.x-near.t.x,dz=target.z-near.t.z,l=Math.hypot(dx,dz)||1,b=town();s.route=[[Math.max(b.minX+2,Math.min(b.maxX-2,target.x+dx/l*10)),Math.max(b.minZ+2,Math.min(b.maxZ-2,target.z+dz/l*10))]];s.routeIndex=0;s.fleeAge=0;}
        s.fleeing=true;s.fleeAge=(s.fleeAge??0)+dt;s.wait=0;s.speed=2.6;
      }else if(s.fleeing&&(!near||near.d>30)){s.fleeing=false;s.route=s.homeRoute;s.speed=s.homeSpeed;s.homeRoute=null;s.homeSpeed=null;}
    }
  }
  const tmp=new THREE.Vector3();
  function overlay(t){
    return o=>{
      if(t.state!=='down')o.look(t.look);
      const a=t.attack;
      if(a){
        const rise=smooth(a.age/a.impact),fall=1-smooth((a.age-a.impact)/Math.max(.01,a.length-a.impact)),env=a.age<a.impact?rise:fall;
        const toPoint=(bone)=>tmp.set(a.point.x,a.point.y,a.point.z).sub(t.model.bonePoint(bone,new THREE.Vector3())).normalize();
        if(a.kind==='punch'||a.kind==='jab'){const arm=ATTACKS[a.kind].arm;o.aimWorld(`DEF-upper_arm_${arm}`,toPoint(`DEF-upper_arm_${arm}`),env*.75);o.aimWorld(`DEF-forearm_${arm}`,toPoint(`DEF-forearm_${arm}`),env*.85);}
        if(a.kind==='grab'){const w=a.hold>0?1:env*.7;o.bend(env*.95);for(const s of['L','R']){o.aimWorld(`DEF-upper_arm_${s}`,toPoint(`DEF-upper_arm_${s}`),w);o.aimWorld(`DEF-forearm_${s}`,toPoint(`DEF-forearm_${s}`),w);}}
        if(a.kind==='clap'){
          const raise=smooth(a.age/(a.impact*.72)),slam=smooth((a.age-a.impact*.72)/(a.impact*.28)),release=1-smooth((a.age-a.impact-.25)/(a.length-a.impact-.25));
          for(const s of['L','R']){
            const side=s==='L'?1:-1,up=new THREE.Vector3(side*.25,1,.25).applyQuaternion(t.model.group.quaternion),down=toPoint(`DEF-upper_arm_${s}`).clone(),dir=up.lerp(down,slam);
            const w=(a.age<a.impact?raise:release)*.95;o.aimWorld(`DEF-upper_arm_${s}`,dir,w);o.aimWorld(`DEF-forearm_${s}`,dir,w);
          }
          o.bend(slam*.35*(a.age<a.impact?1:release));
        }
        if(a.kind==='kick'){
          const wind=smooth(a.age/(a.impact*.6)),strike=smooth((a.age-a.impact*.6)/(a.impact*.4)),w=a.age<a.impact?Math.max(wind,strike):fall;
          const dir=new THREE.Vector3(0,-1,-.5).lerp(new THREE.Vector3(0,-.25,1),strike).applyQuaternion(t.model.group.quaternion);
          o.aimWorld('DEF-thigh_R',dir,w*.9);o.aimWorld('DEF-shin_R',dir,w*.9);o.bend(-.15*w);
        }
        if(a.kind==='sweep')o.bend(env*.25);
      }
      if(t.state==='climb'){
        const c=t.climbClock*2.2;
        for(const s of['L','R']){
          const phase=s==='L'?Math.sin(c):-Math.sin(c),side=s==='L'?1:-1;
          const arm=new THREE.Vector3(side*.35,1,.35+.25*phase).applyQuaternion(t.model.group.quaternion);o.aimWorld(`DEF-upper_arm_${s}`,arm,.9);o.aimWorld(`DEF-forearm_${s}`,arm.add(new THREE.Vector3(0,.2*phase,0)),.85);
          const leg=new THREE.Vector3(0,-1,.55+.45*phase).applyQuaternion(t.model.group.quaternion);o.aimWorld(`DEF-thigh_${s}`,leg,.6);
        }
      }
    };
  }
  function sync(dt){
    for(const t of titans){
      const {group}=t.model;group.position.set(t.x,t.y,t.z);group.rotation.order='YXZ';
      group.rotation.set(t.state==='climb'?.12:0,t.yaw,0);
      t.model.animate(dt,overlay(t));
      t.shape=t.state==='down'?null:t.model.capsules();
    }
  }
  function raycast(origin,direction,maxDistance=60){return raycastTitanShapes(titans,origin,direction,maxDistance);}
  function damageTitan(t,amount,part){
    if(t.state==='down')return false;
    if(part==='nape'){
      t.napeHealth-=amount;
      if(t.napeHealth<=0){t.state='down';t.attack=null;t.stagger=0;t.downTime=0;t.downs++;t.target=null;t.y=groundY();t.shape=null;t.actions.down=(t.actions.down||0)+1;t.model.play('Death01',{loop:false,timeScale:.55,restart:true,fade:.15});hooks.event?.('down',t);return true;}
      if(!['climb','over','drop'].includes(t.state))startStagger(t,'Hit_Head');hooks.event?.('nape',t);
    }else{if(!['climb','over','drop'].includes(t.state))startStagger(t,'Hit_Chest');hooks.event?.('flinch',t);}
    return true;
  }
  function hit(result,damage=25){const t=titans.find(item=>item.id===result?.id);return t?damageTitan(t,damage,result.part):false;}
  function blast(point,radius=3.5){
    const affected=[],p=new THREE.Vector3(point.x,point.y,point.z);
    for(const t of titans){
      if(!t.shape)continue;
      if(t.shape.nape.point.distanceTo(p)<radius*.8){damageTitan(t,120,'nape');affected.push(t.id);continue;}
      const body=Math.hypot(point.x-t.x,point.z-t.z);if(body<radius+t.height*.2&&point.y<t.y+t.height){damageTitan(t,0,'body');affected.push(t.id);}
    }
    return affected;
  }
  const ANCHOR_BONES=['DEF-head','DEF-neck','DEF-spine_003','DEF-spine_001','DEF-hips','DEF-upper_arm_L','DEF-forearm_L','DEF-hand_L','DEF-upper_arm_R','DEF-forearm_R','DEF-hand_R','DEF-thigh_L','DEF-shin_L','DEF-thigh_R','DEF-shin_R'];
  // Hook anchors ride the nearest bone and drop when the giant falls or respawns.
  function anchor(result){
    const t=titans.find(item=>item.id===result?.id);if(!t||!t.shape)return null;
    const point=new THREE.Vector3(result.point.x,result.point.y,result.point.z);let best=null;
    for(const name of ANCHOR_BONES){const dist=t.model.bonePoint(name,tmp).distanceTo(point);if(!best||dist<best.dist)best={name,dist};}
    const bone=t.model.bones[best.name];bone.updateWorldMatrix(true,false);
    return {titanId:t.id,serial:t.serial,bone:best.name,part:result.part,local:bone.worldToLocal(point.clone())};
  }
  function anchorPoint(a,target=new THREE.Vector3()){
    const t=titans.find(item=>item.id===a?.titanId);
    if(!t||t.serial!==a.serial||t.state==='down')return null;
    const bone=t.model.bones[a.bone];bone.updateWorldMatrix(true,false);return target.copy(a.local).applyMatrix4(bone.matrixWorld);
  }
  function napePoint(id){const t=titans.find(item=>item.id===id);return t?.shape?t.shape.nape.point.clone():null;}
  function snapshot(){return titans.map(t=>({id:t.id,x:t.x,y:t.y,z:t.z,yaw:t.yaw,state:t.state,alert:+(t.alert??0).toFixed(2),seen:Boolean(t.seen),lastSeen:t.lastSeen&&{...t.lastSeen},variant:t.model.variant.name,clip:t.model.current,look:+t.look.toFixed(2),speed:+t.speed.toFixed(2),target:t.target,goal:t.goal&&{...t.goal},napeHealth:t.napeHealth,height:t.height,attack:t.attack?.kind??null,stagger:t.stagger>0,lastImpact:t.lastImpact??null,smashes:t.smashes,grabs:t.grabs,downs:t.downs,climbs:t.climbs,actions:{...t.actions}}));}
  function dispose(){for(const t of titans)t.model.dispose();scene?.remove(root);titans=[];}
  return reset(world,config);
}
