import * as THREE from '../vendor/three.module.js';
import { CELL, MATERIALS, ATTACKS, shotgunPower } from './voxel-world.js';
import {DEFAULT_MAP_ID,mapInfo,createLevelForMap,prepareLevelFactory} from './levels.js';
import { Mission } from './mission.js';
import { stepPlayer,PLAYER_CONTROL } from './player.js';
import {restoreLevelSnapshot} from './solid-ground.js';
import { calculateBlastVelocity } from './blast.js';
import { WorldRenderer, Effects, RigidDebrisView, makeEnvironment, makeTool } from './render.js';
import {initRigidPhysics,RigidWorld} from './rigid-world.js';
import {rebindRigidAttachment} from './rigid-attachments.js';
import {CollapseQueue} from './engine/simulation/collapse-transaction.js';
import {CollapseVisualPreparation} from './engine/render/collapse-visual-preparation.js';
import {installOriginalProps} from './engine/assets/original-props.js';
import {installOriginalDoor} from './engine/assets/original-door.js';
import {VoxelJointSystem} from './engine/physics/voxel-joints.js';
import {PlayerGrab} from './engine/simulation/player-grab.js';
import {LocalCargo} from './local-cargo.js';
import {makeHoleRadiusForMaterial} from './engine/core/reference-materials.js';
import {TOOL_POLICY,TOOL_POLICY_ID,cutStaticForTool,cutRigidForTool,shotgunDirections,applyToolHitImpulse} from './engine/simulation/tool-policy.js';
import {createSaveStore} from './save-store.js';
import { LightingPipeline, setupDaylight } from './lighting.js';
import {ShadowDirtyTracker} from './engine/render/shadow-dirty-tracker.js';
import {LayeredShadowCache} from './engine/render/layered-shadow-cache.js';
import {warmDestructionShaders} from './engine/render/destruction-warmup.js';
import {displayPixelRatio,verticalFovForAspect} from './engine/render/display-policy.js';
import {ReferenceFramePolicy} from './engine/render/reference-frame-policy.js';
import {DAYLIGHT_LOOK} from './daylight-look.js';
import { HAMMER_DURATION, hammerPose, crossesHammerImpact } from './tool-motion.js';
import {PROJECTILE_TOOLS,createProjectileSystem} from './projectiles.js';
import {createCharacterSystem,DEFAULT_CHARACTERS} from './characters.js';
import {createTitanSystem} from './titan-ai.js';
import {createGrappleGear} from './grapple-gear.js';
import {createTitanCampaign} from './titan-campaign.js';
import {keyOf} from './voxel-world.js';
import {STANDARD_GAME_APPEARANCE,normalizeGameAppearance} from './game-character-profiles.js';
import {setupParkEnvironment} from './park-environment.js';
import {createThirdPersonCamera} from './third-person-camera.js';
import {createThirdPersonPlayer} from './third-person-player.js';
import {bodyGripDimensions,carryTarget} from './character-grips.js';

const $=id=>document.getElementById(id);
const launchParams=new URLSearchParams(location.search);
// A/B switches for measured physics optimizations, e.g. ?legacy=catchup,charsync.
const physicsLegacy=new Set((launchParams.get('legacy')||'').split(',').filter(Boolean));
const sourcePhysicsAsync=['reference-tasks','reference-step'].includes(launchParams.get('physics'));let pendingPhysicsUpdate=null;
const referenceFramePolicy=sourcePhysicsAsync&&launchParams.get('frame')!=='continuous'?new ReferenceFramePolicy():null;
const selectedMapId=mapInfo(launchParams.get('map')||DEFAULT_MAP_ID).id;
const parkMap=mapInfo(selectedMapId).lighting==='park-original';
const photoMode=new URLSearchParams(location.search).get('view');
const referencePhoto=parkMap&&['reference','overview'].includes(photoMode);
const {readGameSave,writeGameSave}=createSaveStore(undefined,{mapId:mapInfo(selectedMapId).saveNamespace??selectedMapId});
const canvas=$('game'),keys=new Set();

const appearance=normalizeGameAppearance(STANDARD_GAME_APPEARANCE);
let renderer;
try {renderer=new THREE.WebGLRenderer({canvas,antialias:false,powerPreference:'high-performance'});}
catch(error){$('fatal').hidden=false;$('fatal-message').textContent=`无法创建 WebGL 2 渲染器：${error.message}`;throw error;}
renderer.debug.onShaderError=(gl,program,vertexShader,fragmentShader)=>{
  console.error('Game shader failed',{program:gl.getProgramInfoLog(program),vertex:gl.getShaderInfoLog(vertexShader),fragment:gl.getShaderInfoLog(fragmentShader)});
  $('fatal').hidden=false;$('fatal-message').textContent='画面加载失败，请刷新页面重试。';
};
let displayHigh=true,displaySoftware=false;
const pixelRatio=()=>displayPixelRatio({width:innerWidth,height:innerHeight,devicePixelRatio,high:displayHigh,software:displaySoftware});
renderer.setPixelRatio(pixelRatio());renderer.setSize(innerWidth,innerHeight);
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate=false;
renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.04;
const scene=new THREE.Scene();
// Horizontal FOV convention (90 degrees default).
// Three expects a vertical angle, so preserve the horizontal lens on resize.
const verticalCameraFov=verticalFovForAspect;
const camera=new THREE.PerspectiveCamera(verticalCameraFov(innerWidth/innerHeight),innerWidth/innerHeight,.05,400);camera.rotation.order='YXZ';scene.add(camera);
const aimCamera=new THREE.PerspectiveCamera();aimCamera.rotation.order='YXZ';
const thirdCamera=createThirdPersonCamera();let thirdPerson=launchParams.get('perspective')==='third',thirdCameraState={distance:0,bodyVisible:true};
const selectedLevelFactory=await prepareLevelFactory(selectedMapId);
const daylight=await setupParkEnvironment(renderer,scene,selectedLevelFactory.environmentDefinition);
const toolScene=new THREE.Scene(),toolCamera=new THREE.PerspectiveCamera(verticalCameraFov(innerWidth/innerHeight),innerWidth/innerHeight,.03,10);toolCamera.rotation.order='YXZ';toolScene.add(toolCamera);
toolScene.environment=daylight.environment;toolScene.environmentIntensity=DAYLIGHT_LOOK.environmentIntensity;
const toolSky=new THREE.HemisphereLight(DAYLIGHT_LOOK.skyColor,DAYLIGHT_LOOK.groundColor,DAYLIGHT_LOOK.skyIntensity);toolScene.add(toolSky);
const toolKey=new THREE.DirectionalLight(daylight.sun.color,daylight.sun.intensity);toolScene.add(toolKey,toolKey.target);
const lighting=new LightingPipeline(renderer,camera,daylight);
lighting.nativeOpaqueEnabled=launchParams.get('opaque')!=='forward';
lighting.surface.paletteBatchEnabled=launchParams.get('palette')!=='groups';
lighting.shadowGroupsEnabled=launchParams.get('shadowGroups')==='merged';
lighting.activeMaterialWork=lighting.surface.activeMaterialWork=launchParams.get('materialWork')==='active';
// ?legacy=shadowlayers redraws every caster into one map on each update.
const shadowLayers=!physicsLegacy.has('shadowlayers');
const shadowTracker=new ShadowDirtyTracker({layered:shadowLayers});
const shadowCache=shadowLayers?new LayeredShadowCache(renderer).install():null;
$('loading').textContent='正在准备探索场景';
await new Promise(resolve=>setTimeout(resolve,0));
let level=createLevelForMap(selectedMapId),world=level.world;
if(photoMode==='overview')$('spawn-point').value='overview';
else if(launchParams.has('spawn')&&level.points[launchParams.get('spawn')])$('spawn-point').value=launchParams.get('spawn');
lighting.setDepthOfField({focusMin:3,focusMax:60,focusScale:.002,maxRadius:4,sharpCenter:true});
lighting.setDepthOfField({enabled:referencePhoto});
document.querySelector('#help .help-panel > p').textContent='夺回城墙：开局在安全屋，已穿戴飞索腰具，共 3 条命，死亡后在最近的安全屋复活并保留任务进度。7 个任务可任选顺序完成（M 地图查看位置），完成越多评级越高。地面巨人会看、会听：被视野锥看到或弄出大动静会被发现，躲进房屋、断开视线可甩掉追击；它们会伸手进窗户、拆房子。城垣巨猿沿四面墙顶巡逻扫视，看到你就立刻连续投石，落点不提示，保持移动、借房屋遮挡。空格：准星可钩（准星变青并显示距离）时约 0.2 秒后左右交替发钩，按住收绳拉近，松开脱钩保留惯性；准星不可钩时空格为跳跃。E 互动 / 补给点补满气体，B 拔出双刃，左键斩击后颈。Q 在本图无效。1–5 切换工具，WASD 移动，Esc 暂停。';
let rigidPhysics=null,rigidView=null,physicsError=null;
$('loading').textContent='正在初始化刚体物理';
try{await initRigidPhysics();rigidPhysics=new RigidWorld(world,{contactFracture:true,surfaceReuse:true,legacy:physicsLegacy,wholeStep:launchParams.get('physics')==='reference-step',solverBackend:launchParams.get('solver'),nearBackend:launchParams.get('near'),pipeline:launchParams.get('physics')?.startsWith('reference')?'reference':'rapier'});}catch(error){physicsError=error;console.error('Rigid physics initialization failed',error);}
const localGrab=new PlayerGrab(rigidPhysics);
const localCargo=new LocalCargo(rigidPhysics,localGrab);
const pickupDefinitions=()=>level.pickups??[];
localCargo.reset(pickupDefinitions());
const voxelJoints=rigidPhysics?new VoxelJointSystem(rigidPhysics):null;
$('loading').textContent='正在装配场景与工具';
await new Promise(resolve=>setTimeout(resolve,0));
lighting.setWorld(world);
let environment=makeEnvironment(scene,level);const tool=makeTool(toolCamera);
tool.setAppearance(appearance);
let worldRenderer=new WorldRenderer(scene,world),effects=new Effects(scene,world,worldRenderer.material);
if(rigidPhysics)installOriginalProps(rigidPhysics,level.originalProps);
if(voxelJoints)for(const model of level.originalDoors??[])installOriginalDoor(rigidPhysics,voxelJoints,model);
if(rigidPhysics){rigidView=new RigidDebrisView(scene,rigidPhysics,worldRenderer.material);rigidView.onAdd=attachWallCharges;rigidView.setRenderer?.(renderer,camera);rigidView.setBackend?.('raycast');effects.rigidDebris=rigidView;}
$('loading').textContent='正在生成地图网格';
await new Promise(resolve=>setTimeout(resolve,0));
worldRenderer.rebuild();
$('loading').textContent='正在准备角色';
await new Promise(resolve=>setTimeout(resolve,0));
const characters=createCharacterSystem(scene,world,level.characters,{appearanceTransform:normalizeGameAppearance});
const titanConfig=()=>level.titans?{...level.titans,count:launchParams.has('titans')?Math.max(0,Math.min(5,Number(launchParams.get('titans'))||0)):level.titans.count}:null;
let titanGrace=0,titanCatches=0,titanDowns=0;
const titans=createTitanSystem(scene,world,titanConfig(),{
  smash:(point,radius)=>titanSmash(point,radius),
  grab:(target,titan)=>titanGrab(target,titan),
  event:(type,titan,data)=>{
    if(type==='down'){titanDowns++;campaign?.titanEvent('down');toast('击中后颈 · 巨人倒下了');audio('collapse');}
    else if(type==='nape')audio('hit');
    else if(type==='spot'&&titan.target==='player')toast('巨人发现你了！');
    else if(type==='respawn')toast(titan.state==='approach'?'城墙外又出现了一个巨人，它要翻墙进来':'又一个巨人从南门破口进来了');
    else if(type==='climb')toast('巨人正在攀爬城墙！');
    else if(type==='land'){audio('collapse');const d=Math.hypot(data.x-player.x,data.z-player.z);shake=Math.max(shake,Math.max(0,1-d/30)*.3);}
  }
});
const titanTargets=()=>[{id:'player',kind:'player',x:player.x,y:player.y,z:player.z,down:state!=='playing',invulnerable:titanGrace>0},...characters.characters.map(c=>({id:c.id,kind:'npc',x:c.x,y:c.y,z:c.z,down:c.down,state:c}))];
function titanSmash(point,radius){
  if(!world||state!=='playing')return;
  damageLoose(point,radius,ATTACKS.explosion.power,6,'explosion');rigidPhysics?.blast(point,radius*1.7,5);characters.blast(point,radius*1.8,.7);
  damage(point,radius,ATTACKS.explosion.power,6,'explosion');effects.explosion?.(point);audio('collapse');
  const distance=Math.hypot(point.x-player.x,point.y-player.y-1,point.z-player.z);shake=Math.max(shake,Math.max(0,1-distance/26)*.22);
}
function titanGrab(target,titan){
  const direction={x:Math.sin(titan.yaw),y:.5,z:Math.cos(titan.yaw)};
  if(target.kind==='npc'){characters.hit(target.id,{damage:400,direction,force:10});toast(`${target.state?.name??'镇民'}被巨人抓住了`);audio('hit');return;}
  if(campaign?.active){titanCatches++;return campaign.grabbed(titan);}
  titanCatches++;titanGrace=4;audio('explosion');$('damage-flash').style.opacity='1';setTimeout(()=>$('damage-flash').style.opacity='0',380);
  const start=level.points.middle;Object.assign(player,{x:start.x,y:start.y,z:start.z,vx:0,vy:0,vz:0});yaw=start.yaw;pitch=start.pitch||0;
  toast(`被巨人抓住了！已回到北街（第 ${titanCatches} 次）`);
}
const projectiles=createProjectileSystem(scene,{world,effects,explode,raycast:(origin,direction,range)=>{
  const wall=raycastSolids(origin,direction,range),actor=characters.raycast(origin,direction,wall?.distance??range),giant=giants.raycast(origin,direction,actor?.distance??wall?.distance??range);return giant||actor||wall;
}});
let mission=new Mission(level.targets),state='menu',mode='sandbox',selectedTool=0,charges=[],markers=[];
let player={...level.spawn,vy:0,vx:0,vz:0,grounded:true},yaw=0,pitch=0;
const localPlayerView=createThirdPersonPlayer(scene,appearance);
// Ground giants plus the wall ape behind one ray/anchor/hit interface.
const giants={
  get titans(){return titans.titans;},
  raycast(origin,direction,range){const a=titans.raycast(origin,direction,range),b=campaign?.ape?.raycast(origin,direction,a?.distance??range);return b&&(!a||b.distance<a.distance)?b:a;},
  anchor(hit){return hit?.id===campaign?.ape?.ape?.id?campaign.ape.anchor(hit):titans.anchor(hit);},
  anchorPoint(a,target){return a?.titanId===campaign?.ape?.ape?.id?campaign.ape.anchorPoint(a,target):titans.anchorPoint(a,target);},
  hit(result,damage){return result?.id===campaign?.ape?.ape?.id?campaign.ape.hit(result,damage):titans.hit(result,damage);},
  noise(point,radius,kind){return titans.noise?.(point,radius,kind)??[];},
  calm(point,opts){titans.calm?.(point,opts);}
};
const gear=createGrappleGear({world,raycast:(origin,direction,range)=>raycastSolids(origin,direction,range),titans:giants,rigid:rigidPhysics,scene,toolCamera,thirdRoot:localPlayerView.root,events:gearEvent});
const campaign=createTitanCampaign({scene,camera,audio:(type)=>audio(type),toast:(text)=>toast(text),$,gear,titans:giants,
  player:()=>player,yaw:()=>yaw,teleport:p=>{Object.assign(player,{x:p.x,y:p.y,z:p.z,vx:0,vy:0,vz:0,grounded:true});yaw=p.yaw??yaw;pitch=0;},
  setGrace:s=>{titanGrace=s;},invulnerable:()=>titanGrace>0,shake:v=>{shake=Math.max(shake,v);},noise:(point,radius,kind)=>giants.noise(point,radius,kind),
  smash:(point,radius)=>titanSmash(point,radius),sweep:(origin,direction,max)=>raycastSolids(origin,direction,max),solidAt:(x,y,z)=>Boolean(world.getId(Math.floor(x/CELL),Math.floor(y/CELL),Math.floor(z/CELL)))||Boolean(rigidPhysics?.collides(x,y-.05,z,.1,.04)),
  audioContext:()=>sounds.context,onFinish:r=>showTitanResults(r)});
campaign.reset(level);
gear.visuals.setRacks(level.gear);
let gasSound=0;
function gearEvent(type,data){
  if(type==='fire')audio('hook');
  else if(type==='attach'){audio('metal');giants.noise(data.point,10,'hook');if(data.type==='titan')toast(data.part==='nape'?'钩索挂住巨人后颈附近！':'钩索挂在巨人身上');}
  else if(type==='detach'&&data.reason==='anchor-destroyed'){audio('hook-off');toast(`挂点被破坏，${data.side==='L'?'左':'右'}钩索脱落`);}
  else if(type==='detach'&&data.reason==='titan-down'){audio('hook-off');toast(`巨人倒下，${data.side==='L'?'左':'右'}钩索脱落`);}
  else if(type==='detach')audio('hook-off');
  else if(type==='land'){audio('land');shake=Math.max(shake,Math.min(.06,data.speed*.004));}
  else if(type==='equip'){audio('collect');toast('已穿戴飞索腰具 · 空格对准可钩表面发钩 · 按住拉近 · 松开飞出 · B 双刃');}
  else if(type==='refill'){audio('collect');toast('气体已补满');}
}
function gearSpaceMode(){return gear.equipped&&Boolean(level.gear?.length||campaign.active);}
// Space on gear maps: hook when the crosshair is hookable, otherwise jump.
function gearSpace(){
  const aim=new THREE.Vector3();aimCamera.getWorldDirection(aim);
  const eye=aimCamera.position;
  const result=campaign.active?campaign.spacePress(eye,aim):gear.equipped?gear.press(player,yaw,eye,aim):'jump';
  if(result==='jump')jumpQueued=jumpNetworkQueued=true;
  updateHud();
}
function bladeSlash(){
  if(!gear.slashStart())return;
  audio('metal');
  const direction=new THREE.Vector3();aimCamera.getWorldDirection(direction);
  const wall=raycastSolids(aimCamera.position,direction,4.5),giant=giants.raycast(aimCamera.position,direction,wall?.distance??4.5);
  const speed=Math.hypot(player.vx,player.vy,player.vz);
  if(campaign.slash(giant,aimCamera.position,direction)&&!giant)audio('hit');
  if(giant){giants.hit(giant,giant.part==='nape'?(speed>9?120:60):0);audio('hit');shake=.03;lastImpact={material:giant.part==='nape'?'巨人后颈':'巨人',tool:'blades',removed:0,speed:+speed.toFixed(1)};}
  else{const actor=characters.raycast(aimCamera.position,direction,wall?.distance??3.2);if(actor){characters.hit(actor,{damage:40,direction,force:2});audio('hit');}}
}
let destruction=0,rigidDestruction=0,initialVoxels=world.cells.size,collapseAt=0,actionCooldown=0,swing=null,recoil=0,shake=0,bob=0,hammerHits=0,lastImpact=null,toolShotSequence=0;
let quicksave=null,storedSave=null,saveRevision=0,toastUntil=0,lastInteraction=null,lastUi=0,lastMap=0,wasLocked=false,dragging=false,manualPause=false,captureUnavailable=false;
let mouseGrabActive=false,toolHeld=false,jumpQueued=false,jumpNetworkQueued=false;
function releaseMouseGrab(){if(mouseGrabActive){if(localGrab.handle?.mode==='drag')localGrab.release();}mouseGrabActive=false;dragging=false;toolHeld=false;}
function clearControlInputs(){releaseMouseGrab();keys.clear();jumpQueued=jumpNetworkQueued=false;if(player){player._jumpHeld=false;player._jumpBuffer=0;}}
function beginMouseGrab(){
  if(localGrab.handle)return false;
  const d=new THREE.Vector3();aimCamera.getWorldDirection(d);
  if(!localGrab.grab(raycastSolids(aimCamera.position,d,2.8),{mode:'drag'}))return false;
  mouseGrabActive=true;swing=null;return true;
}
let menuTime=0,frameCount=0,frameTime=0,totalPlay=0,lastFrame=performance.now(),lastRendered=performance.now(),accumulator=0,lastTickSpent=0,lastShadowRevision=-1;
const gl=renderer.getContext(),debugRenderer=gl.getExtension('WEBGL_debug_renderer_info');
const performanceStats={fps:0,cpuMs:0,drawCalls:0,triangles:0,gpu:debugRenderer?gl.getParameter(debugRenderer.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),support:null};
const softwareGPU=/SwiftShader|llvmpipe|Software|Microsoft Basic Render/i.test(performanceStats.gpu);
const integratedGPU=!/\bArc\b|Iris.*MAX/i.test(performanceStats.gpu)&&/Intel.*(?:UHD|HD Graphics|Iris)|\b(?:UHD|Iris)\b|Radeon\(TM\) Graphics/i.test(performanceStats.gpu);
const identifiedGPU=Boolean(debugRenderer)&&/NVIDIA|Intel|AMD|Radeon|GeForce|Apple|Adreno|Mali|SwiftShader|llvmpipe|Microsoft Basic Render/i.test(performanceStats.gpu);
const gpuLabel=performanceStats.gpu.match(/(?:NVIDIA|Intel\(R\)|AMD).*?(?= \(0x| Direct3D|, D3D|\)$)/)?.[0]||performanceStats.gpu;
if($('gpu-name'))$('gpu-name').textContent=`当前显卡：${gpuLabel}${softwareGPU?' · 软件渲染':integratedGPU?' · 核显':identifiedGPU?' · 硬件加速':' · 型号未公开'}`;
if($('gpu-advice'))$('gpu-advice').textContent=softwareGPU||integratedGPU?'如有独立显卡，请在 Windows「系统 → 显示 → 图形」将当前浏览器设为高性能，完全退出后再打开。':identifiedGPU?'已请求高性能显卡。调整画质后可观察左下角帧率。':'已请求高性能显卡，浏览器未公开具体型号；可用 Windows 任务管理器的 GPU 引擎列核对。';
performanceStats.powerPreference=gl.getContextAttributes()?.powerPreference;
// A desktop browser may select an integrated GPU even on a machine with an RTX card.
// Keep the visible raster sharp; reduce indirect-light sampling independently.
displaySoftware=softwareGPU;
if(integratedGPU||softwareGPU)setQuality(false);
renderer.info.autoReset=false;
let supportPending=false,supportRetryPending=false,worldEpoch=0,lastCollapseNotice=0;
const collapseQueue=new CollapseQueue();collapseQueue.clear(worldEpoch);
const collapseVisuals=new CollapseVisualPreparation();
const supportWorker=new Worker(new URL('./support-worker.js',import.meta.url),{type:'module'});
supportWorker.onmessage=({data})=>{
  if(data.epoch!==worldEpoch)return;
  supportPending=false;performanceStats.support=data.stats;
  if(data.geometryRevision!==world.geometryRevision){supportRetryPending=true;collapseAt=.05;return;}
  supportRetryPending=false;
  collapseQueue.retainWorkerProposals(data.activeProposalIds,{epoch:data.epoch,geometryRevision:data.geometryRevision});
  const reconfirmed=collapseQueue.reconfirm(data.reconfirmed??[],{epoch:data.epoch,geometryRevision:data.geometryRevision,revision:data.revision,disjointBatch:data.disjointBatch});
  if(reconfirmed.unknown.length){supportRetryPending=true;collapseAt=.05;}
  collapseQueue.enqueue(data.groups,data.failures,{epoch:data.epoch,geometryRevision:data.geometryRevision,revision:data.revision,proposalIds:data.proposalIds,disjointBatch:data.disjointBatch,owned:true});
  if(world.supportDirty.size)collapseAt=.05;
};
function processCollapseQueue({allowCommit=true,commitOnly=false}={}){
  if(!collapseQueue.hasPending)return;
  const transaction=collapseQueue.process(world,rigidPhysics,{epoch:worldEpoch,budgetMs:commitOnly?0:3,visuals:collapseVisuals,allowCommit,commitOnly});
  performanceStats.collapse={remaining:transaction.remaining,pendingCells:transaction.pendingCells,attempted:transaction.attempted,prepareMs:transaction.prepareMs,commitMs:transaction.commitMs,elapsedMs:transaction.elapsedMs,visuals:collapseVisuals.stats};
  // A global revision change can be elsewhere. Keep that worker proposal until
  // fresh analysis reconfirms it; acknowledging it here would lose a still
  // unsupported component when the latest cuts are in a different building.
  const acknowledgements=[...transaction.entries.map(item=>({proposalId:item.proposalId,status:'committed'})),...transaction.staleDetails.filter(item=>item.reason!=='geometry-revision').map(item=>({proposalId:item.proposalId,status:'stale'})),...transaction.rejectedDetails.filter(item=>!item.retryable).map(item=>({proposalId:item.proposalId,status:'permanent-rejection'}))].filter(item=>item.proposalId);
  if(acknowledgements.length)supportWorker.postMessage({epoch:worldEpoch,acknowledgements});
  if(transaction.stale.length){supportRetryPending=true;collapseAt=.05;}
  if(transaction.rejectedDetails.length&&performance.now()-lastCollapseNotice>4000){
    const failure=transaction.rejectedDetails[0];
    toast(failure.reason==='memory'?'物理数据内存暂不足，结构保留并排队重试':failure.reason==='runtime'?'碰撞体创建暂未完成，结构保留并排队重试':'该结构数据无效，保留原结构');lastCollapseNotice=performance.now();
  }
  if(transaction.entries.length){
    const entries=transaction.entries;
    const groups=entries.map(entry=>entry.cells);
    for(const item of entries)attachWallCharges(item.entry);
    destruction+=groups.reduce((n,g)=>n+g.length,0);if(!commitOnly)worldRenderer.rebuild({budgetMs:5});
    if(groups.length){
      audio('collapse');
      for(const entry of entries){
        const p=entry.failure?.pivot??{x:(entry.cells[0].x+.5)*CELL,y:entry.cells[0].y*CELL,z:(entry.cells[0].z+.5)*CELL};
        const proximity=Math.max(0,1-Math.hypot(player.x-p.x,player.y-p.y,player.z-p.z)/18);
        shake=Math.max(shake,proximity*Math.min(.09,entry.cells.length/12000));
        if(entry.failure&&proximity>.15&&performance.now()-lastCollapseNotice>2000){toast('承重失效 · 墙体正在坍塌');lastCollapseNotice=performance.now();}
      }
    }
  }
  if(world.supportDirty.size)collapseAt=.05;
}
function checkSupport(initialize=false,recheckInitial=world.altered.size>0,checkAll=false){
  if(supportPending)return;
  const keys=initialize?[...world.chunks.keys()]:[...world.supportDirty];
  if(!keys.length&&!supportRetryPending)return;
  const chunks=keys.map(key=>world.chunks.get(key)).filter(Boolean).map(c=>({...c,data:c.data.slice()}));
  const baselineChunks=initialize&&world.altered.size?[...world.altered].map(key=>world.initialChunks?.get(key)).filter(Boolean).map(c=>({...c,data:c.data.slice()})):[];
  world.supportDirty.clear();
  supportPending=true;supportWorker.postMessage({initialize,checkInitial:initialize&&recheckInitial,checkAll:initialize&&checkAll,knownProposalIds:collapseQueue.jobs.map(j=>j.proposalId).filter(Boolean),chunks,baselineChunks,count:world.count,revision:world.revision,geometryRevision:world.geometryRevision,epoch:worldEpoch,foundation:initialize?world.foundation:undefined},[...chunks,...baselineChunks].map(c=>c.data.buffer));
}
checkSupport(true);
const bombGeometry=new THREE.BoxGeometry(.18,.25,.07),bombMaterial=new THREE.MeshStandardMaterial({color:0x65704e,roughness:.9});
const sounds={enabled:true,context:null};
// Constructing the first AudioContext blocks the main thread while the output
// device opens (0.1-2.3 s measured). Do it at the start click, not inside the
// fixed-step tick of the first explosion.
function prepareAudio(){
  if(!sounds.enabled||sounds.context||physicsLegacy.has('lazyaudio'))return;
  try{sounds.context=new (window.AudioContext||window.webkitAudioContext)();}catch{}
}

function audio(type) {
  if(!sounds.enabled)return;
  try {
    const ctx=sounds.context ||= new (window.AudioContext||window.webkitAudioContext)();if(ctx.state==='suspended')ctx.resume();
    if(titanSound(ctx,type))return;
    const dur=type==='explosion'?.7:type==='collapse'?.55:type==='shot'?.23:type==='metal'?.3:type==='stone'||type==='hit'?.18:type==='land'?.26:type==='hook'||type==='hook-off'?.16:type==='gas'?.14:.12;
    const gain=ctx.createGain();gain.connect(ctx.destination);gain.gain.setValueAtTime(type==='explosion'?.22:type==='collapse'?.12:.075,ctx.currentTime);gain.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+dur);
    if(type==='collect'||type==='save'||type==='alarm') {
      const osc=ctx.createOscillator();osc.type='sine';osc.frequency.setValueAtTime(type==='alarm'?480:660,ctx.currentTime);osc.frequency.exponentialRampToValueAtTime(type==='alarm'?220:990,ctx.currentTime+dur);osc.connect(gain);osc.start();osc.stop(ctx.currentTime+dur);
    } else if(type==='metal'||type==='glass'||type==='hook'||type==='hook-off'){
      const partials={metal:[[480,.65],[1170,.25]],glass:[[1900,.65],[2850,.25]],hook:[[920,.5],[2240,.3]],'hook-off':[[620,.45],[1380,.2]]}[type];
      for(const [frequency,volume]of partials){
        const oscillator=ctx.createOscillator(),partial=ctx.createGain();oscillator.type='sine';oscillator.frequency.setValueAtTime(frequency,ctx.currentTime);oscillator.frequency.exponentialRampToValueAtTime(frequency*.7,ctx.currentTime+dur);partial.gain.value=volume;oscillator.connect(partial);partial.connect(gain);oscillator.start();oscillator.stop(ctx.currentTime+dur);
      }
    } else {
      const buffer=ctx.createBuffer(1,Math.ceil(ctx.sampleRate*dur),ctx.sampleRate),data=buffer.getChannelData(0);for(let i=0;i<data.length;i++)data[i]=(Math.random()*2-1)*(1-i/data.length);
      const source=ctx.createBufferSource();source.buffer=buffer;const filter=ctx.createBiquadFilter();filter.type=type==='gas'?'bandpass':'lowpass';filter.frequency.value=type==='explosion'?600:type==='collapse'?420:type==='shot'?3200:type==='wood'?550:type==='gas'?2600:type==='land'?260:1500;source.connect(filter);filter.connect(gain);source.start();
    }
  }catch{}
}

// Wall-town sounds, all synthesized: bell, heartbeat, stomp, boulder, whoosh, ignite.
function titanSound(ctx,type){
  const now=ctx.currentTime,out=(volume,dur)=>{const g=ctx.createGain();g.gain.setValueAtTime(volume,now);g.gain.exponentialRampToValueAtTime(.001,now+dur);g.connect(ctx.destination);return g;};
  const noise=(dur,filterType,frequency,volume,sweep=null)=>{const buffer=ctx.createBuffer(1,Math.ceil(ctx.sampleRate*dur),ctx.sampleRate),data=buffer.getChannelData(0);for(let i=0;i<data.length;i++)data[i]=Math.random()*2-1;const src=ctx.createBufferSource();src.buffer=buffer;const f=ctx.createBiquadFilter();f.type=filterType;f.frequency.setValueAtTime(frequency,now);if(sweep)f.frequency.exponentialRampToValueAtTime(sweep,now+dur);f.Q.value=filterType==='bandpass'?3:1;src.connect(f);f.connect(out(volume,dur));src.start();};
  const tone=(frequency,dur,volume,type='sine',to=null,delay=0)=>{const o=ctx.createOscillator(),g=ctx.createGain();o.type=type;o.frequency.setValueAtTime(frequency,now+delay);if(to)o.frequency.exponentialRampToValueAtTime(to,now+delay+dur);g.gain.setValueAtTime(.0001,now);g.gain.setValueAtTime(volume,now+delay);g.gain.exponentialRampToValueAtTime(.001,now+delay+dur);o.connect(g);g.connect(ctx.destination);o.start(now+delay);o.stop(now+delay+dur+.05);};
  if(type==='bell'){for(const [f,v]of [[220,.05],[440,.03],[586,.02],[880,.012]])tone(f,3.2,v);return true;}
  if(type==='heartbeat'){tone(62,.16,.16,'sine',40);tone(58,.14,.12,'sine',38,.2);return true;}
  if(type==='roar'){tone(90,1,.2,'sawtooth',55);tone(134,.9,.08,'sawtooth',70);noise(1,'bandpass',420,.16,180);return true;}
  if(type==='stomp'){tone(48,.35,.14,'sine',30);noise(.25,'lowpass',180,.06);return true;}
  if(type==='boulder'){tone(40,.9,.22,'sine',24);noise(.9,'lowpass',520,.22,90);return true;}
  if(type==='whoosh'){noise(1.2,'bandpass',1600,.12,260);return true;}
  if(type==='ignite'){noise(.6,'highpass',1800,.07);tone(140,.5,.04,'triangle',90);return true;}
  return false;
}
function toast(text) {$('toast').textContent=text;$('toast').classList.add('visible');toastUntil=performance.now()+3300;}
function setQuality(high){displayHigh=high;renderer.setPixelRatio(pixelRatio());renderer.setSize(innerWidth,innerHeight);lighting.high=high;rigidView?.setBackend?.(high?'raycast':'mesh');lastShadowRevision=-1;lighting.resize();$('quality').value=high?'high':'low';}
function setTool(index){const count=PROJECTILE_TOOLS.length;selectedTool=(index+count)%count;swing=null;tool.models.forEach((m,i)=>m.visible=i===selectedTool);updateToolPose();document.querySelectorAll('.tool').forEach((el,i)=>el.classList.toggle('selected',i===selectedTool));$('tool-name').textContent=PROJECTILE_TOOLS[selectedTool].name;$('tool-action').textContent=PROJECTILE_TOOLS[selectedTool].action;updateHud();}
function addMarkers() {
  for(const marker of markers){scene.remove(marker.group);marker.group.traverse(o=>{if(o.geometry)o.geometry.dispose();if(o.material)o.material.dispose();});}markers=[];
  for(const target of level.targets){
    const group=new THREE.Group();group.position.set(target.x,target.y,target.z);
    const box=new THREE.Mesh(new THREE.BoxGeometry(.35,.2,.25),new THREE.MeshStandardMaterial({color:0xedc674,emissive:0x7a5423,emissiveIntensity:.5,roughness:.5}));group.add(box);
    const diamond=new THREE.Mesh(new THREE.OctahedronGeometry(.17),new THREE.MeshBasicMaterial({color:0xf3ce81}));diamond.position.y=.75;group.add(diamond);
    const circle=new THREE.Mesh(new THREE.RingGeometry(.38,.4,24),new THREE.MeshBasicMaterial({color:0xeccb80,side:THREE.DoubleSide,transparent:true,opacity:.6}));circle.rotation.x=-Math.PI/2;circle.position.y=-target.y+.03;group.add(circle);
    scene.add(group);markers.push({group,diamond,target});
  }
}
addMarkers();setTool(0);
// Compile cut surfaces, their shadow pass and instanced chips in the menu,
// using the HDR target's shader configuration rather than stalling on impact.
function warmWorldShaders(){
  const previousTarget=renderer.getRenderTarget();
  try{
    performanceStats.destructionWarmup=warmDestructionShaders({renderer,lighting,scene,camera,worldRenderer,effects});
    // Compile the recovered lens passes during loading, before play begins.
    lighting.pass(lighting.focusMaterial,lighting.focusTargets[0]);
    lighting.pass(lighting.dofPrepareMaterial,lighting.dofPrepared);
    lighting.pass(lighting.dofBlurMaterial,lighting.dofBlurred);
    lighting.pass(lighting.dofCombineMaterial,lighting.lit);
  }catch(error){console.warn('Shader warmup:',error);}
  finally{renderer.setRenderTarget(previousTarget);}
}

function clearCharges(){for(const c of charges)scene.remove(c.mesh);charges=[];}
function resetWorld(nextMapId=selectedMapId) {
  localGrab.release();
  const previousMapId=level.mapId;
  rigidView?.clear();effects.clear();effects.material=null;worldRenderer.dispose();clearCharges();
  level=createLevelForMap(nextMapId);world=level.world;lighting.setWorld(world);worldRenderer=new WorldRenderer(scene,world);worldRenderer.rebuild();effects.world=world;effects.material=worldRenderer.material;
  if(previousMapId!==level.mapId){environment.dispose();environment=makeEnvironment(scene,level);}
  voxelJoints?.clear();rigidPhysics?.reset(world);if(rigidPhysics){rigidPhysics.isReplica=false;installOriginalProps(rigidPhysics,level.originalProps);for(const model of level.originalDoors??[])installOriginalDoor(rigidPhysics,voxelJoints,model);}if(rigidView){rigidView.material=worldRenderer.material;effects.rigidDebris=rigidView;rigidView.sync();}
  localCargo.reset(pickupDefinitions());rigidView?.sync();
  projectiles.reset(world);characters.setWorld(world);characters.reset(level.characters);titans.reset(world,titanConfig());titanGrace=0;titanCatches=0;titanDowns=0;
  gear.setWorld(world);gear.setRigid(rigidPhysics);gear.reset();gear.visuals.setRacks(level.gear);campaign.reset(level);
  initialVoxels=world.cells.size;destruction=0;rigidDestruction=0;collapseAt=0;actionCooldown=0;recoil=0;shake=0;bob=0;lastImpact=null;lastShadowRevision=-1;worldEpoch++;collapseQueue.clear(worldEpoch);supportPending=false;supportRetryPending=false;checkSupport(true);quicksave=null;addMarkers();environment.signs.forEach(s=>s.visible=true);
  // Compile the final scene, including newly created markers. No previous
  // marker/material can be disposed underneath a delayed compilation poll.
  warmWorldShaders();
}
function startGame(nextMode,reset=true) {
  prepareAudio();closeMap();
  if(reset)resetWorld();mode=nextMode;mission=new Mission(level.targets,mode,{duration:level.challengeSeconds??60});
  toolShotSequence=0;
  if(rigidView)effects.rigidDebris=rigidView;
  const start=level.points[$('spawn-point').value]||level.points.middle;
  player={x:start.x,y:start.y,z:start.z,vy:0,vx:0,vz:0,grounded:true};yaw=start.yaw;pitch=start.pitch||0;totalPlay=0;
  state='playing';manualPause=false;clearControlInputs();$('menu').hidden=true;$('hud').hidden=false;$('pause').hidden=true;$('result').hidden=true;$('help').hidden=true;
  thirdCamera.reset();movePlayer(0);tool.group.visible=!thirdPerson;setTool(0);updateHud();saveGame(false);
  if(campaign.active&&reset){campaign.start();movePlayer(0);}
  if(physicsError)toast('刚体物理加载失败：当前使用简化碎屑，刷新页面可重试。');
  else if(campaign.active){}
  else if(level.titans)toast(`巨人来袭 · 共 ${titans.titans.length} 个 · 打后颈击倒 · 身旁发光架按 E 穿戴飞索腰具 · H 查看按键`);
  else toast(selectedMapId==='amusement-park-blindbox-v2'?'砸开封存空间找宝物 · 1 大锤 · 2 霰弹枪 · 4 RPG · E 拿起':localCargo.activeCount?'入口工作台旁有货箱 · E 拿起 · F 装背架 · G 卸下 · V 查看背架':mode==='sandbox'?'1–5 切换工具 · 4 RPG · 5 手雷 · 3 放置炸药，R 引爆':`先拆出路线。第一件目标会触发 ${level.challengeSeconds??60} 秒倒计时。`);requestCapture();
}
function requestCapture(){if(captureUnavailable)return;try{const promise=canvas.requestPointerLock();promise?.catch(()=>{captureUnavailable=true;toast('按住鼠标右键拖动视角，也可正常游玩');});}catch{captureUnavailable=true;toast('按住鼠标右键拖动视角，也可正常游玩');}}
function pauseGame(){if(state!=='playing')return;releaseMouseGrab();jumpQueued=jumpNetworkQueued=false;state='paused';manualPause=true;clearControlInputs();$('pause').hidden=false;updateHud();document.exitPointerLock?.();}
function resumeGame(){state='playing';manualPause=false;clearControlInputs();$('pause').hidden=true;$('help').hidden=true;canvas.focus();requestCapture();}
function backToMenu(){closeMap();state='menu';manualPause=true;clearControlInputs();$('pause').hidden=true;$('result').hidden=true;$('hud').hidden=true;$('help').hidden=true;$('menu').hidden=false;tool.group.visible=false;document.exitPointerLock?.();}
function showHelp(){if(state!=='playing')return;state='help';manualPause=true;clearControlInputs();$('help').hidden=false;document.exitPointerLock?.();}

function saveGame(notify=true) {
  if(mission.phase!=='planning' && mission.phase!=='sandbox'){if(notify)toast('警报响起后无法覆盖准备存档；F9 可重试路线');return;}
  const snapshot=world.altered.size===0&&world.damage.size===0?level.initialSnapshot:world.snapshot();
  quicksave={world:snapshot,joints:voxelJoints?.snapshot(),rigidBodies:rigidPhysics?.snapshot(),toolPolicy:TOOL_POLICY_ID,toolShotSequence,supportSettled:!supportPending&&!collapseQueue.hasPending&&collapseAt<=0&&!world.supportDirty.size,player:{...player},yaw,pitch,mission:mission.snapshot(),destruction,rigidDestruction,characters:characters.snapshot(),barrels:level.barrels.map(b=>({...b})),charges:charges.map(c=>({position:{x:c.mesh.position.x,y:c.mesh.position.y,z:c.mesh.position.z},rigidId:c.rigidId,localPoint:c.localPoint,anchorCell:c.anchorCell,rigidAnchorCell:c.rigidAnchorCell,fallVelocity:c.fallVelocity}))};
  // The in-memory quicksave is immediate. Persist after the input/render task.
  quicksave.cargo=localCargo.snapshot();quicksave.campaign=campaign.saveState();
  const save=quicksave;saveRevision++;
  setTimeout(()=>{if(storedSave!==save)return;writeGameSave(save).then(()=>{if(notify&&storedSave===save)toast('准备存档已保存 · F9 读取');}).catch(error=>{console.warn('Persistent game save failed',error);if(storedSave===save)toast('本次存档仅保留在当前窗口，未能写入本地存储。');});},250);
  storedSave=quicksave;$('continue-save').hidden=false;
  if(notify){toast('正在保存准备状态…');audio('save');}
}
async function loadGame() {
  if(!quicksave){try{quicksave=storedSave||await readGameSave();}catch{}}
  if(!quicksave){toast('还没有准备存档');return;}
  localGrab.release();supportRetryPending=false;
  voxelJoints?.clear();worldEpoch++;collapseQueue.clear(worldEpoch);const migratedTerrain=restoreLevelSnapshot(world,quicksave.world);lighting.setWorld(world);worldRenderer.rebuild();effects.clear();clearCharges();
  rigidView?.clear();rigidPhysics?.reset(world);rigidPhysics?.restore(quicksave.rigidBodies);if(voxelJoints&&quicksave.joints)voxelJoints.restore(quicksave.joints);rigidView?.sync();
  if(!quicksave.cargo&&level.pickups?.length&&rigidPhysics)installOriginalProps(rigidPhysics,(level.originalProps??[]).filter(p=>p.id==='park-loading-table'));
  localCargo.restore(quicksave.cargo,pickupDefinitions());rigidView?.sync();
  toolShotSequence=Number.isSafeInteger(quicksave.toolShotSequence)?Math.max(0,quicksave.toolShotSequence):0;
  projectiles.reset(world);characters.reset(level.characters);characters.restore(quicksave.characters);
  supportPending=false;checkSupport(true,quicksave.supportSettled!==true);lastShadowRevision=-1;
  player={...quicksave.player,vy:0,vx:0,vz:0};yaw=quicksave.yaw;pitch=quicksave.pitch;mission.restore(quicksave.mission);mode=mission.mode;destruction=quicksave.destruction;campaign.loadState(quicksave.campaign);
  // Legacy saves may contain a player already standing underneath the shell.
  if(migratedTerrain&&world.collides(player.x,player.y,player.z)){
    for(let y=player.y;y<25;y+=CELL)if(!world.collides(player.x,y,player.z)){player.y=y;break;}
  }
  if(migratedTerrain){quicksave.world=world.snapshot();quicksave.player={...player};}
  rigidDestruction=quicksave.rigidDestruction||0;
  level.barrels=quicksave.barrels.map(b=>({...b}));for(const charge of quicksave.charges){placeCharge(charge.position);Object.assign(charges[charges.length-1],{rigidId:charge.rigidId,localPoint:charge.localPoint,anchorCell:charge.anchorCell,rigidAnchorCell:charge.rigidAnchorCell,fallVelocity:charge.fallVelocity});}updateCharges();
  collapseAt=0;shake=0;swing=null;actionCooldown=0;environment.signs.forEach((s,i)=>{const p=s.userData.anchor;s.visible=Boolean(world.get(Math.floor(p.x/CELL),Math.floor(p.y/CELL),Math.floor(p.z/CELL)));});
  state='playing';manualPause=false;$('result').hidden=true;$('pause').hidden=true;$('help').hidden=true;clearControlInputs();updateHud();toast('准备存档已读取 · 再试一条更快的路线');requestCapture();
  if(migratedTerrain)writeGameSave(quicksave).catch(error=>console.warn('Migrated save persistence failed',error));
}

function igniteFuel(removed){
  const fuel=removed.filter(p=>p.mat==='fuel');if(!fuel.length)return;
  for(const barrel of level.barrels)if(barrel.alive&&fuel.some(p=>Math.hypot((p.x+.5)*CELL-barrel.x,(p.y+.5)*CELL-barrel.y,(p.z+.5)*CELL-barrel.z)<.8)){barrel.alive=false;explode(barrel,2.8);}
}
function damage(point,radius,power,force=3,kind='generic') {
  const removed=TOOL_POLICY[kind]?cutStaticForTool(world,point,kind,{radius}):world.destroySphere(point,radius,power,{kind});destruction+=removed.length;effects.burst(removed,point,force);
  if(removed.length){worldRenderer.rebuild({budgetMs:5});collapseAt=.18;$('crosshair').classList.add('hit');setTimeout(()=>$('crosshair').classList.remove('hit'),100);}
  igniteFuel(removed);
  // A wall-mounted sign falls out of view if its supporting wall has been removed.
  environment.signs.forEach(s=>{const p=s.userData.anchor;if(!world.get(Math.floor(p.x/CELL),Math.floor(p.y/CELL),Math.floor(p.z/CELL)))s.visible=false;});
  return removed.length;
}
function raycastSolids(origin,direction,range){
  const wall=world.raycast(origin,direction,range);
  const loose=rigidPhysics?.raycast(origin,direction,wall?.distance??range);
  if(!loose)return wall;
  return {...loose,rigidId:loose.id};
}
function showLooseDamage(result,point,force){
  effects.rigidBurst(result,point,force);
  if(result.changes.length){rigidView.sync();updateCharges();lastShadowRevision=-1;$('crosshair').classList.add('hit');setTimeout(()=>$('crosshair').classList.remove('hit'),100);}
}
function damageLoose(point,radius,power,force,kind,id,deferVisuals=false){
  if(!rigidPhysics)return null;
  const result=TOOL_POLICY[kind]?cutRigidForTool(rigidPhysics,point,kind,{id,radius}):rigidPhysics.destroySphere(point,radius,power,kind,{id});
  voxelJoints?.rebind(result.changes);
  localGrab.rebind(result.changes);localCargo.rebind(result.changes);
  for(const change of result.changes)for(const charge of charges){
    const attachment=rebindRigidAttachment(charge,change,rigidPhysics.entries);if(!attachment)continue;
    if(attachment.detached){charge.rigidId=null;charge.localPoint=null;charge.rigidAnchorCell=null;charge.fallVelocity=0;charge.mesh.position.copy(attachment.position);}
    else {Object.assign(charge,{rigidId:attachment.rigidId,localPoint:attachment.localPoint,rigidAnchorCell:attachment.rigidAnchorCell});charge.mesh.position.copy(attachment.position);}
  }
  rigidDestruction+=result.removed.length;
  if(!deferVisuals)showLooseDamage(result,point,force);
  if(result.rejected.length)toast(result.rejected[0].reason==='memory'?'碎块数据内存暂不足，保留原块':'碎块碰撞体创建失败，保留原块');
  return result;
}
function hitLoosePiece(hit,direction,deferVisuals=false){
  const entry=rigidPhysics?.entries.get(hit.rigidId);if(!entry)return;
  const kind=selectedTool===0?'hammer':'shotgun',attack=ATTACKS[kind],depth=attack.penetration;
  applyToolHitImpulse(rigidPhysics,hit,direction,kind);
  const point={x:hit.point.x+direction.x*depth,y:hit.point.y+direction.y*depth,z:hit.point.z+direction.z*depth};
  const result=damageLoose(point,attack.radius,kind==='shotgun'?shotgunPower(hit.distance):attack.power,kind==='hammer'?2.7:4,kind,hit.rigidId,deferVisuals);
  effects.impact(hit,kind);
  lastImpact={material:hit.mat,tool:kind,rigidId:hit.rigidId,removed:result?.removed.length||0,damage:rigidPhysics.damageRatio(hit.rigidId,hit.voxel)};
  return result;
}
function explode(point,radius=ATTACKS.explosion.radius) {
  const torso={x:player.x,y:player.y+1,z:player.z};
  const direction={x:point.x-torso.x,y:point.y-torso.y,z:point.z-torso.z};
  const distance=Math.hypot(direction.x,direction.y,direction.z);
  const blastRadius=Math.max(3.5,radius*1.6);
  // Check cover before the blast removes the wall. Ignore the final 25 cm so
  // the charge or barrel at the explosion point does not block its own force.
  const covered=distance>.35&&distance<blastRadius&&Boolean(world.raycast(torso,direction,distance-.25));
  const velocity=calculateBlastVelocity(player,point,{radius:blastRadius,cover:covered ? .2 : 1});
  if(velocity)Object.assign(player,velocity);
  characters.blast(point,blastRadius,1);titans.blast(point,blastRadius);giants.noise(point,45,'explosion');damageLoose(point,radius,ATTACKS.explosion.power,8,'explosion');rigidPhysics?.blast(point,blastRadius,8);effects.explosion(point);audio('explosion');damage(point,radius,ATTACKS.explosion.power,8,'explosion');
  shake=Math.max(shake,Math.max(0,1-distance/22)*.35);
  if(distance<5){$('damage-flash').style.opacity='1';setTimeout(()=>$('damage-flash').style.opacity='0',220);}
}
function placeCharge(point,rigidId=null,anchorCell=null,rigidAnchorCell=null){
  const mesh=new THREE.Mesh(bombGeometry,bombMaterial);mesh.position.set(point.x,point.y,point.z);scene.add(mesh);const charge={mesh,anchorCell};
  const entry=rigidPhysics?.entries.get(rigidId);
  if(entry)attachChargeToRigid(charge,entry,rigidAnchorCell);
  charges.push(charge);
}
function attachChargeToRigid(charge,entry,anchor=charge.anchorCell){
  charge.rigidAnchorCell=anchor?{x:anchor.x,y:anchor.y,z:anchor.z}:null;
  charge.rigidId=entry.id;charge.anchorCell=null;
  charge.localPoint=charge.mesh.position.clone().sub(entry.position).applyQuaternion(new THREE.Quaternion().copy(entry.rotation).invert()).toArray();
}
function attachWallCharges(entry){
  const pending=charges.filter(c=>!c.rigidId&&c.anchorCell);if(!pending.length)return;
  const occupied=new Set(entry.cells.map(c=>keyOf(c.x,c.y,c.z)));
  for(const charge of pending)if(occupied.has(keyOf(charge.anchorCell.x,charge.anchorCell.y,charge.anchorCell.z)))attachChargeToRigid(charge,entry);
}
function updateCharges(dt=0){
  for(const charge of charges){
    const entry=rigidPhysics?.entries.get(charge.rigidId);
    if(entry&&charge.localPoint){charge.mesh.position.fromArray(charge.localPoint).applyQuaternion(entry.rotation).add(entry.position);charge.mesh.quaternion.copy(entry.rotation);continue;}
    if(charge.rigidId){charge.rigidId=null;charge.localPoint=null;charge.rigidAnchorCell=null;charge.fallVelocity=0;}
    if(charge.fallVelocity===undefined||dt<=0)continue;
    charge.fallVelocity-=(world.gravity??9.81)*dt;const drop=-charge.fallVelocity*dt;
    const hit=raycastSolids(charge.mesh.position,{x:0,y:-1,z:0},drop+.065);
    if(hit){charge.mesh.position.y=hit.point.y+.065;delete charge.fallVelocity;
      if(hit.rigidId)attachChargeToRigid(charge,rigidPhysics.entries.get(hit.rigidId),hit.voxel);
      else charge.anchorCell={x:hit.x,y:hit.y,z:hit.z};
    }else charge.mesh.position.y-=drop;
  }
}
function detonate(){if(state!=='playing')return;if(!charges.length){toast('还没有放置炸药：按 3，再对准墙体点击左键');return;}const pending=charges.map(c=>({...c.mesh.position}));clearCharges();for(const point of pending)explode(point);actionCooldown=.5;toast(`已引爆 ${pending.length} 份炸药`);updateHud();}
function useTool() {
  if(state!=='playing'||actionCooldown>0||localGrab.handle)return;
  if(gear.equipped&&gear.blades&&selectedTool===0){bladeSlash();actionCooldown=.42;return;}
  const origin=aimCamera.position,direction=new THREE.Vector3();aimCamera.getWorldDirection(direction);
  const hit=raycastSolids(origin,direction,selectedTool===0?TOOL_POLICY.hammer.range:selectedTool===1?TOOL_POLICY.shotgun.range:5);
  if(selectedTool===0){swing=0;actionCooldown=HAMMER_DURATION;}
  else if(selectedTool===1){
    recoil=.15;shake=.022;actionCooldown=.55;audio('shot');effects.muzzle(origin,direction);
    const removed=[],looseDamage={removed:[],fragments:[],changes:[]};let loosePoint=null;
    const rays=shotgunDirections(yaw,pitch,++toolShotSequence);
    for(let i=0;i<rays.length;i++){
      const ray=new THREE.Vector3().copy(rays[i]),pellet=raycastSolids(origin,ray,TOOL_POLICY.shotgun.range);
      const actor=characters.raycast(origin,ray,pellet?.distance??TOOL_POLICY.shotgun.range),giant=giants.raycast(origin,ray,actor?.distance??pellet?.distance??TOOL_POLICY.shotgun.range);
      if(giant){giants.hit(giant,giant.part==='nape'?25:0);lastImpact={material:giant.part==='nape'?'巨人后颈':'巨人',tool:'shotgun',removed:0};continue;}
      if(actor){characters.hit(actor,{damage:20,direction:ray,force:2});lastImpact={material:actor.character?.name||'角色',tool:'shotgun',removed:0};continue;}
      if(pellet?.rigidId){const result=hitLoosePiece(pellet,ray,true);if(result){looseDamage.removed.push(...result.removed);looseDamage.fragments.push(...result.fragments);looseDamage.changes.push(...result.changes);loosePoint=pellet.point;}continue;}
      if(pellet){if(i===0)pellet.visualPoint=worldRenderer.surfacePoint(pellet);const depth=TOOL_POLICY.shotgun.penetration,point={x:pellet.point.x+ray.x*depth,y:pellet.point.y+ray.y*depth,z:pellet.point.z+ray.z*depth};removed.push(...cutStaticForTool(world,point,'shotgun'));if(i===0)effects.impact(pellet,'shotgun');}
    }
    // All nine pellets query the updated collision shapes, but only the final
    // shape uploads once. Rebuilding the same large mesh per pellet stalls a shot.
    if(loosePoint){showLooseDamage(looseDamage,loosePoint,4);if(lastImpact?.rigidId)lastImpact.removed=looseDamage.removed.length;}
    if(removed.length){destruction+=removed.length;effects.burst(removed,{x:removed[0].x*CELL,y:removed[0].y*CELL,z:removed[0].z*CELL},4);worldRenderer.rebuild({budgetMs:5});collapseAt=.18;}
    igniteFuel(removed);if(hit&&!hit.rigidId)lastImpact={material:hit.mat,tool:'shotgun',removed:removed.length,damage:world.damageRatio(hit.x,hit.y,hit.z)};
  }
  else if(selectedTool===2){if(!hit){toast('靠近一点，对准 5 米内的墙体或物品');return;}if(charges.length>=16){toast('最多同时放置 16 份炸药，按 R 引爆');return;}placeCharge({x:hit.point.x+hit.normal.x*.1,y:hit.point.y+hit.normal.y*.1,z:hit.point.z+hit.normal.z*.1},hit.rigidId,hit.rigidId?null:{x:hit.x,y:hit.y,z:hit.z},hit.voxel);audio('save');actionCooldown=.3;toast(`已放置炸药 ${charges.length} · 按 R 同时引爆`);}
  else if(projectiles.launch(selectedTool===3?'rocket':'grenade',origin,direction)){
    actionCooldown=selectedTool===3?1.15:.65;recoil=selectedTool===3?.3:.22;
    if(selectedTool===3){audio('shot');effects.muzzle(origin,direction);shake=.035;}else audio('wood');
  }
  updateHud();
}

function interact() {
  if(state!=='playing')return;
  const candidate=nearestInteraction();if(!candidate)return;
  if(candidate.type==='release'){localGrab.release();return;}
  if(candidate.type==='gear'){if(!gear.equip())gear.refill();updateHud();return;}
  if(['mission','rescue','board'].includes(candidate.type)){campaign.interact(candidate);updateHud();return;}
  if(candidate.type==='piece'||candidate.type==='cargo'){
    if(localGrab.grab(candidate.hit)){swing=null;toast(candidate.cargo?`${candidate.cargo.name} · F 装到背架 · E 放下 · Q 抛出`:'E 松手 · Q 抛出 · 重物需要慢慢拖动；放下木板后可以踩踏');}
    return;
  }
  if(candidate.type==='target') {
    const first=mission.phase==='planning';mission.collect(candidate.target.id);audio('collect');
    if(first){toast(`倒计时开始！${level.challengeSeconds??60} 秒内收齐目标，返回交付点。`);audio('alarm');}
    else toast(mission.collected.size===mission.total?'全部机密到手。返回绿色撤离点，按 E 撤离。':`机密 ${candidate.target.id} 已回收`);
  }else if(mission.escape())finish();else toast(mode==='sandbox'?'这里是撤离点，沙盒可以一直游玩':`还需要 ${mission.total-mission.collected.size} 份机密`);
  updateHud();
}
function nearestInteraction(){
  if(localGrab.handle)return {type:'release',cargo:localCargo.held};
  const direction=new THREE.Vector3();aimCamera.getWorldDirection(direction);
  const hit=raycastSolids(aimCamera.position,direction,2.8);
  if(hit?.rigidId&&hit.voxel){const cargo=localCargo.byRigid(hit.rigidId);return {type:cargo?'cargo':'piece',hit,cargo,name:cargo?.name||rigidPhysics.entries.get(hit.rigidId)?.name||'体素碎块'};}
  const nearby=localCargo.nearestHit(aimCamera.position,raycastSolids);
  if(nearby)return {type:'cargo',...nearby,name:nearby.cargo.name};
  const quest=campaign.interaction(player);
  if(quest)return quest;
  const rack=gear.nearestRack(player,level.gear);
  if(rack)return {type:'gear',rack};
  if(mode==='sandbox')return null;
  let closest=null,min=2.4;
  for(const target of level.targets)if(!mission.collected.has(target.id)){
    const dx=target.x-player.x,dy=target.y-(player.y+1.45),dz=target.z-player.z,d=Math.hypot(dx,dy,dz);
    if(d<min){const obstacle=world.raycast({x:player.x,y:player.y+1.45,z:player.z},{x:dx,y:dy,z:dz},d-.15);if(!obstacle){closest={type:'target',target};min=d;}}
  }
  if(!closest && Math.hypot(player.x-level.exit.x,player.z-level.exit.z)<3.3)closest={type:'exit'};
  return closest;
}
function showTitanResults(r){
  state='result';manualPause=true;clearControlInputs();$('result').hidden=false;document.exitPointerLock?.();
  $('result-tag').textContent=r.failed?'MISSION FAILED':r.kind==='complete'?'WALL RECLAIMED':'MISSION REPORT';
  $('result-title').textContent=r.failed?'命数用尽，城墙仍在巨人手里。':r.kind==='complete'?'七项任务全部完成，城墙夺回。':'提前撤回安全屋，行动结算。';
  $('result-copy').textContent=`评级 ${r.grade} · 分数 ${r.score}（星级 ${r.stars} × 100 − 死亡 ${r.deaths} × 80 − 用时分钟 × 5）`;
  const m=Math.floor(r.seconds/60),s=Math.floor(r.seconds%60);
  $('result-stats').innerHTML=`<span><b>${r.completed} / ${r.total}</b>完成任务</span><span><b>${r.deaths}</b>死亡</span><span><b>${m}:${String(s).padStart(2,'0')}</b>用时</span><span><b>${r.grade}</b>评级</span>`;
  $('result-load').disabled=!quicksave;
}
function finish(){
  state='result';manualPause=true;clearControlInputs();$('result').hidden=false;document.exitPointerLock?.();
  const won=mission.phase==='won';$('result-tag').textContent=won?'MISSION COMPLETE':'ALARM TIMEOUT';$('result-title').textContent=won?'干净利落。':'还差一条捷径。';
  $('result-copy').textContent=won?'机密已回收，撤离成功。你为这个场景留下了一条自己的路。':'警报倒计时结束。读取准备存档，再拆一条更直接的路线。';
  const duration=level.challengeSeconds||60;
  $('result-stats').innerHTML=`<span><b>${mission.collected.size} / 3</b>回收物品</span><span><b>${destruction.toLocaleString()}</b>破坏体素</span><span><b>${(won?duration-mission.remaining:duration).toFixed(1)}s</b>行动用时</span>`;
  $('result-load').disabled=!quicksave;
}

function updatePerspectiveButton(){
  $('view-button').setAttribute('aria-label',thirdPerson?'切换第一人称视角':'切换第三人称视角');
  $('view-button').setAttribute('aria-pressed',String(thirdPerson));
  $('view-button').innerHTML=`V <small>${thirdPerson?'第三人称':'第一人称'}</small>`;
}
function togglePerspective(){
  thirdPerson=!thirdPerson;thirdCamera.reset();updatePerspectiveButton();
  if(state==='playing')movePlayer(0);
  if(!thirdPerson){camera.position.copy(aimCamera.position);camera.quaternion.copy(aimCamera.quaternion);}
  toast(thirdPerson?'第三人称 · Alt＋右键环绕角色 · Home 回正 · V 切换':'第一人称 · V 查看角色与背架');
}
function rotateView(deltaYaw,deltaPitch=0,freeLook=false){
  if(thirdPerson&&(freeLook||thirdCamera.orbiting)){thirdCamera.orbit(deltaYaw,deltaPitch);return;}
  yaw+=deltaYaw;pitch=THREE.MathUtils.clamp(pitch+deltaPitch,-1.45,1.45);
}
const reticlePoint=new THREE.Vector3(),reticleDirection=new THREE.Vector3();
function updatePerspective(dt,time){
  const inWorld=!['menu','menuhelp'].includes(state);
  if(thirdPerson&&inWorld){
    thirdCameraState=thirdCamera.update(camera,aimCamera,raycastSolids,dt);
    aimCamera.getWorldDirection(reticleDirection);
    const range=selectedTool===0?TOOL_POLICY.hammer.range:selectedTool===2?5:60;
    const hit=raycastSolids(aimCamera.position,reticleDirection,range);
    if(hit?.point)reticlePoint.copy(hit.point);else reticlePoint.copy(aimCamera.position).addScaledVector(reticleDirection,range);
    camera.updateMatrixWorld(true);reticlePoint.project(camera);
    $('crosshair').style.left=`${THREE.MathUtils.clamp((reticlePoint.x+1)*50,2,98)}%`;
    $('crosshair').style.top=`${THREE.MathUtils.clamp((1-reticlePoint.y)*50,2,98)}%`;
    $('crosshair').style.visibility=thirdCameraState.orbiting?'hidden':'';
  }else{$('crosshair').style.left='50%';$('crosshair').style.top='50%';$('crosshair').style.visibility='';}
  if(campaign.active&&inWorld){aimCamera.getWorldDirection(reticleDirection);campaign.updateCrosshair(aimCamera.position,reticleDirection);}
  $('camera-hint').hidden=!thirdPerson||!inWorld;
  $('camera-hint').textContent=thirdCameraState.orbiting?'环绕观察 · Home 回正 · 移动或左键恢复跟随':'Alt＋右键环绕 · 右键抓取 · Home 回正';
  const heldId=localGrab.handle?.id;
  localPlayerView.update({player,yaw,pitch,time,dt,tool:selectedTool,swing,carrying:Boolean(localGrab.handle),heldEntry:rigidPhysics?.entries.get(heldId),down:false,rack:localCargo.rack,visible:thirdPerson&&inWorld&&thirdCameraState.bodyVisible&&!referencePhoto});
  if(thirdPerson)tool.group.visible=false;
  else if(inWorld&&!referencePhoto)tool.group.visible=!localGrab.handle&&!(gear.equipped&&gear.blades&&selectedTool===0);
}
function updateToolPose(){
  if(selectedTool===0){const pose=hammerPose(swing??0);tool.group.position.set(pose.x,pose.y+Math.sin(bob)*.009,pose.z);tool.group.rotation.set(pose.rx,pose.ry,pose.rz);}
  else{const held=selectedTool===1?{x:.34,y:-.27,z:-.82}:selectedTool===3?{x:.35,y:-.30,z:-.67}:selectedTool===4?{x:.30,y:-.27,z:-.65}:{x:.27,y:-.24,z:-.72};tool.group.position.set(held.x,held.y+Math.sin(bob)*.008,held.z+recoil*.55);tool.group.rotation.set(recoil*(selectedTool===4?-1.2:.4),0,0);}
  tool.updatePose();
}
function movePlayer(dt) {
  const forward=(keys.has('KeyW')||keys.has('ArrowUp')?1:0)-(keys.has('KeyS')||keys.has('ArrowDown')?1:0);
  const strafe=(keys.has('KeyD')?1:0)-(keys.has('KeyA')?1:0);
  if(thirdPerson&&(forward||strafe))thirdCamera.follow();
  const freeLook=keys.has('AltLeft')||keys.has('AltRight');
  if(keys.has('ArrowLeft'))rotateView(dt*1.8,0,freeLook);if(keys.has('ArrowRight'))rotateView(-dt*1.8,0,freeLook);
  if(keys.has('PageUp'))rotateView(0,dt*1.5,freeLook);if(keys.has('PageDown'))rotateView(0,-dt*1.5,freeLook);
  const speedFactor=(localGrab.speedFactor*localCargo.load.speedFactor)/Math.max(1,Math.hypot(forward,strafe));
  player.excludeRigidId=localGrab.handle?.id??null;
  const gearView=new THREE.Vector3();aimCamera.getWorldDirection(gearView);
  const spaceGear=gearSpaceMode(),hold=spaceGear&&keys.has('Space');
  const gearFlags=dt>0?gear.preStep(player,dt,{yaw,view:gearView,hold}):{airInertia:false};
  const movementResult=!(referencePhoto&&photoMode==='overview')&&!campaign.dying?stepPlayer(player,world,{airInertia:gearFlags.airInertia,forward:forward*speedFactor,strafe:strafe*speedFactor,sprint:!gear.reeling&&localCargo.load.canSprint&&!localGrab.handle&&(keys.has('ShiftLeft')||keys.has('ShiftRight')),crouch:keys.has('ControlLeft')||keys.has('ControlRight'),jump:jumpQueued||(!spaceGear&&keys.has('Space'))},yaw,dt,rigidPhysics):{fellInWater:false};
  if(dt>0)jumpQueued=false;
  if(dt>0)gear.postStep(player,dt,{collides:(x,y,z)=>world.collides(x,y,z,player.colliderHeight,PLAYER_CONTROL.radius)||Boolean(rigidPhysics?.collides(x,y,z,player.colliderHeight,PLAYER_CONTROL.radius,{excludeId:player.excludeRigidId}))});
  if(movementResult.fellInWater)toast('已返回出生点。');
  const movement=Math.hypot(player.vx,player.vz);bob+=dt*movement*1.9;
  aimCamera.position.set(player.x,player.y+(player.eyeHeight??PLAYER_CONTROL.standingEye)+(player.grounded?Math.sin(bob*2)*Math.min(.028,movement*.006):0)-Math.sin(Math.min(1,gear.landDip/.18)*Math.PI*.5)*.18,player.z);
  aimCamera.rotation.set(pitch,yaw,0);
  gear.render(dt,{player,yaw,thirdPerson,view:gearView});
  gasSound-=dt;if(gear.reeling&&gasSound<=0){audio('gas');gasSound=.16;}
  if(!thirdPerson){camera.position.copy(aimCamera.position);camera.quaternion.copy(aimCamera.quaternion);}
  if(shake>0){camera.rotation.x+=(Math.random()-.5)*shake;camera.rotation.z+=(Math.random()-.5)*shake*.4;shake*=Math.pow(.02,dt);if(shake<.002)shake=0;}
  if(swing!==null){
    const next=swing+dt;
    if(selectedTool===0&&crossesHammerImpact(swing,next)){
      const direction=new THREE.Vector3();aimCamera.getWorldDirection(direction);const hit=raycastSolids(aimCamera.position,direction,3.2);
      const actor=characters.raycast(aimCamera.position,direction,hit?.distance??3.2),giant=giants.raycast(aimCamera.position,direction,actor?.distance??hit?.distance??3.2);
      if(giant){giants.hit(giant,giant.part==='nape'?100:0);audio('hit');shake=.03;hammerHits++;lastImpact={material:giant.part==='nape'?'巨人后颈':'巨人',tool:'hammer',removed:0};}
      else if(actor){characters.hit(actor,{damage:65,direction,force:3});audio('hit');shake=.025;hammerHits++;}
      else if(hit?.rigidId){hitLoosePiece(hit,direction);audio(MATERIALS[hit.mat].sound);shake=.018;hammerHits++;}
      else if(hit){
        hit.visualPoint=worldRenderer.surfacePoint(hit);
        const attack=ATTACKS.hammer;audio(MATERIALS[hit.mat].sound);
        const removed=damage({x:hit.point.x+direction.x*attack.penetration,y:hit.point.y+direction.y*attack.penetration,z:hit.point.z+direction.z*attack.penetration},attack.radius,attack.power,2.7,'hammer');
        effects.impact(hit,'hammer');lastImpact={material:hit.mat,tool:'hammer',removed,damage:world.damageRatio(hit.x,hit.y,hit.z)};
        shake=Math.max(shake,.018);hammerHits++;
      }
    }
    swing=next>=HAMMER_DURATION?null:next;
  }
  updateToolPose();
  recoil=Math.max(0,recoil-dt);
}

function updateHud(){
  const direction=new THREE.Vector3();aimCamera.getWorldDirection(direction);
  const aimed=raycastSolids(aimCamera.position,direction,selectedTool===0?3.2:selectedTool===2?5:60),kind=['hammer','shotgun','explosion','explosion','explosion'][selectedTool];
  let materialStatus=null;
  if(aimed){const info=MATERIALS[aimed.mat],ratio=aimed.rigidId?rigidPhysics.damageRatio(aimed.rigidId,aimed.voxel):world.damageRatio(aimed.x,aimed.y,aimed.z);materialStatus={id:aimed.mat,name:info.name,damage:ratio,rigidId:aimed.rigidId};const canCut=makeHoleRadiusForMaterial(aimed.mat,TOOL_POLICY[kind].radii)>0;$('material-hint').textContent=`${info.name} · ${canCut?(ratio>.02?'接触损伤 '+Math.round(ratio*100)+'%':info.hardness):makeHoleRadiusForMaterial(aimed.mat,TOOL_POLICY.explosion.radii)>0?'使用炸药破拆':'不可破拆构件'}`;}
  $('material-hint').hidden=!aimed;
  const activeMission=mission;
  const rack=localCargo.rack;
  $('cargo-status').hidden=!localCargo.activeCount;
  if(!$('cargo-status').hidden){const load=rack?.load??localCargo.load;$('cargo-status-count').textContent=`${rack?.items?.length??0} 件 · ${load.kg} / ${load.maxKg} kg`;$('cargo-status-slots').textContent=`背架 ${load.usedBackCells} / ${load.backCells} 格${load.canSprint?'':' · 负重慢行'}`;}
  $('gear-status').hidden=!gear.equipped;
  if(gear.equipped){
    const label={idle:'—',windup:'蓄力',flying:'飞行',attached:'挂住',retract:'回收'};
    $('gear-gas').textContent=`气体 ${Math.round(gear.gas)}%`;$('gear-bar').firstElementChild.style.width=`${gear.gas}%`;$('gear-status').classList.toggle('low',gear.gas<25);
    $('gear-hooks').textContent=`左钩 ${label[gear.hooks[0].state]} · 右钩 ${label[gear.hooks[1].state]} · 双刃 ${gear.blades?'出鞘':'收起'}`;
  }
  performanceStats.physics=rigidPhysics?.stats;campaign.updateHud();
  canvas.dataset.diagnostics=JSON.stringify({campaign:campaign.snapshot(),farWall:Boolean(world.farWall),gear:level.gear?.length||campaign.active?gear.snapshot():null,state,view:thirdPerson?'third':'first',viewCamera:{...thirdCameraState,x:camera.position.x,y:camera.position.y,z:camera.position.z},localCharacter:localPlayerView.visual?.appearance,simulation:'local',phase:activeMission?.phase,voxels:world.cells.size,destruction,rigidDestruction,remaining:activeMission?.remaining,player:{x:player.x,y:player.y,z:player.z},charges:charges.length,bodies:rigidPhysics?.stats.bodies??0,rigid:rigidPhysics?.stats,grab:localGrab.handle,cargo:localCargo.diagnostics(),joints:voxelJoints?.stats(),toolPolicy:TOOL_POLICY_ID,toolShotSequence,assetProfile:level.assetProfile,assetStats:level.assetStats,titans:level.titans?{...titans.stats,catches:titanCatches,downs:titanDowns,list:titans.snapshot()}:null,tool:selectedTool,hammerHits,swing,particles:effects.particles.length,quality:lighting.high?'high':'low',material:materialStatus,lastImpact,performance:{...performanceStats,physicsScope:'local-solver',rebuild:worldRenderer.stats,pixelRatio:renderer.getPixelRatio(),resolution:[canvas.width,canvas.height]}});
  $('hud').classList.toggle('sandbox',mode==='sandbox');
  const labels={planning:['准备阶段','不限时','勘察场地，拆出捷径。第一份机密会触发警报。'],alarm:['警报已触发',mission.remaining.toFixed(1).padStart(4,'0'),'收集全部机密，回到绿色撤离点。'],sandbox:['自由沙盒','∞','无限工具，自由破坏。'],won:['撤离成功','完成',''],failed:['警报结束','00.0','']};
  const [label,timer,hint]=labels[mission.phase];$('phase-label').textContent=label;$('timer').textContent=timer;$('phase-hint').textContent=hint;$('phase').classList.toggle('alarm',mission.phase==='alarm');$('phase').classList.toggle('urgent',mission.phase==='alarm'&&mission.remaining<15);
  const campaignRun=campaign.active?campaign.run:null;
  $('mode-label').textContent=campaignRun?`夺回城墙 · ${campaignRun.result?(campaignRun.result.failed?'行动失败':'已完成'):'任务进行中'}`:mode==='sandbox'?'自由探索 · 不限时':`${level.name||mapInfo(selectedMapId).name} · 回收`;$('target-count').textContent=`${mission.collected.size} / 3`;
  $('objectives-title').textContent=mode==='sandbox'?'场地标记 · 可选':'行动目标';
  document.querySelector('.escape-label').innerHTML=campaignRun?`<span>★</span> 任务 ${campaignRun.completed}/7 · 剩余 ${campaignRun.lives} 条命`:mode==='sandbox'?'<span>∞</span> 不限时，自由探索，无需撤离':'<span>↗</span> 收集完成后，返回撤离点';
  $('target-list').innerHTML=level.targets.map(t=>{const done=mission.collected.has(t.id);return `<div class="target-row ${done?'done':''}"><i>${done?'✓':t.id}</i><span>${t.name}<small>${done?'已回收':Math.round(Math.hypot(t.x-player.x,t.z-player.z))+' 米 · 靠近后按 E'}</small></span></div>`;}).join('');
  $('destroyed').innerHTML=`${destruction.toLocaleString()} <small>体素</small>`;$('charges').textContent=selectedTool===2?`已放置 ${charges.length} / 16 · 按 R 引爆`:'工具不限次数';
  for(const marker of markers)marker.group.visible=mode!=='sandbox'&&!mission.collected.has(marker.target.id);
}

const mapCache=document.createElement('canvas');mapCache.width=mapCache.height=240;let mapFoundation=null;
function drawMap(){
  const ctx=$('minimap').getContext('2d'),scale=218/Math.max(world.bounds.maxX-world.bounds.minX,world.bounds.maxZ-world.bounds.minZ),centerX=(world.bounds.minX+world.bounds.maxX)/2,centerZ=(world.bounds.minZ+world.bounds.maxZ)/2,px=x=>120+(x-centerX)*scale,pz=z=>120+(z-centerZ)*scale;
  if(mapFoundation!==world.foundation){
    const c=mapCache.getContext('2d');c.fillStyle='#1c241fe0';c.fillRect(0,0,240,240);
    c.fillStyle='#b1ad97';
    for(let z=-490;z<490;z+=5)for(let x=-410;x<410;x+=5){
      const h=world.foundation?.[x+512+(z+512)*1024]??-1;
      if(h>=0&&h<115)c.fillRect(px(x*CELL),pz(z*CELL),scale*.5+.1,scale*.5+.1);
    }
    c.fillStyle='#d7c881';c.font='bold 12px Arial';for(const label of level.mapLabels||[{text:'B',x:-23,z:-37},{text:'MID',x:9,z:-12}])c.fillText(label.text,px(label.x)-5,pz(label.z)+4);mapFoundation=world.foundation;
  }
  ctx.clearRect(0,0,240,240);ctx.drawImage(mapCache,0,0);
  if(mode!=='sandbox'&&!campaign.active)for(const t of level.targets){if(mission.collected.has(t.id))continue;ctx.fillStyle='#e8ce76';ctx.fillRect(px(t.x)-2.5,pz(t.z)-2.5,5,5);}
  campaign.drawMap(ctx,px,pz);
  ctx.save();ctx.translate(px(player.x),pz(player.z));ctx.rotate(-yaw);ctx.fillStyle='#e3efc3';ctx.beginPath();ctx.moveTo(0,-6);ctx.lineTo(-4,4);ctx.lineTo(0,2);ctx.lineTo(4,4);ctx.closePath();ctx.fill();ctx.restore();
}

function update(dt) {
  actionCooldown=Math.max(0,actionCooldown-dt);
  if(state==='playing'&&toolHeld&&!localGrab.handle&&actionCooldown<=0)useTool();
  if(state==='playing'){
    const updateEpoch=worldEpoch;
    const grabDirection=new THREE.Vector3();aimCamera.getWorldDirection(grabDirection);localGrab.step(aimCamera.position,grabDirection,dt,localGrab.handle?.mode==='drag'?null:carryTarget(player,yaw,pitch,bodyGripDimensions(localPlayerView.visual)));
    voxelJoints?.step();
    const finishPhysicsUpdate=()=>{
    if(updateEpoch!==worldEpoch)return;
    rigidPhysics?.drainContactEvents?.();
    for(const result of rigidPhysics?.drainFractureEvents?.()||[]){
      voxelJoints?.rebind(result.changes);
      localGrab.rebind(result.changes);localCargo.rebind(result.changes);
      for(const change of result.changes)for(const charge of charges){const attachment=rebindRigidAttachment(charge,change,rigidPhysics.entries);if(!attachment)continue;if(attachment.detached){charge.rigidId=null;charge.localPoint=null;charge.rigidAnchorCell=null;charge.fallVelocity=0;charge.mesh.position.copy(attachment.position);}else Object.assign(charge,attachment);}
      effects.rigidBurst(result,result.contact.point,Math.min(3,result.contact.impactSpeed*.2));rigidDestruction+=result.removed.length;
      if(result.changes.length){lastShadowRevision=-1;audio(MATERIALS[result.contact.material]?.sound||'collapse');if(result.contact?.point)giants.noise(result.contact.point,35,'collapse');}
    }
    voxelJoints?.step();updateCharges(dt);performanceStats.physics=rigidPhysics?.stats;
    movePlayer(dt);tool.group.visible=!localGrab.handle&&!(gear.equipped&&gear.blades&&selectedTool===0);mission.tick(dt);projectiles.update(dt);characters.update(dt,{syncVisuals:physicsLegacy.has('charsync')});titanGrace=Math.max(0,titanGrace-dt);titans.update(dt,titanTargets());campaign.update(dt);effects.update(dt);totalPlay+=dt;
    if(collapseAt>0&&!supportPending){collapseAt-=dt;if(collapseAt<=0)checkSupport();}
    if(mission.phase==='failed')finish();
    };
    if(sourcePhysicsAsync&&rigidPhysics?.referencePipeline)return rigidPhysics.stepAsync(dt).then(finishPhysicsUpdate);
    rigidPhysics?.step(dt);finishPhysicsUpdate();
  }
}


window.addEventListener('pagehide',event=>{if(!event.persisted){collapseVisuals.dispose();voxelJoints?.dispose();rigidPhysics?.dispose();}});

function animate(now) {
  // Two fixed ticks per frame are always granted, as in the reference loop.
  // Further catch-up ticks run only while measured tick cost fits half of the
  // previous frame's non-tick time (at least 8 ms), so GPU-bound frames keep
  // real time while expensive ticks slow the simulation (backlog trimmed below
  // three ticks) instead of enlarging their own budget.
  const started=performance.now(),elapsed=(now-lastFrame)/1000,catchup=physicsLegacy.has('catchup'),strictCap=physicsLegacy.has('tickcap2'),dt=catchup?Math.min(.1,elapsed):Math.min(strictCap?2/60:.1,Math.max(0,elapsed));lastFrame=now;
  // CPU preparation has one budget per animation callback, not per catch-up
  // physics tick. It continues when unchanged waiting redraws are coalesced;
  // readonly asset preparation must not starve behind the solver barrier.
  if(state==='playing')processCollapseQueue({allowCommit:!pendingPhysicsUpdate});
  accumulator=catchup?accumulator+dt:Math.min(strictCap?2.99/60:.1,accumulator+dt);let ticks=0,tickSpent=0,tickCost=0;const tickBudget=Math.max(8,(elapsed*1000-lastTickSpent)/2);
  while(!pendingPhysicsUpdate&&accumulator>=1/60){
    if(!catchup&&ticks>=2&&(strictCap||ticks>=6||tickSpent+tickCost>tickBudget)){accumulator=Math.min(accumulator,2.99/60);break;}
    const epoch=worldEpoch,tickStarted=performance.now(),result=update(1/60);tickCost=performance.now()-tickStarted;tickSpent+=tickCost;ticks++;
    if(result?.then){pendingPhysicsUpdate=(async()=>{
      await result;if(epoch!==worldEpoch)return;accumulator=Math.max(0,accumulator-1/60);
      // Consume fixed-step credit as jobs complete, instead of throttling
      // simulation to one tick per displayed frame. No accumulated tick drops.
      while(epoch===worldEpoch&&state==='playing'&&accumulator>=1/60){processCollapseQueue({commitOnly:true});await update(1/60);if(epoch!==worldEpoch)return;accumulator=Math.max(0,accumulator-1/60);}
    })().catch(error=>{console.error('Physics task failed',error);state='paused';toast('物理任务异常，场景已暂停');}).finally(()=>{pendingPhysicsUpdate=null;});break;}
    accumulator-=1/60;
  }
  lastTickSpent=tickSpent;
  const minimumInterval=document.hidden?500:state==='playing'?0:1000/15;
  const frameState=referenceFramePolicy&&state==='playing'?{now,pending:Boolean(pendingPhysicsUpdate),completionReady:rigidPhysics.referencePipeline?.hasCompletedJobs(),thirdPerson,activeInput:toolHeld||dragging||keys.size>0,steps:rigidPhysics.completedSteps,epoch:worldEpoch,revision:world.geometryRevision+':'+rigidPhysics.structureRevision+':'+worldRenderer.renderRevision,view:[yaw,pitch,player.x,player.y,player.z,canvas.width,canvas.height,selectedTool,toolHeld,dragging]}:null;
  if(now-lastRendered>=minimumInterval&&(!frameState||referenceFramePolicy.shouldRender(frameState))){renderFrame(now,(now-lastRendered)/1000,started);lastRendered=now;if(frameState)referenceFramePolicy.didRender(frameState);}
  requestAnimationFrame(animate);
}
function renderFrame(now,elapsed=0,started=performance.now()){
  rigidView?.sync();
  characters.syncVisuals?.();
  if(state==='menu'){
    menuTime+=elapsed;camera.position.set(level.points.middle.x,level.points.middle.y+1.58,level.points.middle.z);camera.rotation.set(level.points.middle.pitch,level.points.middle.yaw,0);tool.group.visible=false;
  }
  updatePerspective(Math.min(.1,elapsed),now*.001);
  for(const marker of markers){marker.diamond.rotation.y=now*.001;marker.diamond.position.y=.75+Math.sin(now*.003+marker.target.x)*.06;}
  environment.ring.material.opacity=.45+Math.sin(now*.002)*.15;
  if(state==='playing'){
    if(now-lastUi>140){updateHud();lastInteraction=nearestInteraction();$('interaction').classList.toggle('visible',Boolean(lastInteraction));$('interaction').innerHTML=lastInteraction?`<kbd>E</kbd> ${lastInteraction.type==='release'?(lastInteraction.cargo?'放下 · F 装到背架 · Q 抛出':'松手 · Q 抛出'):lastInteraction.type==='cargo'?'拿起 '+lastInteraction.name+' · '+lastInteraction.cargo.rackSize+' · '+lastInteraction.cargo.rackKg+' kg':lastInteraction.type==='piece'?'抓住 '+lastInteraction.name:lastInteraction.type==='target'?'回收 '+lastInteraction.target.name:lastInteraction.type==='gear'?(gear.equipped?'补给点 · 补满气体':'穿戴飞索腰具'):lastInteraction.label?lastInteraction.label:mission.collected.size===3?'撤离场景':'撤离点 · 先收集全部机密'}`:'';lastUi=now;}
    if(now-lastMap>250){drawMap();lastMap=now;}
  }
  if(now>toastUntil)$('toast').classList.remove('visible');
  frameCount++;frameTime+=elapsed;if(frameTime>1){performanceStats.fps=Math.round(frameCount/frameTime);$('fps').textContent=`${performanceStats.fps} FPS`;frameCount=0;frameTime=0;}
  toolCamera.position.copy(camera.position);toolCamera.quaternion.copy(camera.quaternion);
  if(referencePhoto){tool.group.visible=false;$('hud').hidden=true;}
  environment.update(world,camera);
  lighting.setDynamicEntries?.(rigidPhysics?.entries);
  lighting.update(now,camera,toolScene,toolKey,toolSky,environment.lights);performanceStats.lighting=lighting.stats;
  if(world.dirty.size)worldRenderer.rebuild({budgetMs:4});
  scene.updateMatrixWorld(true);
  if(lastShadowRevision===-1)shadowTracker.invalidate('scene-reset');
  const shadowRevision=world.geometryRevision+':'+worldRenderer.renderRevision;
  const shadowsChanged=shadowTracker.needsUpdate(scene,shadowRevision);
  if(shadowsChanged)renderer.shadowMap.needsUpdate=true;
  shadowCache?.setPlan(shadowsChanged?shadowTracker.lastPlan:null);
  lastShadowRevision=shadowRevision;performanceStats.shadows={updated:shadowsChanged,reasons:shadowTracker.lastReasons,diagnostics:shadowTracker.diagnostics,layers:shadowCache?.stats};
  renderer.info.reset();lighting.render(scene,camera,toolScene,toolCamera,{matricesCurrent:true});
  performanceStats.cpuMs=performanceStats.cpuMs*.95+(performance.now()-started)*.05;
  performanceStats.drawCalls=renderer.info.render.calls;performanceStats.triangles=renderer.info.render.triangles;
}

$('start-sandbox').onclick=()=>startGame('sandbox');
$('view-button').onclick=togglePerspective;updatePerspectiveButton();
$('pause-button').onclick=pauseGame;$('resume').onclick=resumeGame;$('restart').onclick=()=>startGame(mode);$('back-menu').onclick=backToMenu;
$('retry').onclick=()=>startGame(mode);$('result-load').onclick=loadGame;$('result-sandbox').onclick=()=>startGame('sandbox');$('help-close').onclick=()=>{if(state==='menuhelp'){state='menu';$('help').hidden=true;}else resumeGame();};
$('menu-help').onclick=()=>{state='menuhelp';$('help').hidden=false;};
$('sound').onchange=e=>{sounds.enabled=e.target.checked;prepareAudio();try{localStorage.setItem('crew-sound',String(sounds.enabled));}catch{}};
const startupSaveRevision=saveRevision;
readGameSave().then(saved=>{if(saveRevision===startupSaveRevision&&saved?.world?.version===2&&Array.isArray(saved?.world?.chunks)&&saved?.mission?.phase&&saved?.player){storedSave=saved;$('continue-save').hidden=false;}}).catch(error=>console.warn('Saved game read failed',error));
$('continue-save').onclick=()=>{const saved=storedSave;startGame(saved.mission.mode,false);quicksave=saved;storedSave=saved;loadGame();};
$('quality').onchange=e=>{setQuality(e.target.value==='high');try{localStorage.setItem('crew-quality',e.target.value);}catch{}};
document.querySelectorAll('.tool').forEach(b=>b.onclick=()=>{setTool(Number(b.dataset.tool));if(state==='playing'&&!document.pointerLockElement)requestCapture();});
function closeMap(){document.querySelector('.map-wrap').classList.remove('expanded');$('map-toggle').setAttribute('aria-expanded','false');}
function toggleMap(){const open=document.querySelector('.map-wrap').classList.toggle('expanded');$('map-toggle').setAttribute('aria-expanded',String(open));if(open)drawMap();}
$('map-toggle').onclick=toggleMap;
document.querySelector('.map-wrap').onclick=toggleMap;
document.addEventListener('keydown',e=>{
  if(e.target.closest?.('input,textarea,select,[contenteditable="true"]'))return;
  if(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','PageUp','PageDown','Home','F5','F9','Tab'].includes(e.code))e.preventDefault();
  if(state==='playing'&&e.ctrlKey)e.preventDefault();
  if(e.repeat){if(state==='playing')keys.add(e.code);return;}
  if(e.code==='Escape'){if(state==='playing')pauseGame();else if(state==='paused'||state==='help')resumeGame();return;}
  if(e.code==='KeyV'&&['playing','paused'].includes(state)){e.preventDefault();togglePerspective();return;}
  if(state==='result'&&e.code==='F9'){loadGame();return;}if(state!=='playing')return;
  keys.add(e.code);
  if(e.code==='Space'){if(gearSpaceMode())gearSpace();else jumpQueued=jumpNetworkQueued=true;}
  // A quick arrow tap can begin and end between rendered frames.
  if(e.code==='Home'&&thirdPerson){thirdCamera.follow();updatePerspective(0,performance.now()*.001);toast('镜头已回到角色背后');}
  if(e.code==='ArrowLeft')rotateView(.045,0,e.altKey);if(e.code==='ArrowRight')rotateView(-.045,0,e.altKey);
  if(e.code==='PageUp')rotateView(0,.055,e.altKey);if(e.code==='PageDown')rotateView(0,-.055,e.altKey);
  if(e.code.startsWith('Digit')&&Number(e.code.slice(-1))<=PROJECTILE_TOOLS.length&&Number(e.code.slice(-1))>=1)setTool(Number(e.code.slice(-1))-1);
  if(e.code==='KeyQ'&&campaign.active)toast('城墙小镇不使用 Q：空格发钩，E 互动');
  else if(e.code==='KeyQ'&&localGrab.handle){const direction=new THREE.Vector3();aimCamera.getWorldDirection(direction);localGrab.release(direction);}
  if(e.code==='KeyF'){{const result=localCargo.mount();toast(result.ok?`${result.cargo.name} 已装到背架 · G 卸下 · V 查看`:result.error);rigidView?.sync();lastShadowRevision=-1;updateHud();}}
  if(e.code==='KeyG'){{const result=localCargo.unmount(player,yaw);toast(result.ok?`${result.cargo.name} 已卸到面前 · E 可再拿起`:result.error);rigidView?.sync();lastShadowRevision=-1;updateHud();}}
  if(level.gear?.length){
    if(e.code==='KeyB'&&gear.equipped){gear.blades=!gear.blades;if(gear.blades)setTool(0);toast(gear.blades?'双刃已拔出 · 左键斩击 · 高速掠过后颈伤害加倍':'双刃已收回');}
  }
  if(e.code==='KeyE')interact();if(e.code==='KeyR')detonate();if(e.code==='KeyM'||e.code==='Tab')toggleMap();if(e.code==='KeyH')showHelp();if(e.code==='F5')saveGame();if(e.code==='F9')loadGame();
});
document.addEventListener('keyup',e=>{keys.delete(e.code);if(e.code==='Space'&&gearSpaceMode())gear.releaseActive();});
window.addEventListener('blur',()=>{clearControlInputs();if(state==='playing')pauseGame();});
document.addEventListener('visibilitychange',()=>{if(document.hidden && state==='playing')pauseGame();});
canvas.addEventListener('contextmenu',e=>e.preventDefault());
canvas.addEventListener('mousedown',e=>{if(state!=='playing')return;if(e.button===2){dragging=true;if(!e.altKey)beginMouseGrab();return;}if(e.button!==0||e.altKey)return;if(mouseGrabActive){const d=new THREE.Vector3();aimCamera.getWorldDirection(d);localGrab.release(d);mouseGrabActive=false;return;}toolHeld=true;if(!document.pointerLockElement&&!dragging){requestCapture();}if(thirdPerson&&thirdCamera.orbiting){thirdCamera.follow();updatePerspective(0,performance.now()*.001);}useTool();});
document.addEventListener('mouseup',e=>{if(e.button===2)releaseMouseGrab();if(e.button===0)toolHeld=false;});
document.addEventListener('mousemove',e=>{if(state==='playing'&&(document.pointerLockElement===canvas||dragging)){rotateView(-e.movementX*.0022,-e.movementY*.0022,e.altKey);}});
canvas.addEventListener('wheel',e=>{if(state==='playing'){e.preventDefault();if(mouseGrabActive){const delta=e.deltaY>0?.2:-.2;localGrab.adjustDistance(delta);}else setTool(selectedTool+(e.deltaY>0?1:-1));}},{passive:false});
document.addEventListener('pointerlockchange',()=>{const locked=document.pointerLockElement===canvas;if(wasLocked&&!locked&&state==='playing'&&!manualPause)pauseGame();wasLocked=locked;});
document.addEventListener('pointerlockerror',()=>{captureUnavailable=true;if(state==='playing')toast('视角捕获不可用：按住右键拖动，或用方向键观察');});
window.addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.fov=verticalCameraFov(camera.aspect);camera.updateProjectionMatrix();toolCamera.aspect=camera.aspect;toolCamera.fov=camera.fov;toolCamera.updateProjectionMatrix();renderer.setPixelRatio(pixelRatio());renderer.setSize(innerWidth,innerHeight);lighting.resize();});
window.addEventListener('error',e=>{console.error('Game error:',e.error);});

// Read-only diagnostics for integration tests and performance checks.
Object.defineProperty(window,'breachDiagnostics',{get:()=>({state,appearance:{...appearance},characterCount:characters.characters.length,characterInstances:characters.mesh?.count,characterVisuals:characters.stats,phase:mission.phase,mode,voxels:world.cells.size,initialVoxels,destruction,remaining:mission.remaining,collected:[...mission.collected],player:{...player},yaw,pitch,tool:selectedTool,charges:charges.length,bodies:effects.bodies.length,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,hasSave:Boolean(quicksave)})});
$('loading').textContent='正在准备画面';
await new Promise(resolve=>setTimeout(resolve,0));
await environment.ready;
warmWorldShaders();
$('loading').textContent=physicsError?'场景就绪 · 简化碎屑模式':'场景就绪';
if(referencePhoto)startGame('sandbox',false);
requestAnimationFrame(animate);

// A lightweight menu owns departure intent. Apply it only after startup unlocks.
export async function launchFromMainMenu(){
  try{
    sounds.enabled=localStorage.getItem('crew-sound')!=='false';$('sound').checked=sounds.enabled;
    const quality=localStorage.getItem('crew-quality');if(quality==='low'||quality==='high')setQuality(quality==='high');
  }catch{}
}
