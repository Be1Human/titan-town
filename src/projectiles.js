import * as THREE from '../vendor/three.module.js';

export const PROJECTILE_TOOLS = [
  {name:'大锤',action:'鼠标左键 · 挥锤'},
  {name:'霰弹枪',action:'鼠标左键 · 射击'},
  {name:'遥控炸药',action:'左键放置 · R 引爆'},
  {name:'RPG',action:'鼠标左键 · 发射火箭'},
  {name:'手雷',action:'鼠标左键 · 投掷，2.6 秒后爆炸'}
];

// Sweep the whole travelled segment, including the grenade's leading surface.
// A projectile cannot skip a thin wall even when the frame takes longer.
export function stepProjectile(body,world,dt){
  if(body.exploded||dt<=0)return false;
  body.age+=dt;
  if(body.kind==='grenade')body.velocity.y-=(world.gravity??9.81)*dt;
  const v=body.velocity,speed=Math.hypot(v.x,v.y,v.z),length=speed*dt;
  const direction=speed?{x:v.x/speed,y:v.y/speed,z:v.z/speed}:{x:0,y:-1,z:0};
  const radius=body.kind==='rocket'?.055:.085;
  let hit=null;
  for(const offset of [[0,0,0],[radius,0,0],[-radius,0,0],[0,0,radius],[0,0,-radius],[0,-radius,0],[0,radius,0]]){
    const origin={x:body.position.x+offset[0],y:body.position.y+offset[1],z:body.position.z+offset[2]};
    const next=world.raycast(origin,direction,length+radius);
    if(next&&(!hit||next.distance<hit.distance))hit=next;
  }
  if(hit){
    const travel=Math.max(0,hit.distance-radius-.003);
    for(const axis of ['x','y','z'])body.position[axis]+=direction[axis]*travel;
    if(body.kind==='rocket')body.exploded=true;
    else{
      const n=hit.normal,dot=v.x*n.x+v.y*n.y+v.z*n.z;
      if(dot<0)for(const axis of ['x','y','z'])v[axis]=(v[axis]-1.48*dot*n[axis])*.78;
      if(n.y>.5&&Math.abs(v.y)<.7){v.y=0;v.x*=.7;v.z*=.7;}
      body.bounces++;
    }
  }else for(const axis of ['x','y','z'])body.position[axis]+=v[axis]*dt;
  // The environment's bedrock plane is also a physical safety floor.
  if(body.position.y<radius){body.position.y=radius;if(body.kind==='rocket')body.exploded=true;else v.y=Math.abs(v.y)*.35;}
  if(body.age>=(body.kind==='grenade'?2.6:6))body.exploded=true;
  return body.exploded;
}

export function createProjectileSystem(scene,{world,effects,explode,raycast}){
  let currentWorld=world,bodies=[];
  const box=new THREE.BoxGeometry(1,1,1),dummy=new THREE.Object3D(),axis=new THREE.Vector3(0,0,-1);
  const colors=[0x586147,0x272d2b,0xe3b967,0xffa545];
  const pools=colors.map((color,i)=>{
    const material=new THREE.MeshStandardMaterial({color,roughness:.7,metalness:i===1?.65:.15,emissive:i===3?0xff6a12:0,emissiveIntensity:i===3?3:0});
    const mesh=new THREE.InstancedMesh(box,material,160);mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);mesh.frustumCulled=false;mesh.count=0;mesh.castShadow=i!==3;mesh.receiveShadow=true;scene.add(mesh);return mesh;
  });
  const orient=new THREE.Quaternion(),dir=new THREE.Vector3();
  function part(body,pool,position,scale){
    dummy.position.set(...position).applyQuaternion(orient).add(body.position);
    dummy.quaternion.copy(orient);dummy.scale.set(...scale);dummy.updateMatrix();
    const mesh=pools[pool];mesh.setMatrixAt(mesh.count++,dummy.matrix);
  }
  function sync(){
    pools.forEach(p=>p.count=0);
    for(const b of bodies){
      if(b.kind==='rocket'){
        orient.setFromUnitVectors(axis,dir.set(b.velocity.x,b.velocity.y,b.velocity.z).normalize());
        part(b,0,[0,0,0],[.105,.105,.57]);part(b,2,[0,0,-.31],[.075,.075,.15]);
        part(b,1,[0,0,.17],[.26,.025,.14]);part(b,1,[0,0,.17],[.025,.26,.14]);
        part(b,3,[0,0,.37],[.075,.075,.22]);
      }else{
        orient.setFromEuler(new THREE.Euler(b.age*5,b.age*3,0));
        part(b,0,[0,0,0],[.13,.17,.13]);part(b,1,[0,.10,0],[.065,.055,.07]);
        part(b,2,[.065,.055,0],[.022,.16,.04]);
      }
    }
    for(const p of pools){p.visible=p.count>0;p.instanceMatrix.needsUpdate=true;}
  }
  return{
    get bodies(){return bodies;},
    launch(kind,origin,direction){
      if(bodies.length>=12)return false;
      const speed=kind==='rocket'?28:11;
      // Start at the eye, then sweep forward normally: near walls are never skipped.
      bodies.push({kind,position:new THREE.Vector3(origin.x,origin.y-.12,origin.z),velocity:{x:direction.x*speed,y:direction.y*speed+(kind==='grenade'?2.2:0),z:direction.z*speed},age:0,bounces:0,trail:0,exploded:false});
      sync();return true;
    },
    update(dt){
      for(let i=bodies.length-1;i>=0;i--){const b=bodies[i];
        if(stepProjectile(b,raycast?{raycast,gravity:currentWorld.gravity}:currentWorld,dt)){bodies.splice(i,1);explode({...b.position},b.kind==='rocket'?3.6:2.5);continue;}
        b.trail+=dt;if(b.kind==='rocket'&&b.trail>.035){b.trail=0;effects.dust(b.position,2,.25,0xc4b9a1);}
      }
      sync();
    },
    reset(nextWorld=currentWorld){currentWorld=nextWorld;bodies=[];sync();},
    dispose(){for(const p of pools){scene.remove(p);p.material.dispose();}box.dispose();bodies=[];}
  };
}
