import * as THREE from '../vendor/three.module.js';
import {worldPoint,sourcePoint,gridCell} from './rigid-fracture.js';

// "飞索腰具": an original waist-mounted twin grapple. One key drives it: a press
// aimed at a hookable surface winds up and fires the next hook (alternating
// L/R), holding reels the player in, releasing lets go and keeps inertia.
// Hooks latch onto static voxels, the far wall, loose rigid pieces or titan
// bones, and fall off when the anchored cell, piece or titan is gone.
export const GEAR={range:48,windup:.2,hookSpeed:120,reelAccel:34,minRope:1.2,reelUse:6,emptyPull:.3,regen:9,regenDelay:1,maxSpeed:32,landSpeed:6,centerHeight:1,pickupRadius:2.6};
const SIDES=['L','R'];

export function createGrappleGear({world,raycast,titans=null,rigid=null,scene=null,toolCamera=null,thirdRoot=null,events=null}={}){
  const hooks=SIDES.map(side=>({side,state:'idle',pos:new THREE.Vector3(),dir:new THREE.Vector3(),target:new THREE.Vector3(),travel:0,windup:0,anchor:null,length:0}));
  const gear={equipped:false,blades:false,gas:100,hooks,next:0,active:null,landDip:0,airTime:0,regenClock:0,slash:0,flying:false,boosting:false,stats:{fired:0,attached:0,detached:0,boosts:0,landings:0,maxSpeed:0,presses:0,jumps:0},
    equip,refill,toggle,fire,press,releaseActive,aimQuery,release,preStep,postStep,anchorPosition,render,nearestRack,reset,slashStart,setWorld(next){world=next;},setRigid(next){rigid=next;},snapshot,visuals:null};
  const tmp=new THREE.Vector3(),center=new THREE.Vector3(),up=new THREE.Vector3(0,1,0);
  const emit=(type,data)=>events?.(type,data);

  function reset(){gear.equipped=false;gear.blades=false;gear.gas=100;gear.next=0;gear.active=null;gear.landDip=0;gear.airTime=0;gear.slash=0;hooks.forEach(h=>{h.state='idle';h.anchor=null;h.windup=0;});gear.visuals?.sync();}
  // Nearest hookable hit along the crosshair ray (solids, far wall, titans).
  function aimHit(eye,aim,range=GEAR.range){
    const hit=raycast(eye,aim,range),giant=titans?.raycast?.(eye,aim,hit?.distance??range);
    return giant&&(!hit||giant.distance<hit.distance)?giant:hit;
  }
  function aimQuery(eye,aim){
    const hit=gear.equipped?aimHit(eye,aim):null;
    if(!hit?.point||!(hit.distance<=GEAR.range))return {hookable:false,distance:hit?.distance??null,point:null};
    return {hookable:true,distance:hit.distance,point:{x:hit.point.x,y:hit.point.y,z:hit.point.z},type:hit.type??(hit.farWall?'static':hit.rigidId?'rigid':'voxel')};
  }
  // Space pressed: hook if the crosshair is on a hookable surface, else tell
  // the caller to jump. Returns 'hook' or 'jump'.
  function press(player,yaw,eye,aim){
    gear.stats.presses++;
    const q=aimQuery(eye,aim);if(!q.hookable){gear.stats.jumps++;return 'jump';}
    const hook=hooks[gear.next%2];gear.next++;
    if(hook.state!=='idle'){hook.state='idle';hook.anchor=null;}
    launchPoint(player,yaw,hook.side,hook.pos);hook.target.set(q.point.x,q.point.y,q.point.z);hook.dir.copy(hook.target).sub(hook.pos).normalize();
    hook.state='windup';hook.windup=GEAR.windup;hook.travel=0;hook.anchor=null;gear.active=hook.side;
    gear.stats.fired++;emit('fire',{side:hook.side,windup:GEAR.windup,distance:q.distance});return 'hook';
  }
  // Space released: let go of the active hook; velocity is untouched.
  function releaseActive(){
    const hook=hooks.find(h=>h.side===gear.active);gear.active=null;if(!hook)return false;
    if(hook.state==='windup'){hook.state='idle';return true;}
    release(hook.side,'manual');return true;
  }
  function equip(){if(gear.equipped)return false;gear.equipped=true;gear.gas=100;emit('equip');gear.visuals?.sync();return true;}
  function refill(){gear.gas=100;emit('refill');}
  function launchPoint(player,yaw,side,target=new THREE.Vector3()){
    const s=side==='L'?-1:1;return target.set(player.x+Math.cos(yaw)*.3*s,player.y+.95,player.z-Math.sin(yaw)*.3*s);
  }
  function fire(side,player,yaw,eye,aim){
    const hook=hooks.find(h=>h.side===side);if(!gear.equipped||!hook)return false;
    const hit=raycast(eye,aim,GEAR.range),target=hit?.point?tmp.set(hit.point.x,hit.point.y,hit.point.z):tmp.copy(eye).addScaledVector(aim,GEAR.range);
    launchPoint(player,yaw,side,hook.pos);hook.dir.copy(target).sub(hook.pos).normalize();hook.travel=0;hook.state='flying';hook.anchor=null;
    gear.stats.fired++;emit('fire',{side});return true;
  }
  function toggle(side,player,yaw,eye,aim){
    const hook=hooks.find(h=>h.side===side);if(!hook)return false;
    if(hook.state==='idle')return fire(side,player,yaw,eye,aim);
    release(side,'manual');return true;
  }
  function release(side,reason='manual'){
    const hook=hooks.find(h=>h.side===side);if(!hook||hook.state==='idle'||hook.state==='retract')return;
    if(hook.state==='windup'){hook.state='idle';return;}
    const was=hook.state;hook.state='retract';hook.anchor=null;if(gear.active===side&&reason!=='manual')gear.active=null;
    if(was==='attached'){gear.stats.detached++;emit('detach',{side,reason});}
  }
  function attach(hook,hit,player){
    let anchor=null;
    if(hit.farWall)anchor={type:'static',point:new THREE.Vector3(hit.point.x,hit.point.y,hit.point.z)};
    else if(hit.type==='titan'){const ref=titans?.anchor(hit);if(ref)anchor={type:'titan',ref,part:hit.part};}
    else if(hit.rigidId){const entry=rigid?.entries.get(hit.rigidId);if(entry)anchor={type:'rigid',id:hit.rigidId,voxel:hit.voxel?{...hit.voxel}:null,source:sourcePoint(entry,hit.point)};}
    else anchor={type:'voxel',cell:[hit.x,hit.y,hit.z],point:new THREE.Vector3(hit.point.x,hit.point.y,hit.point.z),mat:hit.mat};
    if(!anchor){hook.state='retract';return;}
    hook.anchor=anchor;hook.state='attached';hook.pos.set(hit.point.x,hit.point.y,hit.point.z);
    center.set(player.x,player.y+GEAR.centerHeight,player.z);hook.length=Math.max(GEAR.minRope,hook.pos.distanceTo(center));
    gear.stats.attached++;emit('attach',{side:hook.side,type:anchor.type,part:anchor.part,point:hook.pos.clone()});
  }
  function anchorPosition(hook,target=new THREE.Vector3()){
    const a=hook.anchor;if(!a)return null;
    if(a.type==='static')return target.copy(a.point);
    if(a.type==='voxel')return world.getId(...a.cell)?target.copy(a.point):null;
    if(a.type==='rigid'){const entry=rigid?.entries.get(a.id);if(!entry||(a.voxel&&!gridCell(entry,a.voxel.x,a.voxel.y,a.voxel.z)))return null;const p=worldPoint(entry,a.source);return target.set(p.x,p.y,p.z);}
    if(a.type==='titan')return titans?.anchorPoint(a.ref,target)??null;
    return null;
  }
  function flyHooks(player,yaw,dt){
    for(const hook of hooks){
      if(hook.state==='windup'){
        // The claw sits primed in the launcher until the wind-up ends.
        launchPoint(player,yaw,hook.side,hook.pos);hook.windup-=dt;
        if(hook.windup<=0){hook.dir.copy(hook.target).sub(hook.pos).normalize();hook.state='flying';emit('launch',{side:hook.side});}
        continue;
      }
      if(hook.state==='flying'){
        const step=GEAR.hookSpeed*dt,hit=raycast(hook.pos,hook.dir,step),giant=titans?.raycast(hook.pos,hook.dir,hit?.distance??step);
        const best=giant&&(!hit||giant.distance<hit.distance)?giant:hit;
        if(best){attach(hook,best,player);continue;}
        hook.pos.addScaledVector(hook.dir,step);hook.travel+=step;
        if(hook.travel>=GEAR.range){hook.state='retract';emit('miss',{side:hook.side});}
      }else if(hook.state==='retract'){
        const home=launchPoint(player,yaw,hook.side,tmp),d=home.distanceTo(hook.pos),step=GEAR.hookSpeed*1.4*dt;
        if(d<=step+.2){hook.state='idle';continue;}
        hook.pos.lerp(home,step/d);
      }else if(hook.state==='attached'&&!anchorPosition(hook,tmp)){
        release(hook.side,hook.anchor.type==='titan'?'titan-down':'anchor-destroyed');
      }
    }
  }
  // Forces before the movement sweep. Returns flags for stepPlayer.
  // `hold`: Space is held, so the active attached hook reels the player in.
  function preStep(player,dt,{yaw=0,hold=false}={}){
    if(!gear.equipped){gear.flying=false;return {airInertia:false};}
    flyHooks(player,yaw,dt);
    const attached=hooks.filter(h=>h.state==='attached');
    gear.preVy=player.vy;gear.wasGrounded=player.grounded;
    center.set(player.x,player.y+GEAR.centerHeight,player.z);
    const pulling=hold?attached.filter(h=>h.side===gear.active):[];
    gear.reeling=pulling.length>0;
    if(gear.reeling){
      const strength=gear.gas>0?1:GEAR.emptyPull;
      for(const hook of pulling){
        const a=anchorPosition(hook,tmp);if(!a)continue;const d=a.sub(center),dist=d.length();if(dist<1e-3)continue;
        d.divideScalar(dist);const accel=GEAR.reelAccel*strength;
        player.vx+=d.x*accel*dt;player.vy+=d.y*accel*dt+(player.grounded?2.5:0);player.vz+=d.z*accel*dt;
        hook.length=Math.max(GEAR.minRope,Math.min(hook.length,dist));
      }
      gear.gas=Math.max(0,gear.gas-GEAR.reelUse*dt);gear.regenClock=0;
      if(player.grounded&&player.vy>0)player.grounded=false;
    }
    const speed=Math.hypot(player.vx,player.vy,player.vz);
    if(speed>GEAR.maxSpeed){const k=GEAR.maxSpeed/speed;player.vx*=k;player.vy*=k;player.vz*=k;}
    gear.stats.maxSpeed=Math.max(gear.stats.maxSpeed,Math.min(speed,GEAR.maxSpeed));
    gear.flying=attached.length>0||!player.grounded;
    return {airInertia:true};
  }
  // Rope constraint, landing cushion and gas regeneration after the sweep.
  function postStep(player,dt,{collides=null}={}){
    if(!gear.equipped)return;
    for(const hook of hooks){
      if(hook.state!=='attached')continue;
      const a=anchorPosition(hook,tmp);if(!a){release(hook.side,hook.anchor.type==='titan'?'titan-down':'anchor-destroyed');continue;}
      center.set(player.x,player.y+GEAR.centerHeight,player.z);
      const d=center.clone().sub(a),dist=d.length();if(dist<=hook.length||dist<1e-4)continue;
      d.divideScalar(dist);
      const next={x:a.x+d.x*hook.length,y:a.y+d.y*hook.length-GEAR.centerHeight,z:a.z+d.z*hook.length};
      if(!collides?.(next.x,next.y,next.z))Object.assign(player,next);
      const outward=player.vx*d.x+player.vy*d.y+player.vz*d.z;
      if(outward>0){player.vx-=d.x*outward;player.vy-=d.y*outward;player.vz-=d.z*outward;}
    }
    if(!player.grounded)gear.airTime+=dt;
    else{
      if(!gear.wasGrounded&&gear.airTime>.35&&(gear.preVy??0)<-GEAR.landSpeed){player.vx*=.45;player.vz*=.45;gear.landDip=.18;gear.stats.landings++;emit('land',{speed:-gear.preVy});}
      gear.airTime=0;
      if(!gear.reeling){gear.regenClock+=dt;if(gear.regenClock>GEAR.regenDelay)gear.gas=Math.min(100,gear.gas+GEAR.regen*dt);}
    }
    gear.landDip=Math.max(0,gear.landDip-dt*.5);
    gear.slash=Math.max(0,gear.slash-dt);
  }
  function slashStart(){if(!gear.equipped||!gear.blades||gear.slash>0)return false;gear.slash=.42;return true;}
  function nearestRack(player,racks){
    let best=null;for(const r of racks||[]){const d=Math.hypot(r.x-player.x,r.z-player.z);if(d<GEAR.pickupRadius&&Math.abs(r.y-player.y)<2&&(!best||d<best.d))best={rack:r,d};}
    return best?.rack??null;
  }
  function snapshot(){return {equipped:gear.equipped,blades:gear.blades,gas:+gear.gas.toFixed(1),flying:gear.flying,boosting:false,reeling:Boolean(gear.reeling),active:gear.active,next:SIDES[gear.next%2],hooks:hooks.map(h=>({side:h.side,state:h.state,windup:+Math.max(0,h.windup).toFixed(2),type:h.anchor?.type??null,part:h.anchor?.part??null,length:+h.length.toFixed(2),pos:h.pos.toArray().map(v=>+v.toFixed(2))})),stats:{...gear.stats,maxSpeed:+gear.stats.maxSpeed.toFixed(1),boosts:+gear.stats.boosts.toFixed(2)}};}
  function render(dt,state){gear.visuals?.update(dt,state);}
  if(scene)gear.visuals=createGearVisuals(gear,{scene,toolCamera,thirdRoot,launchPoint});
  return gear;
}

function gearMaterials(){
  return {steel:new THREE.MeshStandardMaterial({color:0x9aa3a6,metalness:.55,roughness:.38}),dark:new THREE.MeshStandardMaterial({color:0x34383a,metalness:.35,roughness:.6}),leather:new THREE.MeshStandardMaterial({color:0x6b4a2e,roughness:.85}),brass:new THREE.MeshStandardMaterial({color:0xb08a46,metalness:.5,roughness:.45}),blade:new THREE.MeshStandardMaterial({color:0xdfe5e8,metalness:.8,roughness:.18}),wood:new THREE.MeshStandardMaterial({color:0x8a5a33,roughness:.9}),rope:new THREE.MeshStandardMaterial({color:0x2c2a26,roughness:.8}),glow:new THREE.MeshBasicMaterial({color:0x9fd8ff,transparent:true,opacity:.55,side:THREE.DoubleSide,depthWrite:false})};
}
// Waist unit: two gas tanks across the back, a launcher on each hip, optional blades.
export function buildGearModel(materials,{blades=true}={}){
  const group=new THREE.Group(),parts={launchers:[],blades:[]};
  const mesh=(geometry,material,position,rotation=[0,0,0])=>{const m=new THREE.Mesh(geometry,material);m.position.fromArray(position);m.rotation.set(...rotation);m.castShadow=true;group.add(m);return m;};
  mesh(new THREE.BoxGeometry(.5,.07,.05),materials.leather,[0,0,0]);
  for(const s of[-1,1]){
    mesh(new THREE.CylinderGeometry(.065,.065,.36,14),materials.steel,[s*.12,.02,.15],[0,0,Math.PI/2+s*.25]);
    mesh(new THREE.SphereGeometry(.065,12,8),materials.steel,[s*.28,.065,.15]);
    mesh(new THREE.CylinderGeometry(.02,.02,.05,8),materials.brass,[s*.02,.01,.15],[0,0,Math.PI/2]);
    const launcher=new THREE.Group();launcher.position.set(s*.27,-.02,-.02);group.add(launcher);
    const box=new THREE.Mesh(new THREE.BoxGeometry(.08,.1,.2),materials.dark);launcher.add(box);
    const barrel=new THREE.Mesh(new THREE.CylinderGeometry(.022,.026,.12,10),materials.steel);barrel.rotation.x=Math.PI/2;barrel.position.set(0,.02,-.15);launcher.add(barrel);
    const claw=new THREE.Mesh(new THREE.ConeGeometry(.026,.05,6),materials.brass);claw.rotation.x=-Math.PI/2;claw.position.set(0,.02,-.23);launcher.add(claw);
    const hose=new THREE.Mesh(new THREE.TorusGeometry(.1,.009,6,12,Math.PI*.8),materials.rope);hose.position.set(-s*.08,.04,.07);hose.rotation.set(0,Math.PI/2,0);launcher.add(hose);
    parts.launchers.push(launcher);
    if(blades){
      const sheath=new THREE.Group();sheath.position.set(s*.33,-.05,.1);group.add(sheath);
      const bladeBox=new THREE.Mesh(new THREE.BoxGeometry(.05,.07,.55),materials.dark);bladeBox.position.z=.12;sheath.add(bladeBox);
      parts.blades.push(sheath);
    }
  }
  group.traverse(o=>{if(o.isMesh)o.castShadow=true;});
  return {group,parts};
}
function buildBlade(materials){
  const blade=new THREE.Group();
  const handle=new THREE.Mesh(new THREE.BoxGeometry(.035,.12,.035),materials.leather);blade.add(handle);
  const guard=new THREE.Mesh(new THREE.BoxGeometry(.07,.016,.05),materials.brass);guard.position.y=.065;blade.add(guard);
  const steel=new THREE.Mesh(new THREE.BoxGeometry(.012,.62,.05),materials.blade);steel.position.y=.38;blade.add(steel);
  const tip=new THREE.Mesh(new THREE.ConeGeometry(.026,.08,4),materials.blade);tip.position.y=.73;tip.scale.z=.4;blade.add(tip);
  return blade;
}

function createGearVisuals(gear,{scene,toolCamera,thirdRoot,launchPoint}){
  const materials=gearMaterials(),root=new THREE.Group();root.name='grapple gear';scene.add(root);
  // First-person: launcher grips in the lower corners, blades extend from them.
  const fp=new THREE.Group();fp.name='grapple gear first person';fp.visible=false;toolCamera?.add(fp);
  const fpHands=SIDES.map(side=>{
    const s=side==='L'?-1:1,hand=new THREE.Group();hand.position.set(s*.34,-.36,-.5);hand.rotation.set(.25,-s*.12,0);fp.add(hand);
    const grip=new THREE.Mesh(new THREE.BoxGeometry(.05,.13,.06),materials.leather);grip.rotation.x=-.3;hand.add(grip);
    const body=new THREE.Mesh(new THREE.BoxGeometry(.075,.07,.2),materials.dark);body.position.set(0,.07,-.06);hand.add(body);
    const barrel=new THREE.Mesh(new THREE.CylinderGeometry(.018,.022,.1,10),materials.steel);barrel.rotation.x=Math.PI/2;barrel.position.set(0,.085,-.2);hand.add(barrel);
    const trigger=new THREE.Mesh(new THREE.BoxGeometry(.01,.04,.02),materials.brass);trigger.position.set(0,.02,-.02);hand.add(trigger);
    const blade=buildBlade(materials);blade.position.set(0,.09,-.12);blade.rotation.x=-Math.PI/2+.22;blade.visible=false;hand.add(blade);
    return {hand,blade,s};
  });
  const third=buildGearModel(materials);third.group.name='grapple gear third person';third.group.position.set(0,.98,.04);third.group.visible=false;thirdRoot?.add(third.group);
  const ropes=gear.hooks.map(()=>{const m=new THREE.Mesh(new THREE.CylinderGeometry(1,1,1,6,1,true),materials.rope);m.visible=false;m.frustumCulled=false;root.add(m);return m;});
  const claws=gear.hooks.map(()=>{
    const g=new THREE.Group();g.visible=false;root.add(g);
    const head=new THREE.Mesh(new THREE.ConeGeometry(.07,.18,8),materials.steel);head.rotation.x=Math.PI/2;g.add(head);
    for(let i=0;i<3;i++){const prong=new THREE.Mesh(new THREE.BoxGeometry(.02,.02,.14),materials.brass);const a=i/3*Math.PI*2;prong.position.set(Math.cos(a)*.06,Math.sin(a)*.06,-.04);prong.rotation.set(-Math.sin(a)*.6,Math.cos(a)*.6,0);g.add(prong);}
    return g;
  });
  const puffGeometry=new THREE.SphereGeometry(.22,8,6),puffs=Array.from({length:48},()=>{const m=new THREE.Mesh(puffGeometry,new THREE.MeshBasicMaterial({color:0xe9eef0,transparent:true,opacity:0,depthWrite:false}));m.visible=false;root.add(m);return {mesh:m,life:0,v:new THREE.Vector3()};});
  let puffIndex=0,puffClock=0;
  const racks=[];
  function setRacks(list){
    for(const r of racks){root.remove(r);r.traverse(o=>o.geometry?.dispose());}racks.length=0;
    for(const point of list||[]){
      const g=new THREE.Group();g.position.set(point.x,point.y,point.z);g.rotation.y=point.yaw??0;g.name=point.id;
      for(const s of[-1,1]){const post=new THREE.Mesh(new THREE.BoxGeometry(.08,1.4,.08),materials.wood);post.position.set(s*.4,.7,0);post.castShadow=true;g.add(post);}
      const bar=new THREE.Mesh(new THREE.BoxGeometry(.95,.08,.1),materials.wood);bar.position.y=1.3;g.add(bar);
      const base=new THREE.Mesh(new THREE.BoxGeometry(1.1,.08,.5),materials.wood);base.position.y=.04;g.add(base);
      const model=buildGearModel(materials);model.group.position.set(0,1.05,.06);model.group.rotation.y=Math.PI;g.add(model.group);
      const ring=new THREE.Mesh(new THREE.RingGeometry(.75,.82,32),materials.glow);ring.rotation.x=-Math.PI/2;ring.position.y=.05;g.add(ring);
      root.add(g);racks.push(g);
    }
  }
  const a=new THREE.Vector3(),b=new THREE.Vector3(),mid=new THREE.Vector3(),dir=new THREE.Vector3(),Y=new THREE.Vector3(0,1,0);
  function sync(){fp.visible=gear.equipped&&!gear.thirdPerson;third.group.visible=gear.equipped&&Boolean(gear.thirdPerson);}
  function update(dt,{player,yaw=0,thirdPerson=false,view=null,time=0}){
    gear.thirdPerson=thirdPerson;sync();
    third.parts.blades.forEach(b=>b.visible=!gear.blades);
    const slash=gear.slash>0?Math.sin((1-gear.slash/.42)*Math.PI):0;
    // Wind-up: the launcher on that side cocks back and the claw glows in the muzzle.
    const cock=side=>{const h=gear.hooks.find(k=>k.side===side);return h?.state==='windup'?Math.sin((1-h.windup/GEAR.windup)*Math.PI*.5):0;};
    for(const h of fpHands){const c=cock(h.s<0?'L':'R');h.blade.visible=gear.blades;h.hand.rotation.set(.25-slash*.9+c*.35,-h.s*(.12+slash*.5),h.s*slash*.4);h.hand.position.y=-.36+gear.landDip*.4;h.hand.position.z=-.5+c*.08;}
    gear.hooks.forEach((hook,i)=>{
      const rope=ropes[i],claw=claws[i],visible=hook.state!=='idle';rope.visible=claw.visible=visible;if(!visible)return;
      if(hook.state==='windup'){
        rope.visible=false;launchPoint(player,yaw,hook.side,a);claw.position.copy(a);dir.subVectors(hook.target,a).normalize();claw.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),dir);
        claw.scale.setScalar(1+.6*Math.abs(Math.sin((time||performance.now()/1000)*40+i)));return;
      }
      claw.scale.setScalar(1);
      launchPoint(player,yaw,hook.side,a);b.copy(hook.pos);dir.subVectors(b,a);const len=dir.length();if(len<1e-3){rope.visible=false;return;}
      mid.addVectors(a,b).multiplyScalar(.5);rope.position.copy(mid);rope.quaternion.setFromUnitVectors(Y,dir.divideScalar(len));rope.scale.set(.014,len,.014);
      claw.position.copy(b);claw.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),dir);
    });
    puffClock-=dt;
    if(gear.boosting&&view&&puffClock<=0){
      puffClock=.03;
      for(const s of[-1,1]){const p=puffs[puffIndex++%puffs.length];p.life=.6;p.mesh.visible=true;p.mesh.position.set(player.x+Math.sin(yaw)*.2+Math.cos(yaw)*.12*s,player.y+1.15,player.z+Math.cos(yaw)*.2-Math.sin(yaw)*.12*s);p.v.set(-view.x*1.6+Math.cos(yaw)*s*1.8+(Math.random()-.5)*.6,-view.y*1.6+.3+(Math.random()-.5)*.6,-view.z*1.6-Math.sin(yaw)*s*1.8+(Math.random()-.5)*.6);}
    }
    for(const p of puffs){if(p.life<=0)continue;p.life-=dt;if(p.life<=0){p.mesh.visible=false;continue;}const t=1-p.life/.6;p.mesh.position.addScaledVector(p.v,dt);p.mesh.scale.setScalar(1+t*2);p.mesh.material.opacity=.75*(1-t);}
  }
  function dispose(){root.removeFromParent();fp.removeFromParent();third.group.removeFromParent();root.traverse(o=>o.geometry?.dispose());fp.traverse(o=>o.geometry?.dispose());third.group.traverse(o=>o.geometry?.dispose());Object.values(materials).forEach(m=>m.dispose());puffs.forEach(p=>p.mesh.material.dispose());}
  return {update,sync,setRacks,dispose,get racks(){return racks;},puffs,ropes,claws,fp,third};
}