import * as THREE from '../../../vendor/three.module.js';
import {CELL,MATERIAL_KEYS} from '../../voxel-world.js';

const strides=[1,1024,32];
export const PAGE_SLICES=192;
export const sliceId=(axis,positive,slice)=>axis*64+positive*32+slice;
// Same greedy scan and vertex order as meshChunk, specialized for occupied
// rigid pages. Eight bytes per quad replace per-face JS arrays and buckets.
// No decimation: all six neighbours, material seams and authored air survive.
// A face slice depends only on its own layer and the next one along its normal,
// so `state.slices` keeps each slice's quads and `dirty` re-scans only those.
export function meshFragmentPage(chunks,c,center,cellSize=CELL,state=null,dirty=null){
  const origin=[c.x,c.y,c.z],offset=[center.x,center.y,center.z],min=c.bounds.min,max=c.bounds.max;
  const mask=new Uint8Array(1024),counts=new Uint32Array(MATERIAL_KEYS.length);
  const slices=state?(state.slices??=new Array(PAGE_SLICES).fill(null)):null,rescan=!slices||!dirty||state.complete!==true;
  let quads=new Uint8Array(8192),used=0;
  for(let axis=0;axis<3;axis++){
    const u=(axis+1)%3,v=(axis+2)%3,sa=strides[axis],su=strides[u],sv=strides[v];
    for(let positive=0;positive<2;positive++){
      const sign=positive?1:-1,neighborOrigin=origin.slice();neighborOrigin[axis]+=sign*32;
      const neighbor=chunks.get(neighborOrigin.join(','))?.data;
      for(let slice=min[axis];slice<=max[axis];slice++){
        const id0=sliceId(axis,positive,slice);
        if(!rescan&&!dirty.has(id0)){const kept=slices[id0];if(kept){
          if(used+kept.length>quads.length){let size=quads.length*2;while(size<used+kept.length)size*=2;const next=new Uint8Array(size);next.set(quads.subarray(0,used));quads=next;}
          quads.set(kept,used);used+=kept.length;for(let k=7;k<kept.length;k+=8)counts[kept[k]]+=6;}continue;}
        const start=used;
        const inside=slice+sign>=0&&slice+sign<32,base=slice*sa,neighborBase=(positive?0:31)*sa;
        for(let j=min[v];j<=max[v];j++){
          const row=j*32,indexBase=base+j*sv;
          for(let i=min[u];i<=max[u];i++){
            const index=indexBase+i*su,id=c.data[index];
            mask[row+i]=id&&!(inside?c.data[index+sign*sa]:neighbor?.[neighborBase+j*sv+i*su])?id:0;
          }
        }
        for(let j=min[v];j<=max[v];j++)for(let i=min[u];i<=max[u];){
          const id=mask[i+j*32];if(!id){i++;continue;}
          let w=1,h=1;while(i+w<=max[u]&&mask[i+w+j*32]===id)w++;
          height:while(j+h<=max[v]){for(let k=0;k<w;k++)if(mask[i+k+(j+h)*32]!==id)break height;h++;}
          if(used+8>quads.length){const next=new Uint8Array(quads.length*2);next.set(quads);quads=next;}
          quads[used++]=axis;quads[used++]=positive;quads[used++]=slice;quads[used++]=i;
          quads[used++]=j;quads[used++]=w;quads[used++]=h;quads[used++]=id;counts[id]+=6;
          for(let b=0;b<h;b++)mask.fill(0,i+(j+b)*32,i+w+(j+b)*32);i+=w;
        }
        if(slices)slices[id0]=used>start?quads.slice(start,used):null;
      }
    }
  }
  if(state)state.complete=true;
  const count=used/8,positions=new Float32Array(count*12),normals=new Float32Array(count*12),uvs=new Float32Array(count*8);
  const indices=count*4-1>=65535?new Uint32Array(count*6):new Uint16Array(count*6),cursor=new Uint32Array(counts.length),g=new THREE.BufferGeometry();
  let start=0;for(let id=1;id<counts.length;id++)if(counts[id]){cursor[id]=start;g.addGroup(start,counts[id],id);start+=counts[id];}
  for(let n=0;n<count;n++){
    const k=n*8,axis=quads[k],positive=quads[k+1],u=(axis+1)%3,v=(axis+2)%3,slice=quads[k+2],i=quads[k+3],j=quads[k+4],w=quads[k+5],h=quads[k+6],id=quads[k+7];
    for(let corner=0;corner<4;corner++){
      const a=corner===1||corner===2?w:0,b=positive?(corner>=2?h:0):(corner<2?h:0),vertex=n*4+corner,p=vertex*3;
      // Preserve the old double arithmetic before the final Float32 store.
      positions[p+axis]=(origin[axis]+slice+positive)*CELL*cellSize/CELL-offset[axis];
      positions[p+u]=(origin[u]+i+a)*CELL*cellSize/CELL-offset[u];
      positions[p+v]=(origin[v]+j+b)*CELL*cellSize/CELL-offset[v];normals[p+axis]=positive?1:-1;
      uvs[vertex*2]=(origin[u]+i+a)*CELL/2.4;uvs[vertex*2+1]=(origin[v]+j+b)*CELL/2.4;
    }
    const at=cursor[id],vertex=n*4;indices[at]=vertex;indices[at+1]=vertex+1;indices[at+2]=vertex+2;
    indices[at+3]=vertex;indices[at+4]=vertex+2;indices[at+5]=vertex+3;cursor[id]+=6;
  }
  g.setAttribute('position',new THREE.BufferAttribute(positions,3));g.setAttribute('normal',new THREE.BufferAttribute(normals,3));
  g.setAttribute('uv',new THREE.BufferAttribute(uvs,2));g.setIndex(new THREE.BufferAttribute(indices,1));g.computeBoundingSphere();return g;
}
