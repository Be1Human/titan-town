import {CELL,MATERIAL_KEYS,chunkCoords} from './voxel-world.js';

// Six integers encode a merged voxel face: local minimum XYZ, width, height,
// and material/axis/sign. Four vertices are shared by its two triangles.
export function packVoxelSurfaces(data,chunk){
  const faces=[];
  for(const group of data.groups)for(let i=group.start;i<group.start+group.count;i+=6){
    const first=data.indices[i],axis=[0,1,2].find(a=>data.normals[first*3+a]!==0),sign=data.normals[first*3+axis];
    const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
    for(let j=0;j<6;j++)for(let a=0;a<3;a++){const n=Math.round(data.positions[data.indices[i+j]*3+a]/CELL);min[a]=Math.min(min[a],n);max[a]=Math.max(max[a],n);}
    faces.push(min[0]-chunk.x,min[1]-chunk.y,min[2]-chunk.z,max[(axis+1)%3]-min[(axis+1)%3],max[(axis+2)%3]-min[(axis+2)%3],(group.materialIndex-1)*8+axis*2+Number(sign>0));
  }
  return faces;
}

export function buildVoxelSurfaceData(surfaces,keys){
  const entries=[],groups=[],spans=[],ranges=new Map();let vertices=0,elements=0;
  for(let mat=1;mat<MATERIAL_KEYS.length;mat++){
    const start=elements;
    for(const key of keys){
      const quads=surfaces.get(key)||[],faces=[];
      for(let i=0;i<quads.length;i+=6)if(Math.floor(quads[i+5]/8)+1===mat)faces.push(i);
      if(!faces.length)continue;
      const span={key,mat,start:elements,count:faces.length*6};spans.push(span);
      if(!ranges.has(key))ranges.set(key,[]);ranges.get(key).push(span);
      entries.push({key,quads,faces,vertex:vertices,element:elements});vertices+=faces.length*4;elements+=span.count;
    }
    if(elements>start)groups.push({start,count:elements-start,materialIndex:mat});
  }
  const positions=new Float32Array(vertices*3),normals=new Float32Array(vertices*3),sourceChunks=new Float32Array(vertices),indices=new Uint32Array(elements);
  // A merged face owns an integer rectangle of solid cells. Six bytes per
  // vertex keep mask samples inside that rectangle at rasterized grid edges.
  const sourceCellMin=new Uint8Array(vertices*3),sourceCellMax=new Uint8Array(vertices*3);
  for(const entry of entries){
    const origin=chunkCoords(entry.key),base=[origin.x,origin.y,origin.z];let vertex=entry.vertex,element=entry.element;
    for(const i of entry.faces){
      const q=entry.quads,code=q[i+5]%8,axis=Math.floor(code/2),sign=code%2?1:-1,u=(axis+1)%3,v=(axis+2)%3,w=q[i+3],h=q[i+4];
      const cellMin=[q[i],q[i+1],q[i+2]];cellMin[axis]-=Number(sign>0);
      const cellMax=[...cellMin];cellMax[u]+=w-1;cellMax[v]+=h-1;
      const corners=sign>0?[[0,0],[w,0],[w,h],[0,h]]:[[0,h],[w,h],[w,0],[0,0]];
      for(let j=0;j<4;j++){
        const p=[base[0]+q[i],base[1]+q[i+1],base[2]+q[i+2]];p[u]+=corners[j][0];p[v]+=corners[j][1];
        for(let a=0;a<3;a++){positions[(vertex+j)*3+a]=p[a]*CELL;normals[(vertex+j)*3+a]=a===axis?sign:0;}
        sourceChunks[vertex+j]=entry.key;
        sourceCellMin.set(cellMin,(vertex+j)*3);sourceCellMax.set(cellMax,(vertex+j)*3);
      }
      indices.set([vertex,vertex+1,vertex+2,vertex,vertex+2,vertex+3],element);vertex+=4;element+=6;
    }
  }
  return {positions,normals,sourceChunks,sourceCellMin,sourceCellMax,indices,groups,spans,ranges,vertices,elements};
}
