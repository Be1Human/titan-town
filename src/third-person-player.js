import * as THREE from '../vendor/three.module.js';
import {createWorkerVisual} from './worker-visual.js';
import {appearanceKey} from './character-config.js';
import {gameCharacterScale} from './character-scale.js';
import {fitTwoHandTool,fitCarryHands,clearCarryHands} from './character-grips.js';

// A local world actor, distinct from the remote roster and the first-person
// overlay. Body, skin, animation and rack all use the same production factory.
export function createThirdPersonPlayer(scene,input){
  const root=new THREE.Group();root.name='local third-person player';root.visible=false;scene.add(root);
  const steel=new THREE.MeshStandardMaterial({color:'#8c9290',metalness:.3,roughness:.55}),wood=new THREE.MeshStandardMaterial({color:'#a46c39',roughness:.9}),dark=new THREE.MeshStandardMaterial({color:'#303734',roughness:.95}),olive=new THREE.MeshStandardMaterial({color:'#74815b',roughness:.9});
  const tools=Array.from({length:5},()=>new THREE.Group()),geometries=[];
  function box(parent,size,position,material){const geometry=new THREE.BoxGeometry(...size);geometries.push(geometry);const mesh=new THREE.Mesh(geometry,material);mesh.position.fromArray(position);mesh.castShadow=true;mesh.receiveShadow=true;parent.add(mesh);}
  box(tools[0],[.045,.61,.045],[0,.16,0],wood);box(tools[0],[.25,.14,.14],[0,.43,0],steel);
  for(const i of [1,3]){box(tools[i],[i===1?.065:.13,.08,i===1?.65:.8],[0,.09,.33],i===1?steel:olive);box(tools[i],[.08,.15,.10],[0,0,0],dark);box(tools[i],[.075,.09,.20],[0,.07,-.07],wood);box(tools[i],[.09,.07,.12],[0,.025,i===1?.29:.33],wood);}
  box(tools[2],[.18,.22,.1],[0,.025,.07],olive);box(tools[2],[.185,.045,.105],[0,.015,.07],dark);
  box(tools[4],[.10,.13,.10],[0,.045,.045],olive);box(tools[4],[.06,.025,.065],[0,.13,.045],dark);
  let visual=null,key=null,rackKey=null,phase=0,disposed=false;
  function setAppearance(a){
    const next=appearanceKey(a);if(next===key)return;
    tools.forEach(t=>t.removeFromParent());visual?.dispose();visual=createWorkerVisual(a,{courier:true,worldScale:gameCharacterScale(a)});root.add(visual.group);key=next;rackKey=null;
    for(const [i,t]of tools.entries()){
      t.position.set(0,0,0);t.rotation.set(0,0,0);
      if(i===1||i===3)visual.mesh.parent.add(t);
      else visual.attachments[i===0?'leftHand':'rightHand'].add(t);
    }
    // The shaft runs across the palm, perpendicular to the straight forearm.
    // Inheriting only the arm's rotation previously drove it through the wrist.
    visual.group.updateWorldMatrix(true,true);
    const palm=visual.bones.leftShoulder.worldToLocal(visual.attachments.leftHand.getWorldPosition(new THREE.Vector3()));
    tools[0].rotation.x=Math.atan2(-palm.y,palm.z);
  }
  function update({player,yaw=0,pitch=0,time=0,dt=0,tool=0,swing=null,carrying=false,heldEntry=null,down=false,rack=null,visible=true}){
    if(disposed)return;
    root.visible=visible;if(!carrying)clearCarryHands(visual);if(!visible)return;
    root.position.set(player.x,player.y,player.z);root.rotation.y=yaw;
    const speed=Math.hypot(player.vx||0,player.vz||0);phase+=speed*Math.min(dt,.1)*7;
    visual.group.rotation.set(down?Math.PI/2:0,Math.PI,0);
    visual.group.position.set(0,down?-visual.bounds.min.z+.005:0,down?-visual.height*.5:0);
    const action=swing!==null&&tool===0?'hammer':!player.grounded&&Math.abs(player.vy||0)>.7?'jump':player.crouching?'crouch':carrying?'carry':speed>5?'run':'idle';
    visual.setPose({phase,walk:Math.min(1,speed/3),time,action,carrying,down,progress:swing===null?0:Math.min(1,swing/.58)});
    if(!down){
      if(carrying)fitCarryHands(visual,heldEntry);
      else if(tool===1||tool===3)fitTwoHandTool(visual,tools[tool],new THREE.Vector3(0,.025,tool===1?.29:.33),pitch);
      else if(tool>0){visual.bones.rightShoulder.rotation.x=-.5;visual.group.updateWorldMatrix(true,true);visual.skeleton.update();}
    }
    tools.forEach((t,i)=>t.visible=!carrying&&!down&&i===tool);
    const next=JSON.stringify(rack?.items||[])+Boolean(rack?.extended);
    if(visual.courier&&next!==rackKey){visual.courier.setLayout(rack?.items||[],{extended:Boolean(rack?.extended)});visual.courier.setVisible(true);rackKey=next;}
  }
  function dispose(){if(disposed)return;disposed=true;tools.forEach(t=>t.removeFromParent());visual?.dispose();geometries.forEach(g=>g.dispose());[steel,wood,dark,olive].forEach(m=>m.dispose());root.removeFromParent();}
  setAppearance(input);return{root,update,setAppearance,dispose,tools,get visual(){return visual;}};
}
