import {MATERIAL_KEYS} from './voxel-world.js';

// Cache the precise imported vertices once. A voxel deletion mask clips only
// the actual opening; cavity meshes add the newly exposed interior faces.
export function buildSourceData(sourceMeshes,keys){
  const entries=[],groups=[],ranges=new Map(),spans=[];let vertices=0;
  for(let mat=1;mat<MATERIAL_KEYS.length;mat++){
    const start=vertices;
    for(const key of keys)for(const [id,points]of sourceMeshes.get(key)||[]){
      if(id!==mat||!points.length)continue;
      const range={key,mat,start:vertices,count:points.length/3};spans.push(range);
      if(!ranges.has(key))ranges.set(key,[]);ranges.get(key).push(range);
      entries.push({points,start:vertices});vertices+=range.count;
    }
    if(vertices>start)groups.push({start,count:vertices-start,materialIndex:mat});
  }
  const positions=new Float32Array(vertices*3),normals=new Float32Array(vertices*3),uvs=new Float32Array(vertices*2),sourceChunks=new Float32Array(vertices);
  for(const [key,spans]of ranges)for(const {start,count}of spans)sourceChunks.fill(key,start,start+count);
  for(const {points,start}of entries){
    positions.set(points,start*3);
    for(let i=0;i<points.length;i+=9){
      const bx=points[i+3]-points[i],by=points[i+4]-points[i+1],bz=points[i+5]-points[i+2];
      const cx=points[i+6]-points[i],cy=points[i+7]-points[i+1],cz=points[i+8]-points[i+2];
      const nx=by*cz-bz*cy,ny=bz*cx-bx*cz,nz=bx*cy-by*cx,length=Math.hypot(nx,ny,nz)||1;
      const axis=Math.abs(nx)>Math.abs(ny)&&Math.abs(nx)>Math.abs(nz)?0:Math.abs(ny)>Math.abs(nz)?1:2,u=(axis+1)%3,v=(axis+2)%3;
      for(let j=0;j<3;j++){const vertex=start+i/3+j;normals.set([nx/length,ny/length,nz/length],vertex*3);uvs[vertex*2]=points[i+j*3+u]/2.4;uvs[vertex*2+1]=points[i+j*3+v]/2.4;}
    }
  }
  return {positions,normals,uvs,sourceChunks,groups,ranges,spans,vertices};
}

export function partitionSource(data,altered,pristine,cut){
  let intactCount=0,cutCount=0;const intactGroups=[],cutGroups=[];
  for(const group of data.groups){
    const a=intactCount,b=cutCount;
    for(const span of data.spans)if(span.mat===group.materialIndex){
      if(altered.has(span.key))for(let i=span.start;i<span.start+span.count;i++)cut[cutCount++]=data.indices?data.indices[i]:i;
      else for(let i=span.start;i<span.start+span.count;i++)pristine[intactCount++]=data.indices?data.indices[i]:i;
    }
    if(intactCount>a)intactGroups.push({start:a,count:intactCount-a,materialIndex:group.materialIndex});
    if(cutCount>b)cutGroups.push({start:b,count:cutCount-b,materialIndex:group.materialIndex});
  }
  return {intactCount,cutCount,intactGroups,cutGroups};
}
