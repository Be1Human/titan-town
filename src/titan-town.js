import {VoxelWorld} from './voxel-world.js';
import {loadSceneAssets,assembleVoxelScene} from './engine/assets/scene-assets.js';
import {loadTitanRig} from './titan-model.js';
import {installFarWall} from './far-wall.js';

export const TITAN_TOWN_ID='titan-town-v1';
export const titanTownAssets=await loadSceneAssets('scenes/titan-town.scene.json');
export const titanRig=await loadTitanRig();
const ROLES=['patrol','mechanic','porter','scout','medic'];
const NAMES=['面包师','铁匠学徒','卖花人','守夜人','裁缝','磨坊工','牧师助手','酒馆侍者','石匠','邮差'];
const ENTERABLE=['row-a','row-b','row-c','row-d','row-e','inn','bell-tower','smithy','stable','barracks','supply-depot','church','granary','safehouse'];
let initial;
export function createTitanTown({titans}={}){
 initial??=assembleVoxelScene(titanTownAssets);
 const source=initial.world,world=new VoxelWorld(),definition=initial.scene,points=definition.points,bounds={...definition.bounds};
 for(const [key,c]of source.chunks){world.chunks.set(key,{...c,data:c.data.slice()});world.count+=c.count;world.dirty.add(key);world.lightDirty.add(key);world.supportDirty.add(key);}
 Object.assign(world,{snapshotCache:new Map(initial.snapshot.chunks),initialChunks:source.chunks,voxelSurfaces:source.voxelSurfaces,foundation:source.foundation,terrainColumns:source.terrainColumns,terrainVersion:1,palette:source.palette,materialProfiles:source.materialProfiles,assetInstances:source.assetInstances,assetShapes:source.assetShapes,assetOwners:source.assetOwners,mapId:TITAN_TOWN_ID,bounds,floorAt:()=>0,gravity:9.81,respawn:{...points.middle}});
 world.sourceShapeAt=source.sourceShapeAt;world.shapeAt=(x,y,z)=>world.getId(x,y,z)?world.sourceShapeAt(x,y,z):null;world.revision++;
 // Indestructible upper wall: collision and rays only, strictly above the voxel wall.
 if(definition.farWall)installFarWall(world,definition.farWall);
 const characters=definition.townsfolk.map((c,i)=>({id:c.id,name:NAMES[i%NAMES.length],role:ROLES[i%ROLES.length],x:c.x,y:.32,z:c.z,yaw:0,speed:.5,route:c.route.map(p=>[...p])}));
 const buildingTargets=definition.instances.filter(i=>ENTERABLE.includes(i.prefab)).map(i=>({id:i.id,x:i.position[0],z:i.position[2]}));
 const config=definition.titans,count=Math.max(0,Math.min(5,Math.floor(titans??config.count)));
 return {mapId:TITAN_TOWN_ID,name:definition.name,world,initialSnapshot:initial.snapshot,spawn:{...points.middle},points,yaw:points.middle.yaw,exit:{x:0,y:.3,z:-30,radius:2},barrels:[],targets:[],characters,pickups:[],originalProps:[],originalDoors:[],challengeSeconds:600,assetProfile:'titan-town-cc0-import-v3',assetStats:initial.stats,sceneDefinition:definition,parkLights:initial.lights,signs:initial.signs,fixtures:[],cables:[],bedrockColor:0x5d7a48,mapLabels:definition.mapLabels,buildings:{repair:{camera:points.repair},warehouse:{camera:points.warehouse}},
  gear:(definition.gear??[]).map(g=>({...g})),gearAutoEquip:Boolean(definition.gearAutoEquip),
  farWall:definition.farWall??null,
  missions:definition.missions?{missions:definition.missions,safehouses:definition.safehouses,rescue:definition.rescue}:null,
  ape:definition.ape?{...definition.ape,patrol:definition.ape.patrol.map(p=>[...p]),rig:titanRig,center:[0,0],groundY:.3,sun:definition.environment?.sunDirection?[...definition.environment.sunDirection]:null}:null,
  titans:{...config,count,rig:titanRig,spawns:config.spawns.map(s=>({...s})),climbSpawns:(config.climbSpawns??[]).map(s=>({...s,dir:[...s.dir]})),targets:buildingTargets,town:config.town??{minX:-44,maxX:44,minZ:-44,maxZ:44}}};
}
createTitanTown.environmentDefinition=titanTownAssets.scene.environment;
