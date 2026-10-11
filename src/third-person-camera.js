import * as THREE from '../vendor/three.module.js';

// View-only spring arm. Gameplay continues to query the player's eye, so
// switching view cannot extend hammer/pickup reach or move a network shot.
export function createThirdPersonCamera({distance=4.2,shoulder=.65,lift=.3,radius=.18}={}){
  const behind=new THREE.Vector3(),right=new THREE.Vector3(),up=new THREE.Vector3(),delta=new THREE.Vector3(),origin=new THREE.Vector3(),target=new THREE.Vector3();
  const viewRotation=new THREE.Euler(0,0,0,'YXZ'),viewQuaternion=new THREE.Quaternion();
  let length=null,orbitYaw=0,orbitPitch=0;
  function follow(){orbitYaw=0;orbitPitch=0;}
  function reset(){length=null;follow();}
  function orbit(yaw,pitch=0){
    if(!Number.isFinite(yaw)||!Number.isFinite(pitch))return;
    orbitYaw=THREE.MathUtils.euclideanModulo(orbitYaw+yaw+Math.PI,Math.PI*2)-Math.PI;
    orbitPitch=THREE.MathUtils.clamp(orbitPitch+pitch,-2.9,2.9);
  }
  function update(camera,eye,raycast,dt=1/60){
    viewRotation.setFromQuaternion(eye.quaternion,'YXZ');
    viewRotation.y+=orbitYaw;viewRotation.x=THREE.MathUtils.clamp(viewRotation.x+orbitPitch,-1.45,1.45);
    viewQuaternion.setFromEuler(viewRotation);
    behind.set(0,0,1).applyQuaternion(viewQuaternion);right.set(1,0,0).applyQuaternion(viewQuaternion);up.set(0,1,0).applyQuaternion(viewQuaternion);
    delta.copy(behind).multiplyScalar(distance).addScaledVector(right,shoulder).addScaledVector(up,lift);
    const wanted=delta.length();delta.normalize();let safe=wanted;
    // Sweep a small camera volume, not only its centre ray. This protects
    // the near-plane edges beside a wall and beneath a low ceiling.
    for(const [x,y]of [[0,0],[radius,0],[-radius,0],[0,radius],[0,-radius]]){
      origin.copy(eye.position).addScaledVector(right,x).addScaledVector(up,y);
      const hit=raycast(origin,delta,wanted+radius);
      if(hit&&Number.isFinite(hit.distance))safe=Math.min(safe,Math.max(.04,hit.distance-radius));
    }
    if(length===null||safe<length)length=safe;
    else length+=(safe-length)*(1-Math.exp(-7*Math.max(0,dt)));
    target.copy(eye.position).addScaledVector(delta,length);camera.position.copy(target);camera.quaternion.copy(viewQuaternion);
    return {distance:length,occluded:length<wanted-.05,bodyVisible:length>.85,orbiting:Math.abs(orbitYaw)+Math.abs(orbitPitch)>.0001,orbitYaw,orbitPitch};
  }
  return{update,reset,orbit,follow,get orbiting(){return Math.abs(orbitYaw)+Math.abs(orbitPitch)>.0001;}};
}
