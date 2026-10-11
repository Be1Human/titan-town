import {DEFAULT_MAP_ID,MAPS} from './map-catalog.js';
export {DEFAULT_MAP_ID,MAPS} from './map-catalog.js';
const sources={'titan-town-v1':()=>import('./titan-town.js').then(m=>m.createTitanTown)};
const factories=new Map(),pending=new Map();
export const mapInfo=id=>MAPS.find(map=>map.id===id)||MAPS[0];
export async function prepareLevelFactory(id=DEFAULT_MAP_ID){if(!sources[id])throw new Error('未知地图：'+id);if(!pending.has(id))pending.set(id,sources[id]().then(factory=>{factories.set(id,factory);return factory;}));return pending.get(id);}
export function getLevelFactory(id=DEFAULT_MAP_ID){const factory=factories.get(id);if(!factory)throw new Error('地图资源尚未加载：'+id);return factory;}
export const createLevelForMap=id=>getLevelFactory(id)();
// Node-side callers (tests) keep synchronous factories. The browser loads only its map.
if(typeof window==='undefined')await Promise.all(MAPS.map(m=>prepareLevelFactory(m.id)));
