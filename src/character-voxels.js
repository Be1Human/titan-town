import * as THREE from '../vendor/three.module.js';
import {CHARACTER_CELL as CELL,CHARACTER_PARTS,MAX_VOXEL_EDITS,normalizeVoxelEdits} from './character-config.js';

export const cellKey=(x,y,z)=>`${x},${y},${z}`;

// Store cells in joint-local grids, then merge only coplanar faces of the same
// colour and joint. Rigid skinning keeps every edited voxel square in motion.
export function createCharacterVoxels(rig){
  const parts=CHARACTER_PARTS.map((name,index)=>({name,index,origin:[...rig.points[name]],cells:new Map()}));
  for(const part of parts)if(part.name.endsWith('Foot'))part.origin[1]=0;
  function box(p,s,paint,name='spine'){
    const part=parts.find(v=>v.name===name),ranges=p.map((value,i)=>{
      const middle=(value-part.origin[i])/CELL,span=Math.max(1,Math.round(s[i]/CELL));
      const start=Math.round(middle-span/2);return [start,start+span];
    });
    for(let x=ranges[0][0];x<ranges[0][1];x++)for(let y=ranges[1][0];y<ranges[1][1];y++)for(let z=ranges[2][0];z<ranges[2][1];z++){
      if(part.origin[1]+y*CELL<-.00001)continue;
      part.cells.set(cellKey(x,y,z),paint);
    }
  }
  function apply(edits){
    for(const [index,x,y,z,paint]of normalizeVoxelEdits(edits)){
      const part=parts[index],key=cellKey(x,y,z);
      if(paint===null)part.cells.delete(key);
      else if(part.origin[1]+y*CELL>=-.00001)part.cells.set(key,paint);
    }
  }
  function finish(){
    const positions=[],normals=[],colors=[],weights=[],skinIndices=[],partIndices=[],indices=[],finishes=[];
    const colorCache=new Map(),boneIndex=Object.fromEntries(rig.list.map((bone,i)=>[bone.name,i]));
    for(const part of parts)for(let axis=0;axis<3;axis++)for(const direction of [-1,1]){
      const u=(axis+1)%3,v=(axis+2)%3,planes=new Map();
      for(const [key,paint]of part.cells){
        const p=key.split(',').map(Number),neighbor=[...p];neighbor[axis]+=direction;
        if(part.cells.has(cellKey(...neighbor)))continue;
        const layer=p[axis]+(direction>0?1:0),planeKey=`${layer}:${paint}`;
        let plane=planes.get(planeKey);if(!plane){plane={layer,paint,cells:new Set()};planes.set(planeKey,plane);}
        plane.cells.add(`${p[u]},${p[v]}`);
      }
      for(const plane of planes.values())while(plane.cells.size){
        const [x,y]=plane.cells.values().next().value.split(',').map(Number);
        let w=1,h=1;while(plane.cells.has(`${x+w},${y}`))w++;
        outer:while(true){for(let i=0;i<w;i++)if(!plane.cells.has(`${x+i},${y+h}`))break outer;h++;}
        for(let i=0;i<w;i++)for(let j=0;j<h;j++)plane.cells.delete(`${x+i},${y+j}`);
        const corners=[[x,y],[x+w,y],[x+w,y+h],[x,y+h]],offset=positions.length/3;
        let c=colorCache.get(plane.paint);if(!c){c=new THREE.Color(plane.paint);colorCache.set(plane.paint,c);}
        for(const [corner,[a,b]]of corners.entries()){
          const p=[...part.origin],n=[0,0,0];p[axis]+=plane.layer*CELL;p[u]+=a*CELL;p[v]+=b*CELL;n[axis]=direction;
          // Recessed voxel corners remain readable in every animated pose.
          const sample=[0,0,0],su=corner===0||corner===3?-1:1,sv=corner<2?-1:1;
          sample[axis]=plane.layer+(direction>0?0:-1);sample[u]=a+(su>0?-1:0);sample[v]=b+(sv>0?-1:0);
          const occupied=(du,dv)=>{const q=[...sample];q[u]+=du;q[v]+=dv;return Number(part.cells.has(cellKey(...q)));};
          const sideU=occupied(su,0),sideV=occupied(0,sv),ao=sideU&&sideV?0:3-sideU-sideV-occupied(su,sv),shade=.62+.38*ao/3;
          positions.push(...p);normals.push(...n);colors.push(c.r*shade,c.g*shade,c.b*shade);finishes.push(.92,0);
          skinIndices.push(boneIndex[part.name],0,0,0);weights.push(1,0,0,0);partIndices.push(part.index);
        }
        indices.push(...(direction>0?[0,1,2,0,2,3]:[0,2,1,0,3,2]).map(i=>i+offset));
      }
    }
    const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
    g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));g.setAttribute('workerSurface',new THREE.Float32BufferAttribute(finishes,2));
    g.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(skinIndices,4));g.setAttribute('skinWeight',new THREE.Float32BufferAttribute(weights,4));
    g.setAttribute('characterPart',new THREE.Uint8BufferAttribute(partIndices,1));g.setIndex(indices);g.computeBoundingBox();g.computeBoundingSphere();
    return g;
  }
  return {parts,box,apply,finish};
}

export function hitCharacterCell(hit,mesh,parts,{add=false}={}){
  if(!hit?.face||hit.object!==mesh)return null;
  const index=mesh.geometry.attributes.characterPart.getX(hit.face.a),part=parts[index];
  const p=mesh.worldToLocal(hit.point.clone()),normal=hit.face.normal;
  let coords=['x','y','z'].map((axis,i)=>Math.floor((p[axis]-part.origin[i])/CELL+normal[axis]*(add?.001:-.001)));
  // Authored planar surfaces are not snapped to the sculpture grid. Resolve
  // their nearest occupied cell before painting/removing or adding its neighbour.
  if(mesh.geometry.userData.planarCharacter&&!part.cells.has(cellKey(...coords))){
    const inward=['x','y','z'].map((axis,i)=>Math.floor((p[axis]-part.origin[i])/CELL-normal[axis]*.001));let nearest=null,distance=Infinity;
    for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++){const q=inward.map((v,i)=>v+[x,y,z][i]);if(!part.cells.has(cellKey(...q)))continue;const d=q.reduce((sum,v,i)=>sum+(part.origin[i]+(v+.5)*CELL-p.getComponent(i))**2,0);if(d<distance){nearest=q;distance=d;}}
    if(nearest){coords=nearest;if(add){const axis=[0,1,2].sort((a,b)=>Math.abs(normal.getComponent(b))-Math.abs(normal.getComponent(a)))[0];coords=[...nearest];coords[axis]+=Math.sign(normal.getComponent(axis));}}
  }
  return {part:index,coords,paint:part.cells.get(cellKey(...coords)),center:coords.map((n,i)=>part.origin[i]+(n+.5)*CELL)};
}

export function editCharacterCell(profile,target,mode,paint){
  if(!target||!['add','paint','remove'].includes(mode))return profile;
  const [x,y,z]=target.coords;if(![x,y,z].every(n=>Number.isInteger(n)&&Math.abs(n)<=32))return profile;
  if(mode!=='add'&&!target.paint)return profile;
  const edits=normalizeVoxelEdits(profile.voxelEdits),key=[target.part,x,y,z].join(',');
  const index=edits.findIndex(v=>v.slice(0,4).join(',')===key);
  const entry=[target.part,x,y,z,mode==='remove'?null:paint];
  if(index>=0)edits[index]=entry;else if(edits.length<MAX_VOXEL_EDITS)edits.push(entry);else return profile;
  return {...profile,voxelEdits:normalizeVoxelEdits(edits)};
}
