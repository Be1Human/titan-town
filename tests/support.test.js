import test from 'node:test';
import assert from 'node:assert/strict';
import {VoxelWorld,keyOf} from '../src/voxel-world.js';

function groupKeys(groups){return groups.map(g=>g.map(p=>keyOf(p.x,p.y,p.z)).sort((a,b)=>a-b).join(',')).sort();}
function cut(world,positions){const removed=[];for(const p of positions)if(world.getId(p.x,p.y,p.z)){removed.push(p);world.set(p.x,p.y,p.z,null);}return removed;}
function compare(world,positions){
  const reference=new VoxelWorld();reference.restore(world.snapshot());reference.foundation=world.foundation;
  const removed=cut(world,positions);cut(reference,positions);
  assert.deepEqual(groupKeys(world.detachLocal(removed)),groupKeys(reference.detachUnsupported()));
  assert.equal(world.count,reference.count);
}

test('local support checks keep a second pillar and detach only after the final cut',()=>{
  const world=new VoxelWorld();world.box(0,0,0,1,4,1,'brick');world.box(4,0,0,1,4,1,'brick');world.box(0,4,0,5,1,1,'roof');
  compare(world,[{x:0,y:2,z:0}]);assert.equal(world.get(2,4,0),'roof');
  compare(world,[{x:4,y:2,z:0}]);assert.equal(world.get(2,4,0),undefined);
});

test('local support respects imported fixings, chunk boundaries and multiple cut components',()=>{
  const world=new VoxelWorld();world.foundation=new Int16Array(1024*1024);world.foundation.fill(-1);
  world.foundation[31+512+(512-1)*1024]=7;world.box(31,7,-1,1,6,1,'brick');world.box(28,13,-1,7,1,1,'wood');
  compare(world,[{x:31,y:10,z:-1},{x:30,y:13,z:-1},{x:33,y:13,z:-1}]);
  assert.equal(world.get(31,7,-1),'brick');assert.equal(world.get(28,13,-1),undefined);
});

test('local support agrees with the global reference over deterministic sequences of cuts',()=>{
  let seed=719;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  for(let fixture=0;fixture<12;fixture++){
    const world=new VoxelWorld();world.box(-3,0,-3,7,1,7,'stone');world.box(-3,8,-3,7,1,7,'wood');
    for(const x of[-3,0,3])for(const z of[-3,0,3])world.box(x,1,z,1,7,1,'brick');
    for(let step=0;step<8;step++){
      const positions=Array.from({length:3},()=>({x:Math.floor(random()*7)-3,y:1+Math.floor(random()*8),z:Math.floor(random()*7)-3}));
      compare(world,positions);
    }
  }
});

test('support dirty tracks changed storage chunks independently of rendering neighbors',()=>{
  const world=new VoxelWorld();world.set(31,31,31,'wood');
  assert.equal(world.supportDirty.size,1);assert.ok(world.dirty.size>1);
  world.dirty.clear();assert.equal(world.supportDirty.size,1);
  world.restore(world.snapshot());assert.equal(world.supportDirty.size,world.chunks.size);
});
