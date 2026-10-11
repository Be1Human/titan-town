import * as THREE from '../vendor/three.module.js';
import {CELL} from './voxel-world.js';

export function buildNativePaletteGeometry(component,dense,asset,materialIndices){
  const positions=[],normals=[],colors=[],buckets=new Map(),size=component.size,[sx,sy,sz]=size;
  const sourceColors=new Map(),color=new THREE.Color();
  const transparent=new Set(Object.entries(asset.paletteAppearance??{}).filter(([,p])=>p.opacity<1).map(([i])=>Number(i)));
  for(const [index,rgba]of Object.entries(asset.palette)){
    color.setRGB(rgba[0]/255,rgba[1]/255,rgba[2]/255,THREE.SRGBColorSpace);
    sourceColors.set(Number(index),[color.r,color.g,color.b]);
  }
  const strides=[1,sx,sx*sy];
  for(let axis=0;axis<3;axis++){
    const u=(axis+1)%3,v=(axis+2)%3,mask=new dense.constructor(size[u]*size[v]);
    for(const sign of[-1,1])for(let slice=0;slice<size[axis];slice++){
      const p=[0,0,0];p[axis]=slice;
      for(let j=0;j<size[v];j++)for(let i=0;i<size[u];i++){
        p[u]=i;p[v]=j;const offset=p[0]+p[1]*sx+p[2]*sx*sy,id=dense[offset];
        const q=slice+sign;
        const neighbour=q>=0&&q<size[axis]?dense[offset+sign*strides[axis]]:(component.neighbourAt?component.neighbourAt(p[0]+(axis===0?sign:0),p[1]+(axis===1?sign:0),p[2]+(axis===2?sign:0)):0);
        mask[i+j*size[u]]=id&&(!neighbour||(!transparent.has(id)&&transparent.has(neighbour)))?id:0;
      }
      for(let j=0;j<size[v];j++)for(let i=0;i<size[u];){
        const id=mask[i+j*size[u]];if(!id){i++;continue;}
        let width=1,height=1;
        while(i+width<size[u]&&mask[i+width+j*size[u]]===id)width++;
        grow:while(j+height<size[v]){
          for(let k=0;k<width;k++)if(mask[i+k+(j+height)*size[u]]!==id)break grow;
          height++;
        }
        const start=positions.length/3,n=[0,0,0];n[axis]=sign;
        const rgb=sourceColors.get(id),materialIndex=materialIndices.get(id);
        const corners=sign>0?[[0,0],[width,0],[width,height],[0,height]]:[[0,height],[width,height],[width,0],[0,0]];
        for(const [a,b]of corners){
          const q=[0,0,0];q[axis]=slice+(sign>0?1:0);q[u]=i+a;q[v]=j+b;
          positions.push(q[0]*CELL,q[1]*CELL,q[2]*CELL);normals.push(...n);colors.push(...rgb);
        }
        let bucket=buckets.get(materialIndex);if(!bucket){bucket=[];buckets.set(materialIndex,bucket);}
        bucket.push(start,start+1,start+2,start,start+2,start+3);
        for(let row=0;row<height;row++)mask.fill(0,i+(j+row)*size[u],i+width+(j+row)*size[u]);
        i+=width;
      }
    }
  }
  const geometry=new THREE.BufferGeometry(),indices=[];
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
  geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  for(const [materialIndex,bucket]of buckets){
    geometry.addGroup(indices.length,bucket.length,materialIndex);for(const index of bucket)indices.push(index);
  }
  geometry.setIndex(indices);geometry.computeBoundingBox();geometry.computeBoundingSphere();
  return geometry;
}

