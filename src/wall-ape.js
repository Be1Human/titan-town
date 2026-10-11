import * as THREE from '../vendor/three.module.js';
import {createTitanModel,APE_VARIANT} from './titan-model.js';
import {raycastTitanShapes} from './titan-ai.js';

// 城垣巨猿: walks the closed wall-top loop, scans with head and upper body,
// fills a detection meter from real-voxel line of sight and, once the meter is
// full, throws volleys of boulders at the player (and keeps pounding the last
// sighting for a while after the player ducks into cover). Landing points are
// never shown. Boulders are swept ballistic bodies: every contact with a voxel
// or debris goes through the caller's explosion damage at that point.
export const APE={speed:1.6,cornerPause:.8,scanPeriod:4.5,scanAmp:50*Math.PI/180,searchScanPeriod:3,searchScanAmp:80*Math.PI/180,
  cone:75*Math.PI/180,range:120,senseEvery:.1,rayLead:2,gain:.32,gainNear:40,gainFar:.3,decay:.5,watchLost:1.2,coverAbove:8,shadowReach:12,
  lift:.35,firstLift:1,release:.25,volley:[3,3],volleyGap:2.4,rest:[4.5,4.5],suppress:6,suppressLead:.6,suppressMax:3,maxBoulders:4,leadSpeed:14,
  spreadBase:.5,spreadPerMetre:.012,spreadFar:30,spreadPerFarMetre:.06,spreadPerSpeed:.8,spreadFlying:1.6,flightBase:1.1,flightPerRange:.6,
  relocateMin:6,relocateMax:10,searchSpeed:2.2,searchLook:6,killRadius:2.2,napeHealth:300,stagger:1.2,respawn:60,
  boulder:{radius:1.1,gravity:16,arm:4,keep:.6,breakSpeed:7,radiusBase:.9,radiusPerSpeed:.026,radiusMax:2.5,groundBand:.8,bounce:.22,rollFriction:6,rollMax:3,shatterSpeed:2.5,maxImpacts:8,crush:1.7,crushSpeed:4}};
const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));

export function createWallApe(scene,initialWorld,initialConfig,hooks={}){
  let world=initialWorld,config=initialConfig,ape=null,time=0,random=1;
  const root=new THREE.Group();root.name='wall ape';scene?.add(root);
  const rand=()=>{random=(random*16807)%2147483647;return random/2147483647;};
  const boulderGeometry=new THREE.IcosahedronGeometry(1,1),boulderMaterial=new THREE.MeshStandardMaterial({color:0x6e665c,roughness:.95});
  let path=null;
  const system={get ape(){return ape;},get path(){return path;},reset,update,launch:(from,velocity,extra)=>ape&&launch(from,velocity,extra),raycast,hit,anchor,anchorPoint,alertTo,calm,save,restore,positionAt,nearestS,snapshot,dispose,aimPoint:player=>ape&&aimPoint(player),concealed:chest=>concealed(chest),
    get boulders(){return ape?.boulders??[];},get stats(){return ape?{...ape.stats,state:ape.state,meter:+ape.meter.toFixed(3)}:null;}};

  // Closed loop: segments between consecutive patrol corners, by arc length.
  function buildPath(points){
    const segs=[];let total=0;
    for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length],len=Math.hypot(b[0]-a[0],b[1]-a[1]);segs.push({a,b,len,start:total,dir:[(b[0]-a[0])/len,(b[1]-a[1])/len]});total+=len;}
    return {segs,total,points};
  }
  function positionAt(s){
    const total=path.total;s=((s%total)+total)%total;
    for(const g of path.segs)if(s<=g.start+g.len+1e-9){const u=s-g.start;return {x:g.a[0]+g.dir[0]*u,z:g.a[1]+g.dir[1]*u,seg:g,s};}
    const g=path.segs[0];return {x:g.a[0],z:g.a[1],seg:g,s:0};
  }
  // Wall-top point closest to (x, z), as arc length.
  function nearestS(x,z){
    let best=null;
    for(const g of path.segs){const u=Math.max(0,Math.min(g.len,(x-g.a[0])*g.dir[0]+(z-g.a[1])*g.dir[1])),px=g.a[0]+g.dir[0]*u,pz=g.a[1]+g.dir[1]*u,d=Math.hypot(px-x,pz-z);if(!best||d<best.d)best={s:g.start+u,d};}
    return best.s;
  }
  // Signed shortest loop distance from s0 to s1.
  const loopDelta=(s0,s1)=>{const t=path.total;let d=((s1-s0)%t+t)%t;if(d>t/2)d-=t;return d;};
  // Facing into town from a wall segment (perpendicular to the walk direction).
  function inward(seg){const c=config.center??[0,0],nx=-seg.dir[1],nz=seg.dir[0],mx=(seg.a[0]+seg.b[0])/2,mz=(seg.a[1]+seg.b[1])/2,toward=(c[0]-mx)*nx+(c[1]-mz)*nz>0?1:-1;return Math.atan2(nx*toward,nz*toward);}

  function reset(nextWorld=world,nextConfig=config){
    world=nextWorld;config=nextConfig;time=0;random=4243;
    if(ape){root.remove(ape.model.group);ape.model.dispose();for(const b of ape.boulders)root.remove(b.mesh);if(ape.held)root.remove(ape.held);}
    ape=null;if(!config)return system;
    if(!config.rig)throw new Error('城垣巨猿缺少骨骼资源 rig');
    path=buildPath(config.patrol);
    const model=createTitanModel(config.rig,0,{height:config.height??APE_VARIANT.height,variant:APE_VARIANT});root.add(model.group);
    const s0=nearestS(...(config.start??config.patrol[0]));
    ape={id:config.id??'wall-ape',name:config.name??'城垣巨猿',model,height:model.height,s:s0,dir:1,y:config.y??45.3,x:0,z:0,yaw:0,viewYaw:0,bodyTurn:0,state:'patrol',meter:0,engaged:false,
      seen:false,seenAt:-Infinity,lastSeen:null,senseClock:0,pause:0,scanClock:0,stateTime:0,throwClock:0,thrown:0,goalS:null,searchS:null,look:0,
      health:config.napeHealth??APE.napeHealth,stagger:0,downTime:0,serial:0,boulders:[],held:null,shape:null,volleyLeft:0,restClock:0,
      stats:{thrown:0,impacts:0,spots:0,searches:0,relocations:0,corners:0,distance:0,walls:new Set(),hits:0,repelled:0,stateLog:[]}};
    const p=positionAt(ape.s);ape.x=p.x;ape.z=p.z;ape.seg=p.seg;ape.yaw=wrap(Math.atan2(p.seg.dir[0],p.seg.dir[1]));
    model.play('Walk_Loop',{fade:0});sync(0);return system;
  }
  function setState(next){if(ape.state===next)return;ape.state=next;ape.stateTime=0;ape.stats.stateLog.push([+time.toFixed(2),next]);if(ape.stats.stateLog.length>64)ape.stats.stateLog.shift();}

  function headPoint(target=new THREE.Vector3()){return ape.model.bonePoint('DEF-head',target);}
  // Vision: cone around the scan-rotated view direction, real-voxel ray.
  function sense(player){
    ape.seen=false;if(!player||player.down||player.invulnerable)return;
    const head=headPoint(new THREE.Vector3()),chest={x:player.x,y:player.y+1.2,z:player.z};
    const dx=chest.x-head.x,dy=chest.y-head.y,dz=chest.z-head.z,dist=Math.hypot(dx,dy,dz);if(dist>APE.range||dist<1)return;
    if(Math.abs(wrap(Math.atan2(dx,dz)-ape.viewYaw))>APE.cone)return;
    const dir={x:dx/dist,y:dy/dist,z:dz/dist},start={x:head.x+dir.x*APE.rayLead,y:head.y+dir.y*APE.rayLead,z:head.z+dir.z*APE.rayLead};
    if(world.raycast(start,dir,dist-APE.rayLead-.6))return;
    if(concealed(chest))return;
    ape.seen=true;ape.seenAt=time;ape.lastSeen={x:player.x,y:player.y,z:player.z,vx:player.vx??0,vz:player.vz??0};ape.seenDistance=Math.hypot(player.x-ape.x,player.z-ape.z);
  }
  // Indoors, under eaves or arcades (anything overhead), or in a building's
  // cast shadow (sun ray blocked nearby): the ape cannot make the player out.
  function concealed(chest){
    if(world.raycast(chest,{x:0,y:1,z:0},config.coverAbove??APE.coverAbove))return true;
    const s=config.sun;if(!s)return false;const l=Math.hypot(s[0],s[1],s[2])||1;
    return Boolean(world.raycast(chest,{x:s[0]/l,y:s[1]/l,z:s[2]/l},config.shadowReach??APE.shadowReach));
  }
  function walk(dt,speed,dir){
    const a=ape.s,step=speed*dt*dir,b=a+step;
    // Corner crossing: short pause at each loop vertex (patrol only).
    for(const g of path.segs)for(const c of [g.start,g.start+path.total,g.start-path.total])
      if(a!==c&&(a-c)*(b-c)<=0&&ape.state==='patrol'){ape.pause=config.cornerPause??APE.cornerPause;ape.stats.corners++;}
    ape.s=((b%path.total)+path.total)%path.total;ape.stats.distance+=Math.abs(step);
    const p=positionAt(ape.s);ape.x=p.x;ape.z=p.z;ape.seg=p.seg;ape.stats.walls.add(path.segs.indexOf(p.seg));
    const walkYaw=Math.atan2(p.seg.dir[0]*dir,p.seg.dir[1]*dir);ape.yaw=turnToward(ape.yaw,walkYaw,dt*1.6);ape.speed=speed;
  }
  const turnToward=(from,to,max)=>{const d=wrap(to-from);return wrap(from+Math.sign(d)*Math.min(Math.abs(d),max));};
  const scan=(period,amp)=>Math.sin(time*2*Math.PI/period)*amp;
  function faceSeen(dt){if(!ape.lastSeen)return;const want=Math.atan2(ape.lastSeen.x-ape.x,ape.lastSeen.z-ape.z);ape.viewYaw=turnToward(ape.viewYaw,want,dt*2.4);ape.yaw=turnToward(ape.yaw,want,dt*1.2);}
  // The first boulder of a volley gets a long, roaring wind-up the player can hear and see coming.
  function beginLift(){
    if(!(ape.volleyLeft>0))startVolley();const first=ape.volleyFresh;ape.volleyFresh=false;
    setState('lift');ape.liftTime=first?APE.firstLift:APE.lift;ape.throwClock=APE.volleyGap+ape.liftTime-APE.lift;ape.stats.lifts=(ape.stats.lifts||0)+1;
    if(!ape.held){ape.held=new THREE.Mesh(boulderGeometry,boulderMaterial);ape.held.scale.setScalar(APE.boulder.radius);ape.held.castShadow=true;root.add(ape.held);}
    ape.model.play('Idle_Loop',{timeScale:.4,fade:.08});hooks.event?.('lift',ape,{first,seconds:ape.liftTime});
  }
  function startVolley(){const [a,b]=APE.volley;ape.volleyLeft=a+Math.floor(rand()*(b-a+1));ape.volleyFresh=true;ape.stats.volleys=(ape.stats.volleys||0)+1;hooks.event?.('volley',ape,{count:ape.volleyLeft});}
  // Aim at the chest with lead and scatter; whatever lies on the way is hit.
  function aimPoint(player){
    const vx=player.vx??0,vz=player.vz??0,v=Math.hypot(vx,vz),k=v>APE.leadSpeed?APE.leadSpeed/v:1;
    const d=Math.hypot(player.x-ape.x,player.z-ape.z),T=APE.flightBase+Math.min(1,d/APE.range)*APE.flightPerRange;
    const flying=player.flying||v>12,max=(APE.spreadBase+d*APE.spreadPerMetre+Math.max(0,d-APE.spreadFar)*APE.spreadPerFarMetre+v*APE.spreadPerSpeed)*(flying?APE.spreadFlying:1);
    const r=max*Math.sqrt(rand()),a=rand()*Math.PI*2;
    return {point:{x:player.x+vx*k*T+Math.cos(a)*r,y:player.y+1,z:player.z+vz*k*T+Math.sin(a)*r},flight:T,lead:{x:vx*k*T,z:vz*k*T},spread:r};
  }
  // Suppressive aim uses only what the ape saw: the last sighting pushed along
  // the motion it saw, never the hidden player's live position.
  function coverTarget(){
    const seen=ape.lastSeen;let ox=(seen.vx??0)*APE.suppressLead,oz=(seen.vz??0)*APE.suppressLead;const l=Math.hypot(ox,oz);
    if(l>APE.suppressMax){ox*=APE.suppressMax/l;oz*=APE.suppressMax/l;}
    return {x:seen.x+ox,y:seen.y,z:seen.z+oz,vx:0,vz:0};
  }
  // Ballistic launch velocity that reaches `to` after `flight` seconds.
  function launchVelocity(from,to,flight){const g=APE.boulder.gravity;return {x:(to.x-from.x)/flight,y:(to.y-from.y)/flight+.5*g*flight,z:(to.z-from.z)/flight};}
  function launch(from,velocity,extra={}){
    const mesh=extra.mesh??new THREE.Mesh(boulderGeometry,boulderMaterial);mesh.scale.setScalar(APE.boulder.radius);mesh.castShadow=true;root.add(mesh);
    const b={id:++ape.thrown,pos:{x:from.x,y:from.y,z:from.z},vel:{...velocity},age:0,travel:0,rolling:false,rollTime:0,impacts:[],mesh,...extra,mesh};
    mesh.position.set(b.pos.x,b.pos.y,b.pos.z);ape.boulders.push(b);ape.stats.thrown++;return b;
  }
  function release(player,aimedBy='sight'){
    const aim=aimPoint(player),from=ape.held?ape.held.position.clone():headPoint(new THREE.Vector3());
    if(ape.held)root.remove(ape.held);
    const mesh=ape.held;ape.held=null;
    const b=launch(from,launchVelocity(from,aim.point,aim.flight),{mesh:mesh??undefined,to:aim.point,flight:aim.flight,lead:aim.lead,spread:aim.spread,volley:ape.stats.volleys??0});
    ape.volleyLeft--;
    ape.stats.lastThrow={time:+time.toFixed(2),target:{...aim.point},player:{x:player.x,y:player.y,z:player.z,vx:player.vx??0,vz:player.vz??0,flying:Boolean(player.flying)},aim:aimedBy,lead:aim.lead,spread:+aim.spread.toFixed(2),flight:+aim.flight.toFixed(2),volleyLeft:ape.volleyLeft};
    hooks.event?.('throw',ape,b);
  }
  // Swept contact: centre line plus four rim lines at 0.7 radius.
  const UP={x:0,y:1,z:0};
  function sweep(p,d,len){
    const R=APE.boulder.radius*.7,dir={x:d.x/len,y:d.y/len,z:d.z/len};
    let u={x:dir.z,y:0,z:-dir.x},ul=Math.hypot(u.x,u.z);if(ul<1e-4){u={x:1,y:0,z:0};ul=1;}u={x:u.x/ul,y:0,z:u.z/ul};
    const w={x:u.y*dir.z-u.z*dir.y,y:u.z*dir.x-u.x*dir.z,z:u.x*dir.y-u.y*dir.x};
    const cast=hooks.sweep??((o,dd,m)=>world.raycast(o,dd,m));let best=null;
    for(const [a,c] of [[0,0],[1,0],[-1,0],[0,1],[0,-1]]){
      const o={x:p.x+(u.x*a+w.x*c)*R,y:p.y+(u.y*a+w.y*c)*R,z:p.z+(u.z*a+w.z*c)*R},hit=cast(o,dir,len);
      if(hit&&hit.distance<=len&&(!best||hit.distance<best.distance))best={...hit,contact:hit.point};
    }
    return best&&{...best,dir};
  }
  const speedOf=v=>Math.hypot(v.x,v.y,v.z);
  function impact(b,point,speed,hit){
    const B=APE.boulder,radius=Math.min(B.radiusMax,B.radiusBase+speed*B.radiusPerSpeed);
    b.impacts.push({x:+point.x.toFixed(2),y:+point.y.toFixed(2),z:+point.z.toFixed(2),speed:+speed.toFixed(1),radius:+radius.toFixed(2),rigid:Boolean(hit?.rigidId),farWall:Boolean(hit?.farWall)});
    ape.stats.impacts++;hooks.smash?.(point,radius,b);hooks.event?.('impact',ape,b);
  }
  function retire(b,i,reason){root.remove(b.mesh);ape.boulders.splice(i,1);b.end=reason;ape.stats.shattered=(ape.stats.shattered||0)+1;hooks.event?.('shatter',ape,b);}
  function updateBoulders(dt){
    const B=APE.boulder,ground=config.groundY??.3;
    for(let i=ape.boulders.length-1;i>=0;i--){
      const b=ape.boulders[i];b.age+=dt;
      if(b.rolling){
        const h=Math.hypot(b.vel.x,b.vel.z),slow=Math.max(0,h-B.rollFriction*dt),k=h>1e-6?slow/h:0;b.vel.x*=k;b.vel.z*=k;b.vel.y=0;b.rollTime+=dt;
        if(slow<B.shatterSpeed||b.rollTime>B.rollMax){retire(b,i,'rolled');continue;}
      }else b.vel.y-=B.gravity*dt;
      const d={x:b.vel.x*dt,y:b.vel.y*dt,z:b.vel.z*dt},len=Math.hypot(d.x,d.y,d.z);
      const armed=b.travel>=B.arm,hit=armed&&len>1e-6?sweep(b.pos,d,len):null;
      if(!hit){b.pos={x:b.pos.x+d.x,y:b.pos.y+d.y,z:b.pos.z+d.z};b.travel+=len;}
      else{
        const speed=speedOf(b.vel),contact=hit.contact;
        b.pos={x:b.pos.x+hit.dir.x*hit.distance,y:b.pos.y+hit.dir.y*hit.distance,z:b.pos.z+hit.dir.z*hit.distance};b.travel+=hit.distance;
        if(hit.farWall){impact(b,contact,speed,hit);retire(b,i,'far-wall');continue;}
        const floor=hit.normal?.y>.6&&contact.y<=ground+B.groundBand;
        if(speed>=B.breakSpeed)impact(b,contact,speed,hit);
        if(b.impacts.length>=B.maxImpacts||speed<B.breakSpeed&&!floor){retire(b,i,'stopped');continue;}
        if(floor){
          // Ground contact: bounce, then roll along the surface.
          b.vel={x:b.vel.x*.55,y:Math.abs(b.vel.y)*B.bounce,z:b.vel.z*.55};b.pos.y=contact.y+B.radius;
          if(b.vel.y<3){b.vel.y=0;b.rolling=true;}
        }else{
          // Broke through: carry on with the remaining speed, slightly deflected.
          const k=B.keep;b.vel={x:b.vel.x*k+(rand()-.5)*2,y:b.vel.y*k,z:b.vel.z*k+(rand()-.5)*2};
          b.pos={x:b.pos.x-hit.dir.x*.05,y:b.pos.y-hit.dir.y*.05,z:b.pos.z-hit.dir.z*.05};
        }
      }
      if(b.rolling){
        const down=world.raycast({x:b.pos.x,y:b.pos.y+.5,z:b.pos.z},{x:0,y:-1,z:0},B.radius+2);
        if(down)b.pos.y=down.point.y+B.radius;else b.rolling=false;
      }
      if(b.pos.y<ground-5||b.age>12){retire(b,i,'lost');continue;}
      b.mesh.position.set(b.pos.x,b.pos.y,b.pos.z);const spin=speedOf(b.vel)/B.radius*dt;b.mesh.rotation.x+=spin;b.mesh.rotation.z+=spin*.6;
    }
  }
  function update(dt,player=null){
    dt=Math.max(0,Math.min(.1,dt));if(!dt||!ape)return system;time+=dt;ape.stateTime+=dt;
    updateBoulders(dt);
    if(ape.state==='repelled'){
      ape.downTime+=dt;
      // Topples backwards off the outer edge of the walkway.
      if(ape.downTime<3){const out=inward(ape.seg)+Math.PI;ape.x+=Math.sin(out)*dt*2;ape.z+=Math.cos(out)*dt*2;ape.y-=dt*4*ape.downTime;}
      else ape.model.group.visible=false;
      if(ape.downTime>=(config.respawnSeconds??APE.respawn))respawn(player);
      sync(dt);return system;
    }
    ape.senseClock-=dt;if(ape.senseClock<=0){ape.senseClock=APE.senseEvery;sense(player);}
    // After a respawn the ape stays unaware for `blind` seconds, like the ground giants' safehouse hold.
    ape.blind=Math.max(0,(ape.blind??0)-dt);
    const visible=time-ape.seenAt<APE.senseEvery*1.5;
    if(visible&&ape.blind<=0){const v=Math.hypot(player.vx??0,player.vz??0),d=ape.seenDistance??60,far=d<=APE.gainNear?1:Math.max(APE.gainFar,1-(1-APE.gainFar)*(d-APE.gainNear)/(APE.range-APE.gainNear));
      ape.meter=Math.min(1,ape.meter+APE.gain*far*(.8+v/15)*dt);}
    else ape.meter=Math.max(0,ape.meter-APE.decay*dt);
    if(ape.stagger>0){ape.stagger-=dt;ape.speed=0;if(ape.stagger<=0)setState(ape.engaged?'track':'watch');sync(dt);return system;}
    const lost=time-ape.seenAt;ape.throwClock-=dt;
    // The breather starts once the volley's last boulder has landed, not at its release.
    if(ape.restClock>0&&!ape.boulders.some(b=>!b.rolling)){ape.restClock-=dt;if(ape.restClock<=0){ape.restClock=0;startVolley();}}
    if(ape.meter>=1&&!ape.engaged){ape.engaged=true;ape.stats.spots++;hooks.event?.('spot',ape);}
    switch(ape.state){
      case 'patrol':{
        ape.viewYaw=wrap(inward(ape.seg)+scan(config.scanPeriod??APE.scanPeriod,APE.scanAmp));
        if(visible){setState('watch');ape.speed=0;break;}
        if(ape.pause>0){ape.pause-=dt;ape.speed=0;break;}
        walk(dt,config.speed??APE.speed,ape.dir);break;
      }
      case 'watch':{
        ape.speed=0;faceSeen(dt);
        if(ape.engaged&&visible&&!(ape.restClock>0)&&ape.throwClock<=0){beginLift();break;}
        if(!visible&&lost>APE.watchLost&&ape.meter<.6)startSearch();
        break;
      }
      case 'lift':{
        ape.speed=0;faceSeen(dt);
        if(ape.stateTime>=(ape.liftTime??APE.lift)){setState('throw');}
        break;
      }
      case 'throw':{
        ape.speed=0;faceSeen(dt);
        if(!ape.released&&ape.stateTime>=APE.release){ape.released=true;release(visible?player:coverTarget(),visible?'sight':'suppress');}
        if(ape.stateTime>=APE.release+.15){ape.released=false;setState('track');
          if(ape.volleyLeft<=0){
            // Volley done: a short rest to fetch a new boulder and change angle.
            const [a,b]=APE.rest;ape.restClock=a+rand()*(b-a);ape.stats.rests=(ape.stats.rests||0)+1;hooks.event?.('rest',ape,{seconds:ape.restClock});
            if(ape.lastSeen){const target=nearestS(ape.lastSeen.x,ape.lastSeen.z),delta=loopDelta(ape.s,target),dist=APE.relocateMin+rand()*(APE.relocateMax-APE.relocateMin);ape.goalS=Math.abs(delta)<1?ape.s+dist*(rand()<.5?1:-1):ape.s+Math.sign(delta)*Math.min(Math.abs(delta),dist);ape.stats.relocations++;}
          }}
        break;
      }
      case 'track':{
        if(ape.goalS!==null){const delta=loopDelta(ape.s,((ape.goalS%path.total)+path.total)%path.total);if(Math.abs(delta)<.3)ape.goalS=null;else walk(dt,APE.searchSpeed,Math.sign(delta));}
        else ape.speed=0;
        faceSeen(dt);
        // Keeps pounding the last sighting for a while after the player hides.
        const firing=visible||lost<APE.suppress;
        if(firing&&ape.restClock<=0&&ape.throwClock<=0&&ape.boulders.length<APE.maxBoulders){beginLift();break;}
        if(!visible&&lost>APE.suppress)startSearch();
        break;
      }
      case 'search':{
        const delta=loopDelta(ape.s,ape.searchS);
        if(Math.abs(delta)>.3&&!ape.arrived){walk(dt,APE.searchSpeed,Math.sign(delta));ape.viewYaw=wrap(inward(ape.seg)+scan(APE.scanPeriod,APE.scanAmp));}
        else{if(!ape.arrived){ape.arrived=true;ape.arrivedAt=time;ape.stats.searchArrivals=(ape.stats.searchArrivals||0)+1;hooks.event?.('search-arrive',ape);}ape.speed=0;ape.viewYaw=wrap(inward(ape.seg)+scan(APE.searchScanPeriod,APE.searchScanAmp));}
        if(visible){ape.arrived=false;setState(ape.engaged&&ape.meter>.5?'track':'watch');break;}
        if(ape.arrived&&time-ape.arrivedAt>=APE.searchLook){ape.arrived=false;ape.engaged=false;setState('patrol');hooks.event?.('resume',ape);}
        break;
      }
    }
    sync(dt);return system;
  }
  // A lost target must be re-spotted by filling the meter again (continuous sight).
  function startSearch(){
    ape.searchS=ape.lastSeen?nearestS(ape.lastSeen.x,ape.lastSeen.z):ape.s;ape.arrived=false;ape.goalS=null;ape.stats.searches++;ape.volleyLeft=0;ape.restClock=0;ape.engaged=false;
    if(ape.held){root.remove(ape.held);ape.held=null;}
    setState('search');hooks.event?.('lost',ape,{searchS:ape.searchS,lastSeen:ape.lastSeen});
  }
  function respawn(player){
    const far=player?positionAt(nearestS(player.x,player.z)+path.total/2).s:ape.s;
    Object.assign(ape,{s:far,y:config.y??45.3,state:'patrol',meter:0,engaged:false,volleyLeft:0,restClock:0,health:config.napeHealth??APE.napeHealth,downTime:0,stagger:0,goalS:null,seenAt:-Infinity});
    ape.serial++;ape.model.group.visible=true;ape.model.resetPose();ape.model.play('Walk_Loop',{fade:0});
    const p=positionAt(ape.s);ape.x=p.x;ape.z=p.z;ape.seg=p.seg;hooks.event?.('respawn',ape);
  }
  // Signal smoke: the ape snaps its gaze to the point and the meter jumps.
  function alertTo(point,amount=.5){if(!ape||ape.state==='repelled')return;ape.lastSeen={x:point.x,y:point.y??0,z:point.z};ape.meter=Math.min(1,ape.meter+amount);if(ape.state==='patrol'||ape.state==='search')setState('watch');ape.seenAt=time;}
  // Quicksave: wall position, nape health and whether it is knocked off the wall.
  function save(){return ape?{s:ape.s,health:ape.health,repelled:ape.state==='repelled',downTime:ape.downTime,serial:ape.serial}:null;}
  function restore(s,blind=0){
    if(!ape||!s)return false;
    for(const b of ape.boulders)root.remove(b.mesh);ape.boulders.length=0;
    Object.assign(ape,{s:s.s,health:s.health,downTime:s.downTime??0,stagger:0,goalS:null});
    const p=positionAt(ape.s);ape.x=p.x;ape.z=p.z;ape.seg=p.seg;
    if(s.repelled){if(ape.held){root.remove(ape.held);ape.held=null;}ape.state='repelled';ape.shape=null;ape.model.group.visible=ape.downTime<3;return true;}
    ape.y=config.y??45.3;ape.model.group.visible=true;if(ape.state==='repelled'){ape.state='patrol';ape.model.resetPose();ape.model.play('Walk_Loop',{fade:0});}
    calm(blind);return true;
  }
  function calm(blind=0){if(!ape||ape.state==='repelled')return;ape.blind=blind;ape.meter=0;ape.engaged=false;ape.seenAt=-Infinity;ape.volleyLeft=0;ape.restClock=0;if(ape.held){root.remove(ape.held);ape.held=null;}setState('patrol');}

  const tmp=new THREE.Vector3(),tmp2=new THREE.Vector3();
  function overlay(o){
    const a=ape;o.bend(APE_VARIANT.hunch);
    // Neck and head rise against the hunch so the face looks ahead.
    const lift=-APE_VARIANT.hunch*(APE_VARIANT.headLift??0);o.turn('DEF-neck',o.rightAxis(),lift*.6);o.turn('DEF-head',o.rightAxis(),lift*.4);
    // Upper body takes part of the gaze, the neck and head the rest.
    const rel=wrap(a.viewYaw-a.yaw),clamped=Math.max(-1.6,Math.min(1.6,rel));a.look+=(clamped-a.look)*.25;
    o.turn('DEF-spine_003',new THREE.Vector3(0,1,0),a.look*.4);o.look(a.look*.6);
    const q=a.model.group.quaternion,fwd=new THREE.Vector3(0,0,1).applyQuaternion(q),up=new THREE.Vector3(0,1,0);
    const right=a.model.bonePoint('DEF-upper_arm_R',tmp).sub(a.model.bonePoint('DEF-upper_arm_L',tmp2)).setY(0).normalize();
    // +twist about Y moves the right shoulder forward when this is positive.
    const sgn=Math.sign(new THREE.Vector3().crossVectors(up,right).dot(fwd))||1;
    const twist=angle=>{o.turn('DEF-spine_001',up,angle*.45*sgn);o.turn('DEF-spine_003',up,angle*.55*sgn);};
    const arm=(s,dir,w=1,fore=dir)=>{o.aimWorld(`DEF-upper_arm_${s}`,dir.clone().normalize(),w);o.aimWorld(`DEF-forearm_${s}`,fore.clone().normalize(),w);};
    const ease=x=>x*x*(3-2*x);
    if(a.state==='lift'||(a.state==='throw'&&a.stateTime<APE.release)){
      // Pitcher's wind-up: body coils away, right arm far back over the shoulder, left arm points at the target.
      const w=a.state==='lift'?ease(Math.min(1,a.stateTime/(a.liftTime??APE.lift))):1,k=a.state==='throw'?ease(a.stateTime/APE.release):0;
      twist(-1*w+1.7*k);
      const phi=2.5-2.85*k*k,throwDir=fwd.clone().multiplyScalar(Math.cos(phi)).addScaledVector(up,Math.sin(phi)).addScaledVector(right,.25*(1-k));
      arm('R',fwd.clone().multiplyScalar(-.8*w).addScaledVector(up,.5+.2*w).addScaledVector(right,.35).lerp(throwDir,k),1,fwd.clone().multiplyScalar(-.6*w).addScaledVector(up,.8).lerp(throwDir,k));
      arm('L',fwd.clone().multiplyScalar(.85).addScaledVector(up,.25-.6*k).addScaledVector(right,-.35-.3*k),.9*w);
      o.bend(.18*k);
    }else if(a.state==='throw'||(a.state==='track'&&a.stateTime<.45&&a.stats.lastThrow)){
      // Follow-through: the right arm whips down across the body.
      const t=a.state==='throw'?0:a.stateTime/.45,f=1-ease(Math.min(1,t));
      twist(.7*f);arm('R',fwd.clone().multiplyScalar(.55).addScaledVector(up,-.8).addScaledVector(right,-.45),.95*f);
      arm('L',fwd.clone().multiplyScalar(-.2).addScaledVector(up,-.9).addScaledVector(right,-.3),.7*f);o.bend(.22*f);
    }else if(a.state!=='repelled'){
      // Knuckle-walking: two-bone IK puts the knuckles on the walkway ahead of
      // the shoulders, elbows bending back and out; arms swing in turn.
      const moving=a.speed>.1,swing=Math.sin(time*2.4)*(moving?1:.12);
      for(const s of['L','R']){
        const S=a.model.bonePoint(`DEF-upper_arm_${s}`,new THREE.Vector3()),E0=a.model.bonePoint(`DEF-forearm_${s}`,new THREE.Vector3()),H0=a.model.bonePoint(`DEF-hand_${s}`,new THREE.Vector3());
        const la=S.distanceTo(E0),lb=E0.distanceTo(H0)+a.height*.03,ph=(s==='L'?swing:-swing),side=(s==='R'?1:-1);
        const T=S.clone().addScaledVector(fwd,a.height*(.2+.07*ph)).addScaledVector(right,side*a.height*.07);T.y=a.y+(moving?Math.max(0,ph)*a.height*.05:0);
        const u=T.clone().sub(S),d=Math.min(u.length(),(la+lb)*.995);u.normalize();
        const bendDir=fwd.clone().multiplyScalar(-1).addScaledVector(right,side*.5);const n=bendDir.addScaledVector(u,-bendDir.dot(u)).normalize();
        const cos=Math.max(-1,Math.min(1,(la*la+d*d-lb*lb)/(2*la*d))),E=S.clone().addScaledVector(u,la*cos).addScaledVector(n,la*Math.sqrt(1-cos*cos));
        const hand=S.clone().addScaledVector(u,d);
        arm(s,E.clone().sub(S),1,hand.sub(E));
      }
    }
  }
  function locomotion(){
    const a=ape,m=a.model;if(['lift','throw','repelled'].includes(a.state)||a.stagger>0)return;
    if(a.speed<.15){m.play('Idle_Loop',{timeScale:.6});return;}
    const clip='Walk_Loop',ts=Math.max(.08,a.speed/(m.strides[clip]*m.scale));m.play(clip,{timeScale:ts}).timeScale=ts;
  }
  function sync(dt){
    if(!ape)return;const {group}=ape.model;group.position.set(ape.x,ape.y,ape.z);group.rotation.set(0,ape.yaw,0);
    locomotion();ape.model.animate(dt,overlay);
    ape.shape=ape.state==='repelled'?null:ape.model.capsules();
    if(ape.held){const hand=ape.model.bonePoint('DEF-hand_R',tmp),wrist=ape.model.bonePoint('DEF-forearm_R',tmp2);ape.held.position.copy(hand).sub(wrist).setLength(APE.boulder.radius*.9).add(hand);}
  }
  function raycast(origin,direction,max=60){return ape?raycastTitanShapes([ape],origin,direction,max):null;}
  function hit(result,damage=25){
    if(!ape||result?.id!==ape.id||ape.state==='repelled')return false;
    if(result.part!=='nape')return true;
    ape.health-=damage;ape.stats.hits++;
    if(ape.health<=0){ape.state='repelled';ape.downTime=0;ape.stats.repelled++;ape.shape=null;if(ape.held){root.remove(ape.held);ape.held=null;}ape.model.play('Death01',{loop:false,timeScale:.55,restart:true,fade:.15});hooks.event?.('repelled',ape);return true;}
    ape.stagger=APE.stagger;if(ape.held){root.remove(ape.held);ape.held=null;}ape.model.play('Hit_Head',{loop:false,timeScale:.6,restart:true,fade:.1});hooks.event?.('nape',ape);return true;
  }
  const BONES=['DEF-head','DEF-neck','DEF-spine_003','DEF-spine_001','DEF-hips','DEF-upper_arm_L','DEF-forearm_L','DEF-hand_L','DEF-upper_arm_R','DEF-forearm_R','DEF-hand_R','DEF-thigh_L','DEF-shin_L','DEF-thigh_R','DEF-shin_R'];
  function anchor(result){
    if(!ape?.shape||result?.id!==ape.id)return null;const point=new THREE.Vector3(result.point.x,result.point.y,result.point.z);let best=null;
    for(const name of BONES){const d=ape.model.bonePoint(name,tmp).distanceTo(point);if(!best||d<best.d)best={name,d};}
    const bone=ape.model.bones[best.name];bone.updateWorldMatrix(true,false);
    return {titanId:ape.id,serial:ape.serial,bone:best.name,part:result.part,local:bone.worldToLocal(point.clone())};
  }
  function anchorPoint(a,target=new THREE.Vector3()){
    if(!ape||a?.titanId!==ape.id||a.serial!==ape.serial||ape.state==='repelled')return null;
    const bone=ape.model.bones[a.bone];bone.updateWorldMatrix(true,false);return target.copy(a.local).applyMatrix4(bone.matrixWorld);
  }
  function snapshot(){
    if(!ape)return null;
    return {id:ape.id,state:ape.state,x:+ape.x.toFixed(2),y:+ape.y.toFixed(2),z:+ape.z.toFixed(2),s:+ape.s.toFixed(2),perimeter:+path.total.toFixed(2),yaw:+ape.yaw.toFixed(3),viewYaw:+ape.viewYaw.toFixed(3),meter:+ape.meter.toFixed(3),engaged:ape.engaged,seen:ape.seen,
      lastSeen:ape.lastSeen&&{...ape.lastSeen},searchS:ape.searchS??null,health:ape.health,clip:ape.model.current,boulders:ape.boulders.map(b=>({id:b.id,age:+b.age.toFixed(2),flight:b.flight,speed:+speedOf(b.vel).toFixed(1),rolling:b.rolling,impacts:b.impacts.length,pos:{x:+b.pos.x.toFixed(2),y:+b.pos.y.toFixed(2),z:+b.pos.z.toFixed(2)},to:b.to})),volleyLeft:ape.volleyLeft,restClock:+ape.restClock.toFixed(2),
      stats:{...ape.stats,walls:[...ape.stats.walls],distance:+ape.stats.distance.toFixed(1),stateLog:ape.stats.stateLog.slice(-16)}};
  }
  function dispose(){if(ape)ape.model.dispose();boulderGeometry.dispose();boulderMaterial.dispose();scene?.remove(root);ape=null;}
  return reset(world,config);
}
