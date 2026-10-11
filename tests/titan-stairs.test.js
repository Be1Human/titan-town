import test from 'node:test';
import assert from 'node:assert/strict';
import {createTitanTown} from '../src/titan-town.js';
import {stepPlayer} from '../src/player.js';

const level=createTitanTown(),world=level.world,access=level.sceneDefinition.access;
const townhouses=Object.entries(access).filter(([,a])=>/^row-/.test(a.prefab));
const starts=[];

// Hold W while steering 0.7 m ahead on the stair centre line, starting `offset`
// metres to the side of the foot; the climb settles before it is judged.
function climb(from,to,offset){
 const dx=to[0]-from[0],dz=to[2]-from[2],l=Math.hypot(dx,dz),ux=dx/l,uz=dz/l,nx=-uz,nz=ux;
 // A start inside the side wall is not a place a player can stand: move it toward the centre line.
 while(Math.abs(offset)>.01&&world.collides(from[0]+nx*offset,from[1]+.12,from[2]+nz*offset,1.82,.38))offset-=Math.sign(offset)*.02;
 if(Math.abs(offset)>.01)starts.push(Math.abs(offset));
 const p={x:from[0]+nx*offset,y:from[1]+.02,z:from[2]+nz*offset,vx:0,vy:0,vz:0,grounded:false};
 for(let t=0;t<8;t+=1/60){
  const s=Math.min(l,(p.x-from[0])*ux+(p.z-from[2])*uz+.7),gx=from[0]+ux*s,gz=from[2]+uz*s;
  stepPlayer(p,world,{forward:1},Math.atan2(-(gx-p.x),-(gz-p.z)),1/60);
  if((p.x-to[0])*ux+(p.z-to[2])*uz>-.2)break;
 }
 for(let i=0;i<40;i++)stepPlayer(p,world,{},0,1/60);
 return p.y;
}

test('townhouse stairs: every flight climbs and descends along its axis from up to 0.2 m off-centre',()=>{
 assert.ok(townhouses.length>=15,`${townhouses.length} townhouses with stairs`);
 const failures=[];let flights=0;
 for(const [id,a] of townhouses)for(const f of a.stairs){
  flights++;
  for(const off of [-.2,0,.2]){
   const up=climb(f.bottom,f.top,off);if(Math.abs(up-f.to)>.05)failures.push(`${id} ${f.from}->${f.to} up off ${off}: y ${up.toFixed(2)}`);
   // Descending ends on the floor or the first tread (one 0.4 m riser) at the foot.
   const down=climb(f.top,f.bottom,off);if(down-f.from>.45||down<f.from-.05)failures.push(`${id} ${f.to}->${f.from} down off ${off}: y ${down.toFixed(2)}`);
  }
 }
 assert.deepEqual(failures,[],`${failures.length} of ${flights*6} climbs failed`);
 assert.ok(Math.min(...starts)>=.1,`off-centre starts are at least 0.1 m to the side (min ${Math.min(...starts).toFixed(2)})`);
});

test('steep tower stairs: the bell tower flight climbs and descends along its axis, and its foot holds the player',()=>{
 const steep=Object.entries(access).flatMap(([id,a])=>(a.stairs??[]).filter(f=>f.kind==='steep').map(f=>[id,f]));
 assert.ok(steep.some(([id])=>id==='bell-tower'),'bell tower has a steep flight');
 for(const [id,f] of steep){
  assert.equal(world.collides(f.bottom[0],f.bottom[1]+.02,f.bottom[2],1.82,.38),false,`${id}: a player fits on the foot landing`);
  // The foot is reachable on foot from the street door, not a sealed alcove.
  const door=access[id].doors[0].inside,y=f.bottom[1]+.02,S=.05,key=(x,z)=>Math.round(x/S)+','+Math.round(z/S),seen=new Set([key(door[0],door[2])]),queue=[[door[0],door[2]]];let reached=false;
  for(let h=0;h<queue.length&&!reached;h++){const [x,z]=queue[h];if(Math.hypot(x-f.bottom[0],z-f.bottom[2])<.08)reached=true;
   for(const [dx,dz] of [[S,0],[-S,0],[0,S],[0,-S]]){const X=x+dx,Z=z+dz,k=key(X,Z);if(seen.has(k)||Math.hypot(X-door[0],Z-door[2])>8)continue;seen.add(k);if(!world.collides(X,y,Z,1.82,.38))queue.push([X,Z]);}}
  assert.ok(reached,`${id}: walk from the door to the stair foot`);
  for(const off of [-.1,0,.1]){
   const up=climb(f.bottom,f.top,off);assert.ok(Math.abs(up-f.to)<.05,`${id} up off ${off}: y ${up.toFixed(2)}`);
   const down=climb(f.top,f.bottom,off);assert.ok(down-f.from<=.55&&down>=f.from-.05,`${id} down off ${off}: y ${down.toFixed(2)}`);
  }
 }
});

test('documents mission: the north-east house is reachable from the street door to the documents storey',()=>{
 const docs=level.missions.missions.find(m=>m.id==='documents'),house=access['ne-docs'];
 assert.ok(docs&&house);const storey=house.storeys.find(s=>Math.abs(s.y-docs.at.y)<.3);
 assert.ok(storey,'documents lie on a storey of ne-docs');
 for(const f of house.stairs.filter(f=>f.to<=storey.y+.05))assert.ok(Math.abs(climb(f.bottom,f.top,0)-f.to)<.05,`flight ${f.from}->${f.to}`);
});
