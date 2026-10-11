import {CELL,CHUNK,MATERIAL_KEYS} from './voxel-world.js';

function cavityBounds(world,chunk){
  const min=[32,32,32],max=[-1,-1,-1],original=world.initialChunks?.get(chunk.key);
  const include=(x,y,z)=>{const p=[x,y,z];for(let a=0;a<3;a++){min[a]=Math.min(min[a],p[a]-1);max[a]=Math.max(max[a],p[a]+1);}};
  if(original)for(let i=0;i<32768;i++)if(original.data[i]&&!chunk.data[i])include(i&31,i>>10,(i>>5)&31);
  // A cut across the chunk boundary can expose this chunk without changing
  // any of its own cells. Include those edge cells as well.
  for(let axis=0;axis<3;axis++)for(const edge of[0,31])for(let a=0;a<32;a++)for(let b=0;b<32;b++){
    const p=[0,0,0];p[axis]=edge;p[(axis+1)%3]=a;p[(axis+2)%3]=b;
    const index=p[0]+p[1]*1024+p[2]*32;if(!chunk.data[index])continue;
    const q=[chunk.x+p[0],chunk.y+p[1],chunk.z+p[2]];q[axis]+=edge===0?-1:1;
    if(world.getOriginalId(...q)&&!world.getId(...q))include(...p);
  }
  return {min:min.map(n=>Math.max(0,n)),max:max.map(n=>Math.min(31,n))};
}

// Merge coplanar exposed faces while retaining the 10 cm destruction grid.
export function meshChunk(world,chunk,{cutFacesOnly=false,occupiedBounds=null}={}){
  const positions=[],normals=[],uvs=[],indices=[],buckets=Array.from({length:MATERIAL_KEYS.length},()=>[]);
  const origin=[chunk.x,chunk.y,chunk.z],mask=new Uint8Array(CHUNK*CHUNK),strides=[1,1024,32];
  // A detached piece knows its occupied extent within this chunk. Air outside
  // that extent cannot emit a face; neighbouring occupied chunks still decide
  // whether faces on the 32-cell boundary are exposed.
  const {min,max}=cutFacesOnly?cavityBounds(world,chunk):occupiedBounds??{min:[0,0,0],max:[31,31,31]};
  for(let axis=0;axis<3;axis++){
    const u=(axis+1)%3,v=(axis+2)%3,p=[0,0,0];
    for(const sign of[-1,1])for(let slice=min[axis];slice<=max[axis];slice++){
      p[axis]=slice;
      for(let j=min[v];j<=max[v];j++)for(let i=min[u];i<=max[u];i++){
        p[u]=i;p[v]=j;const offset=p[0]+p[1]*1024+p[2]*32,id=chunk.data[offset];
        if(!id||world.nativePaletteRecords?.has(world.assetOwners.get(chunk.key)?.[offset])){mask[i+j*CHUNK]=0;continue;}
        const neighbor=slice+sign>=0&&slice+sign<CHUNK?chunk.data[offset+sign*strides[axis]]:world.getId(origin[0]+p[0]+(axis===0?sign:0),origin[1]+p[1]+(axis===1?sign:0),origin[2]+p[2]+(axis===2?sign:0));
        // Imported outer surfaces remain precise. For a cut chunk, add only
        // cavity faces adjacent to cells that originally held solid material.
        const cavity=!neighbor&&(!cutFacesOnly||world.getOriginalId(origin[0]+p[0]+(axis===0?sign:0),origin[1]+p[1]+(axis===1?sign:0),origin[2]+p[2]+(axis===2?sign:0)));
        mask[i+j*CHUNK]=neighbor||!cavity?0:id;
      }
      for(let j=min[v];j<=max[v];j++)for(let i=min[u];i<=max[u];){
        const id=mask[i+j*CHUNK];if(!id){i++;continue;}
        let w=1,h=1;while(i+w<=max[u]&&mask[i+w+j*CHUNK]===id)w++;
        height:while(j+h<=max[v]){for(let k=0;k<w;k++)if(mask[i+k+(j+h)*CHUNK]!==id)break height;h++;}
        const start=positions.length/3,normal=[0,0,0];normal[axis]=sign;
        const corners=sign>0?[[0,0],[w,0],[w,h],[0,h]]:[[0,h],[w,h],[w,0],[0,0]];
        for(const[a,b]of corners){const q=[...origin];q[axis]+=slice+(sign>0?1:0);q[u]+=i+a;q[v]+=j+b;positions.push(q[0]*CELL,q[1]*CELL,q[2]*CELL);normals.push(...normal);uvs.push(q[u]*CELL/2.4,q[v]*CELL/2.4);}
        buckets[id].push(start,start+1,start+2,start,start+2,start+3);
        for(let b=0;b<h;b++)mask.fill(0,i+(j+b)*CHUNK,i+w+(j+b)*CHUNK);i+=w;
      }
    }
  }
  const groups=[];for(let id=1;id<buckets.length;id++)if(buckets[id].length){groups.push({start:indices.length,count:buckets[id].length,materialIndex:id});for(const index of buckets[id])indices.push(index);}
  return{positions,normals,uvs,indices,groups};
}
