import {MATERIALS,impactEnergy} from './materials.js';
import {createMakeHoleCut,holeCellBounds} from './engine/core/make-hole.js';
export {MATERIALS,ATTACKS,shotgunPower} from './materials.js';
export const CELL=.1,CHUNK=32,STRIDE=1024,LAYER=1048576;
export const MATERIAL_KEYS=['',...Object.keys(MATERIALS)],MATERIAL_IDS=Object.fromEntries(MATERIAL_KEYS.map((name,i)=>[name,i]));
export const DIRS=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
export const keyOf=(x,y,z)=>x+512+(z+512)*STRIDE+y*LAYER;
export const coordsOf=key=>({x:key%STRIDE-512,y:Math.floor(key/LAYER),z:Math.floor(key/STRIDE)%STRIDE-512});
export const chunkOf=(x,y,z)=>(x>>5)+16+((z>>5)+16)*32+(y>>5)*1024;
export const chunkCoords=key=>({x:(key%32-16)*CHUNK,y:Math.floor(key/1024)*CHUNK,z:(Math.floor(key/32)%32-16)*CHUNK});
export const localIndex=(x,y,z)=>(x&31)+(z&31)*32+(y&31)*1024;
export function variation(x,y,z){let n=Math.imul(x+71,374761393)^Math.imul(y+13,668265263)^Math.imul(z+97,1274126177);n=Math.imul(n^(n>>>13),1274126177);return ((n^(n>>>16))>>>0)/4294967295;}
class CellView{
  constructor(world){this.world=world;}get size(){return this.world.count;}
  *[Symbol.iterator](){for(const c of this.world.chunks.values())for(let i=0;i<32768;i++)if(c.data[i])yield [keyOf(c.x+(i&31),c.y+(i>>10),c.z+((i>>5)&31)),MATERIAL_KEYS[c.data[i]]];}
  *keys(){for(const [key]of this)yield key;}get(key){const p=coordsOf(key);return this.world.get(p.x,p.y,p.z);}
}
export class VoxelWorld{
  constructor(){this.chunks=new Map();this.snapshotCache=new Map();this.cells=new CellView(this);this.count=0;this.dirty=new Set();this.lightDirty=new Set();this.supportDirty=new Set();this.damage=new Map();this.revision=0;this.contentRevision=0;this.geometryRevision=0;this.lastMutation=null;this.floorAt=()=>0;this.bounds={minX:-30,maxX:30,minZ:-30,maxZ:30};this.foundation=null;this.sourceMeshes=null;this.altered=new Set();}
  getId(x,y,z){if(y<0||y>=256||x<-512||x>=512||z<-512||z>=512)return 0;return this.chunks.get(chunkOf(x,y,z))?.data[localIndex(x,y,z)]||0;}
  get(x,y,z){const id=this.getId(x,y,z);return id?MATERIAL_KEYS[id]:undefined;}
  getOriginalId(x,y,z){if(y<0||y>=256||x<-512||x>=512||z<-512||z>=512)return 0;return this.initialChunks?.get(chunkOf(x,y,z))?.data[localIndex(x,y,z)]||0;}
  getChunk(key,create=false){let c=this.chunks.get(key);if(!c&&create){c={...chunkCoords(key),key,data:new Uint8Array(32768),count:0,revision:0};this.chunks.set(key,c);}return c;}
  markDirty(x,y,z){const mark=(a,b,c)=>{if(a<-512||a>=512||b<0||b>=256||c<-512||c>=512)return;const k=chunkOf(a,b,c);this.dirty.add(k);this.lightDirty.add(k);this.altered.add(k);};mark(x,y,z);if((x&31)===0)mark(x-1,y,z);if((x&31)===31)mark(x+1,y,z);if((y&31)===0)mark(x,y-1,z);if((y&31)===31)mark(x,y+1,z);if((z&31)===0)mark(x,y,z-1);if((z&31)===31)mark(x,y,z+1);}
  set(x,y,z,material){if(y<0||y>=256||x<-512||x>=512||z<-512||z>=512)return;const id=material?MATERIAL_IDS[material]:0,c=this.getChunk(chunkOf(x,y,z),Boolean(id));if(!c)return;const i=localIndex(x,y,z),old=c.data[i];if(old===id)return;c.data[i]=id;const change=Number(Boolean(id))-Number(Boolean(old));c.count+=change;this.count+=change;c.revision++;this.revision++;this.contentRevision++;this.geometryRevision++;this.damage.delete(keyOf(x,y,z));this.markDirty(x,y,z);this.supportDirty.add(c.key);this.snapshotCache.delete(c.key);}
  removeCells(cells){
    // Atomic ownership handoff: clear precisely the proved cells, collecting
    // chunk/neighbor invalidation once. Revision increments match repeated set.
    const touched=new Map();let removed=0;
    for(const {x,y,z}of cells){
      if(y<0||y>=256||x<-512||x>=512||z<-512||z>=512)continue;
      const key=chunkOf(x,y,z),chunk=this.chunks.get(key);if(!chunk)continue;
      const i=localIndex(x,y,z);if(!chunk.data[i])continue;chunk.data[i]=0;chunk.count--;removed++;
      if(this.damage.size)this.damage.delete(keyOf(x,y,z));
      let record=touched.get(key);if(!record){record={chunk,count:0,edges:0};touched.set(key,record);}record.count++;
      if((x&31)===0)record.edges|=1;if((x&31)===31)record.edges|=2;
      if((y&31)===0)record.edges|=4;if((y&31)===31)record.edges|=8;
      if((z&31)===0)record.edges|=16;if((z&31)===31)record.edges|=32;
    }
    const mark=(x,y,z)=>{if(x<-512||x>=512||y<0||y>=256||z<-512||z>=512)return;const key=chunkOf(x,y,z);this.dirty.add(key);this.lightDirty.add(key);this.altered.add(key);};
    for(const [key,{chunk:c,count,edges}]of touched){
      c.revision+=count;this.supportDirty.add(key);this.snapshotCache.delete(key);mark(c.x,c.y,c.z);
      if(edges&1)mark(c.x-32,c.y,c.z);if(edges&2)mark(c.x+32,c.y,c.z);
      if(edges&4)mark(c.x,c.y-32,c.z);if(edges&8)mark(c.x,c.y+32,c.z);
      if(edges&16)mark(c.x,c.y,c.z-32);if(edges&32)mark(c.x,c.y,c.z+32);
    }
    this.count-=removed;this.revision+=removed;this.contentRevision+=removed;this.geometryRevision+=removed;return removed;
  }
  box(x,y,z,w,h,d,mat){for(let b=y;b<y+h;b++)for(let c=z;c<z+d;c++)for(let a=x;a<x+w;a++)this.set(a,b,c,mat);}
  boxMeters(x,y,z,w,h,d,mat){this.box(Math.round(x/CELL),Math.round(y/CELL),Math.round(z/CELL),Math.max(1,Math.round(w/CELL)),Math.max(1,Math.round(h/CELL)),Math.max(1,Math.round(d/CELL)),mat);}
  destroySphere(point,radius,power=10,{kind='generic'}={}){
    const removed=[],changes=[],baseRevision=this.revision;let partial=0;
    this.lastMutation={baseRevision,revision:this.revision,changes};
    if(![point?.x,point?.y,point?.z,radius,power].every(Number.isFinite)||radius<=0||power<=0)return removed;
    const cx=point.x/CELL,cy=point.y/CELL,cz=point.z/CELL,r=radius/CELL,r2=r*r;
    for(let y=Math.max(0,Math.floor(cy-r));y<=Math.min(255,Math.ceil(cy+r));y++)for(let z=Math.max(-512,Math.floor(cz-r));z<=Math.min(511,Math.ceil(cz+r));z++)for(let x=Math.max(-512,Math.floor(cx-r));x<=Math.min(511,Math.ceil(cx+r));x++){
      const d2=(x+.5-cx)**2+(y+.5-cy)**2+(z+.5-cz)**2;if(d2>r2)continue;
      const id=this.getId(x,y,z);if(!id)continue;
      // Retain the actual bottom voxel of terrain columns as bedrock. The
      // destructible ground above it still forms real, renderable craters.
      if(y===0&&this.terrainColumns?.[x+512+(z+512)*STRIDE]>0)continue;
      const mat=MATERIAL_KEYS[id],energy=impactEnergy(mat,power,Math.sqrt(d2)/r,kind);if(energy<=0)continue;
      const key=keyOf(x,y,z),hit=(this.damage.get(key)||0)+energy;
      if(hit>=MATERIALS[mat].strength){removed.push({x,y,z,mat});this.set(x,y,z,null);changes.push([x,y,z,0,0]);}else {this.damage.set(key,hit);partial++;changes.push([x,y,z,id,hit]);}
    }
    if(partial){this.revision++;this.contentRevision++;}
    this.lastMutation.revision=this.revision;this.lastMutation.geometryRevision=this.geometryRevision;
    return removed;
  }
  // Independent implementation of the verified three material-class radii.
  // Direct occupancy edits share the exact cut predicate with dynamic shapes.
  // Tool accumulation remains a separate legacy API until callers migrate.
  makeHole(point,radii,options={}){
    const removed=[],changes=[],baseRevision=this.revision;
    this.lastMutation={baseRevision,revision:this.revision,geometryRevision:this.geometryRevision,changes};
    const cut=createMakeHoleCut(radii,options);
    if(!cut||!cut.radius||![point?.x,point?.y,point?.z].every(Number.isFinite))return removed;
    const bounds=holeCellBounds(point,cut.radius,CELL,{x:-512,y:0,z:-512},{x:512,y:256,z:512});if(!bounds)return removed;
    const {lo,hi}=bounds;
    for(let y=lo.y;y<=hi.y;y++)for(let z=lo.z;z<=hi.z;z++)for(let x=lo.x;x<=hi.x;x++){
      const mat=this.get(x,y,z);if(!mat||(y===0&&this.terrainColumns?.[x+512+(z+512)*STRIDE]>0))continue;
      if(!cut.contains(mat,(x+.5)*CELL-point.x,(y+.5)*CELL-point.y,(z+.5)*CELL-point.z))continue;
      removed.push({x,y,z,mat});this.set(x,y,z,null);changes.push([x,y,z,0,0]);
    }
    this.lastMutation={baseRevision,revision:this.revision,geometryRevision:this.geometryRevision,changes};return removed;
  }
  damageRatio(x,y,z){const mat=this.get(x,y,z);return mat?Math.min(1,(this.damage.get(keyOf(x,y,z))||0)/MATERIALS[mat].strength):0;}
  detachLocal(removed){
    // Deleting cells can only disconnect components touching the cut. Search
    // each of those components until an original fixing is reached. Prefer
    // downward paths, and reuse the proven paths across the whole impact.
    const supported=new Set(),detached=new Set(),seeds=new Set(),groups=[];
    const neighbors=[[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0],[0,-1,0]];
    for(const p of removed)for(const [dx,dy,dz]of neighbors){const x=p.x+dx,y=p.y+dy,z=p.z+dz;if(this.getId(x,y,z))seeds.add(keyOf(x,y,z));}
    let examined=0;
    for(const seed of seeds){
      if(supported.has(seed)||detached.has(seed))continue;
      const stack=[seed],visited=new Set([seed]);let anchored=false;
      while(stack.length){
        const key=stack.pop(),p=coordsOf(key);examined++;
        const anchor=this.foundation?.[p.x+512+(p.z+512)*STRIDE]??0;
        if(p.y<=anchor||supported.has(key)){anchored=true;break;}
        for(const [dx,dy,dz]of neighbors){const x=p.x+dx,y=p.y+dy,z=p.z+dz;if(!this.getId(x,y,z))continue;const k=keyOf(x,y,z);if(visited.has(k)||detached.has(k))continue;visited.add(k);stack.push(k);}
      }
      if(anchored){for(const key of visited)supported.add(key);}
      else {const group=[];for(const key of visited){detached.add(key);const p=coordsOf(key);group.push({...p,mat:this.get(p.x,p.y,p.z)});}groups.push(group);}
    }
    for(const group of groups)for(const p of group)this.set(p.x,p.y,p.z,null);
    this.supportStats={examined,seeds:seeds.size};return groups;
  }
  detachUnsupported({pinInitial=false}={}){
    const visited=new Map(),queue=new Int32Array(Math.max(1,this.count));let head=0,tail=0;
    const push=(x,y,z)=>{const ck=chunkOf(x,y,z),c=this.chunks.get(ck);if(!c)return;const i=localIndex(x,y,z);if(!c.data[i])return;let marks=visited.get(ck);if(!marks){marks=new Uint8Array(32768);visited.set(ck,marks);}if(marks[i])return;marks[i]=1;queue[tail++]=keyOf(x,y,z);};
    for(const c of this.chunks.values())for(let z=0;z<32;z++)for(let x=0;x<32;x++){
      const anchor=this.foundation?.[(c.x+x+512)+(c.z+z+512)*1024]??0;
      for(let y=0;y<32&&c.y+y<=anchor;y++)if(c.data[x+z*32+y*1024])push(c.x+x,c.y+y,c.z+z);
    }
    let lowest=null;
    const flood=collect=>{const group=[];while(head<tail){const p=coordsOf(queue[head++]);if(pinInitial&&(!lowest||p.y<lowest.y))lowest=p;if(collect)group.push({...p,mat:this.get(p.x,p.y,p.z)});for(const[dx,dy,dz]of DIRS){const x=p.x+dx,y=p.y+dy,z=p.z+dz;if(y>=0&&y<256&&x>=-512&&x<512&&z>=-512&&z<512)push(x,y,z);}}return group;};
    flood(false);const groups=[];for(const c of this.chunks.values())for(let i=0;i<32768;i++)if(c.data[i]&&!visited.get(c.key)?.[i]){head=0;tail=0;lowest=null;push(c.x+(i&31),c.y+(i>>10),c.z+((i>>5)&31));const group=flood(!pinInitial);if(pinInitial){const k=lowest.x+512+(lowest.z+512)*1024;this.foundation[k]=Math.max(this.foundation[k],lowest.y);}else groups.push(group);}
    for(const group of groups)for(const p of group)this.set(p.x,p.y,p.z,null);return groups;
  }
  raycast(origin,direction,maxDistance=60){const length=Math.hypot(direction.x,direction.y,direction.z);if(!length)return null;const d={x:direction.x/length,y:direction.y/length,z:direction.z/length},p={x:Math.floor(origin.x/CELL),y:Math.floor(origin.y/CELL),z:Math.floor(origin.z/CELL)},step={},next={},delta={};for(const axis of['x','y','z']){step[axis]=Math.sign(d[axis]);delta[axis]=d[axis]?Math.abs(CELL/d[axis]):Infinity;next[axis]=d[axis]?((p[axis]+(d[axis]>0?1:0))*CELL-origin[axis])/d[axis]:Infinity;}let distance=0,normal={x:0,y:0,z:0};while(distance<=maxDistance){const mat=this.get(p.x,p.y,p.z);if(mat)return{...p,mat,distance,normal,point:{x:origin.x+d.x*distance,y:origin.y+d.y*distance,z:origin.z+d.z*distance}};const axis=next.x<=next.y&&next.x<=next.z?'x':next.y<=next.z?'y':'z';distance=next[axis];p[axis]+=step[axis];next[axis]+=delta[axis];normal={x:0,y:0,z:0};normal[axis]=-step[axis];}return null;}
  collides(x,feetY,z,height=1.72,radius=.29){for(let b=Math.floor((feetY+.025)/CELL);b<=Math.floor((feetY+height-.025)/CELL);b++)for(let c=Math.floor((z-radius)/CELL);c<=Math.floor((z+radius)/CELL);c++)for(let a=Math.floor((x-radius)/CELL);a<=Math.floor((x+radius)/CELL);a++)if(this.getId(a,b,c))return true;return false;}
  snapshot(){const chunks=[];for(const c of this.chunks.values()){if(!c.count)continue;let runs=this.snapshotCache.get(c.key);if(!runs){runs=[];let id=c.data[0],length=1;for(let i=1;i<=32768;i++){if(i<32768&&c.data[i]===id)length++;else{runs.push(length,id);id=c.data[i];length=1;}}this.snapshotCache.set(c.key,runs);}chunks.push([c.key,runs]);}return{version:2,terrainVersion:this.terrainVersion??0,chunks,damage:[...this.damage],altered:[...this.altered]};}
  restore(s){if(s.version!==2)throw new Error('存档来自旧版地图');this.terrainVersion=s.terrainVersion??0;for(const key of this.chunks.keys()){this.dirty.add(key);this.lightDirty.add(key);}this.chunks.clear();this.snapshotCache=new Map(s.chunks);this.supportDirty.clear();this.count=0;for(const[key,runs]of s.chunks){const c=this.getChunk(key,true);let offset=0;for(let i=0;i<runs.length;i+=2){const length=runs[i],id=runs[i+1];c.data.fill(id,offset,offset+length);if(id)c.count+=length;offset+=length;}this.count+=c.count;this.dirty.add(key);this.lightDirty.add(key);this.supportDirty.add(key);}this.damage=new Map(s.damage);this.altered=new Set(s.altered||[]);this.revision++;this.contentRevision++;this.geometryRevision++;this.lastMutation=null;}
}
