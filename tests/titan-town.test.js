import test from 'node:test';
import assert from 'node:assert/strict';
import {createTitanTown} from '../src/titan-town.js';
import {createTitanSystem} from '../src/titan-ai.js';
import {cutStaticForTool} from '../src/engine/simulation/tool-policy.js';
import {stepPlayer} from '../src/player.js';
import {MAPS} from '../src/map-catalog.js';
import {TITAN_VARIANTS} from '../src/titan-model.js';
import * as THREE from '../vendor/three.module.js';
import fs from 'node:fs';

const level=createTitanTown(),world=level.world,access=level.sceneDefinition.access;
const at=(w,x,y,z)=>w.getId(Math.floor(x*10),Math.floor(y*10),Math.floor(z*10));
const houses=Object.entries(access).map(([id,a])=>({id,...a}));
const INNER=level.sceneDefinition.inner.maxX;

test('map is registered and the scene keeps third-party provenance',()=>{
 assert.ok(MAPS.some(m=>m.id==='titan-town-v1'&&m.sandboxOnly));
 assert.equal(level.mapId,'titan-town-v1');
 assert.ok(Math.abs(INNER-47)<.3,'inner wall face at about ±47 m: '+INNER);
 assert.equal(houses.length,32,'every house, safehouse and public building is enterable');
 for(const prefab of ['barracks','supply-depot','church','granary','stable','safehouse'])assert.ok(houses.some(h=>h.prefab===prefab),prefab);
 for(const source of level.sceneDefinition.sources)assert.match(source.license,/CC0/);
 assert.equal(world.collides(level.spawn.x,level.spawn.y,level.spawn.z),false);
 for(const p of Object.values(level.points))if(p.y<1)assert.equal(world.collides(p.x,p.y,p.z),false,JSON.stringify(p));
});

test('every enterable building has a foundation, real walls and room air on each storey',()=>{
 for(const house of houses){
  const [x,y,z]=house.storeys[0].point;
  assert.ok(at(world,x,y-.15,z),house.id+' foundation');
  assert.equal(at(world,x,y+1.2,z),0,house.id+' ground-floor room air');
  // Doors and windows open some probes, so each side tries several rays.
  let walls=0;
  for(const [dx,dz]of [[1,0],[-1,0],[0,1],[0,-1]]){
   let solid=false;
   for(const h of [.5,1.3,2])for(const s of [-1.2,0,1.2]){
    const hit=world.raycast({x:x+dz*s,y:y+h,z:z+dx*s},{x:dx,y:0,z:dz},14);if(!hit||hit.distance>9)continue;
    let n=0;while(n<8&&world.getId(hit.x+dx*n,hit.y,hit.z+dz*n))n++;if(n>=3)solid=true;
   }
   if(solid)walls++;
  }
  assert.equal(walls,4,`${house.id} has ${walls} solid walls of >= 3 cells`);
  for(const s of house.storeys.slice(1).filter(s=>s.reach==='stairs')){
   const [sx,sy,sz]=s.point;assert.ok(at(world,sx,sy-.05,sz),`${house.id} floor slab at ${sy}`);assert.equal(at(world,sx,sy+1.2,sz),0,`${house.id} room air at ${sy}`);
  }
 }
});

test('town wall is thick on all four sides and broken at the south gate',()=>{
 const e=INNER-3;
 for(const [x,z,dx,dz]of [[10,-e,0,-1],[e,10,1,0],[-e,-10,-1,0],[20,e,0,1]]){
  const hit=world.raycast({x,y:4,z},{x:dx,y:0,z:dz},6);assert.ok(hit,`wall at ${x},${z}`);
  let n=0;while(n<10&&world.getId(hit.x+dx*n,hit.y,hit.z+dz*n))n++;assert.ok(n>=5,`wall ${x},${z} thickness ${n}`);
 }
 for(const y of [1,4,7])assert.equal(at(world,0,y,INNER+1.9),0,'breach is open at '+y);
 const p={x:0,y:.32,z:INNER-6,vx:0,vy:0,vz:0,grounded:true};
 for(let i=0;i<300;i++)stepPlayer(p,world,{forward:-1},0,1/60);
 assert.ok(p.z>INNER+4,'player walks out through the breach: '+p.z.toFixed(2));
});

test('cuts are isolated per instance and repeat cleanly on the same wall',()=>{
 const damaged=createTitanTown().world,[a,b]=houses.filter(h=>h.prefab==='row-a');
 // Ground-storey rooms hold stairs and furniture; aim at a wall of soft layers
 // (the hammer does not cut brick or stone) at least 4 cells thick.
 const wallRay=(w,[x,y,z])=>{for(const d of [{x:1,y:0,z:0},{x:-1,y:0,z:0},{x:0,y:0,z:1},{x:0,y:0,z:-1}]){const h=w.raycast({x,y:y+1.3,z},d,12);if(!h||h.mat!=='plaster')continue;let run=0;while(run<8&&w.getId(h.x+d.x*run,h.y,h.z+d.z*run))run++;if(run>=4)return {hit:h,d};}return null;};
 const [ax,ay,az]=a.storeys[0].point,{hit,d}=wallRay(damaged,a.storeys[0].point),point={x:hit.point.x+d.x*.15,y:ay+1.3,z:hit.point.z+d.z*.15};
 const first=cutStaticForTool(damaged,point,'hammer'),second=cutStaticForTool(damaged,{...point,x:point.x+d.z*.4,z:point.z+d.x*.4},'hammer');
 assert.ok(first.length>0);assert.ok(second.length>0,'second blow on the same wall still removes cells');
 const mirror=wallRay(world,b.storeys[0].point).hit;
 assert.ok(damaged.getId(mirror.x,mirror.y,mirror.z),'same prefab elsewhere keeps its wall');
 assert.ok(createTitanTown().world.getId(hit.x,hit.y,hit.z),'next level copy is intact');
});

test('a giant enters through the breach, smashes buildings, spots, chases and falls to a nape hit',()=>{
 const w=createTitanTown().world,smashes=[],grabs=[];
 const titans=createTitanSystem(null,w,{...level.titans,count:1},{smash:(point,radius)=>{smashes.push(point);cutStaticForTool(w,point,'explosion',{radius});},grab:target=>grabs.push(target.id)});
 const giant=titans.titans[0];assert.equal(giant.state,'enter');
 for(let i=0;i<300&&giant.state==='enter';i++)titans.update(.1,[]);
 assert.equal(giant.state,'wander');assert.ok(giant.z<INNER-2,'inside the wall');
 for(let i=0;i<900&&!smashes.length;i++)titans.update(.1,[]);
 assert.ok(smashes.length>0,'walking into buildings triggers smashes');
 for(let i=0;i<40&&giant.attack;i++)titans.update(.1,[]);
 const target={id:'npc',kind:'npc',x:giant.x+Math.sin(giant.yaw)*4,y:giant.y,z:giant.z+Math.cos(giant.yaw)*4,down:false,state:{route:[],speed:.5}};
 for(let i=0;i<30&&giant.state!=='chase';i++)titans.update(.1,[target]);
 assert.equal(giant.state,'chase');assert.equal(giant.target,'npc');
 assert.ok(target.state.fleeing,'nearby townsfolk flee');
 for(let i=0;i<120&&!grabs.length;i++)titans.update(.1,[target]);
 assert.deepEqual(grabs,['npc']);
 assert.equal(giant.lastImpact.kind,'grab');assert.ok(Math.abs(giant.lastImpact.clipTime-giant.model.contacts.PickUp_Table)<.06,'grab lands on the clip contact frame');
 target.down=true;for(let i=0;i<40&&giant.attack;i++)titans.update(.1,[target]);
 const nape=titans.napePoint(giant.id),behind={x:nape.x-Math.sin(giant.yaw)*6,y:nape.y,z:nape.z-Math.cos(giant.yaw)*6},dir={x:nape.x-behind.x,y:nape.y-behind.y,z:nape.z-behind.z};
 const hit=titans.raycast(behind,dir,20);assert.equal(hit?.part,'nape');
 titans.hit(hit,100);assert.equal(giant.state,'down');assert.equal(titans.raycast(behind,dir,20),null);
 for(let i=0;i<300;i++)titans.update(.1,[]);
 assert.ok(['enter','approach'].includes(giant.state),'giant respawns outside the wall');
 assert.ok(Math.abs(giant.x)>INNER||Math.abs(giant.z)>INNER);
});

test('titan rig keeps CC0 provenance, varies by variant and lands blows on clip contact frames',()=>{
  const rig=level.titans.rig;
  // The upstream source file is not redistributed; its URL and SHA-256 stay recorded.
  assert.equal(rig.source.license,'CC0 1.0');assert.match(rig.source.sha256,/^[0-9a-f]{64}$/);assert.match(rig.source.download,/^https:\/\/opengameart\.org\//);
 const w=createTitanTown().world,impacts=[];
 const titans=createTitanSystem(null,w,{...level.titans,count:5,climbSpawns:[]},{smash:(point,radius,t)=>{impacts.push({...t.lastImpact,id:t.id});cutStaticForTool(w,point,'explosion',{radius});}});
 assert.deepEqual(titans.titans.map(t=>t.model.variant.name),TITAN_VARIANTS.map(v=>v.name));
 assert.equal(new Set(titans.titans.map(t=>t.height)).size,5);
 for(const t of titans.titans){
  assert.equal(t.model.skeleton.bones.length,53);assert.ok(t.model.bones['DEF-head'].children.length>12,'face and hair ride the head bone');
  assert.equal(t.model.skeleton.boneInverses.flatMap(m=>m.elements).filter(Number.isFinite).length,53*16,'inverse bind matrices are complete');
  t.model.group.updateMatrixWorld(true);const pos=t.model.mesh.geometry.attributes.position,v=new THREE.Vector3(),box=new THREE.Box3();
  for(let k=0;k<pos.count;k+=5){v.fromBufferAttribute(pos,k);t.model.mesh.applyBoneTransform(k,v);box.expandByPoint(v.applyMatrix4(t.model.mesh.matrixWorld));}
  assert.ok(box.max.y-box.min.y>t.height*.85&&box.max.y-box.min.y<t.height*1.4,`${t.model.variant.name} skinned body spans its height`);
 }
 let looks=0;
 for(let i=0;i<2400&&impacts.filter(x=>x.clip!=='Idle_Loop'&&x.clip!=='Push_Loop').length<4;i++){titans.update(1/30,[]);for(const t of titans.titans)looks=Math.max(looks,Math.abs(t.look));}
 assert.ok(looks>.3,'giants turn their heads while wandering');
 assert.ok(new Set(impacts.map(x=>x.kind)).size>=2,'several attack kinds are used');
 for(const x of impacts){
  assert.ok(x.age>=x.impact&&x.age-x.impact<1/30+1e-6,'impact waits for the contact time');
  const giant=titans.titans.find(t=>t.id===x.id),contact=giant.model.contacts[x.clip];
  if(contact!==undefined)assert.ok(Math.abs(x.clipTime-contact)<.05,`${x.kind} hits on the ${x.clip} contact frame`);
 }
 const g=titans.titans.find(t=>!t.attack&&t.state!=='down');titans.hit({id:g.id,part:'torso'});
 assert.ok(g.stagger>0);titans.update(1/30,[]);assert.equal(g.model.current,'Hit_Chest');
});

test('a giant climbs the town wall, claws the crest and drops inside',()=>{
 const w=createTitanTown().world,claws=[];
 const titans=createTitanSystem(null,w,{...level.titans,count:2},{smash:(point,radius,t)=>{if(t.index===1&&t.state==='climb')claws.push(point);cutStaticForTool(w,point,'explosion',{radius});}});
 const g=titans.titans[1];assert.equal(g.state,'approach');assert.ok(Math.abs(g.x)>INNER||Math.abs(g.z)>INNER);
 const seen=new Set();for(let i=0;i<1500&&!(seen.has('drop')&&g.state==='wander');i++){titans.update(.1,[]);seen.add(g.state);}
 assert.deepEqual(['approach','climb','over','drop','wander'].filter(s=>seen.has(s)||g.state===s),['approach','climb','over','drop','wander']);
 assert.ok(claws.length>0&&claws.every(p=>p.y>8),'climbing claws break the crest');
 assert.ok(Math.abs(g.x)<INNER-.5&&Math.abs(g.z)<INNER-.5&&Math.abs(g.y-.3)<1e-6,'lands inside the wall');
});
