import * as THREE from '../vendor/three.module.js';
import {createWallApe,APE} from './wall-ape.js';
import {createMissionRun,standHeight} from './titan-missions.js';
import {createAtmosphere} from './titan-atmosphere.js';
import {createFarWallMesh} from './far-wall.js';
import {PLAYER_CONTROL} from './player.js';

// "夺回城墙" glue between game.js and the level systems: wall ape, missions,
// lives, detection UI, crosshair hook hints, HUD panel and results.
export const CAMPAIGN={respawnFade:.6,grace:4,respawnClear:{radius:20,hold:8},fallHeight:18,fallSpeed:22,noise:{fire:18,attach:10,explosion:45,collapse:35,boulder:40,land:10},stompRange:12,whooshRange:40,
  health:{max:100,direct:1.8,splash:5,near:70,far:35,knock:.6,knockSpeed:4,knockUp:3,regenDelay:10,regenRate:6,grabWindow:1.2,grabGrace:1.5,escapeCooldown:5,escapeCone:25,escapeReach:4.5,hitGuard:.8,splashPerVolley:1}};
const STAR='★';
// Boulder impact at torso distance d: 'kill' inside the direct radius, splash
// damage falling linearly from near to far out to the splash radius, else 0.
// Knockback must test the whole player cylinder; a centre-only test slid the body into wall faces and wedged it there.
export function knockBlocked(world,solidAt,x,y,z,height=PLAYER_CONTROL.standingHeight){return world.collides(x,y,z,height,PLAYER_CONTROL.radius)||Boolean(solidAt?.(x,y+.9,z));}
// While pinned the gripping arm can sit at the edge of view or behind the torso capsule; a swing
// aimed within `cone` of either arm segment and within `reach` frees the player.
export function armInReach(shape,eye,dir,{cone=CAMPAIGN.health.escapeCone,reach=CAMPAIGN.health.escapeReach}={}){
  if(!shape)return false;const len=Math.hypot(dir.x,dir.y,dir.z)||1,cos=Math.cos(cone*Math.PI/180);
  for(const c of shape.capsules){if(!/^arm/.test(c.part??''))continue;
    for(let i=0;i<=8;i++){const u=i/8,x=c.start.x+(c.end.x-c.start.x)*u-eye.x,y=c.start.y+(c.end.y-c.start.y)*u-eye.y,z=c.start.z+(c.end.z-c.start.z)*u-eye.z,d=Math.hypot(x,y,z);
      if(d<=reach+c.radius&&(d<=c.radius||(x*dir.x+y*dir.y+z*dir.z)/(d*len)>=cos))return true;}}
  return false;
}
// Splash bookkeeping: `hitGuard` seconds of immunity after a splash (one boulder breaking through
// walls registers several impacts), and at most `splashPerVolley` damaging splashes per volley so a
// knocked-down player is not finished by the rest of the same volley. Direct hits still kill.
export function splashLands(book,volley,now,h=CAMPAIGN.health){
  if(now-(book.at??-Infinity)<h.hitGuard)return false;
  if(volley!=null){if(book.volley!==volley){book.volley=volley;book.count=0;}if(book.count>=h.splashPerVolley)return false;book.count++;}
  book.at=now;return true;
}
export function boulderDamage(d,h=CAMPAIGN.health){
  if(d<=h.direct)return 'kill';if(d>h.splash)return 0;
  return h.near-(h.near-h.far)*(d-h.direct)/(h.splash-h.direct);
}

const CSS=`
#detect-ui{position:fixed;inset:0;pointer-events:none;z-index:6}
#detect-vignette{position:absolute;inset:0;opacity:0;background:radial-gradient(ellipse at center,transparent 52%,rgba(150,10,10,.85) 100%);transition:opacity .15s}
#detect-eye{position:absolute;left:50%;top:14px;transform:translateX(-50%);filter:drop-shadow(0 1px 2px #000a)}
#detect-eye svg *{stroke:#9a9a9a}#detect-eye .pupil{fill:#9a9a9a;stroke:none}#detect-eye .ring{stroke:#e6c34a;transform:rotate(-90deg);transform-origin:32px 20px}
#detect-eye.yellow svg *{stroke:#e6c34a}#detect-eye.yellow .pupil{fill:#e6c34a}
#detect-eye.red svg *{stroke:#ff3b2f}#detect-eye.red .pupil{fill:#ff3b2f}#detect-eye.red{animation:eyepulse .5s infinite alternate}
#detect-eye.windup svg *{stroke:#fff}#detect-eye.windup .pupil{fill:#ff3b2f}#detect-eye.windup{animation:eyeblink .16s steps(2,jump-none) infinite}
@keyframes eyeblink{from{opacity:1;transform:translateX(-50%) scale(1.35)}to{opacity:.25;transform:translateX(-50%) scale(1)}}
@keyframes eyepulse{to{transform:translateX(-50%) scale(1.15)}}
.detect-arrow{position:absolute;left:50%;top:50%;width:0;height:0;border-left:11px solid transparent;border-right:11px solid transparent;border-bottom:20px solid rgb(230,195,74);opacity:calc(.45 + var(--alert,0)*.55)}
.detect-arrow.red{border-bottom-color:#ff3b2f}
#crosshair.hookable{color:#7fe0ff;border-color:#7fe0ff}#crosshair.unhookable{opacity:.55}
#hook-range{position:fixed;left:50%;top:calc(50% - 32px);transform:translateX(-50%);font:600 12px/1 system-ui,sans-serif;color:#cfd8dc;text-shadow:0 1px 2px #000;pointer-events:none;z-index:5}
#hook-range.hookable{color:#7fe0ff}
#titan-panel{position:fixed;right:14px;top:120px;width:250px;padding:10px 12px;background:#15130fd0;border:1px solid #6b5a3a;border-radius:6px;color:#e9e1cf;font:12px/1.45 system-ui,sans-serif;z-index:5;pointer-events:none}
#titan-panel h4{margin:0 0 4px;font-size:13px;color:#f0c27a;display:flex;justify-content:space-between}
#titan-panel .row{display:flex;justify-content:space-between;gap:6px}#titan-panel .row.done{opacity:.55;text-decoration:line-through}#titan-panel .row.active b{color:#9fe3a7}
#titan-panel .hp{position:relative;height:14px;margin:2px 0 4px;background:#3a2a22;border:1px solid #6b5a3a;border-radius:3px;overflow:hidden}
#titan-panel .hp i{position:absolute;inset:0 auto 0 0;background:linear-gradient(#d9573f,#9e2f22)}#titan-panel .hp span{position:relative;display:block;text-align:center;font-size:11px;line-height:14px;text-shadow:0 1px 1px #000}
#titan-panel .grab{color:#ff6b55;font-weight:700}
#titan-panel .stars{color:#f2c14e;letter-spacing:-1px}#titan-panel small{color:#b5aa94}
#titan-fade{position:fixed;inset:0;background:#000;opacity:0;pointer-events:none;transition:opacity .25s;z-index:7}
`;

// A wall left standing between the (already carved) impact and the torso takes
// the blast; the boulder itself still crushes on contact.
export function boulderImpactShielded(world,point,player,d){
  const torso={x:player.x,y:player.y+.9,z:player.z},dir={x:(torso.x-point.x)/d,y:(torso.y-point.y)/d,z:(torso.z-point.z)/d};
  const hit=world.raycast(point,dir,d);return Boolean(hit&&hit.distance<d-.4);
}
export function createTitanCampaign(ctx){
  const {scene,camera,audio,toast,$}=ctx;
  let level=null,world=null,ape=null,run=null,atmosphere=null,farMesh=null,active=false,rescueMesh=null,markers=[];
  const status={dying:0,deathReason:null,airPeak:0,wasGrounded:true,lastVy:0,stompClock:{},whooshed:new Set(),hook:{hookable:false,distance:null},results:null,music:null,lastSpot:-Infinity,health:CAMPAIGN.health.max,hurtAgo:Infinity,knock:null,grab:null,damageTaken:0,escapes:0,splash:{},time:0};
  const heal=()=>{status.health=CAMPAIGN.health.max;status.hurtAgo=Infinity;status.knock=null;status.grab=null;status.splash={};};
  let style=null;
  const standAt=(x,z,y)=>standHeight((a,b,c)=>world.getId(a,b,c),x,z,y);
  function ensureDom(){
    if(!style&&typeof document!=='undefined'){style=document.createElement('style');style.textContent=CSS;document.head.appendChild(style);}
    for(const [id,tag]of [['hook-range','div'],['titan-panel','div'],['titan-fade','div']])if(!document.getElementById(id)){const el=document.createElement(tag);el.id=id;el.hidden=true;document.body.appendChild(el);}
  }
  const apeHooks={
    smash:(point,radius,boulder)=>onImpact(point,radius,boulder),
    sweep:(origin,direction,max)=>ctx.sweep?ctx.sweep(origin,direction,max):world.raycast(origin,direction,max),
    event:(type,a,data)=>{
      if(type==='spot'){toast('城垣巨猿发现了你！');audio('alarm');}
      else if(type==='lift'){if(data?.first){audio('roar');atmosphere?.windup(data.seconds);}else audio('heartbeat');}
      else if(type==='throw')audio('whoosh');
      else if(type==='lost')toast('巨猿失去了你的踪迹，正沿墙道搜寻');
      else if(type==='repelled'){audio('collapse');const done=run?.apeRepelled(ctx.player());toast(done?'城垣巨猿被击退！城墙夺回':'城垣巨猿被击退了');}
      else if(type==='respawn')toast('城垣巨猿重新爬上了城墙');
      else if(type==='nape'){audio('hit');toast('击中巨猿后颈！');}
    }
  };
  function reset(nextLevel){
    level=nextLevel;world=level.world;active=Boolean(level.missions);
    farMesh?.removeFromParent();farMesh?.userData.dispose?.();farMesh=null;
    ape?.dispose();ape=null;atmosphere?.dispose();atmosphere=null;
    rescueMesh?.removeFromParent();rescueMesh=null;markers.forEach(m=>m.removeFromParent());markers=[];
    run=null;status.results=null;status.dying=0;heal();
    if(typeof document!=='undefined'){ensureDom();for(const id of ['hook-range','titan-panel'])document.getElementById(id).hidden=!active;document.getElementById('crosshair')?.classList.remove('hookable','unhookable');}
    if(!active)return;
    if(level.farWall){try{farMesh=createFarWallMesh(level.farWall);scene.add(farMesh);}catch(error){console.warn('远景墙网格创建失败',error);}}
    if(level.ape)ape=createWallApe(scene,world,level.ape,apeHooks);
    const columns=[[-70,10,-20],[60,10,-75]];
    atmosphere=createAtmosphere({scene,camera,smokeColumns:columns});
    run=createMissionRun(level.missions,{events:missionEvent});
    rescueMesh=villagerMesh();scene.add(rescueMesh);
    placeMarkers();
  }
  function placeMarkers(){
    markers.forEach(m=>m.removeFromParent());markers=[];
    for(const m of run.missions){if(m.kind==='hunt'||m.status==='done')continue;const g=beacon(m.stars);g.position.set(m.at.x,m.at.y,m.at.z);g.userData.mission=m.id;scene.add(g);markers.push(g);}
  }
  // F5/F9: mission progress, lives, health and the wall ape go into the quicksave. Ground giants are
  // not saved, so a load is treated like a respawn: brief grace, nearby giants back off, the ape is calm.
  function saveState(){return active&&run?{run:run.save(),health:status.health,ape:ape?.save()??null}:null;}
  function loadState(s){
    if(!active||!run||!s?.run)return false;
    run.restore(s.run);status.dying=0;status.results=null;heal();status.health=Math.min(CAMPAIGN.health.max,s.health??CAMPAIGN.health.max);
    const fade=document.getElementById('titan-fade');if(fade)fade.style.opacity='0';
    if(ape&&s.ape)ape.restore(s.ape,CAMPAIGN.respawnClear.hold);
    const p=ctx.player();ctx.setGrace(CAMPAIGN.grace);ctx.titans.calm?.({x:p.x,y:p.y,z:p.z},CAMPAIGN.respawnClear);
    placeMarkers();return true;
  }
  function villagerMesh(){
    const g=new THREE.Group(),cloth=new THREE.MeshStandardMaterial({color:0x7a4f8c,roughness:.8}),skin=new THREE.MeshStandardMaterial({color:0xe0b394,roughness:.7});
    const body=new THREE.Mesh(new THREE.CylinderGeometry(.22,.28,1.2,10),cloth);body.position.y=.6;g.add(body);
    const head=new THREE.Mesh(new THREE.SphereGeometry(.19,12,10),skin);head.position.y=1.42;g.add(head);g.traverse(o=>{if(o.isMesh)o.castShadow=true;});g.name='rescue villager';return g;
  }
  // Mission beacon: a thin light column; nothing marks boulder landings.
  function beacon(stars){
    const g=new THREE.Group(),material=new THREE.MeshBasicMaterial({color:0xf2c14e,transparent:true,opacity:.35,depthWrite:false});
    material.color.setRGB(.95,.76,.31,THREE.SRGBColorSpace);
    const beam=new THREE.Mesh(new THREE.CylinderGeometry(.08,.08,6,8,1,true),material);beam.position.y=3;g.add(beam);
    for(let i=0;i<stars;i++){const s=new THREE.Mesh(new THREE.OctahedronGeometry(.12),material);s.position.set((i-(stars-1)/2)*.3,1.9,0);g.add(s);}
    return g;
  }
  function missionEvent(type,data){
    if(type==='complete'){audio('collect');toast(`任务完成：${data.name} ${STAR.repeat(data.stars)}`);markers.find(m=>m.userData.mission===data.id)?.removeFromParent();}
    else if(type==='rescue-follow')toast(`${data.name}跟着你 · 护送到任意安全屋`);
    else if(type==='rescue-lost')toast('镇民跟丢了，回去找她');
    else if(type==='finish')showResults(data);
  }
  function start(){
    if(!active)return;
    const home=run.safehouses[0];if(home)ctx.teleport(home.spawn);
    if(level.gearAutoEquip)ctx.gear.equip();
    toast('夺回城墙 · 7 个任务任选 · 空格对准可钩表面发钩、按住拉近、松开飞出 · 3 条命 · H 查看按键');
  }
  function onImpact(point,radius,boulder){
    ctx.smash(point,radius);
    const p=ctx.player(),d=Math.hypot(point.x-p.x,point.y-(p.y+.9),point.z-p.z);
    atmosphere?.dust(point,1);audio('boulder');ctx.shake(Math.max(0,1-d/30)*.45);
    ctx.noise(point,CAMPAIGN.noise.boulder,'boulder');
    const hurt=boulderDamage(d);
    if(!hurt||ctx.invulnerable()||status.dying>0||boulderImpactShielded(world,point,p,d))return;
    if(hurt==='kill'){die('boulder');return;}
    if(!splashLands(status.splash,boulder?.volley,status.time))return;
    damage(hurt,'boulder');
    const h=CAMPAIGN.health,dx=p.x-point.x,dz=p.z-point.z,l=Math.hypot(dx,dz)||1;
    status.knock={t:h.knock,vx:dx/l*h.knockSpeed,vz:dz/l*h.knockSpeed};p.vy=Math.max(p.vy,h.knockUp);p.grounded=false;
  }
  function damage(amount,reason){
    status.health-=amount;status.hurtAgo=0;status.damageTaken+=amount;
    const flash=document.getElementById('damage-flash');if(flash){flash.style.opacity='1';setTimeout(()=>flash.style.opacity='0',300);}
    if(status.health<=0){status.health=0;die(reason);}else toast(`被飞石擦伤 · 生命 ${Math.round(status.health)}`);
  }
  // Ground-giant grab: a short window to slash the gripping arm, else death.
  function grabbed(titan){
    if(!active||status.dying>0||status.grab||!run||run.result)return;
    const p=ctx.player();status.grab={titan,clock:CAMPAIGN.health.grabWindow,at:{x:p.x,y:p.y,z:p.z}};
    audio('hit');toast('被巨人抓住了！左键双刃斩手挣脱');
    return CAMPAIGN.health.grabWindow;
  }
  function slash(hit,eye,dir){
    const g=status.grab;if(!g)return false;
    const struck=hit&&hit.id===g.titan.id&&/^arm/.test(hit.part??'');
    if(!struck&&!(eye&&dir&&armInReach(g.titan.shape,eye,dir)))return false;
    status.grab=null;status.escapes++;ctx.setGrace(CAMPAIGN.health.grabGrace);g.titan.cooldown=Math.max(g.titan.cooldown??0,CAMPAIGN.health.escapeCooldown);toast('斩中巨手 · 挣脱了！');return true;
  }
  function die(reason){
    if(!active||status.dying>0||!run||run.result)return;
    status.dying=CAMPAIGN.respawnFade;status.deathReason=reason;audio('explosion');
    const fade=document.getElementById('titan-fade');if(fade){fade.hidden=false;fade.style.opacity='1';}
  }
  function finishDeath(){
    const p=ctx.player(),outcome=run.die(status.deathReason,p);
    const fade=document.getElementById('titan-fade');if(fade)fade.style.opacity='0';
    if(!outcome)return;
    if(outcome.failed){toast('命数用尽 · 行动失败');return;}
    heal();ctx.teleport(outcome.safehouse.spawn);ctx.setGrace(CAMPAIGN.grace);ctx.titans.calm?.(outcome.safehouse.spawn,CAMPAIGN.respawnClear);ape?.calm(CAMPAIGN.respawnClear.hold);
    const why={grab:'被巨人抓住',boulder:'被巨石砸中',fall:'高处坠落'}[status.deathReason]??'倒下';
    toast(`${why} · 剩余 ${run.lives} 条命 · 已回到${outcome.safehouse.name}`);
  }
  // Space pressed on this map: hook if the crosshair is hookable, else jump.
  function spacePress(eye,aim){
    if(!active||!ctx.gear.equipped)return 'jump';
    const result=ctx.gear.press(ctx.player(),ctx.yaw(),eye,aim);
    if(result==='hook')ctx.noise(ctx.player(),CAMPAIGN.noise.fire,'hook');
    return result;
  }
  function updateCrosshair(eye,aim){
    if(!active)return;
    const q=ctx.gear.equipped?ctx.gear.aimQuery(eye,aim):{hookable:false,distance:null};status.hook=q;
    const cross=$('crosshair'),label=$('hook-range');
    cross.classList.toggle('hookable',q.hookable);cross.classList.toggle('unhookable',!q.hookable);
    label.hidden=false;label.classList.toggle('hookable',q.hookable);
    label.style.left=cross.style.left||'50%';label.style.top=`calc(${cross.style.top||'50%'} - 32px)`;
    label.textContent=q.hookable?`钩 ${Math.round(q.distance)} m`:q.distance!=null?`跳 · ${Math.round(q.distance)} m 超出射程`:'跳';
  }
  const tmp=new THREE.Vector3();
  function update(dt){
    if(!active||!run)return;
    const p=ctx.player();status.time+=dt;
    if(status.dying>0){status.dying-=dt;p.vx=p.vy=p.vz=0;if(status.dying<=0)finishDeath();}
    const h=CAMPAIGN.health;
    if(status.grab&&status.dying<=0){
      const g=status.grab;g.clock-=dt;Object.assign(p,{x:g.at.x,y:g.at.y,z:g.at.z,vx:0,vy:0,vz:0});
      if(g.clock<=0){status.grab=null;die('grab');}
    }
    if(status.knock){
      const k=status.knock,nx=p.x+k.vx*dt,nz=p.z+k.vz*dt;k.t-=dt;
      if(!knockBlocked(world,ctx.solidAt,nx,p.y,nz,p.colliderHeight)){p.x=nx;p.z=nz;}
      p.vx=p.vz=0;if(k.t<=0)status.knock=null;
    }
    status.hurtAgo+=dt;
    if(status.hurtAgo>=h.regenDelay&&status.dying<=0)status.health=Math.min(h.max,status.health+h.regenRate*dt);
    // Fall death: big drop and hard vertical impact.
    if(!p.grounded){status.airPeak=Math.max(status.airPeak,p.y);status.lastVy=p.vy;}
    else{if(!status.wasGrounded&&status.airPeak-p.y>=CAMPAIGN.fallHeight&&status.lastVy<-CAMPAIGN.fallSpeed&&!ctx.invulnerable())die('fall');else if(!status.wasGrounded&&status.lastVy<-8)ctx.noise(p,CAMPAIGN.noise.land,'land');status.airPeak=p.y;}
    status.wasGrounded=p.grounded;
    ape?.update(dt,{x:p.x,y:p.y,z:p.z,vx:p.vx,vy:p.vy,vz:p.vz,flying:Boolean(ctx.gear?.flying),down:status.dying>0||Boolean(run.result)||Boolean(status.grab),invulnerable:ctx.invulnerable()});
    run.update(dt,{player:p,standAt,groundAt:(x,z,y)=>{const hit=world.raycast({x,y:(y??p.y)+1.2,z},{x:0,y:-1,z:0},6);return hit?hit.point.y:(y??p.y);},solidAt:ctx.solidAt});
    if(run.rescue){rescueMesh.visible=run.rescue.state!=='saved';rescueMesh.position.set(run.rescue.x,run.rescue.y,run.rescue.z);}
    for(const m of markers)m.rotation.y+=dt;
    // Boulder whoosh once per boulder when it comes close.
    for(const b of ape?.boulders??[]){
      const d=Math.hypot(b.pos.x-p.x,b.pos.y-(p.y+.9),b.pos.z-p.z);
      if(!status.whooshed.has(b.id)&&d<CAMPAIGN.whooshRange){status.whooshed.add(b.id);audio('whoosh');}
      if(d<APE.boulder.crush&&Math.hypot(b.vel.x,b.vel.y,b.vel.z)>=APE.boulder.crushSpeed&&!ctx.invulnerable())die('boulder');
    }
    // Footstep tremors of nearby walking giants.
    const giants=ctx.titans.titans??[];
    for(const t of giants){
      if(t.state==='down'||!(t.speed>.3))continue;const d=Math.hypot(t.x-p.x,t.z-p.z);if(d>CAMPAIGN.stompRange*2.5)continue;
      status.stompClock[t.id]=(status.stompClock[t.id]??0)-dt*t.speed/(t.height*.35);
      if(status.stompClock[t.id]<=0){status.stompClock[t.id]=1;if(d<CAMPAIGN.stompRange){audio('stomp');ctx.shake(Math.max(0,1-d/CAMPAIGN.stompRange)*.08);}}
    }
    const watching=t=>t.target==='player'||(!t.target&&t.seenId==='player');
    const observers=giants.filter(t=>t.state!=='down'&&watching(t)).map(t=>({x:t.x,y:t.y+t.height*.8,z:t.z,alert:t.alert??(t.state==='chase'?1:0),kind:'titan'}));
    const a=ape?.ape,apeInfo=a&&a.state!=='repelled'?{x:a.x,y:a.y+a.height*.85,z:a.z,meter:a.meter,aiming:['lift','throw'].includes(a.state)}:null;
    const steam=giants.filter(t=>t.state!=='down').map(t=>({point:t.model.bonePoint('DEF-spine_003',new THREE.Vector3())}));
    const chasing=giants.some(t=>t.state==='chase'&&t.target==='player')||Boolean(a?.engaged);
    const cues=atmosphere.update(dt,{observers,ape:apeInfo,titans:steam,boulders:ape?.boulders.length??0,chasing,player:p});
    if(cues.heartbeat)audio('heartbeat');if(cues.bell)audio('bell');if(cues.alarm&&performanceNow()-status.lastSpot>4000){status.lastSpot=performanceNow();audio('alarm');}
    updateMusic(atmosphere.state.chase);
  }
  const performanceNow=()=>globalThis.performance?.now()??0;
  function updateMusic(level){
    const ac=ctx.audioContext?.();if(!ac)return;
    try{
      if(!status.music){const osc=ac.createOscillator(),filter=ac.createBiquadFilter(),gain=ac.createGain(),lfo=ac.createOscillator(),lfoGain=ac.createGain();osc.type='sawtooth';osc.frequency.value=55;filter.type='lowpass';filter.frequency.value=240;gain.gain.value=0;lfo.frequency.value=2;lfoGain.gain.value=0;lfo.connect(lfoGain);lfoGain.connect(gain.gain);osc.connect(filter);filter.connect(gain);gain.connect(ac.destination);osc.start();lfo.start();status.music={osc,gain,lfoGain};}
      const v=Math.max(0,Math.min(1,level))*.05;status.music.gain.gain.setTargetAtTime(v,ac.currentTime,.4);status.music.lfoGain.gain.setTargetAtTime(v*.6,ac.currentTime,.4);
    }catch{}
  }
  function interaction(player){return active&&run&&!run.result?run.interactionAt(player):null;}
  function interact(target){
    if(!target)return false;
    const done=run.interact(target);
    if(target.type==='mission'&&target.mission.id==='supply')ctx.gear.refill();
    if(target.type==='mission'&&target.mission.id==='signal'){atmosphere.signal(target.mission.at);ape?.alertTo(target.mission.at,.5);audio('ignite');toast('信号烟已点燃 · 巨猿转向钟楼！');}
    return done;
  }
  function titanEvent(type){if(!active||!run)return;if(type==='down')run.titanDown();}
  function updateHud(){
    if(!active||!run)return;
    const p=ctx.player(),panel=$('titan-panel');panel.hidden=false;
    const hearts='♥'.repeat(run.lives)+'♡'.repeat(Math.max(0,3-run.lives)),min=Math.floor(run.seconds/60),sec=Math.floor(run.seconds%60);
    panel.innerHTML=`<h4><span>夺回城墙 · ${run.completed}/7</span><span>${hearts}</span></h4><div class="hp"><i style="width:${(status.health/CAMPAIGN.health.max*100).toFixed(1)}%"></i><span>生命 ${Math.ceil(status.health)}/${CAMPAIGN.health.max}</span></div>`+
      (status.grab?`<div class="grab">被抓住！${status.grab.clock.toFixed(1)} s 内左键斩手挣脱</div>`:'')+
      `<small>用时 ${min}:${String(sec).padStart(2,'0')} · 死亡 ${run.deaths} · 巨猿发现 ${Math.round((ape?.ape?.meter??0)*100)}%</small>`+
      run.missions.map(m=>{const d=m.kind==='hunt'?`${run.downs}/${m.count} 击倒`:m.kind==='seal'?`占据 ${Math.round(run.sealRatio*100)}%`:`${Math.round(Math.hypot(m.at.x-p.x,m.at.z-p.z))} m`;return `<div class="row ${m.status}"><span><span class="stars">${STAR.repeat(m.stars)}</span> ${m.name}</span><small>${m.status==='done'?'✓':m.danger+' · '+d}</small></div>`;}).join('');
  }
  function drawMap(c,px,pz){
    if(!active||!run)return;
    for(const s of run.safehouses){c.fillStyle='#89dfad';c.fillRect(px(s.x)-4,pz(s.z)-4,8,8);}
    c.font='bold 9px Arial';
    for(const m of run.missions){if(m.status==='done'||m.kind==='hunt')continue;c.fillStyle=['#e8ce76','#f0a85a','#ef7a4a','#e2513f','#c0392b'][m.stars-1];c.beginPath();c.arc(px(m.at.x),pz(m.at.z),3.5,0,Math.PI*2);c.fill();c.fillText(String(m.stars),px(m.at.x)+4,pz(m.at.z)-3);}
    const a=ape?.ape;if(a&&a.state!=='repelled'){c.fillStyle=a.engaged?'#ff3b2f':'#b07a5a';c.beginPath();c.arc(px(a.x),pz(a.z),4.5,0,Math.PI*2);c.fill();}
    if(run.rescue&&run.rescue.state!=='saved'){c.fillStyle='#c79be0';c.fillRect(px(run.rescue.x)-2.5,pz(run.rescue.z)-2.5,5,5);}
  }
  function showResults(r){
    status.results=r;ctx.onFinish?.(r);
  }
  function finishEarly(){return run?.finish('early');}
  function snapshot(){return active?{run:run?.snapshot()??null,ape:ape?.snapshot()??null,atmosphere:atmosphere?.snapshot()??null,hook:status.hook,dying:status.dying>0,results:status.results,health:+status.health.toFixed(1),damageTaken:+status.damageTaken.toFixed(1),grabbed:status.grab?+status.grab.clock.toFixed(2):null,escapes:status.escapes,knocked:Boolean(status.knock)}:null;}
  return {get active(){return active;},get dying(){return status.dying>0;},get health(){return status.health;},get grabbedBy(){return status.grab?.titan??null;},grabbed,slash,saveState,loadState,get ape(){return ape;},get run(){return run;},get atmosphere(){return atmosphere;},reset,start,update,die,spacePress,updateCrosshair,interaction,interact,titanEvent,updateHud,drawMap,finishEarly,snapshot};
}
