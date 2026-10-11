import * as THREE from '../vendor/three.module.js';

// "被看见" UI and dusk atmosphere. Screen elements are DOM overlays (no WebGL
// pass); world effects are plain transparent MeshBasicMaterial meshes that
// never write depth or touch voxel occupancy. Boulder landing points are never
// marked. If DOM setup fails the game keeps running with toast text only.
export const ATMOSPHERE={particles:64,bellMin:24,bellMax:40,heartbeatSlow:1,heartbeatFast:.42,chaseFade:3,dustCount:10,dustLife:2.2,steamEvery:1.6};

export function detectionLevel(value){return value>=1?'red':value>.02?'yellow':'grey';}

export function createAtmosphere({scene,camera,document:doc=globalThis.document,smokeColumns=[]}={}){
  const state={eye:'grey',maxAlert:0,vignette:0,heartbeatClock:0,bellClock:ATMOSPHERE.bellMin,chase:0,chasing:false,lastChase:-Infinity,time:0,ui:false,error:null,indicators:0,cues:{heartbeat:0,bell:0,alarm:0}};
  let eye=null,ring=null,vignette=null,indicatorRoot=null;const arrows=[];
  try{
    if(doc?.body){
      const host=doc.getElementById('detect-ui')??Object.assign(doc.createElement('div'),{id:'detect-ui'});
      if(!host.parentNode)doc.body.appendChild(host);
      host.innerHTML='<div id="detect-vignette"></div><div id="detect-indicators"></div><div id="detect-eye" class="grey"><svg viewBox="0 0 64 40" width="64" height="40"><circle class="ring" cx="32" cy="20" r="18" fill="none" stroke-width="3" stroke-dasharray="113" stroke-dashoffset="113"/><path d="M4 20 Q32 -4 60 20 Q32 44 4 20Z" fill="none" stroke-width="3"/><circle class="pupil" cx="32" cy="20" r="6"/></svg></div>';
      eye=doc.getElementById('detect-eye');ring=eye.querySelector('.ring');vignette=doc.getElementById('detect-vignette');indicatorRoot=doc.getElementById('detect-indicators');state.ui=true;
    }
  }catch(error){state.error=String(error);console.warn('发现界面初始化失败，改用文字提示',error);}

  const root=new THREE.Group();root.name='atmosphere';scene?.add(root);
  const puffGeometry=new THREE.SphereGeometry(1,8,6);
  const pool=Array.from({length:ATMOSPHERE.particles},()=>{const material=new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:0,depthWrite:false});material.color.setRGB(1,1,1,THREE.SRGBColorSpace);const mesh=new THREE.Mesh(puffGeometry,material);mesh.visible=false;mesh.frustumCulled=false;root.add(mesh);return {mesh,life:0,max:1,v:new THREE.Vector3(),grow:1,alpha:.5};});
  let next=0;
  function emit(position,{color='#d8d2c4',life=1.6,size=1,grow=2,alpha=.5,velocity=[0,1,0],jitter=.6}={}){
    const p=pool[next++%pool.length];p.life=p.max=life;p.grow=grow;p.alpha=alpha;p.mesh.visible=true;p.mesh.position.set(position.x,position.y,position.z);p.mesh.scale.setScalar(size);
    p.mesh.material.color.set(color);p.v.set(velocity[0]+(Math.random()-.5)*jitter,velocity[1]+(Math.random()-.5)*jitter,velocity[2]+(Math.random()-.5)*jitter);return p;
  }
  // Dust burst where a boulder lands (after the impact, never before).
  function dust(point,strength=1){for(let i=0;i<ATMOSPHERE.dustCount;i++){const a=i/ATMOSPHERE.dustCount*Math.PI*2;emit({x:point.x+Math.cos(a)*.8,y:point.y+.4,z:point.z+Math.sin(a)*.8},{color:'#a89a84',life:ATMOSPHERE.dustLife,size:1.1*strength,grow:3.2,alpha:.62,velocity:[Math.cos(a)*3,1.6,Math.sin(a)*3],jitter:1.2});}}
  const signals=[];
  function signal(point){signals.push({x:point.x,y:point.y,z:point.z,clock:0});}
  // Wind-up before the first boulder of a volley: the eye icon blinks white/red (never a landing mark).
  function windup(seconds=1){state.windup=Math.max(state.windup??0,seconds);state.windups=(state.windups??0)+1;}
  let steamClock=0,columnClock=0;
  const v=new THREE.Vector3();
  // observers: [{x,y,z,alert,kind}] (giants and the ape); ape: {meter, aiming}.
  function update(dt,{observers=[],ape=null,titans=[],boulders=0,chasing=false,player=null}={}){
    state.time+=dt;state.cues={heartbeat:0,bell:0,alarm:0};
    const apeMeter=ape?.meter??0,aiming=Boolean(ape?.aiming);
    state.maxAlert=Math.max(apeMeter>=1?1:apeMeter,...observers.map(o=>o.alert),0);
    const level=detectionLevel(state.maxAlert);
    if(level==='red'&&state.eye!=='red')state.cues.alarm=1;
    state.eye=level;
    state.vignette=aiming?.75*(.8+.2*Math.sin(state.time*9)):.55*apeMeter;
    // Heartbeat: from 1.0 s down to 0.42 s between double beats.
    const tension=Math.max(apeMeter,boulders?1:0);
    if(tension>.35){state.heartbeatClock-=dt;if(state.heartbeatClock<=0){state.cues.heartbeat=1;state.heartbeatClock=ATMOSPHERE.heartbeatSlow-(ATMOSPHERE.heartbeatSlow-ATMOSPHERE.heartbeatFast)*Math.min(1,(tension-.35)/.65);}}
    else state.heartbeatClock=0;
    state.bellClock-=dt;if(state.bellClock<=0){state.cues.bell=1;state.bellClock=ATMOSPHERE.bellMin+Math.random()*(ATMOSPHERE.bellMax-ATMOSPHERE.bellMin);}
    if(chasing)state.lastChase=state.time;
    state.chasing=state.time-state.lastChase<ATMOSPHERE.chaseFade;state.chase+=((chasing?1:state.chasing?.3:0)-state.chase)*Math.min(1,dt*1.5);
    state.windup=Math.max(0,(state.windup??0)-dt);
    if(state.ui){
      eye.className=level+(state.windup>0?' windup':'');ring.style.strokeDashoffset=String(113*(1-Math.min(1,state.maxAlert)));
      vignette.style.opacity=state.vignette.toFixed(3);
      const shown=[...observers.filter(o=>o.alert>.05),...(ape&&apeMeter>.05?[{...ape,alert:apeMeter,kind:'ape'}]:[])];
      while(arrows.length<shown.length){const el=doc.createElement('div');el.className='detect-arrow';indicatorRoot.appendChild(el);arrows.push(el);}
      arrows.forEach((el,i)=>{const o=shown[i];el.hidden=!o;if(!o||!camera)return;
        v.set(o.x,o.y,o.z).applyMatrix4(camera.matrixWorldInverse);const angle=Math.atan2(v.x,-v.z);
        el.style.transform=`translate(-50%,-50%) rotate(${angle}rad) translateY(-38vmin)`;el.style.setProperty('--alert',o.alert.toFixed(2));el.dataset.kind=o.kind;el.classList.toggle('red',o.alert>=1);});
      state.indicators=shown.length;
    }
    // Steam off giant shoulders, distant smoke columns, signal smoke.
    steamClock-=dt;if(steamClock<=0){steamClock=ATMOSPHERE.steamEvery;for(const t of titans)if(t.point)emit(t.point,{color:'#f2f0ea',life:1.8,size:.7,grow:2.4,alpha:.45,velocity:[0,2.2,0]});}
    columnClock-=dt;if(columnClock<=0){columnClock=.5;for(const c of smokeColumns)emit({x:c[0],y:c[1]??8,z:c[2]},{color:'#6e6a66',life:6,size:3,grow:2.5,alpha:.38,velocity:[.6,3,0],jitter:.8});}
    for(const s of signals){s.clock-=dt;if(s.clock<=0){s.clock=.18;emit({x:s.x,y:s.y+1,z:s.z},{color:'#c84a3a',life:5,size:.9,grow:3,alpha:.6,velocity:[.3,4.2,0],jitter:.5});}}
    for(const p of pool){if(p.life<=0)continue;p.life-=dt;if(p.life<=0){p.mesh.visible=false;continue;}const t=1-p.life/p.max;p.mesh.position.addScaledVector(p.v,dt);p.v.multiplyScalar(1-dt*.6);p.mesh.scale.multiplyScalar(1+dt*p.grow/p.max);p.mesh.material.opacity=p.alpha*(1-t);}
    return state.cues;
  }
  function reset(){state.maxAlert=0;state.vignette=0;state.eye='grey';signals.length=0;for(const p of pool){p.life=0;p.mesh.visible=false;}if(state.ui){vignette.style.opacity='0';eye.className='grey';arrows.forEach(a=>a.hidden=true);}}
  function snapshot(){return {eye:state.eye,maxAlert:+state.maxAlert.toFixed(2),vignette:+state.vignette.toFixed(2),chase:+state.chase.toFixed(2),indicators:state.indicators,ui:state.ui,error:state.error,particles:pool.filter(p=>p.life>0).length,signals:signals.length,windup:+(state.windup??0).toFixed(2),windups:state.windups??0,landingMarkers:0};}
  function dispose(){root.removeFromParent();puffGeometry.dispose();pool.forEach(p=>p.mesh.material.dispose());doc?.getElementById?.('detect-ui')?.remove();}
  return {state,update,dust,signal,windup,emit,reset,snapshot,dispose,root};
}
