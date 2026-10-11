import test from 'node:test';
import assert from 'node:assert/strict';
import {VoxelWorld,MATERIAL_KEYS,MATERIAL_IDS,keyOf,chunkOf} from '../src/voxel-world.js';

test('makeHole chooses the independent soft, medium and hard radii and protects category three',()=>{
  const categories={plaster:0,stone:1,brick:1,concrete:2,wood:0,darkwood:0,roof:1,metal:1,rust:1,dark:3,glass:0,leaf:0,fuel:1},radii=[.6,.3,.1];
  for(const mat of MATERIAL_KEYS.slice(1)){
    const world=new VoxelWorld();for(const x of [0,2,5,7])world.set(x,10,0,mat);const before=world.geometryRevision,removed=world.makeHole({x:.05,y:1.05,z:.05},radii),expected=[[0,2,5],[0,2],[0],[]][categories[mat]];
    assert.deepEqual(removed.map(c=>c.x).sort((a,b)=>a-b),expected,mat);for(const x of [0,2,5,7])assert.equal(Boolean(world.get(x,10,0)),!expected.includes(x),`${mat}:${x}`);assert.equal(world.geometryRevision,before+expected.length);assert.deepEqual(world.lastMutation.changes,removed.map(c=>[c.x,c.y,c.z,0,0]));
  }
});

test('makeHole clamps larger medium/hard radii to the soft radius and retains foundation voxels',()=>{
  const world=new VoxelWorld();world.set(0,10,0,'concrete');world.set(5,10,0,'concrete');world.makeHole({x:.05,y:1.05,z:.05},[.2,.4,.8]);assert.equal(world.get(0,10,0),undefined);assert.equal(world.get(5,10,0),'concrete');
  world.terrainColumns=new Uint8Array(1024*1024);world.terrainColumns[512+512*1024]=1;world.set(0,0,0,'wood');assert.deepEqual(world.makeHole({x:.05,y:.05,z:.05},[.2,.2,.2]),[]);assert.equal(world.get(0,0,0),'wood');
});

test('partial damage updates content revisions without geometry, lighting or support invalidation',()=>{
  const world=new VoxelWorld();world.set(0,10,0,'metal');world.dirty.clear();world.lightDirty.clear();world.supportDirty.clear();const key=chunkOf(0,10,0),chunk=world.chunks.get(key),saved=world.snapshot(),before={revision:world.revision,content:world.contentRevision,geometry:world.geometryRevision,chunk:chunk.revision};
  assert.deepEqual(world.destroySphere({x:.05,y:1.05,z:.05},.01,.5),[]);assert.equal(world.get(0,10,0),'metal');assert.equal(world.damage.get(keyOf(0,10,0)),.5);assert.equal(world.revision,before.revision+1);assert.equal(world.contentRevision,before.content+1);assert.equal(world.geometryRevision,before.geometry);assert.equal(chunk.revision,before.chunk);assert.equal(world.dirty.size,0);assert.equal(world.lightDirty.size,0);assert.equal(world.supportDirty.size,0);assert.equal(world.snapshot().chunks[0][1],saved.chunks[0][1]);assert.deepEqual(saved.damage,[]);assert.deepEqual(world.lastMutation.changes,[[0,10,0,MATERIAL_IDS.metal,.5]]);assert.equal(world.lastMutation.geometryRevision,before.geometry);
});

test('restoring a snapshot advances both version classes and invalidates old and restored geometry',()=>{
  const world=new VoxelWorld();world.set(0,10,0,'wood');world.set(33,10,0,'metal');world.destroySphere({x:3.35,y:1.05,z:.05},.01,.5);const saved=world.snapshot();world.set(0,10,0,'brick');world.set(65,10,0,'glass');world.dirty.clear();world.lightDirty.clear();world.supportDirty.clear();const before={revision:world.revision,content:world.contentRevision,geometry:world.geometryRevision};
  world.restore(saved);assert.equal(world.revision,before.revision+1);assert.equal(world.contentRevision,before.content+1);assert.equal(world.geometryRevision,before.geometry+1);assert.equal(world.count,2);assert.equal(world.get(0,10,0),'wood');assert.equal(world.get(33,10,0),'metal');assert.equal(world.get(65,10,0),undefined);assert.equal(world.damage.get(keyOf(33,10,0)),.5);assert.ok(world.dirty.has(chunkOf(65,10,0)));assert.ok(world.lightDirty.has(chunkOf(65,10,0)));for(const key of world.chunks.keys()){assert.ok(world.dirty.has(key));assert.ok(world.lightDirty.has(key));assert.ok(world.supportDirty.has(key));}assert.equal(world.lastMutation,null,'a restore cannot expose a pre-restore attack packet');
});
