import * as THREE from '../vendor/three.module.js';

// The indestructible upper wall above the voxel wall (y >= config.bottom). It
// never holds voxel cells, so holes blown into the voxel wall stay open; it
// only adds collision boxes to `world.collides` / `world.raycast`.
export function farWallBoxes(config){
  return (config?.boxes??[]).map(b=>({id:b.id,min:[...b.min],max:[...b.max]}));
}

export function boxRay(box,origin,d,max){
  let t0=0,t1=max,axis=-1,sign=0;
  const o=[origin.x,origin.y,origin.z],v=[d.x,d.y,d.z];
  for(let i=0;i<3;i++){
    if(Math.abs(v[i])<1e-12){if(o[i]<box.min[i]||o[i]>box.max[i])return null;continue;}
    let a=(box.min[i]-o[i])/v[i],b=(box.max[i]-o[i])/v[i],s=-Math.sign(v[i]);
    if(a>b){[a,b]=[b,a];}
    if(a>t0){t0=a;axis=i;sign=s;}
    if(b<t1)t1=b;
    if(t0>t1)return null;
  }
  if(axis<0)return null;
  const normal={x:0,y:0,z:0};normal['xyz'[axis]]=sign;
  return {distance:t0,normal};
}

export function installFarWall(world,config){
  const boxes=farWallBoxes(config);
  if(!boxes.length||world.farWall)return world.farWall??null;
  const voxelCollides=world.collides.bind(world),voxelRaycast=world.raycast.bind(world);
  function boxCollides(x,feetY,z,height=1.72,radius=.29){
    for(const b of boxes)if(x+radius>b.min[0]&&x-radius<b.max[0]&&z+radius>b.min[2]&&z-radius<b.max[2]&&feetY+height>b.min[1]&&feetY<b.max[1])return true;
    return false;
  }
  function boxRaycast(origin,direction,max){
    const length=Math.hypot(direction.x,direction.y,direction.z);if(!length)return null;
    const d={x:direction.x/length,y:direction.y/length,z:direction.z/length};let best=null;
    for(const b of boxes){const hit=boxRay(b,origin,d,max);if(hit&&(!best||hit.distance<best.distance))best={...hit,box:b.id};}
    if(!best)return null;
    return {farWall:true,box:best.box,mat:'stone',distance:best.distance,normal:best.normal,point:{x:origin.x+d.x*best.distance,y:origin.y+d.y*best.distance,z:origin.z+d.z*best.distance}};
  }
  world.collides=(x,feetY,z,height,radius)=>voxelCollides(x,feetY,z,height,radius)||boxCollides(x,feetY,z,height,radius);
  world.raycast=(origin,direction,max=60)=>{
    const wall=boxRaycast(origin,direction,max),voxel=voxelRaycast(origin,direction,wall?wall.distance:max);
    return voxel&&(!wall||voxel.distance<=wall.distance)?voxel:wall;
  };
  world.farWall={config,boxes,collides:boxCollides,raycast:boxRaycast,top:config.top,bottom:config.bottom};
  return world.farWall;
}

// Giant ashlar texture: 3.2 m courses of 4.8–9.6 m stones with dark joints,
// a light top bevel, a dark bottom bevel and weathering streaks; one tile is
// 25.6 × 12.8 m. Deterministic, sRGB.
function ashlarCanvas(){
  const canvas=document.createElement('canvas');canvas.width=512;canvas.height=256;const g=canvas.getContext('2d');
  let seed=7;const rnd=()=>{seed=(seed*16807)%2147483647;return seed/2147483647;};
  g.fillStyle='#4f4a43';g.fillRect(0,0,512,256);
  for(let row=0;row<4;row++){
    const y=row*64;let x=-Math.floor(rnd()*96);
    while(x<512){
      const w=96+Math.floor(rnd()*4)*32,v=128+Math.floor(rnd()*30),warm=Math.floor(rnd()*8);
      for(const dx of [0,-512,512]){
        const x0=x+dx+3,w0=w-6;
        g.fillStyle=`rgb(${v+warm},${v-3},${v-12})`;g.fillRect(x0,y+3,w0,58);
        g.fillStyle=`rgba(255,248,232,.22)`;g.fillRect(x0,y+3,w0,4);
        g.fillStyle=`rgba(20,16,12,.28)`;g.fillRect(x0,y+55,w0,6);g.fillRect(x0+w0-4,y+3,4,58);
        for(let k=0;k<3;k++){const sx=x0+rnd()*w0,sw=6+rnd()*14;g.fillStyle=`rgba(40,34,28,${.06+rnd()*.08})`;g.fillRect(sx,y+7,sw,48);}
      }
      x+=w;
    }
  }
  return canvas;
}
// Stone mesh with walkway merlons; regular lit material, so no new render
// pass is involved. The boxes stay flat (they are the collision volume); the
// long inner and outer faces darken toward their ends through vertex colour so
// the 100 m wall reads as curving away.
export function createFarWallMesh(config){
  const group=new THREE.Group();group.name='far wall';
  const canvas=typeof document!=='undefined'?ashlarCanvas():null;let map=null;
  if(canvas){map=new THREE.CanvasTexture(canvas);map.colorSpace=THREE.SRGBColorSpace;map.wrapS=map.wrapT=THREE.RepeatWrapping;map.anisotropy=8;}
  const material=new THREE.MeshStandardMaterial({color:0xffffff,map,roughness:.92,metalness:0,vertexColors:true});
  if(!map)material.color.set(0x8f8b82);
  for(const b of farWallBoxes(config)){
    const size=b.max.map((v,i)=>v-b.min[i]),long=size[0]>size[2]?0:2,segments=[1,1,1];segments[long]=24;segments[1]=6;
    const geometry=new THREE.BoxGeometry(...size,...segments),pos=geometry.attributes.position,normal=geometry.attributes.normal,colors=new Float32Array(pos.count*3);
    for(let i=0;i<pos.count;i++){
      const t=pos.getComponent(i,long)/size[long]+.5,h=pos.getY(i)/size[1]+.5,side=Math.abs(normal.getComponent(i,long))<.5&&Math.abs(normal.getY(i))<.5;
      const k=side?(1-.3*Math.pow(Math.abs(2*t-1),2))*(.9+.1*h):1;colors[i*3]=colors[i*3+1]=colors[i*3+2]=k;
    }
    geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));
    if(map){const uv=geometry.attributes.uv;for(let i=0;i<uv.count;i++){const n=[normal.getX(i),normal.getY(i),normal.getZ(i)],p=[pos.getX(i)+b.min[0]+size[0]/2,pos.getY(i)+b.min[1]+size[1]/2,pos.getZ(i)+b.min[2]+size[2]/2];const [u,v]=Math.abs(n[0])>.5?[p[2],p[1]]:Math.abs(n[2])>.5?[p[0],p[1]]:[p[0],p[2]];uv.setXY(i,u/25.6,v/12.8);}}
    const mesh=new THREE.Mesh(geometry,material);mesh.position.set(b.min[0]+size[0]/2,b.min[1]+size[1]/2,b.min[2]+size[2]/2);mesh.castShadow=mesh.receiveShadow=true;mesh.name='far wall '+b.id;group.add(mesh);
    // Merlons along the outer deck edge only; visual, the walkway stays open.
    const m=config.merlons;if(!m)continue;
    const along=size[0]>size[2]?0:2,len=size[along],count=Math.floor(len/(m.width+m.gap));
    const outer=b.id==='north'?b.min[2]:b.id==='south'?b.max[2]:b.id==='west'?b.min[0]:b.max[0];
    const mg=new THREE.BoxGeometry(along===0?m.width:.6,m.height,along===0?.6:m.width);mg.setAttribute('color',new THREE.BufferAttribute(new Float32Array(mg.attributes.position.count*3).fill(1),3));
    for(let k=0;k<count;k++){const merlon=new THREE.Mesh(mg,material);const a=b.min[along]+(k+.5)*(len/count);merlon.position.set(along===0?a:outer+(b.id==='west'?.3:-.3),b.max[1]+m.height/2,along===0?outer+(b.id==='north'?.3:-.3):a);merlon.castShadow=true;group.add(merlon);}
  }
  group.userData.dispose=()=>{group.traverse(o=>o.geometry?.dispose());material.dispose();map?.dispose();};
  return group;
}
