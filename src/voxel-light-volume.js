import {CHUNK,chunkCoords,MATERIAL_IDS} from './voxel-world.js';

// A 40 cm block stores 64 individual 10 cm occupancy bits. Empty blocks are
// skipped by the GPU; small holes retain the same resolution as destruction.
export const LIGHT_BLOCK_CELLS=4;
// The reconstructed props extend a few cells beyond the original BSP sector.
export const LIGHT_BOUNDS={min:[-424,0,-504],size:[848,256,1008]};
export class VoxelLightVolume{
  constructor({min=LIGHT_BOUNDS.min,size=LIGHT_BOUNDS.size}={}){
    if([...min,...size].some(n=>n%4))throw new Error('Light volume bounds must align to four cells');
    this.min=[...min];this.size=size.map(n=>n/4);
    const count=this.size.reduce((a,b)=>a*b,1);
    this.bits=new Uint32Array(count*2);this.materials=new Uint8Array(count);
  }
  index(x,y,z){
    const p=[x,y,z].map((n,a)=>Math.floor((n-this.min[a])/4));
    if(p.some((n,a)=>n<0||n>=this.size[a]))return -1;
    return p[0]+this.size[0]*(p[1]+this.size[1]*p[2]);
  }
  occupied(x,y,z){
    const i=this.index(x,y,z);if(i<0)return false;
    const bit=(x&3)+(y&3)*4+(z&3)*16;
    return Boolean(this.bits[i*2+(bit>>>5)]&(1<<(bit&31)));
  }
  region(key){
    const c=chunkCoords(key),origin=[c.x,c.y,c.z];
    const min=origin.map((n,i)=>Math.max(0,(n-this.min[i])/4));
    const max=origin.map((n,i)=>Math.min(this.size[i],(n+CHUNK-this.min[i])/4));
    return max.some((n,i)=>n<=min[i])?null:{min,max};
  }
  updateChunk(world,key){
    const c=world.chunks.get(key),p=c||chunkCoords(key);let changed=0;
    for(let z=0;z<CHUNK;z+=4)for(let y=0;y<CHUNK;y+=4)for(let x=0;x<CHUNK;x+=4){
      const i=this.index(p.x+x,p.y+y,p.z+z);if(i<0)continue;
      let lo=0,hi=0,material=0;
      if(c)for(let dz=0;dz<4;dz++)for(let dy=0;dy<4;dy++)for(let dx=0;dx<4;dx++){
        const id=c.data[x+dx+(z+dz)*32+(y+dy)*1024];if(!id)continue;
        const bit=dx+dy*4+dz*16;
        if(bit<32)lo|=1<<bit;else hi|=1<<(bit-32);
        if(!material)material=id;
      }
      lo>>>=0;hi>>>=0;
      if(this.bits[i*2]!==lo||this.bits[i*2+1]!==hi||this.materials[i]!==material){
        this.bits[i*2]=lo;this.bits[i*2+1]=hi;this.materials[i]=material;changed++;
      }
    }
    return changed;
  }
  rebuild(world){for(const key of world.chunks.keys())this.updateChunk(world,key);return this;}
  snapshot(){
    const runs=[];let start=0;
    for(let i=1;i<=this.materials.length;i++)if(i===this.materials.length||this.bits[i*2]!==this.bits[start*2]||this.bits[i*2+1]!==this.bits[start*2+1]||this.materials[i]!==this.materials[start]){
      runs.push(i-start,this.bits[start*2],this.bits[start*2+1],this.materials[start]);start=i;
    }
    return {version:1,min:this.min,size:this.size.map(n=>n*4),runs};
  }
  restore(snapshot){
    if(snapshot.version!==1||snapshot.min.some((n,i)=>n!==this.min[i])||snapshot.size.some((n,i)=>n!==this.size[i]*4))throw new Error('Incompatible light volume');
    let offset=0;
    for(let r=0;r<snapshot.runs.length;r+=4){
      const [count,lo,hi,material]=snapshot.runs.slice(r,r+4);
      for(let i=offset;i<offset+count;i++){this.bits[i*2]=lo;this.bits[i*2+1]=hi;}
      this.materials.fill(material,offset,offset+count);offset+=count;
    }
    if(offset!==this.materials.length)throw new Error('Incomplete light volume');return this;
  }
}

// Bounded exact occupancy atlas for nearby moving objects. Geometry uploads
// only when a slot or shape revision changes; pose changes use uniforms. This
// supplements static light occupancy rather than overwriting terrain bits.
export class DynamicVoxelLightVolume{
  constructor({limit=4,side=128}={}){this.limit=limit;this.side=side;this.data=new Uint8Array(side**3*limit);this.slots=[];this.bytes=this.data.byteLength;this.shapeCache=new WeakMap();}
  update(entries,eye={x:0,y:0,z:0}){
    const candidates=[...(entries?.values?.()||entries||[])].filter(e=>e.cells?.length&&!e.hiddenVisual&&e.visual!==false&&!String(e.id).startsWith('cargo-')).sort((a,b)=>(a.position.x-eye.x)**2+(a.position.y-eye.y)**2+(a.position.z-eye.z)**2-((b.position.x-eye.x)**2+(b.position.y-eye.y)**2+(b.position.z-eye.z)**2));
    const selected=[];let skipped=0;const dirtySlots=[];
    for(const entry of candidates){
      if(selected.length>=this.limit){skipped++;continue;}
      let shape=this.shapeCache.get(entry.cells);if(!shape||shape.revision!==entry.revision){const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];let glass=false;for(const c of entry.cells){glass||=c.mat==='glass'||(!entry.palette&&c.paletteIndex===MATERIAL_IDS.glass);for(let a=0;a<3;a++){const n=c[['x','y','z'][a]];min[a]=Math.min(min[a],n);max[a]=Math.max(max[a],n+1);}}shape={min,max,glass,revision:entry.revision,size:max.map((v,a)=>v-min[a])};this.shapeCache.set(entry.cells,shape);}
      if(shape.glass||shape.size.some(v=>v>this.side)){skipped++;continue;}selected.push({entry,shape});
    }
    // Keep atlas slots stable while objects move past one another. Nearest
    // membership changes can upload, distance-order swaps alone cannot.
    selected.sort((a,b)=>String(a.entry.id).localeCompare(String(b.entry.id)));
    const next=selected.map(({entry,shape},i)=>{const old=this.slots[i],cellSize=entry.cellSize||.1;if(old?.entry.id===entry.id&&old.revision===entry.revision&&old.cells===entry.cells&&old.cellSize===cellSize){old.entry=entry;return old;}dirtySlots.push(i);return {entry,revision:entry.revision,cells:entry.cells,...shape,cellSize,localMin:shape.min.map((n,a)=>n*cellSize-entry.center[['x','y','z'][a]]),localMax:shape.max.map((n,a)=>n*cellSize-entry.center[['x','y','z'][a]])};});
    for(let i=next.length;i<this.slots.length;i++)dirtySlots.push(i);
    for(const i of dirtySlots){this.data.fill(0,i*this.side**3,(i+1)*this.side**3);const slot=next[i];if(slot)for(const c of slot.cells){const x=c.x-slot.min[0],y=c.y-slot.min[1],z=c.z-slot.min[2]+i*this.side;this.data[x+this.side*(y+this.side*z)]=(slot.entry.palette?MATERIAL_IDS[c.mat]:c.paletteIndex??MATERIAL_IDS[c.mat])??0;}}
    this.slots=next;return {changed:dirtySlots.length>0,dirtySlots,count:next.length,skipped,bytes:dirtySlots.length*this.side**3};
  }
}

export function sampleToolLighting(world,position,sunDirection){
  const sunlight=world.raycast(position,sunDirection,90)?0:1;
  let open=0;
  for(const d of [{x:0,y:1,z:0},{x:.8,y:.6,z:0},{x:-.8,y:.6,z:0},{x:0,y:.6,z:.8},{x:0,y:.6,z:-.8}])if(!world.raycast(position,d,9))open++;
  return {sunlight,sky:open/5};
}
