import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';
import {createTitanTown} from '../src/titan-town.js';
import {createWallApe,APE} from '../src/wall-ape.js';
import {CAMPAIGN,boulderDamage,knockBlocked,armInReach,splashLands} from '../src/titan-campaign.js';
import {createAtmosphere} from '../src/titan-atmosphere.js';
import {createMissionRun} from '../src/titan-missions.js';
import {createTitanSystem,raycastTitanShapes} from '../src/titan-ai.js';

const level=createTitanTown(),world=level.world;
const makeApe=()=>createWallApe(new THREE.Scene(),world,{...level.ape},{smash:()=>{},event:()=>{}});
const H=CAMPAIGN.health;

test('boulder damage: direct hit kills, splash falls 70 -> 35 from 1.8 to 5 m, nothing beyond',()=>{
 assert.equal(H.max,100);
 assert.equal(boulderDamage(0),'kill');assert.equal(boulderDamage(H.direct),'kill');
 assert.ok(Math.abs(boulderDamage(H.direct+1e-6)-H.near)<1e-3);
 assert.ok(Math.abs(boulderDamage(3.4)-52.5)<1e-6,'midpoint');
 assert.equal(boulderDamage(H.splash),H.far);assert.equal(boulderDamage(H.splash+.01),0);
 assert.deepEqual([H.direct,H.splash,H.near,H.far,H.knock,H.regenDelay,H.grabWindow],[1.8,5,70,35,.6,10,1.2]);
 assert.ok(2*H.far<H.max&&2*H.near>H.max,'two near splashes kill, two far splashes do not');
});

test('knockback stops at the wall face instead of wedging the player in the town wall',()=>{
 const solid=(x,y,z)=>Boolean(world.getId(Math.floor(x/.1),Math.floor(y/.1),Math.floor(z/.1)));
 const p={x:-8,y:.3,z:-45.5};assert.equal(world.collides(p.x,p.y,p.z,1.82,.38),false);
 for(let i=0;i<60;i++){const nz=p.z-.04;if(!knockBlocked(world,solid,p.x,p.y,nz))p.z=nz;}
 assert.ok(p.z<-46,'knocked toward the wall');
 assert.equal(world.collides(p.x,p.y,p.z,1.82,.38),false,`player at z ${p.z.toFixed(2)} is not inside the wall`);
});

test('grab escape: a swing within 25 degrees of the gripping arm and 4.5 m counts, other aims do not',()=>{
 const shape={capsules:[{part:'torso',start:{x:0,y:2,z:-3},end:{x:0,y:6,z:-3},radius:1.2},{part:'armR',start:{x:1,y:5,z:-3},end:{x:.3,y:1.6,z:-1.2},radius:.35}]};
 const eye={x:0,y:1.6,z:0},to=(x,y,z)=>({x:x-eye.x,y:y-eye.y,z:z-eye.z});
 assert.equal(armInReach(shape,eye,to(.3,1.6,-1.2)),true,'looking at the hand');
 assert.equal(armInReach(shape,eye,to(.8,1.6,-1.2)),true,'hand about 20 degrees off');
 assert.equal(armInReach(shape,eye,to(1.2,1.6,-1.2)),false,'nearest arm point about 31 degrees off');
 assert.equal(armInReach(shape,eye,to(0,1.6,1)),false,'looking away');
 assert.equal(armInReach(shape,eye,to(-3,1.6,-.5)),false,'looking far left');
 const far={capsules:[{part:'armL',start:{x:0,y:1.6,z:-9},end:{x:0,y:1.6,z:-7},radius:.35}]};
 assert.equal(armInReach(far,eye,to(0,1.6,-8)),false,'arm beyond 4.5 m');
 assert.deepEqual([H.escapeCone,H.escapeReach],[25,4.5]);
});

test('splash: 0.8 s hit guard and one damaging splash per volley; a new volley can hurt again',()=>{
 assert.deepEqual([H.hitGuard,H.splashPerVolley],[.8,1]);
 const book={};
 assert.equal(splashLands(book,1,10),true,'first splash of volley 1');
 assert.equal(splashLands(book,1,10.3),false,'second impact of the same boulder inside the guard');
 assert.equal(splashLands(book,1,12.4),false,'next boulder of the same volley');
 assert.equal(splashLands(book,2,20),true,'first splash of the next volley');
 assert.equal(splashLands(book,3,20.5),false,'any splash inside the guard');
 assert.equal(splashLands({},undefined,1),true,'boulders without a volley id still hurt');
});

test('wind-up cue: the eye icon blinks for the wind-up and no landing marker exists',()=>{
 const atmo=createAtmosphere({document:null});atmo.windup(APE.firstLift);
 assert.equal(atmo.snapshot().windup,APE.firstLift);atmo.update(.5,{});assert.equal(atmo.snapshot().windup,.5);
 atmo.update(.6,{});assert.equal(atmo.snapshot().windup,0);assert.equal(atmo.snapshot().windups,1);assert.equal(atmo.snapshot().landingMarkers,0);
 assert.ok(APE.firstLift>=.8,'the first wind-up is long enough to react to');
});

test('arcades: every placed arcade hides a standing player from the ape and leaves walking room under it',()=>{
 const ape=makeApe(),list=level.sceneDefinition.instances.filter(i=>/^arcade-/.test(i.id));
 assert.ok(list.length>=12,`${list.length} arcades placed`);
 for(const a of list){const [x,y,z]=a.position;
  assert.equal(world.collides(x,y,z,1.82,.38),false,`${a.id}: room for the player under the roof`);
  assert.equal(ape.concealed({x,y:y+1.2,z}),true,`${a.id}: overhead cover hides the player`);
  assert.equal(world.raycast({x,y:y+1.2,z:z+2.5},{x:0,y:1,z:0},8),null,`${a.id}: nothing overhead just outside the roof`);}
});

test('quicksave: mission progress, lives and the ape come back exactly; a finished result is cleared',()=>{
 const run=createMissionRun(level.missions);run.complete('supply');run.update(12,{player:{x:0,y:.3,z:0}});
 const saved=run.save();run.die('boulder',{x:0,z:0});run.complete('documents');run.die('boulder',{x:0,z:0});run.die('boulder',{x:0,z:0});
 assert.equal(run.result.failed,true);
 assert.equal(run.restore(saved),true);
 assert.equal(run.result,null);assert.deepEqual([run.lives,run.deaths,run.completed],[3,0,1]);
 assert.equal(run.mission('documents').status,'todo');assert.equal(run.mission('supply').status,'done');assert.ok(Math.abs(run.seconds-12)<1e-9);
 assert.deepEqual(JSON.parse(JSON.stringify(saved)),saved,'plain data for persistent saves');
 const ape=makeApe(),a=ape.ape;a.s=42;a.health=120;const s=ape.save();a.s=5;a.health=300;a.meter=.9;
 ape.restore(s,8);assert.deepEqual([a.s,a.health,a.meter,a.state,a.blind],[42,120,0,'patrol',8]);
 a.state='repelled';a.downTime=10;const down=ape.save();ape.restore({...s,repelled:false});assert.equal(a.state,'patrol');
 ape.restore(down);assert.equal(a.state,'repelled');assert.equal(a.downTime,10);
});

test('ape rhythm: volley of 3, 2.4 s apart, 4.5 s rest',()=>{
 assert.deepEqual(APE.volley,[3,3]);assert.equal(APE.volleyGap,2.4);assert.deepEqual(APE.rest,[4.5,4.5]);
});

function spread(ape,player,n=400){let max=0,sum=0;for(let i=0;i<n;i++){const s=ape.aimPoint(player).spread;max=Math.max(max,s);sum+=s;}return {max,mean:sum/n};}
test('aim error grows with distance (steeper past 30 m) and with player speed; hook flight is worst',()=>{
 const ape=makeApe(),a=ape.ape,at=(d,vx=0,flying=false)=>({x:a.x+d,y:.3,z:a.z,vx,vy:0,vz:0,flying});
 const s20=spread(ape,at(20)).max,s30=spread(ape,at(30)).max,s60=spread(ape,at(60)).max;
 assert.ok(s20<s30&&s30<s60);
 assert.ok((s60-s30)/30>2*(s30-s20)/10,'error per metre is much larger beyond 30 m');
 const still=spread(ape,at(30)).mean,sprint=spread(ape,at(30,7)).mean,fly=spread(ape,at(30,15,true)).mean;
 assert.ok(sprint>2*still&&fly>2*sprint,`still ${still.toFixed(2)} sprint ${sprint.toFixed(2)} fly ${fly.toFixed(2)}`);
 assert.ok(still<APE.spreadBase+30*APE.spreadPerMetre+1e-6,'standing still at 30 m: under 1 m');
 const lead=ape.aimPoint(at(30,6)).lead;assert.ok(Math.abs(lead.x-6*ape.aimPoint(at(30,6)).flight)<1e-9,'straight constant motion is led exactly');
});

const chestAt=(x,z)=>{for(let y=0;y<4;y+=.1)if(!world.getId(Math.floor(x/.1),Math.floor(y/.1),Math.floor(z/.1))&&!world.getId(Math.floor(x/.1),Math.floor((y+1.2)/.1),Math.floor(z/.1)))return {x,y:y+1.2,z};return null;};
test('ape cannot see the player indoors, under eaves or in building shadow; open sunlit street is visible',()=>{
 const ape=makeApe(),home=level.missions.safehouses[0].spawn;
 assert.equal(ape.concealed({x:home.x,y:home.y+1.2,z:home.z}),true,'inside the safehouse');
 let open=0,hidden=0;
 for(let x=-40;x<=40;x+=2)for(let z=-40;z<=40;z+=2){const c=chestAt(x,z);if(!c)continue;if(ape.concealed(c))hidden++;else open++;}
 const ratio=hidden/(open+hidden);
 assert.ok(open>100,'plenty of exposed street where standing still is lethal');
 assert.ok(ratio>.2&&ratio<.8,`cover and shadow are a real but partial refuge: ${(ratio*100).toFixed(0)}% concealed`);
 const roof=world.raycast({x:home.x,y:home.y+1.2,z:home.z},{x:0,y:1,z:0},APE.coverAbove);assert.ok(roof,'safehouse has a roof overhead');
});

test('detection: needs continuous sight, slows past 40 m, drains faster than it fills; a still player is hit inside 8 s',()=>{
 assert.equal(APE.gainNear,40);assert.ok(APE.decay>=.45&&APE.decay<=.6);
 const near=APE.gain*1*.8,far=APE.gain*Math.max(APE.gainFar,1-(1-APE.gainFar)*(80-APE.gainNear)/(APE.range-APE.gainNear))*.8;
 assert.ok(APE.decay>near,'a broken sight line drains the meter faster than a standing player fills it');
 assert.ok(1/near<4.5,`still player within 40 m spotted in ${(1/near).toFixed(1)} s`);
 const land=1/near+APE.firstLift+APE.release+APE.flightBase+40/APE.range*APE.flightPerRange;
 assert.ok(land<7,`first boulder lands ${land.toFixed(1)} s after a still player at 40 m is first seen`);
 assert.ok(APE.spreadBase+40*APE.spreadPerMetre+Math.max(0,40-APE.spreadFar)*APE.spreadPerFarMetre<H.direct,'scatter on a still player at 40 m stays inside the direct-hit radius');
 assert.ok(far<near*.7,'gain at 80 m is clearly slower');
});

test('respawn blinds the ape for the safehouse hold: no meter while visible, then detection resumes',()=>{
 const ape=makeApe(),a=ape.ape,player={x:0,y:.32,z:-6.5,vx:5,vy:0,vz:0},hold=CAMPAIGN.respawnClear.hold;
 let peak=0,seen=false;for(let t=0;t<30&&!seen;t+=.05){ape.update(.05,player);seen=a.meter>.2;}
 assert.ok(seen,'this street spot is visible to the ape');
 ape.calm(hold);
 for(let t=0;t<hold-.2;t+=.05){ape.update(.05,player);peak=Math.max(peak,a.meter);}
 assert.equal(peak,0,'no detection during the hold');
 for(let t=0;t<20&&a.meter<=.05;t+=.05)ape.update(.05,player);
 assert.ok(a.meter>.05,'detection resumes after the hold');
});
test('respawn clears the safehouse: nearby giants walk off and hold their grabs',()=>{
 const titans=createTitanSystem(null,createTitanTown().world,{...level.titans,count:2,climbSpawns:[]}),[a,b]=titans.titans;
 for(let i=0;i<300&&titans.titans.some(t=>t.state==='enter');i++)titans.update(.1,[]);
 for(let i=0;i<40&&titans.titans.some(t=>t.attack);i++)titans.update(.1,[]);
 const spawn=level.missions.safehouses[0].spawn,{radius,hold}=CAMPAIGN.respawnClear;
 Object.assign(a,{x:spawn.x+3,z:spawn.z,state:'chase',target:'player'});Object.assign(b,{x:spawn.x+radius+30,z:spawn.z,state:'wander'});const bGoal={...b.goal};
 titans.calm(spawn,CAMPAIGN.respawnClear);
 assert.equal(a.state,'wander');assert.equal(a.target,null);assert.ok(a.cooldown>=hold,'no grab during the hold');
 assert.ok(Math.hypot(a.goal.x-spawn.x,a.goal.z-spawn.z)>=radius,'walks to a goal outside the cleared radius');
 assert.deepEqual(b.goal,bGoal,'far giants keep their plans');assert.ok(b.cooldown<hold);
});
test('a blade ray from inside the torso (held player) reaches the gripping arm',()=>{
 const V=(x,y,z)=>new THREE.Vector3(x,y,z),shape={capsules:[{part:'torso',start:V(0,4,0),end:V(0,8,0),radius:1.6},{part:'armL',start:V(1.5,7,0),end:V(3.5,5,0),radius:.5}],nape:{point:V(0,9,-.8),radius:.4}};
 const hit=raycastTitanShapes([{id:'g',shape}],V(.8,6,0),V(1,0,0),4.5);
 assert.equal(hit?.part,'armL');
 assert.equal(raycastTitanShapes([{id:'g',shape}],V(-3,6,0),V(1,0,0),4.5)?.part,'torso','from outside the torso is still hit first');
});
test('a grab holds its reach through the escape window, so the gripping arm stays in blade range',()=>{
 let grabs=0;const titans=createTitanSystem(null,createTitanTown().world,{...level.titans,count:1,climbSpawns:[]},{grab:()=>{grabs++;return CAMPAIGN.health.grabWindow;}}),[t]=titans.titans;
 for(let i=0;i<300&&t.state==='enter';i++)titans.update(.1,[]);
 for(let i=0;i<40&&t.attack;i++)titans.update(.1,[]);
 const R=t.height*.45,target={id:'player',kind:'player',x:t.x+Math.sin(t.yaw)*R,y:t.y,z:t.z+Math.cos(t.yaw)*R};
 t.attack={kind:'grab',point:{x:target.x,y:target.y+1,z:target.z},age:0,impact:.5,length:1,done:false,target:'player'};
 for(let i=0;i<5;i++)titans.update(.1,[target]);
 assert.equal(grabs,1);
 for(let i=0;i<10;i++)titans.update(.1,[target]);
 assert.equal(t.attack?.kind,'grab','still holding after the attack clip would have ended');assert.ok(Math.abs(t.attack.age-t.attack.impact)<1e-9,'arms stay at full reach');
 const eye=new THREE.Vector3(target.x,target.y+1.6,target.z),seg=new THREE.Line3(),q=new THREE.Vector3();
 const reach=Math.min(...t.shape.capsules.filter(c=>/^arm/.test(c.part)).map(c=>{seg.set(c.start,c.end);seg.closestPointToPoint(eye,true,q);return q.distanceTo(eye)-c.radius;}));
 assert.ok(reach<4.5,`gripping arm within blade reach of the held eye: ${reach.toFixed(2)} m`);
 for(let i=0;i<10;i++)titans.update(.1,[target]);
 assert.equal(t.attack,null,'lets go once the hold runs out');
});
