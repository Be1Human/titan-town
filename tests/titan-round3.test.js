import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';
import {createTitanTown} from '../src/titan-town.js';
import {createTitanSystem,VISION} from '../src/titan-ai.js';
import {cutStaticForTool} from '../src/engine/simulation/tool-policy.js';
import {stepPlayer} from '../src/player.js';
import {createGrappleGear} from '../src/grapple-gear.js';
import {farWallBoxes} from '../src/far-wall.js';
import {createWallApe,APE} from '../src/wall-ape.js';
import {VoxelWorld,ATTACKS} from '../src/voxel-world.js';
import {createMissionRun,scoreRun,standHeight,MISSION_RULES} from '../src/titan-missions.js';
import {boulderImpactShielded} from '../src/titan-campaign.js';

const level=createTitanTown(),world=level.world,scene=level.sceneDefinition;
const CELL=.1,cell=v=>Math.floor(v/CELL+1e-6);
const playerAt=(x,y,z)=>({x,y,z,vx:0,vy:0,vz:0,grounded:true});

test('far wall sits strictly above the voxel wall, carries the player and blocks rays',()=>{
 const boxes=farWallBoxes(level.farWall);assert.equal(boxes.length,4);
 assert.ok(level.farWall.bottom>=scene.farWall.bottom&&level.farWall.top===45.3);
 let overlap=0;
 for(const b of boxes)for(let x=b.min[0];x<b.max[0];x+=.5)for(let z=b.min[2];z<b.max[2];z+=.5)for(let y=b.min[1];y<Math.min(b.max[1],25.6);y+=.1)if(world.getId(cell(x),cell(y),cell(z)))overlap++;
 assert.equal(overlap,0,'no voxel cell inside a far-wall box');
 const p=playerAt(scene.points.walltop.x,scene.points.walltop.y+.5,scene.points.walltop.z);p.grounded=false;
 for(let i=0;i<90;i++)stepPlayer(p,world,{},0,1/60);
 assert.ok(p.grounded&&Math.abs(p.y-45.3)<.05,`player stands on the deck: ${p.y.toFixed(2)}`);
 const hit=world.raycast({x:0,y:30,z:0},{x:0,y:0,z:-1},80);assert.ok(hit?.farWall,'ray from town hits the far wall');
 assert.equal(hit.mat,'stone');
});

// Reachability that mirrors stepPlayer on real voxels: a cylinder of radius
// 0.38 m and height 1.82 m rests on any solid cell under its disc, steps up
// at most 0.5 m when blocked and otherwise falls until supported.
const DISC=[];for(let dx=-4;dx<=4;dx++)for(let dz=-4;dz<=4;dz++)if(dx*dx+dz*dz<=3.8*3.8+.5)DISC.push([dx,dz]);
function accessGraph(entry){
 const pts=[...entry.doors.flatMap(d=>[d.outside,d.inside]),...entry.storeys.filter(s=>s.point).map(s=>s.point)];
 const x0=cell(Math.min(...pts.map(p=>p[0]))-4),x1=cell(Math.max(...pts.map(p=>p[0]))+4),z0=cell(Math.min(...pts.map(p=>p[2]))-4),z1=cell(Math.max(...pts.map(p=>p[2]))+4);
 const H=cell(Math.max(...entry.storeys.filter(s=>s.reach!=='grapple').map(s=>s.y))+2.4)+1,W=x1-x0+1,D=z1-z0+1;
 // freeUp: run of empty cells from (x, y, z) upward, capped at 19.
 const freeUp=new Uint8Array(W*D*(H+1)),solidAt=new Uint8Array(W*D*(H+1)),idx=(x,y,z)=>((x-x0)*D+(z-z0))*(H+1)+y;
 for(let x=x0;x<=x1;x++)for(let z=z0;z<=z1;z++){let run=19;for(let y=H;y>=0;y--){const s=world.getId(x,y,z)?1:0;solidAt[idx(x,y,z)]=s;run=s?0:Math.min(19,run+1);freeUp[idx(x,y,z)]=run;}}
 const inside=(x,z)=>x>=x0&&x<=x1&&z>=z0&&z<=z1;
 const clearCache=new Uint8Array(W*D*(H+1)),supportCache=new Uint8Array(W*D*(H+1));
 const clear=(x,y,z)=>{if(y<1||y>H-19||!inside(x,z))return false;const i=idx(x,y,z);if(!clearCache[i]){let ok=1;for(const [dx,dz]of DISC){const a=x+dx,b=z+dz;if(inside(a,b)&&freeUp[idx(a,y,b)]<19){ok=0;break;}}clearCache[i]=ok?1:2;}return clearCache[i]===1;};
 const supported=(x,y,z)=>{const i=idx(x,y,z);if(!supportCache[i]){let ok=0;for(const [dx,dz]of DISC){const a=x+dx,b=z+dz;if(inside(a,b)&&solidAt[idx(a,y-1,b)]){ok=1;break;}}supportCache[i]=ok?1:2;}return supportCache[i]===1;};
 const settle=(x,y,z)=>{for(let k=0;k<16&&y>=1;k++,y--){if(!clear(x,y,z))return null;if(supported(x,y,z))return y;}return null;};
 const key=(x,y,z)=>idx(x,y,z);
 function search(from){
  const seen=new Set(),queue=[],sx=cell(from[0]),sz=cell(from[2]),sy=settle(sx,cell(from[1])+2,sz);
  if(sy!==null){seen.add(key(sx,sy,sz));queue.push([sx,sy,sz]);}
  for(let q=0;q<queue.length;q++){
   const [x,y,z]=queue[q];
   for(const [dx,dz]of [[1,0],[-1,0],[0,1],[0,-1]]){
    const nx=x+dx,nz=z+dz;let h=0;while(h<=5&&!clear(nx,y+h,nz))h++;if(h>5)continue;
    const ny=settle(nx,y+h,nz);if(ny===null)continue;
    const k=key(nx,ny,nz);if(!seen.has(k)){seen.add(k);queue.push([nx,ny,nz]);}
   }
  }
  return queue;
 }
 const near=(nodes,p,r=4)=>nodes.some(([x,y,z])=>Math.abs(x-cell(p[0]))<=r&&Math.abs(z-cell(p[2]))<=r&&Math.abs(y-cell(p[1]))<=2);
 return {search,near};
}

test('every enterable building: doors reach the ground floor and stairs reach each upper storey',()=>{
 const report=[];
 for(const [id,entry]of Object.entries(scene.access)){
  assert.ok(entry.doors.length>=1,id+' has a door');
  const graph=accessGraph(entry),nodes=graph.search(entry.doors[0].outside);
  for(const [i,d]of entry.doors.entries())assert.ok(graph.near(nodes,d.inside),`${id} door ${i} (${d.side}) leads inside`);
  for(const s of entry.storeys){
   if(s.reach==='grapple'){report.push(`${id}@${s.y}=grapple`);continue;}
   assert.ok(['door','stairs'].includes(s.reach),`${id} storey ${s.y} reach ${s.reach}`);
   assert.ok(graph.near(nodes,s.point),`${id} storey ${s.y} (${s.reach}) is walkable from the door`);
  }
  assert.equal(entry.stairs.length,entry.storeys.filter(s=>s.reach==='stairs').length,id+' one stair per upper storey');
  for(const s of entry.stairs.filter(s=>s.kind==='straight')){
   const ax=s.top[0]-s.bottom[0],az=s.top[2]-s.bottom[2],al=Math.hypot(ax,az),yaw=Math.atan2(-ax,-az);
   // Short landings against a wall are entered from the side; start at the
   // first clear spot along the stair axis.
   let p=null;for(let k=0;k<30&&!p;k++)for(let h=0;h<=.6&&!p;h+=.1){const x=s.bottom[0]+ax/al*k*.05,z=s.bottom[2]+az/al*k*.05,y=s.bottom[1]+.02+h;if(!world.collides(x,y,z,1.82,.38))p=playerAt(x,y,z);}
   assert.ok(p,id+' stair has a clear starting spot');
   let reached=false;for(let i=0;i<360&&!reached;i++){stepPlayer(p,world,{forward:1},yaw,1/60);reached=p.grounded&&Math.abs(p.y-s.to)<.05;}
   assert.ok(reached,`${id} straight stair climbed by the real controller: ${p.y.toFixed(2)} / ${s.to}`);
  }
 }
 assert.deepEqual(report,['bell-tower@8.4=grapple'],'only the bell chamber needs the grapple');
});

function makeGear(w,extra={}){
 const events=[];
 const gear=createGrappleGear({world:w,raycast:(o,d,r)=>w.raycast(o,d,r),events:(type,data)=>events.push({type,...data}),...extra});
 return {gear,events};
}
const norm=v=>{const l=Math.hypot(v.x,v.y,v.z);return {x:v.x/l,y:v.y/l,z:v.z/l};};

test('Space grapple: wind-up, alternate sides, hold to reel, release keeps inertia, unhookable jumps',()=>{
 const w=createTitanTown().world,{gear,events}=makeGear(w),p=playerAt(0,.32,-30);
 const step=(dt,hold)=>{const f=gear.preStep(p,dt,{yaw:0,hold});stepPlayer(p,w,{airInertia:f.airInertia},0,dt,null);gear.postStep(p,dt,{collides:(x,y,z)=>w.collides(x,y,z,p.colliderHeight)});};
 const eye=()=>({x:p.x,y:p.y+1.65,z:p.z});
 assert.equal(gear.press(p,0,eye(),norm({x:0,y:.6,z:-1})),'jump','without gear Space jumps');
 gear.equip();
 assert.equal(gear.press(p,0,eye(),{x:0,y:1,z:0}),'jump','sky is not hookable');
 const q=gear.aimQuery(eye(),norm({x:0,y:.5,z:-1}));assert.ok(q.hookable&&q.distance<48,'wall ahead is hookable with a distance');
 assert.equal(gear.press(p,0,eye(),norm({x:0,y:.5,z:-1})),'hook');
 const first=gear.hooks.find(h=>h.state==='windup');assert.equal(first.side,'L');
 step(.1,true);assert.equal(first.state,'windup','still winding up at 0.1 s');
 step(.12,true);assert.notEqual(first.state,'windup','launched after 0.2 s');assert.ok(events.some(e=>e.type==='launch'));
 for(let i=0;i<60&&first.state!=='attached';i++)step(1/60,true);
 assert.equal(first.state,'attached');assert.equal(first.anchor.type,'voxel');
 const anchor=first.pos.clone(),dist=()=>Math.hypot(p.x-anchor.x,p.y+1-anchor.y,p.z-anchor.z),d0=dist();
 for(let i=0;i<30;i++)step(1/60,true);
 assert.ok(gear.reeling&&dist()<d0-3&&p.y>1.2,'holding Space reels in');
 const v=Math.hypot(p.vx,p.vy,p.vz);gear.releaseActive();assert.equal(first.state,'retract');
 assert.ok(Math.abs(Math.hypot(p.vx,p.vy,p.vz)-v)<1e-9,'release keeps velocity');
 for(let i=0;i<240&&!p.grounded;i++)step(1/60,false);
 assert.equal(gear.press(p,0,eye(),norm({x:.3,y:.5,z:-1})),'hook');
 assert.equal(gear.hooks.find(h=>h.state==='windup').side,'R','presses alternate L/R');
 assert.equal(gear.stats.jumps,2,'no-gear press and sky press both jumped');
});

test('grapple attaches to the far wall as a static anchor and drops when a voxel anchor is destroyed',()=>{
 const w=createTitanTown().world,{gear,events}=makeGear(w);gear.equip();
 const p=playerAt(0,.32,-40),step=(dt,hold)=>{const f=gear.preStep(p,dt,{yaw:0,hold});stepPlayer(p,w,{airInertia:f.airInertia},0,dt,null);gear.postStep(p,dt,{collides:(x,y,z)=>w.collides(x,y,z,p.colliderHeight)});};
 assert.equal(gear.press(p,0,{x:0,y:1.97,z:-40},norm({x:0,y:4,z:-1})),'hook');
 for(let i=0;i<90&&gear.hooks[0].state!=='attached';i++)step(1/60,true);
 assert.equal(gear.hooks[0].anchor?.type,'static');assert.ok(gear.hooks[0].pos.y>20.3,'hooked above the voxel wall');
 gear.releaseActive();for(let i=0;i<240&&!p.grounded;i++)step(1/60,false);
 Object.assign(p,playerAt(0,.32,-30));
 assert.equal(gear.press(p,0,{x:0,y:1.97,z:-30},norm({x:0,y:.5,z:-1})),'hook');
 const hook=gear.hooks[1];for(let i=0;i<90&&hook.state!=='attached';i++)step(1/60,true);
 assert.equal(hook.anchor.type,'voxel');
 cutStaticForTool(w,hook.pos,'explosion',{radius:1.5});step(1/60,true);
 assert.equal(hook.state,'retract');assert.ok(events.some(e=>e.type==='detach'&&e.reason==='anchor-destroyed'));
});

test('rescue escort follows the footprint trail through the real door and never climbs into walls',()=>{
 const run=createMissionRun(level.missions),r=run.rescue,getId=(x,y,z)=>world.getId(x,y,z);
 const standAt=(x,z,y)=>standHeight(getId,x,z,y);
 assert.ok(Math.abs(standAt(r.x,r.z,r.y)-.3)<.05,'villager starts on the ground floor');
 const house=scene.access['sw-rescue'],door=house.doors[0];
 run.interact({type:'rescue'});
 const walker={x:r.x,y:.3,z:r.z},route=[door.inside,door.outside,[door.outside[0],.3,door.outside[2]-4]];let peak=r.y;
 for(const [tx,,tz] of route)for(let i=0;i<600;i++){const dx=tx-walker.x,dz=tz-walker.z,d=Math.hypot(dx,dz);if(d<.05)break;walker.x+=dx/d*Math.min(d,.06);walker.z+=dz/d*Math.min(d,.06);run.update(1/60,{player:walker,standAt});peak=Math.max(peak,r.y);}
 for(let i=0;i<120;i++){run.update(1/60,{player:walker,standAt});peak=Math.max(peak,r.y);}
 assert.equal(r.state,'following');assert.ok(peak<.8,`villager stays on the street level (peak ${peak.toFixed(2)} m)`);
 assert.ok(r.z<door.outside[2]+.3,`villager walked out through the door (z ${r.z.toFixed(2)})`);
 // Walking straight through a wall: she stops at the wall instead of climbing it.
 const run2=createMissionRun(level.missions),r2=run2.rescue;run2.interact({type:'rescue'});const w2={x:r2.x,y:.3,z:r2.z};let peak2=r2.y;
 for(let i=0;i<300;i++){w2.x+=.06;run2.update(1/60,{player:w2,standAt});peak2=Math.max(peak2,r2.y);}
 assert.ok(peak2<.8,`no wall climbing (peak ${peak2.toFixed(2)} m)`);
});

test('missions: interactions, rescue escort, three lives with nearest-safehouse respawn, grades',()=>{
 const events=[],run=createMissionRun(level.missions,{events:(t,d)=>events.push(t)});
 assert.equal(run.missions.length,7);assert.equal(run.lives,3);
 assert.equal(run.missions.reduce((n,m)=>n+m.stars,0),20);
 const supply=run.mission('supply'),near=run.interactionAt({x:supply.at.x+.5,y:supply.at.y,z:supply.at.z});
 assert.equal(near?.type,'mission');assert.ok(run.interact(near));assert.equal(supply.status,'done');assert.equal(run.stars,1);
 // The belfry sill is narrow: the signal lights from the grapple hang in the arch, up to 3.2 m below.
 const signal=run.mission('signal'),at=signal.at;
 assert.equal(run.interactionAt({x:at.x+1.2,y:at.y-3,z:at.z})?.mission?.id,'signal');
 assert.equal(run.interactionAt({x:at.x+1.2,y:at.y-3.4,z:at.z}),null);
 const r=run.rescue;assert.equal(run.interactionAt({x:r.x,y:r.y,z:r.z}).type,'rescue');run.interact({type:'rescue'});
 const home=run.safehouses[1].spawn,walker={x:r.x,y:r.y,z:r.z};
 for(let i=0;i<4000&&r.state!=='saved';i++){const dx=home.x-walker.x,dz=home.z-walker.z,d=Math.hypot(dx,dz);if(d>.5){walker.x+=dx/d*.06;walker.z+=dz/d*.06;}run.update(1/60,{player:walker,groundAt:()=>.32});}
 assert.equal(r.state,'saved');assert.equal(run.mission('rescue').status,'done');
 run.titanDown();run.titanDown();assert.equal(run.mission('hunt').status,'done');
 const death=run.die('boulder',{x:26,z:12});assert.equal(death.safehouse.id,'safehouse-east');assert.equal(run.lives,2);
 assert.equal(run.completed,3,'progress kept after death');
 run.die('grab',{x:0,z:0});const last=run.die('fall',{x:0,z:0});assert.ok(last.failed);assert.equal(run.result.kind,'failed');
 assert.ok(['C','D'].includes(run.result.grade),'failed runs grade at most C');
 assert.equal(scoreRun({stars:20,deaths:0,seconds:600}).grade,'S');
 assert.equal(scoreRun({stars:20,deaths:2,seconds:600,failed:true}).grade,'C');
 assert.equal(scoreRun({stars:1,deaths:0,seconds:60}).grade,'D');
 assert.ok(MISSION_RULES.grades[0][1]<=20*MISSION_RULES.starPoints,'S is reachable');
});

test('ground giants: vision cone with line of sight, noise investigation, search after losing the target',()=>{
 const w=createTitanTown().world,titans=createTitanSystem(null,w,{...level.titans,count:1,climbSpawns:[]});
 const g=titans.titans[0];for(let i=0;i<300&&g.state==='enter';i++)titans.update(.1,[]);assert.equal(g.state,'wander');
 for(let i=0;i<40&&g.attack;i++)titans.update(.1,[]);
 const ahead=d=>({id:'player',kind:'player',x:g.x+Math.sin(g.yaw+g.look)*d,y:g.y,z:g.z+Math.cos(g.yaw+g.look)*d,down:false});
 const behind={id:'player',kind:'player',x:g.x-Math.sin(g.yaw)*12,y:g.y,z:g.z-Math.cos(g.yaw)*12,down:false};
 titans.update(.1,[behind]);assert.equal(g.seen,false,'target behind is outside the cone');
 const front=ahead(14);titans.update(.1,[front]);
 if(g.seen){assert.ok(g.alert>0&&g.alert<1);assert.equal(g.state,'suspicious','first sight raises suspicion before a chase');}
 for(let i=0;i<60&&g.state!=='chase';i++){Object.assign(front,ahead(10));titans.update(.1,[front]);}
 assert.equal(g.state,'chase');assert.equal(g.seenId,'player','sightings record who was seen so the eye only reacts to the player');
 const hide={x:g.x-Math.sin(g.yaw)*40,z:g.z-Math.cos(g.yaw)*40};
 let chased=0;for(;chased<200&&g.state==='chase';chased++){Object.assign(front,hide);if(!g.attack)g.attack={kind:'smash',point:{x:g.x,y:g.y,z:g.z},age:0,impact:0,length:1.2,done:true};titans.update(.1,[front]);}
 assert.equal(g.state,'search','losing sight starts a search at the last seen point');
 assert.ok(chased*.1<=VISION.lost+1.5,`attacking an obstacle does not pause the lost timer (took ${chased*.1} s)`);
 g.goal={x:g.x+400,z:g.z};let searched=0;for(;searched<400&&g.state==='search';searched++)titans.update(.1,[]);
 assert.ok(g.state!=='search'&&searched*.1<=VISION.searchLimit+5,`an unreachable search gives up after ${VISION.searchLimit} s (took ${searched*.1} s)`);
 titans.calm();assert.equal(g.state,'wander');
 const heard=titans.noise({x:g.x+8,y:0,z:g.z},20,'explosion');assert.deepEqual(heard,[g.id]);assert.equal(g.state,'suspicious');
 assert.equal(titans.noise({x:g.x+80,y:0,z:g.z},20,'explosion').length,0,'out of earshot');
});

function makeApe(events=[],smashes=[]){
 const root=new THREE.Scene();
 const ape=createWallApe(root,world,{...level.ape},{smash:(p,r,b)=>smashes.push({p,b}),event:(type,a,data)=>events.push({type,t:a?.stats?.stateLog?.length,data})});
 return {ape,root};
}
const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));

test('wall ape walks the closed four-wall loop with short corner pauses and scans while walking',()=>{
 const {ape}=makeApe(),a=ape.ape;
 assert.ok(level.ape.loop&&level.ape.patrol.length===4);assert.ok(Math.abs(ape.path.total-391.2)<1,'perimeter ~391 m');
 let rel=[],pauses=0,paused=0;
 for(let i=0;i<600;i++){ape.update(.1,null);if(a.state==='patrol'&&a.speed>0)rel.push(wrap(a.viewYaw-a.yaw));if(a.pause>0)paused+=.1;else if(paused>0){pauses=Math.max(pauses,paused);paused=0;}}
 assert.equal(a.state,'patrol');
 assert.ok(a.stats.distance>=90,`walked ${a.stats.distance.toFixed(1)} m in 60 s`);
 assert.ok(a.stats.corners>=1&&pauses<=1.01,`corner pauses ${pauses.toFixed(2)} s`);
 assert.ok(Math.max(...rel)-Math.min(...rel)>1.2,'view cone sweeps left and right while walking');
});

test('wall ape: full meter throws at once, then volleys of 3 boulders 2.4 s apart separated by 4.5 s rests, with lead and scatter, no landing marker',()=>{
 const events=[],smashes=[],{ape,root}=makeApe(events,smashes),a=ape.ape;
 const player={x:0,y:.32,z:-6.5,vx:5,vy:0,vz:0};
 let t=0,spotAt=null,throws=[],records=[],meterSeen=false;
 for(let i=0;i<1200&&throws.length<8;i++){
  ape.update(.05,player);t+=.05;
  if(a.state==='watch'&&a.meter>0&&!a.engaged)meterSeen=true;
  if(spotAt===null&&a.engaged)spotAt=t;
  if(a.stats.thrown>throws.length){throws.push(t);records.push(a.stats.lastThrow);}
  player.x=Math.sin(t*.4)*4;
 }
 assert.ok(meterSeen,'watching while the meter rises');
 assert.ok(spotAt!==null,'meter fills and the ape engages');
 assert.ok(throws[0]-spotAt<=APE.firstLift+APE.release+.2,`first throw ${(throws[0]-spotAt).toFixed(2)} s after spotting`);
 assert.ok(throws[0]-spotAt>=APE.firstLift,'the first boulder of a volley has the long wind-up');
 const lifts=events.filter(e=>e.type==='lift');assert.ok(lifts[0]?.data?.first&&lifts[0].data.seconds===APE.firstLift&&lifts.slice(1,3).every(e=>!e.data?.first),'only the first lift of a volley is flagged');
 const gaps=throws.slice(1).map((x,i)=>x-throws[i]),rests=gaps.filter(g=>g>=APE.rest[0]);
 assert.ok(throws.length>=7,`${throws.length} throws`);
 // The rest clock waits for the last boulder to land: a rest gap adds at most one flight time, and if the
 // relocating ape lost sight during the rest it must refill the meter (one re-spot) before the roaring first lift.
 assert.ok(rests.length>=1&&rests.every(g=>g<=APE.rest[1]+APE.flightBase+APE.flightPerRange+1/(APE.gain*.8)+APE.firstLift+APE.release+1.5),`one rest between volleys: ${gaps.map(g=>g.toFixed(2))}`);
 const first=gaps.indexOf(rests[0])+1;assert.ok(first>=APE.volley[0]&&first<=APE.volley[1],`first volley has ${first} boulders`);
 // Never faster than the volley gap; exactly the gap between two aimed throws of one volley.
 // (After a suppressive throw the target may be lost and must be re-spotted, which takes longer.)
 gaps.forEach((g,i)=>{if(g>=APE.rest[0])return;assert.ok(g>=APE.volleyGap-.06,`gap ${g.toFixed(2)} s`);if(records[i].aim==='sight'&&records[i+1].aim==='sight')assert.ok(g<=APE.volleyGap+.2,`in-volley gap ${g.toFixed(2)} s`);});
 // Brief losses of sight (eave or building shadow) make some throws suppressive; check the last aimed one.
 const last=records.filter(r=>r.aim!=='suppress').at(-1),d=Math.hypot(last.player.x-a.x,last.player.z-a.z);
 assert.ok(Math.abs(last.lead.x-5*last.flight)<.03,'lead = player velocity x flight time');
 const v=Math.hypot(last.player.vx??0,last.player.vz??0);
 assert.ok(last.spread<=APE.spreadBase+d*APE.spreadPerMetre+Math.max(0,d-APE.spreadFar)*APE.spreadPerFarMetre+v*APE.spreadPerSpeed+.006,'scatter stays inside its disc');
 assert.ok(a.stats.relocations>=1&&a.stats.rests>=1,'moves along the walkway during the rest');
 for(let i=0;i<80;i++)ape.update(.05,player);
 assert.ok(smashes.length>=1,'boulders hit through the explosion hook');
 // Hide mid-volley, so the rest of the volley falls inside the suppression window.
 for(let i=0;i<400&&!(a.state==='track'&&a.volleyLeft>=1&&a.restClock<=0&&a.seen);i++){ape.update(.05,player);t+=.05;player.x=Math.sin(t*.4)*4;}
 // Hidden player: the ape keeps pounding the last sighting, then searches.
 // The player hides 8 m away from where it was seen: suppression may only use
 // the sighting (pushed at most suppressMax along the seen motion).
 const hidden={...player,x:player.x+8,down:true},before=a.stats.thrown;let searchAt=null;const targets=[];
 for(let i=0;i<300&&searchAt===null;i++){ape.update(.05,hidden);if(a.stats.thrown>before+targets.length)targets.push(a.stats.lastThrow.target);if(a.state==='search')searchAt=i*.05;}
 assert.ok(a.stats.thrown>before,'suppressive throws at the last sighting after the player hides');
 const seen=a.lastSeen,ds=Math.hypot(seen.x-a.x,seen.z-a.z)+8,reach=APE.suppressMax+APE.spreadBase+ds*APE.spreadPerMetre+Math.max(0,ds-APE.spreadFar)*APE.spreadPerFarMetre+Math.hypot(seen.vx,seen.vz)*APE.spreadPerSpeed;
 for(const t of targets){assert.ok(Math.hypot(t.x-seen.x,t.z-seen.z)<=reach,`suppression aims near the sighting, ${Math.hypot(t.x-seen.x,t.z-seen.z).toFixed(1)} m`);assert.ok(Math.hypot(t.x-hidden.x,t.z-hidden.z)>=8-reach,'not at the hidden player');}
 assert.ok(searchAt!==null&&searchAt<=APE.suppress+.5,`searches after ${searchAt} s of no sight`);
 let markers=0;root.traverse(o=>{if(o.isMesh&&/Ring|Circle|Plane/.test(o.geometry?.type))markers++;});
 assert.equal(markers,0,'nothing marks the landing point');
 assert.ok(!('landing' in ape.snapshot())&&!JSON.stringify(ape.snapshot()).includes('marker'));
 assert.ok(events.some(e=>e.type==='spot')&&events.some(e=>e.type==='throw'));
});

test('fast boulder is stopped by a 0.3 m wall, carves it, breaks through with less speed, hits the next wall, then rolls and shatters',()=>{
 const w=new VoxelWorld();
 for(let x=-20;x<400;x++)for(let z=-40;z<40;z++)w.set(x,0,z,'stone');
 const wall=(x0,mat)=>{for(let x=x0;x<x0+3;x++)for(let y=1;y<50;y++)for(let z=-30;z<30;z++)w.set(x,y,z,mat);};
 wall(100,'brick');wall(200,'plaster');
 const removed=[],smashes=[];
 const ape=createWallApe(new THREE.Scene(),w,{...level.ape,groundY:.1},{smash:(p,r)=>{smashes.push({p,r});removed.push(...w.destroySphere(p,r,ATTACKS.explosion.power,{kind:'explosion'}));}});
 const b=ape.launch({x:0,y:2.2,z:0},{x:80,y:0,z:0});
 assert.ok(80/60>.3,'per-tick travel is several times the wall thickness');
 for(let i=0;i<600&&ape.boulders.includes(b);i++)ape.update(1/60,null);
 assert.ok(b.impacts.length>=2,`impacts: ${JSON.stringify(b.impacts)}`);
 const [first,second]=b.impacts;
 assert.ok(Math.abs(first.x-10)<.3,`first contact on the brick wall face (x=${first.x})`);
 assert.ok(removed.some(c=>c.x>=100&&c.x<103),'cells removed from the first wall');
 assert.ok(Math.abs(second.x-20)<1.5&&second.speed<first.speed&&second.radius<first.radius,'second wall hit with less speed and a smaller radius');
 assert.ok(removed.some(c=>c.x>=200&&c.x<203),'cells removed from the second wall');
 assert.ok(['rolled','stopped'].includes(b.end),`ends by rolling out or stopping: ${b.end}`);
 assert.ok(!ape.boulders.includes(b));
});

test('a boulder impact behind a standing wall does not kill the player; an open impact within the kill radius does',()=>{
 const w=new VoxelWorld();
 for(let x=-40;x<40;x++)for(let z=-20;z<20;z++)w.set(x,0,z,'stone');
 for(let x=0;x<3;x++)for(let y=1;y<30;y++)for(let z=-15;z<15;z++)w.set(x,y,z,'brick');
 const player={x:.9,y:.1,z:0},torso=y=>y+.9;
 // Impact on the far face of a 0.3 m wall, 1.5 m from the torso.
 const behind={x:-.55,y:1.2,z:0},d1=Math.hypot(player.x-behind.x,torso(player.y)-behind.y,player.z-behind.z);
 assert.ok(d1<APE.killRadius);assert.equal(boulderImpactShielded(w,behind,player,d1),true,'wall shields the player');
 const open={x:2.2,y:1.2,z:1.5},d2=Math.hypot(player.x-open.x,torso(player.y)-open.y,player.z-open.z);
 assert.ok(d2<APE.killRadius);assert.equal(boulderImpactShielded(w,open,player,d2),false,'same side of the wall is lethal');
});

test('wall ape walks to the wall section nearest the last sighting, looks around, then resumes patrol',()=>{
 const events=[],{ape}=makeApe(events),a=ape.ape;
 const sighting={x:44,y:.32,z:20};ape.alertTo(sighting,.5);
 const target=ape.nearestS(sighting.x,sighting.z);
 let arrived=null,sweep=[];
 for(let i=0;i<1400&&a.state!=='patrol'||i<5;i++){
  ape.update(.1,{x:0,y:-50,z:0,down:true});
  if(a.state==='search'&&a.arrived){arrived??=a.s;sweep.push(wrap(a.viewYaw-a.yaw));}
  if(i>5&&a.state==='patrol')break;
 }
 assert.ok(a.stats.searches>=1,'search started after losing sight');
 assert.ok(arrived!==null,'arrived at the search point');
 const delta=Math.abs(((arrived-target)%ape.path.total+ape.path.total*1.5)%ape.path.total-ape.path.total/2);assert.ok(delta<.5,`stopped ${delta.toFixed(2)} m from the nearest wall point`);
 const p=ape.positionAt(target);assert.ok(p.x>45,'nearest wall to an east sighting is the east wall');
 assert.ok(Math.max(...sweep)-Math.min(...sweep)>1.5,'looks around while searching');
 assert.equal(a.state,'patrol');assert.ok(events.some(e=>e.type==='search-arrive')&&events.some(e=>e.type==='resume'));
});
