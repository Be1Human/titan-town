import * as THREE from '../../../vendor/three.module.js';
import {CELL,MATERIAL_KEYS} from '../../voxel-world.js';
import {createVoxelRaycastView} from './voxel-raycast.js';
import {createVoxelPaletteMaterials} from './voxel-palette-view.js';

// Compile by drawing representative objects through the production passes.
// compile(warmGroup) alone misses MRT material clones, instancing and the
// actual shadow target configuration. No world cells are touched here.
export function warmDestructionShaders({renderer,lighting,scene,camera,worldRenderer,effects}){
  const started=performance.now(),group=new THREE.Group(),geometry=new THREE.BoxGeometry(.1,.1,.1);
  const count=geometry.attributes.position.count;
  geometry.setAttribute('sourceChunk',new THREE.BufferAttribute(new Float32Array(count).fill(-1),1));
  geometry.setAttribute('sourceCellMin',new THREE.BufferAttribute(new Uint8Array(count*3),3));
  geometry.setAttribute('sourceCellMax',new THREE.BufferAttribute(new Uint8Array(count*3),3));
  group.position.copy(camera.position).addScaledVector(camera.getWorldDirection(new THREE.Vector3()),2);
  const add=mesh=>{mesh.frustumCulled=false;group.add(mesh);return mesh;};
  for(const material of worldRenderer.cutMaterial)if(material?.visible){
    const mesh=add(new THREE.Mesh(geometry,material));mesh.receiveShadow=mesh.castShadow=true;mesh.customDepthMaterial=worldRenderer.cutDepth;
  }
  for(const material of worldRenderer.material)if(material?.visible){
    const mesh=add(new THREE.Mesh(geometry,material));mesh.receiveShadow=mesh.castShadow=true;
    const chip=add(new THREE.InstancedMesh(effects.chipGeometry,material,1));chip.receiveShadow=true;
  }
  if(worldRenderer.world.nativePaletteRecords?.size){
    // Native colours are uniforms, but detached native shapes use a plain
    // finish shader distinct from the static brush-material bank.
    worldRenderer.destructionWarmPalette??=createVoxelPaletteMaterials({
      1:{rgba:[180,150,120,255],roughness:.9,metalness:0,opacity:1,emission:0},
      2:{rgba:[180,220,240,255],roughness:.1,metalness:0,opacity:.5,emission:0},
    },CELL);
    for(const material of worldRenderer.destructionWarmPalette)if(material?.visible){const mesh=add(new THREE.Mesh(geometry,material));mesh.castShadow=mesh.receiveShadow=true;}
  }
  add(effects.createFireMesh(1)).scale.setScalar(.01);
  for(const material of Object.values(effects.markMaterials))add(new THREE.Mesh(effects.markGeometry,material));
  // Retain one representative ray material: disposing the last owner after
  // warmup would release the cached programs before the first falling piece.
  let ray=worldRenderer.destructionWarmRay;
  if(!ray){
    const id=worldRenderer.material.findIndex((m,i)=>i>0&&m?.visible&&!m.transparent&&!(m.transmission>0));
    if(id>0){
      ray=createVoxelRaycastView({cells:[{x:0,y:0,z:0,mat:MATERIAL_KEYS[id]}],center:{x:.05,y:.05,z:.05},materials:worldRenderer.material});
      worldRenderer.destructionWarmRay=ray;
    }
  }
  if(ray)add(ray.mesh);
  const target=renderer.getRenderTarget(),autoClear=renderer.autoClear,shadowAuto=renderer.shadowMap.autoUpdate;
  try{
    renderer.initTexture?.(worldRenderer.cutMask.lookup);renderer.initTexture?.(worldRenderer.cutMask.texture);
    scene.add(group);
    lighting.surface.render(scene,camera);
    renderer.setRenderTarget(lighting.color);renderer.autoClear=true;
    renderer.shadowMap.needsUpdate=true;
    // Three.compile traverses material arrays without skipping null entries;
    // the world bank intentionally reserves index zero. Representative meshes
    // have scalar materials and still use the live scene's lights/fog/IBL.
    renderer.compile(group,camera,scene);
    if(effects.points)renderer.compile(effects.points,camera,scene);
    renderer.render(scene,camera);
  }finally{
    group.removeFromParent();if(ray)ray.mesh.removeFromParent();geometry.dispose();
    renderer.autoClear=autoClear;renderer.shadowMap.autoUpdate=shadowAuto;
    // The warmup objects entered the shadow map. Repaint it without them on
    // the next actual frame even if the caller had a clean cached shadow.
    renderer.shadowMap.needsUpdate=true;
    renderer.setRenderTarget(target);
  }
  return {ms:performance.now()-started,programs:renderer.info.programs.length};
}
