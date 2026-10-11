import * as THREE from '../vendor/three.module.js';
import {CELL} from './voxel-world.js';
export function makeParkDressing(scene,level){
 const group=new THREE.Group();group.name='Original park prefab lamps and water';scene.add(group);
 const definitions=level.parkLights.map(l=>({...l})),ropes=[],ropeMaterial=new THREE.MeshStandardMaterial({color:0x39423c,roughness:.9});
 for(const cable of level.sceneDefinition.stringLights??[]){
  const start=new THREE.Vector3(...cable.start),end=new THREE.Vector3(...cable.end),middle=start.clone().lerp(end,.5);middle.y-=cable.sag;
  const curve=new THREE.CatmullRomCurve3([start,middle,end]),mesh=new THREE.Mesh(new THREE.TubeGeometry(curve,30,.015,4,false),ropeMaterial);group.add(mesh);const ropeIndex=ropes.length;ropes.push({mesh,start,end});
  const count=Math.floor(start.distanceTo(end)/cable.spacing);for(let i=1;i<count;i++){const p=curve.getPoint(i/count);definitions.push({id:cable.id+'-'+i,position:[p.x,p.y-.06,p.z],anchor:cable.start,power:0,size:.09,ropeIndex});}
 }
 const geometry=new THREE.BoxGeometry(1,1,1),material=new THREE.MeshStandardMaterial({color:0xffe4aa,emissive:0xffb75d,emissiveIntensity:1.25,roughness:.4});
 const bulbs=new THREE.InstancedMesh(geometry,material,definitions.length);bulbs.frustumCulled=false;group.add(bulbs);
 const transform=new THREE.Object3D(),positions=definitions.map(l=>new THREE.Vector3(...l.position));
 const lights=Array.from({length:8},()=>{const light=new THREE.PointLight(0xffe0a6,0,5,2);group.add(light);return light;});
 let lastWorld,lastRevision=-1;const active=definitions.map(()=>true);
 const stream=level.sceneDefinition.terrain.stream,vertices=[],indices=[];
 const waterY=(level.sceneDefinition.terrain.streamHeightCells??1)*CELL+.07;
 stream.points.forEach(([x,z],i)=>{const before=stream.points[Math.max(0,i-1)],after=stream.points[Math.min(stream.points.length-1,i+1)],direction=new THREE.Vector2(after[0]-before[0],after[1]-before[1]).normalize(),w=stream.width*.46;vertices.push(x-direction.y*w,waterY,z+direction.x*w,x+direction.y*w,waterY,z-direction.x*w);if(i)indices.push((i-1)*2,(i-1)*2+1,i*2,(i-1)*2+1,i*2+1,i*2);});
 const waterGeometry=new THREE.BufferGeometry();waterGeometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));waterGeometry.setIndex(indices);waterGeometry.computeVertexNormals();
 const water=new THREE.Mesh(waterGeometry,new THREE.MeshStandardMaterial({color:0x6c9694,roughness:.23,metalness:.35,side:THREE.DoubleSide}));water.name='Original garden stream';group.add(water);
 function update(world,camera){
  if(lastWorld!==world||lastRevision!==world.revision){lastWorld=world;lastRevision=world.revision;ropes.forEach(rope=>{rope.mesh.visible=[rope.start,rope.end].every(a=>world.getId(Math.floor(a.x/CELL),Math.floor(a.y/CELL),Math.floor(a.z/CELL)));});definitions.forEach((lamp,i)=>{const a=lamp.anchor;active[i]=Boolean(world.getId(Math.floor(a[0]/CELL),Math.floor(a[1]/CELL),Math.floor(a[2]/CELL)))&&(lamp.ropeIndex===undefined||ropes[lamp.ropeIndex].mesh.visible);transform.position.copy(positions[i]);transform.scale.setScalar(active[i]?lamp.size:0);transform.updateMatrix();bulbs.setMatrixAt(i,transform.matrix);});bulbs.instanceMatrix.needsUpdate=true;}
  const nearest=definitions.map((d,i)=>({d,i,score:camera?positions[i].distanceToSquared(camera.position)/(d.power||.001):i})).filter(l=>active[l.i]&&l.d.power>0).sort((a,b)=>a.score-b.score).slice(0,8);
  lights.forEach((light,i)=>{const entry=nearest[i];light.intensity=entry?entry.d.power:0;if(entry){light.position.copy(positions[entry.i]);light.distance=entry.d.radius;}});
 }
 return {lights,update,dispose(){scene.remove(group);ropes.forEach(r=>r.mesh.geometry.dispose());ropeMaterial.dispose();geometry.dispose();material.dispose();waterGeometry.dispose();water.material.dispose();}};
}
