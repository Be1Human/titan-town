import * as THREE from '../vendor/three.module.js';
import {debrisSamples, debrisTopplePlan, stepDebris} from './debris-physics.js';
import {CELL,MATERIALS,MATERIAL_KEYS,keyOf,chunkCoords} from './voxel-world.js';
import {meshChunk} from './mesher.js';
import {buildSourceData,partitionSource} from './source-geometry.js';
import {CutMask,applyCutShader} from './cut-mask.js';
import {buildVoxelSurfaceData} from './voxel-surfaces.js';
import {voxelMaterialBank,styleVoxelMaterial,styleVoxelGeometry} from './voxel-material.js';
import {voxelizeTool} from './voxel-tool.js';
import {handMaterials,addToolHands,detachToolHands,attachArmRig} from './first-person-hands.js';
import {createVoxelRaycastView} from './engine/render/voxel-raycast.js';
import {applyParkMaterials} from './park-materials.js';
import {makeParkDressing} from './park-dressing.js';
import {copyMaterialAttributeDefaults} from './engine/render/material-attributes.js';
import {createVoxelPaletteMaterials,buildVoxelPaletteFragment} from './engine/render/voxel-palette-view.js';
import {fragmentGeometry} from './engine/render/fragment-geometry.js';
import {restoreFragmentGeometry} from './engine/render/fragment-transfer.js';
import {batchFragmentMaterials} from './engine/render/fragment-material-batches.js';
import {RigidSurfaceCache} from './engine/render/rigid-surface-cache.js';
import {t as tr} from './i18n.js';

function geometry(data){
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(data.positions,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(data.normals,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(data.uvs,2));g.setIndex(data.indices);
  for(const group of data.groups)g.addGroup(group.start,group.count,group.materialIndex);g.computeBoundingSphere();return g;
}
const sourceCache=new WeakMap();
const backgroundCache=new WeakMap();
function sourceGeometry(data){
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.BufferAttribute(data.positions,3));g.setAttribute('normal',new THREE.BufferAttribute(data.normals,3));if(data.uvs)g.setAttribute('uv',new THREE.BufferAttribute(data.uvs,2));
  g.setAttribute('sourceChunk',new THREE.BufferAttribute(data.sourceChunks,1));
  if(data.sourceCellMin){g.setAttribute('sourceCellMin',new THREE.BufferAttribute(data.sourceCellMin,3));g.setAttribute('sourceCellMax',new THREE.BufferAttribute(data.sourceCellMax,3));}
  const indices=data.indices?data.indices.slice():Uint32Array.from({length:data.vertices},(_,i)=>i);g.setIndex(new THREE.BufferAttribute(indices,1).setUsage(THREE.DynamicDrawUsage));
  for(const group of data.groups)g.addGroup(group.start,group.count,group.materialIndex);
  g.computeBoundingSphere();return g;
}
export class WorldRenderer{
  constructor(scene,world){
    this.scene=scene;this.world=world;this.sourceMeshes=world.voxelSurfaces||world.sourceMeshes;this.meshes=new Map();this.backgroundMeshes=[];this.cutMask=new CutMask(world);this.material=voxelMaterialBank();this.regions=new Map();this.regionKeys=new Map();this.regionMeshes=new Map();this.cutMeshes=new Map();
    if(world.voxelSurfaces)for(const material of this.material)if(material){material.side=THREE.FrontSide;material.shadowSide=THREE.DoubleSide;}
    // Imported background faces do not promise the closed, outward winding of
    // cached voxel surfaces. Build a separate bank: Material.clone() loses the
    // voxel shader hook, while a fresh bank retains it and stays double-sided.
    this.backgroundMaterial=world.backgroundSurfaces&&world.voxelSurfaces?voxelMaterialBank():this.material;
    for(const bank of new Set([this.material,this.backgroundMaterial]))for(let i=1;i<bank.length;i++)if(world.palette?.[MATERIAL_KEYS[i]])bank[i].color.setHex(world.palette[MATERIAL_KEYS[i]]);
    for(const bank of new Set([this.material,this.backgroundMaterial])){applyParkMaterials(bank,world.materialProfiles);bank[0]=new THREE.MeshStandardMaterial({visible:false});}
    const cutOptions={voxelAligned:Boolean(world.voxelSurfaces)},cutVariant=cutOptions.voxelAligned?'voxels':'source';
    this.cutMaterial=this.material.map(m=>{
      if(!m)return null;const cut=copyMaterialAttributeDefaults(m.clone(),m),program=m.customProgramCacheKey(),compile=m.onBeforeCompile;
      // Capture the base hook now. SurfaceBuffer later wraps the intact
      // material; consulting its live hook would inject forward lighting into
      // the cut capture shader, and twice into the cut forward shader.
      cut.onBeforeCompile=(shader,renderer)=>{compile.call(m,shader,renderer);applyCutShader(shader,this.cutMask.uniforms,cutOptions);};cut.customProgramCacheKey=()=>program+'-cut-v6-'+cutVariant;return cut;
    });
    this.cutDepth=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking,side:THREE.DoubleSide});this.cutDepth.onBeforeCompile=s=>applyCutShader(s,this.cutMask.uniforms,cutOptions);this.cutDepth.customProgramCacheKey=()=> 'voxel-cut-depth-v5-'+cutVariant;this.cutDepth.defaultAttributeValues={sourceChunk:[-1]};
    if(this.sourceMeshes)for(const key of this.sourceMeshes.keys()){
      // A precise face on a chunk boundary can have all its solid cells in
      // the adjacent chunk. Saved cuts can also empty a chunk entirely.
      // Source geometry exists independently of current voxel occupancy.
      const c=chunkCoords(key);
      const region=`${Math.floor(c.x/160)},${Math.floor(c.y/160)},${Math.floor(c.z/160)}`;
      this.regionKeys.set(key,region);if(!this.regions.has(region))this.regions.set(region,[]);this.regions.get(region).push(key);
    }
    let cache=sourceCache.get(this.sourceMeshes);if(!cache&&this.sourceMeshes){cache=new Map();sourceCache.set(this.sourceMeshes,cache);}
    for(const [region,keys]of this.regions){
      let data=cache.get(region);if(!data){data=world.voxelSurfaces?buildVoxelSurfaceData(this.sourceMeshes,keys):buildSourceData(this.sourceMeshes,keys);cache.set(region,data);}
      const mesh=new THREE.Mesh(sourceGeometry(data),this.material);mesh.userData.sourceData=data;mesh.castShadow=true;mesh.receiveShadow=true;this.scene.add(mesh);this.regionMeshes.set(region,mesh);
      const g=new THREE.BufferGeometry();for(const [name,attribute]of Object.entries(mesh.geometry.attributes))g.setAttribute(name,attribute);
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(data.elements??data.vertices),1).setUsage(THREE.DynamicDrawUsage));g.boundingSphere=mesh.geometry.boundingSphere;g.setDrawRange(0,0);
      const cut=new THREE.Mesh(g,this.cutMaterial);cut.castShadow=true;cut.receiveShadow=true;cut.customDepthMaterial=this.cutDepth;this.scene.add(cut);this.cutMeshes.set(region,cut);
    }
    if(world.backgroundSurfaces){
      let cache=backgroundCache.get(world.backgroundSurfaces);
      if(!cache){cache=new Map();backgroundCache.set(world.backgroundSurfaces,cache);}
      for(const [region,groups]of world.backgroundSurfaces){
        let data=cache.get(region);
        if(!data){data=buildSourceData(new Map([[-1,groups]]),[-1]);cache.set(region,data);}
        const g=sourceGeometry(data);g.deleteAttribute('sourceChunk');g.index.setUsage(THREE.StaticDrawUsage);
        const mesh=new THREE.Mesh(g,this.backgroundMaterial);mesh.castShadow=true;mesh.receiveShadow=true;
        this.scene.add(mesh);this.backgroundMeshes.push(mesh);
      }
    }
    // Source indices start wholly in the intact batch. Track only the source
    // chunks whose current altered membership has reached those GPU batches.
    this.partitionedAltered=new Set();this.alteredRef=null;
    this.renderRevision=0;this.stats={ms:0,chunks:0,maskBytes:0,indexUploadBytes:0,pending:0};
  }
  rebuild({budgetMs=Infinity}={}){
    if(this.world.nativeDisplayGeometry){this.world.dirty.clear();this.renderRevision=this.world.geometryRevision;this.stats.pending=0;return;}
    const started=performance.now(),regions=new Set();let chunks=0,maskBytes=0,indexUploadBytes=0,processed=0;
    // restore() replaces altered and can omit a source-only chunk that became
    // empty from its dirty set. Queue membership changes so they still repartition.
    if(this.alteredRef!==this.world.altered){
      for(const key of this.regionKeys.keys())if(this.partitionedAltered.has(key)!==this.world.altered.has(key))this.world.dirty.add(key);
      this.alteredRef=this.world.altered;
    }
    for(const key of this.world.dirty){
      if(processed&&performance.now()-started>=budgetMs)break;
      this.world.dirty.delete(key);processed++;
      maskBytes+=this.cutMask.update(key);
      const region=this.regionKeys.get(key);
      if(region&&this.partitionedAltered.has(key)!==this.world.altered.has(key))regions.add(region);
      const old=this.meshes.get(key);if(old){this.scene.remove(old);old.geometry.dispose();this.meshes.delete(key);}
      const chunk=this.world.chunks.get(key);if(!chunk?.count)continue;
      const original=this.sourceMeshes?.get(key);
      if(original&&!this.world.altered.has(key))continue;
      chunks++;const data=meshChunk(this.world,chunk,{cutFacesOnly:Boolean(original&&this.world.initialChunks)});if(!data.indices.length)continue;const surface=geometry(data);
      const mesh=new THREE.Mesh(surface,this.material);mesh.castShadow=true;mesh.receiveShadow=true;this.scene.add(mesh);this.meshes.set(key,mesh);
    }
    for(const region of regions){
      const source=this.regionMeshes.get(region),cut=this.cutMeshes.get(region),a=source.geometry,b=cut.geometry;
      const result=partitionSource(source.userData.sourceData,this.world.altered,a.index.array,b.index.array);
      a.clearGroups();b.clearGroups();for(const g of result.intactGroups)a.addGroup(g.start,g.count,g.materialIndex);for(const g of result.cutGroups)b.addGroup(g.start,g.count,g.materialIndex);
      a.setDrawRange(0,result.intactCount);b.setDrawRange(0,result.cutCount);
      // Only active prefixes are consumed by the new draw ranges. Uploading
      // both entire capacity buffers doubles first-cut traffic needlessly.
      for(const [index,count]of [[a.index,result.intactCount],[b.index,result.cutCount]]){
        index.clearUpdateRanges();if(count){index.addUpdateRange(0,count);index.needsUpdate=true;indexUploadBytes+=count*index.array.BYTES_PER_ELEMENT;}
      }
      // partitionSource classifies every key in the region, including keys
      // whose cavity mask and mesh are still waiting for the frame budget.
      for(const key of this.regions.get(region)){
        if(this.world.altered.has(key))this.partitionedAltered.add(key);
        else this.partitionedAltered.delete(key);
      }
    }
    if(processed)this.renderRevision++;
    this.stats={ms:performance.now()-started,chunks,maskBytes,indexUploadBytes,pending:this.world.dirty.size};
  }
  surfacePoint(hit){
    const normal=new THREE.Vector3(hit.normal.x,hit.normal.y,hit.normal.z);if(normal.lengthSq()<.5)return hit.point;
    const origin=new THREE.Vector3(hit.point.x,hit.point.y,hit.point.z).addScaledVector(normal,.22);
    const ray=new THREE.Raycaster(origin,normal.negate(),0,.5);
    return ray.intersectObjects([...this.regionMeshes.values(),...this.cutMeshes.values(),...this.meshes.values()],false)[0]?.point??hit.point;
  }
  dispose(){this.destructionWarmRay?.dispose();this.destructionWarmRay=null;for(const m of this.destructionWarmPalette??[])m?.dispose();this.destructionWarmPalette=null;for(const m of [...this.meshes.values(),...this.regionMeshes.values(),...this.cutMeshes.values(),...this.backgroundMeshes]){this.scene.remove(m);m.geometry.dispose();}this.meshes.clear();this.regionMeshes.clear();this.cutMeshes.clear();this.backgroundMeshes=[];for(const m of new Set([...this.material,...this.cutMaterial,...this.backgroundMaterial]))if(m)m.dispose();this.cutMask.dispose();this.cutDepth.dispose();}
}
// Persistent gameplay pieces have their own lifetime. Cosmetic chips cannot
// evict a platform the player is standing on, and only Rapier integrates it.
export class RigidDebrisView{
  constructor(scene,physics,material){
    this.scene=scene;this.physics=physics;this.material=material;this.meshes=new Map();this.rayViews=new Map();this.rayFailures=new Map();this.poses=new Map();this.dirtyIds=new Set();this.backend='mesh';this.reconcile=true;
    this.stats={backend:'mesh',raycastObjects:0,meshObjects:0,volumeBytes:0,fallbacks:0,entriesVisited:0,poseUpdates:0,fullReconciliations:0};
    // ?legacy=slicemesh re-scans every slice of a cut page.
    this.surfaceOptions={slices:!physics.legacy?.has?.('slicemesh')};
    // Each view owns its pending poses. Multiple solver steps, another reader,
    // or a final transition to sleep cannot consume this view's notification.
    this.unsubscribePoses=physics.subscribePoses?.(entry=>this.dirtyIds.add(entry.id));
  }
  setRenderer(renderer,camera){if(this.renderer!==renderer){for(const id of [...this.rayViews.keys()])this.removeRay(id);this.rayFailures.clear();}this.renderer=renderer;this.camera=camera;const gl=renderer?.getContext?.();this.max3DTextureSize=gl?gl.getParameter(gl.MAX_3D_TEXTURE_SIZE):Infinity;this.reconcile=true;this.sync();return Promise.all([...this.rayViews.values()].map(v=>v.ready));}
  setBackend(backend){if(!['mesh','raycast'].includes(backend))throw new Error('Unknown rigid rendering backend');if(this.backend!==backend)this.rayFailures.clear();this.backend=backend;this.reconcile=true;this.sync();return this.stats;}
  visibility(mesh,visible,field){if(mesh.visible!==visible){this.stats[field]+=visible?1:-1;mesh.visible=visible;}}
  removeRay(id){const view=this.rayViews.get(id);if(!view)return;if(view.mesh.visible)this.stats.raycastObjects--;this.stats.volumeBytes-=view.stats.bytes;view.dispose();this.rayViews.delete(id);}
  removeView(id){const mesh=this.meshes.get(id);if(mesh){if(mesh.visible)this.stats.meshObjects--;mesh.removeFromParent();if(mesh.userData.rigidSurfaceCache)mesh.userData.rigidSurfaceCache.dispose();else mesh.geometry.dispose();this.meshes.delete(id);mesh.userData.paletteMaterials?.forEach(m=>m?.dispose());}this.removeRay(id);this.rayFailures.delete(id);this.poses.delete(id);this.dirtyIds.delete(id);}
  prepareRay(entry){
    if(!this.renderer||!this.camera||this.rayViews.has(entry.id)||this.rayViews.size>=64)return;
    const failure=this.rayFailures.get(entry.id);if(failure&&failure.revision===entry.revision&&failure.cells===entry.cells)return;
    let view;
    try{view=createVoxelRaycastView({cells:entry.cells,center:entry.center,cellSize:entry.cellSize||CELL,materials:this.meshes.get(entry.id)?.userData.paletteMaterials??this.material});
      if(view.volume.levels[0].size.some(n=>n>this.max3DTextureSize))throw new Error('Object exceeds GPU 3D texture dimensions');
      if(this.stats.volumeBytes+view.stats.bytes>16*1024*1024)throw new Error('Rigid raycast views exceed memory budget');
    }catch(error){view?.dispose();this.rayFailures.set(entry.id,{revision:entry.revision,cells:entry.cells});this.stats.fallbacks++;return;}
    view.revision=entry.revision;view.mesh.visible=false;view.mesh.position.copy(entry.position);view.mesh.quaternion.copy(entry.rotation);this.scene.add(view.mesh);this.rayViews.set(entry.id,view);this.stats.volumeBytes+=view.stats.bytes;
    // Compile with the live scene's light configuration before replacing the
    // existing visible mesh. A stale revision never becomes visible later.
    const warm=new THREE.Scene();warm.add(new THREE.Mesh(view.mesh.geometry,view.mesh.material));
    this.warmQueue??=Promise.resolve();view.ready=this.warmQueue=this.warmQueue.then(()=>{
      if(this.rayViews.get(entry.id)!==view)return;
      const oldError=this.renderer.debug.onShaderError;let failed=false;
      this.renderer.debug.onShaderError=(gl,program,vs,fs)=>{if(gl.getShaderSource(fs).includes('bool objectTrace()'))failed=true;else oldError?.(gl,program,vs,fs);};
      // Keep compilation and the current-view check in one task. The stock
      // asynchronous poll cannot be cancelled when fracture/reset disposes a
      // material; a disposed view must not strand the next queued warmup.
      try{this.renderer.compile(warm,this.camera,this.scene);const programs=this.renderer.properties.get(view.mesh.material).programs;view.compiled=!failed&&![...(programs?.values()||[])].some(p=>p.diagnostics?.runnable===false);if(!view.compiled)this.stats.fallbacks++;}
      catch{this.stats.fallbacks++;view.compiled=false;}
      finally{this.renderer.debug.onShaderError=oldError;}
      if(this.rayViews.get(entry.id)===view){this.dirtyIds.add(entry.id);this.sync();}
    });
  }
  add(cells,origin=null,failure=null){
    if(!cells.length)return false;
    const bounds={minX:Infinity,minY:Infinity,minZ:Infinity,maxX:-Infinity,maxY:-Infinity,maxZ:-Infinity};
    for(const p of cells)for(const axis of ['X','Y','Z']){const value=p[axis.toLowerCase()];bounds['min'+axis]=Math.min(bounds['min'+axis],value);bounds['max'+axis]=Math.max(bounds['max'+axis],value+1);}
    const center={x:(bounds.minX+bounds.maxX)*CELL/2,y:(bounds.minY+bounds.maxY)*CELL/2,z:(bounds.minZ+bounds.maxZ)*CELL/2};
    const plan=debrisTopplePlan(bounds,center,CELL,failure,origin,cells.length);
    const entry=this.physics.add(cells,{angularVelocity:plan?{x:plan.axis.x*.55,y:0,z:plan.axis.z*.55}:{x:0,y:0,z:0},velocity:plan?{x:plan.direction.x*.12,y:0,z:plan.direction.z*.12}:{x:0,y:0,z:0}});
    if(!entry)return false;this.onAdd?.(entry);this.sync();return true;
  }
  syncEntry(entry){
    this.stats.entriesVisited++;
    if(entry.hiddenVisual||entry.visual===false){this.removeView(entry.id);return;}
    let mesh=this.meshes.get(entry.id);
    const build=()=>{
      const prepared=entry.preparedVisual;
      if(prepared&&prepared.cells===entry.cells&&prepared.revision===entry.revision&&prepared.cellSize===(entry.cellSize||CELL)){
        delete entry.preparedVisual;return restoreFragmentGeometry(prepared.geometry);
      }
      delete entry.preparedVisual;
      return styleVoxelGeometry(batchFragmentMaterials(entry.palette?buildVoxelPaletteFragment(entry.cells,entry.center,entry.cellSize||CELL,entry.palette):fragmentGeometry(entry.cells,entry.center,entry.cellSize||CELL),entry.palette),{cell:entry.cellSize||CELL});
    };
    const makeView=()=>{const prepared=entry.preparedVisual;
      if(entry.preparedSurfaceCache){const cache=entry.preparedSurfaceCache;delete entry.preparedSurfaceCache;delete entry.surfaceParent;return cache.group;}
      if(!entry.palette&&(prepared?.geometry.chunks||(!prepared&&entry.cells.length>=2048))){const cache=new RigidSurfaceCache(entry,this.material,prepared?.geometry,null,this.surfaceOptions);delete entry.preparedVisual;return cache.group;}
      const m=new THREE.Mesh(build(),this.material);m.castShadow=m.receiveShadow=true;return m;};
    if(!mesh){mesh=makeView();this.scene.add(mesh);this.meshes.set(entry.id,mesh);this.stats.meshObjects++;}
    if(mesh.userData.rigidPalette!==entry.palette){mesh.userData.paletteMaterials?.forEach(m=>m?.dispose());mesh.userData.paletteMaterials=entry.palette?createVoxelPaletteMaterials(entry.palette,entry.cellSize||CELL):null;mesh.userData.rigidPalette=entry.palette;this.removeRay(entry.id);}
    const shapeChanged=mesh.userData.rigidRevision!==entry.revision||mesh.userData.rigidCells!==entry.cells||mesh.userData.rigidCellSize!==(entry.cellSize||CELL);
    if(shapeChanged){
      let keptRay=false;const previousRay=this.rayViews.get(entry.id),edits=entry.voxelEdits?.filter(e=>e.revision>(previousRay?.revision??Infinity));
      if(previousRay&&mesh.userData.rigidCells===entry.cells&&edits?.length&&edits[0].revision===previousRay.revision+1){
        try{previousRay.updateRemoved(edits.flatMap(e=>e.removed),this.renderer);previousRay.revision=entry.revision;keptRay=true;}
        catch(error){this.stats.fallbacks++;console.warn('Rigid voxel local upload failed; rebuilding visible surface',error);}}
      if(mesh.userData.rigidRevision!==undefined){const cache=mesh.userData.rigidSurfaceCache;
        if(cache){if(!cache.update(entry,{deferGeometry:keptRay&&previousRay.compiled===true&&this.backend==='raycast'})){const visible=mesh.visible;cache.dispose();mesh=makeView();mesh.visible=visible;this.scene.add(mesh);this.meshes.set(entry.id,mesh);this.poses.delete(entry.id);}}
        else{mesh.geometry.dispose();mesh.geometry=build();}}
      mesh.userData.rigidRevision=entry.revision;mesh.userData.rigidCells=entry.cells;mesh.userData.rigidCellSize=entry.cellSize||CELL;if(!keptRay)this.removeRay(entry.id);
    }
    mesh.material=mesh.userData.paletteMaterials??this.material;
    mesh.userData.rigidSurfaceCache?.setMaterial(mesh.material);
    let ray=this.rayViews.get(entry.id);
    if(this.backend==='raycast'){this.prepareRay(entry);ray=this.rayViews.get(entry.id);}
    const cached=this.poses.get(entry.id),p=entry.position,q=entry.rotation,versioned=Number.isSafeInteger(entry.poseRevision),values=versioned?null:[p.x,p.y,p.z,q.x,q.y,q.z,q.w];
    const changed=!cached||cached.entry!==entry||(versioned?cached.revision!==entry.poseRevision:cached.values.some((v,i)=>v!==values[i]));
    if(changed){
      mesh.position.copy(p);mesh.quaternion.copy(q);const cache=mesh.userData.rigidSurfaceCache;if(cache)mesh.position.add(new THREE.Vector3(cache.center.x-entry.center.x,cache.center.y-entry.center.y,cache.center.z-entry.center.z).applyQuaternion(mesh.quaternion));if(ray){ray.mesh.position.copy(p);ray.mesh.quaternion.copy(q);}
      this.poses.set(entry.id,{entry,revision:entry.poseRevision,values:values||[p.x,p.y,p.z,q.x,q.y,q.z,q.w]});this.stats.poseUpdates++;
    }
    const useRay=this.backend==='raycast'&&ray?.compiled===true&&ray.revision===entry.revision;
    if(ray){const currentGeometry=!mesh.userData.rigidSurfaceCache?.dirtyPages.size;ray.mesh.userData.nativeDepthMesh=useRay&&currentGeometry?mesh:null;}
    if(!useRay)mesh.userData.rigidSurfaceCache?.ensureGeometry();
    if(ray)this.visibility(ray.mesh,useRay,'raycastObjects');
    this.visibility(mesh,!ray?.mesh.visible,'meshObjects');
  }
  sync(){
    this.stats.entriesVisited=0;this.stats.poseUpdates=0;
    const bank=Array.isArray(this.material)?this.material:[this.material];
    const materialChanged=this.lastMaterial!==this.material||this.lastBank?.length!==bank.length||bank.some((m,i)=>m!==this.lastBank[i]);
    const subscribed=typeof this.unsubscribePoses==='function'&&Number.isSafeInteger(this.physics.structureRevision);
    const full=this.reconcile||!subscribed||this.lastEntries!==this.physics.entries||this.lastStructureRevision!==this.physics.structureRevision||materialChanged;
    if(materialChanged){for(const id of [...this.rayViews.keys()])this.removeRay(id);this.rayFailures.clear();this.lastMaterial=this.material;this.lastBank=[...bank];}
    if(full){
      this.stats.fullReconciliations++;this.reconcile=false;
      const memo=new Map(),temporary=new Set(),final=new Set();
      const sourceCache=(entry,depth=0)=>{
        if(!entry||entry.palette||depth>64)return null;if(memo.has(entry))return memo.get(entry);
        const existing=this.meshes.get(entry.id)?.userData.rigidSurfaceCache;
        if(existing?.cells===(entry.cacheCells??entry.cells)&&(existing.revision===entry.revision||existing.update(entry))){memo.set(entry,existing);return existing;}
        const parent=sourceCache(entry.surfaceParent,depth+1);if(!parent){memo.set(entry,null);return null;}
        const cache=new RigidSurfaceCache(entry,this.material,null,parent,this.surfaceOptions);temporary.add(cache);memo.set(entry,cache);return cache;
      };
      // Snapshot/fork source pages before the same-id child replaces its
      // parent's view. Exact unchanged geometry is shared with ref-counted
      // ownership; split boundaries and removed neighbours rebuild locally.
      for(const entry of this.physics.entries.values())if(!entry.hiddenVisual&&entry.visual!==false&&entry.surfaceParent&&!entry.palette&&entry.cells.length>=2048){const cache=sourceCache(entry);if(cache&&temporary.has(cache)){entry.preparedSurfaceCache=cache;final.add(cache);}}
      for(const id of this.meshes.keys())if(!this.physics.entries.has(id))this.removeView(id);
      this.dirtyIds.clear();for(const entry of this.physics.entries.values())this.syncEntry(entry);
      for(const entry of this.physics.entries.values()){if(entry.preparedSurfaceCache){final.delete(entry.preparedSurfaceCache);delete entry.preparedSurfaceCache;}delete entry.surfaceParent;}
      for(const cache of temporary)if(!final.has(cache))cache.dispose();
      this.lastEntries=this.physics.entries;this.lastStructureRevision=this.physics.structureRevision;
    }else{
      const changed=[...this.dirtyIds];this.dirtyIds.clear();
      for(const id of changed){const entry=this.physics.entries.get(id);if(entry)this.syncEntry(entry);else this.removeView(id);}
    }
    this.stats.backend=this.backend;
  }
  clear(){for(const id of [...this.meshes.keys()])this.removeView(id);this.poses.clear();this.dirtyIds.clear();this.reconcile=true;Object.assign(this.stats,{raycastObjects:0,meshObjects:0,volumeBytes:0});}
  dispose(){this.clear();this.unsubscribePoses?.();this.unsubscribePoses=null;}
}
export class Effects{
  constructor(scene,world,material){
    this.scene=scene;this.world=world;this.material=material;this.bodies=[];this.flashes=[];this.particles=[];
    this.chipGeometry=new THREE.BoxGeometry(CELL,CELL,CELL);this.chipPools=new Map();
    for(let id=1;id<MATERIAL_KEYS.length;id++){
      const mesh=new THREE.InstancedMesh(this.chipGeometry,material[id],90);mesh.count=0;mesh.frustumCulled=false;mesh.receiveShadow=true;mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);scene.add(mesh);this.chipPools.set(id,mesh);
    }
    // Fixed light counts avoid compiling new shader variants during a shot.
    this.flashLights=[new THREE.PointLight(0xffb35b,0,19)];
    this.flashLights.forEach(light=>scene.add(light));
    this.particleMax=700;this.positions=new Float32Array(2100);this.colors=new Float32Array(2100);this.sizes=new Float32Array(700);this.alphas=new Float32Array(700);this.kinds=new Float32Array(700);
    this.geometry=new THREE.BufferGeometry();this.geometry.setAttribute('position',new THREE.BufferAttribute(this.positions,3));this.geometry.setAttribute('color',new THREE.BufferAttribute(this.colors,3));this.geometry.setDrawRange(0,0);
    this.geometry.setAttribute('size',new THREE.BufferAttribute(this.sizes,1));this.geometry.setAttribute('alpha',new THREE.BufferAttribute(this.alphas,1));this.geometry.setAttribute('kind',new THREE.BufferAttribute(this.kinds,1));
    const particleMaterial=new THREE.ShaderMaterial({transparent:true,depthWrite:false,vertexColors:true,uniforms:{pixelScale:{value:innerHeight*.5}},vertexShader:`
      attribute float size,alpha,kind;varying vec3 tint;varying float opacity,spark;
      uniform float pixelScale;
      void main(){tint=color;opacity=alpha;spark=kind;vec4 p=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*p;gl_PointSize=clamp(size*pixelScale/max(.1,-p.z),1.,170.);}
    `,fragmentShader:`
      varying vec3 tint;varying float opacity,spark;
      float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x),f.y);}
      void main(){vec2 p=gl_PointCoord*2.-1.;float r=dot(p,p);if(r>1.)discard;
        float cloud=exp(-r*4.5)*(1.-smoothstep(.45,1.,r))*(.45+.55*noise(p*3.5));
        if(spark>.5)cloud=exp(-dot(p*vec2(3.5,1.),p*vec2(3.5,1.))*2.5);
        gl_FragColor=vec4(tint,cloud*opacity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`});
    this.points=new THREE.Points(this.geometry,particleMaterial);this.points.frustumCulled=false;scene.add(this.points);
    this.marks=[];this.markGeometry=new THREE.PlaneGeometry(.34,.34);this.markMaterials={};
    // Keep the fire program alive between explosions. Recreating/discarding
    // ShaderMaterial on every flash also discards Three's shader-cache entry.
    this.fireGeometry=new THREE.IcosahedronGeometry(1,3);
    this.fireMaterial=new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,uniforms:{age:{value:0}},vertexShader:'varying vec3 p;varying vec3 n;void main(){p=position;n=normalMatrix*normal;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',fragmentShader:`
      varying vec3 p,n;uniform float age;
      void main(){float cloud=sin(p.x*14.+age*12.)*sin(p.y*11.-age*9.)*sin(p.z*17.+age*7.);
        float edge=pow(abs(normalize(n).z),1.4);float glow=(.65+cloud*.35)*edge;
        vec3 color=mix(vec3(1.8,.22,.018),vec3(4.,2.5,.8),glow);
        gl_FragColor=vec4(color,glow*pow(1.-age,2.)*.8);
      }`});
    for(const type of ['stone','metal','wood','glass']){
      const canvas=document.createElement('canvas');canvas.width=canvas.height=128;const context=canvas.getContext('2d');
      if(type==='metal'){
        const dent=context.createRadialGradient(64,64,2,64,64,28);dent.addColorStop(0,'rgba(10,15,18,.55)');dent.addColorStop(.55,'rgba(18,24,28,.2)');dent.addColorStop(1,'rgba(18,24,28,0)');context.fillStyle=dent;context.fillRect(0,0,128,128);
        context.strokeStyle='rgba(180,190,194,.6)';context.lineWidth=1;for(let i=0;i<5;i++){context.beginPath();context.moveTo(52+i*4,53);context.lineTo(54+i*4,73);context.stroke();}
      }else{
        context.strokeStyle=type==='glass'?'rgba(235,246,248,.7)':'rgba(24,18,13,.9)';context.lineWidth=2.4;
        const branches=type==='wood'?4:7;
        for(let i=0;i<branches;i++){const angle=type==='wood'?(i%2?Math.PI/2:-Math.PI/2)+(i-2)*.07:i*Math.PI*2/branches;
          const dx=Math.cos(angle),dy=Math.sin(angle);context.beginPath();context.moveTo(64,64);context.lineTo(64+dx*15+dy*4,64+dy*15-dx*4);context.lineTo(64+dx*34-dy*3,64+dy*34+dx*3);context.lineTo(64+dx*(40+i*2),64+dy*(40+i*2));context.stroke();
        }
      }
      const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
      this.markMaterials[type]=new THREE.MeshBasicMaterial({map:texture,transparent:true,opacity:.8,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-3,side:THREE.DoubleSide});
    }
  }
  dust(p,count=25,force=2,color=0xdacbad){
    for(let i=0;i<count;i++){if(this.particles.length>=this.particleMax)this.particles.shift();const life=1.1+Math.random()*1.8;this.particles.push({x:p.x,y:p.y,z:p.z,vx:(Math.random()-.5)*force,vy:Math.random()*force*.45,vz:(Math.random()-.5)*force,life,total:life,size:(.18+Math.random()*.35)*(force>=5?3:1),color:new THREE.Color(color).multiplyScalar(.36+Math.random()*.25),kind:0});}
  }
  sparks(p,force=3,count=18){
    for(let i=0;i<count;i++){if(this.particles.length>=this.particleMax)this.particles.shift();const life=.12+Math.random()*.28;this.particles.push({x:p.x,y:p.y,z:p.z,vx:(Math.random()-.5)*force*2,vy:Math.random()*force,vz:(Math.random()-.5)*force*2,life,total:life,size:.035+Math.random()*.055,color:new THREE.Color(0xffaf42).multiplyScalar(4),kind:1});}
  }
  burst(removed,p,force=2){
    const stride=Math.max(1,Math.ceil(removed.length/18));for(let i=0;i<removed.length;i+=stride)this.addBody([removed[i]],p,force,8);
    if(removed.length){const material=MATERIALS[removed[Math.floor(removed.length/2)].mat];this.dust(p,Math.min(material.sound==='wood'?40:75,removed.length/3),force,material.color);if(removed.some(v=>MATERIALS[v.mat].sound==='metal'))this.sparks(p,force);}
  }
  rigidBurst(result,p,force=2){
    const chips=result.removed.map(c=>({point:c.point,mat:c.mat,velocity:c.velocity,rotation:c.rotation,cellSize:c.cellSize||CELL}));
    for(const fragment of result.fragments){
      for(const c of fragment.cells){
        const cellSize=fragment.cellSize||CELL,point=new THREE.Vector3((c.x+.5)*cellSize-fragment.center.x,(c.y+.5)*cellSize-fragment.center.y,(c.z+.5)*cellSize-fragment.center.z).applyQuaternion(fragment.rotation).add(fragment.position);
        chips.push({point,mat:c.mat,velocity:fragment.velocity,rotation:fragment.rotation,cellSize});
      }
    }
    const stride=Math.max(1,Math.ceil(chips.length/24));
    for(let i=0;i<chips.length;i+=stride){
      const chip=chips[i],point=chip.point;
      // addBody's single-cell path is instanced; fractional source coordinates
      // place the chip at the actual rotated world position without remeshing.
      this.addBody([{x:point.x/CELL-.5,y:point.y/CELL-.5,z:point.z/CELL-.5,mat:chip.mat}],p,force,8);
      const body=this.bodies[this.bodies.length-1];
      body.mesh?.scale.setScalar((chip.cellSize||CELL)/CELL);
      if(chip.velocity){body.vx+=chip.velocity.x;body.vy+=chip.velocity.y;body.vz+=chip.velocity.z;}
      if(chip.rotation)body.baseRotation=new THREE.Quaternion().copy(chip.rotation);
    }
    if(chips.length){const material=MATERIALS[chips[0].mat];this.dust(p,Math.min(55,chips.length/3),force,material.color);if(chips.some(c=>MATERIALS[c.mat].sound==='metal'))this.sparks(p,force);}
  }
  impact(hit,kind){
    const material=MATERIALS[hit.mat],normal=new THREE.Vector3(hit.normal.x,hit.normal.y,hit.normal.z);
    const surface=hit.visualPoint??hit.point,point=new THREE.Vector3(surface.x,surface.y,surface.z).addScaledVector(normal,.012);
    if(material.sound==='metal')this.sparks(point,kind==='hammer'?2:3,kind==='hammer'?9:5);
    else this.dust(point,kind==='hammer'?8:4,1,material.color);
    if(hit.rigidId||!this.world.getId(hit.x,hit.y,hit.z)||normal.lengthSq()<.5)return;
    const existing=this.marks.find(m=>m.cell.x===hit.x&&m.cell.y===hit.y&&m.cell.z===hit.z);if(existing){existing.mesh.scale.setScalar(Math.min(1.6,existing.mesh.scale.x*1.06));return;}
    if(this.marks.length>=64){const old=this.marks.shift();this.scene.remove(old.mesh);}
    const mesh=new THREE.Mesh(this.markGeometry,this.markMaterials[material.sound]);mesh.position.copy(point);mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),normal);mesh.rotateZ(Math.random()*.5);mesh.scale.setScalar(kind==='hammer'?1:.55);this.scene.add(mesh);
    this.marks.push({mesh,cell:{x:hit.x,y:hit.y,z:hit.z},material:hit.mat});
  }
  addBody(cells,origin=null,force=1,life=30,failure=null){
    if(!cells.length)return;if(this.bodies.length>=90)this.releaseBody(this.bodies.shift());
    let minX=Infinity,minY=Infinity,minZ=Infinity,maxX=-Infinity,maxY=-Infinity,maxZ=-Infinity;
    for(const p of cells){minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x+1);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y+1);minZ=Math.min(minZ,p.z);maxZ=Math.max(maxZ,p.z+1);}
    const center={x:(minX+maxX)*CELL/2,y:(minY+maxY)*CELL/2,z:(minZ+maxZ)*CELL/2},chip=cells.length===1;
    const mesh=chip?new THREE.Object3D():new THREE.Mesh(fragmentGeometry(cells,center),this.material);
    mesh.position.copy(center);mesh.castShadow=!chip&&cells.length>=64;mesh.receiveShadow=true;if(!chip)this.scene.add(mesh);
    const d=origin?new THREE.Vector3(center.x-origin.x,Math.max(.2,center.y-origin.y),center.z-origin.z).normalize():new THREE.Vector3((Math.random()-.5)*.3,.05,(Math.random()-.5)*.3);
    const samples=debrisSamples(cells,center,CELL);
    const toppling=this.bodies.reduce((count,body)=>count+Number(body.topple?.state==='tilting'),0);
    const topple=chip||toppling>=12?null:debrisTopplePlan({minX,minY,minZ,maxX,maxY,maxZ},center,CELL,failure,origin,cells.length);
    if(topple)topple.axisVector=new THREE.Vector3(topple.axis.x,0,topple.axis.z);
    this.bodies.push({mesh,position:{...center},samples,chipId:chip?MATERIAL_KEYS.indexOf(cells[0].mat):0,halfY:(maxY-minY)*CELL/2,vx:d.x*force,vy:d.y*force,vz:d.z*force,life,rest:false,restRevision:this.world.revision,spin:chip?(Math.random()-.5)*2:0,angleX:0,angleZ:0,topple,dustColor:MATERIALS[cells[0].mat].color});
  }
  releaseBody(body){if(!body.chipId){this.scene.remove(body.mesh);body.mesh.geometry.dispose();}}
  syncChips(){
    for(const [id,pool]of this.chipPools){pool.count=0;pool.material=this.material[id];}
    for(const body of this.bodies)if(body.chipId){const pool=this.chipPools.get(body.chipId);body.mesh.updateMatrix();pool.setMatrixAt(pool.count++,body.mesh.matrix);}
    for(const pool of this.chipPools.values()){pool.visible=pool.count>0;pool.instanceMatrix.clearUpdateRanges();if(pool.count){pool.instanceMatrix.addUpdateRange(0,pool.count*16);pool.instanceMatrix.needsUpdate=true;}}
  }
  flashLight(index,point){const light=this.flashLights[index];for(const f of this.flashes)if(f.light===light)f.light=null;light.position.copy(point);return light;}
  collapse(groups,origin,failures=[]){groups.forEach((cells,i)=>{if(!this.rigidDebris?.add(cells,origin,failures[i]))this.addBody(cells,origin,.35,40,failures[i]);});}
  createFireMesh(age=0){
    const mesh=new THREE.Mesh(this.fireGeometry,this.fireMaterial);mesh.userData.explosionAge=age;
    // Several charges may flash together; each draw supplies its own age.
    mesh.onBeforeRender=()=>{this.fireMaterial.uniforms.age.value=mesh.userData.explosionAge;this.fireMaterial.uniformsNeedUpdate=true;};
    return mesh;
  }
  explosion(p){
    const light=this.flashLight(0,p);light.distance=19;light.color.setHex(0xffb35b);
    const sphere=this.createFireMesh();sphere.position.copy(p);this.scene.add(sphere);
    this.flashes.push({light,mesh:sphere,life:.3,total:.3,power:220});this.dust(p,70,6,0x9c8a72);this.sparks(p,9,55);
    this.dust({...p,y:p.y+.5},35,2,0x5d554b);
  }
  muzzle(origin,direction){
    const light=this.flashLight(0,origin);light.distance=4;light.color.setHex(0xffc16c);light.position.addScaledVector(direction,.8);this.flashes.push({light,life:.065,total:.065,power:35});
  }
  update(dt){
    for(let i=this.marks.length-1;i>=0;i--){const mark=this.marks[i];if(this.world.get(mark.cell.x,mark.cell.y,mark.cell.z)!==mark.material){this.scene.remove(mark.mesh);this.marks.splice(i,1);}}
    for(let i=this.bodies.length-1;i>=0;i--){
      const b=this.bodies[i];b.life-=dt;if(b.life<=0){this.releaseBody(b);this.bodies.splice(i,1);continue;}
      const impact=stepDebris(b,this.world,dt,CELL);
      b.mesh.position.set(b.position.x,b.position.y,b.position.z);
      if(b.topple){b.topple.axisVector.set(b.topple.axis.x,0,b.topple.axis.z);b.mesh.quaternion.setFromAxisAngle(b.topple.axisVector,b.topple.angle);}
      else {b.mesh.rotation.set(b.angleX,b.baseRotation?0:b.mesh.rotation.y,b.angleZ);if(b.baseRotation)b.mesh.quaternion.premultiply(b.baseRotation);}
      if(impact)this.dust(impact,Math.min(24,10+Math.round(impact.speed*3)),2.2,b.dustColor);
    }
    this.syncChips();
    for(let i=this.flashes.length-1;i>=0;i--){const f=this.flashes[i];f.life-=dt;const t=Math.max(0,f.life/f.total);if(f.light)f.light.intensity=f.power*t*t;if(f.mesh){f.mesh.scale.setScalar(.15+(1-t)*2.8);f.mesh.userData.explosionAge=1-t;}if(f.life<=0){if(f.mesh)this.scene.remove(f.mesh);this.flashes.splice(i,1);}}
    this.points.material.uniforms.pixelScale.value=innerHeight*.5;
    for(let i=this.particles.length-1;i>=0;i--){const p=this.particles[i];p.life-=dt;if(p.life<=0){this.particles.splice(i,1);continue;}p.x+=p.vx*dt;p.y+=p.vy*dt;p.z+=p.vz*dt;p.vy-=(p.kind?12:.45)*dt;if(!p.kind){p.vx*=Math.pow(.14,dt);p.vz*=Math.pow(.14,dt);p.size+=dt*.22;}if(p.y<.05){p.y=.05;p.vy=0;}}
    this.particles.forEach((p,i)=>{const t=p.life/p.total;this.positions.set([p.x,p.y,p.z],i*3);this.colors.set([p.color.r,p.color.g,p.color.b],i*3);this.sizes[i]=p.size;this.alphas[i]=(p.kind?1:.30)*Math.min(1,(1-t)*12)*t;this.kinds[i]=p.kind;});for(const a of Object.values(this.geometry.attributes)){a.clearUpdateRanges();if(this.particles.length){a.addUpdateRange(0,this.particles.length*a.itemSize);a.needsUpdate=true;}}this.geometry.setDrawRange(0,this.particles.length);
  }
  clear(){for(const b of this.bodies)this.releaseBody(b);for(const f of this.flashes)if(f.mesh)this.scene.remove(f.mesh);for(const light of this.flashLights)light.intensity=0;for(const pool of this.chipPools.values()){pool.count=0;pool.visible=false;}for(const mark of this.marks)this.scene.remove(mark.mesh);this.marks=[];this.bodies=[];this.flashes=[];this.particles=[];this.geometry.setDrawRange(0,0);}
}

export function makeEnvironment(scene,level){
  const backdrop={ready:Promise.resolve(),dispose(){}};
  const park=makeParkDressing(scene,level);
  const group=new THREE.Group();scene.add(group);
  const bedrock=new THREE.Mesh(new THREE.PlaneGeometry(200,200),styleVoxelMaterial(new THREE.MeshStandardMaterial({color:level.bedrockColor??0xd9bd91,roughness:.91}),{profile:'plaster',grain:.025}));
  bedrock.geometry.attributes.uv.array.forEach((n,i,a)=>a[i]=n*35);bedrock.rotation.x=-Math.PI/2;bedrock.position.y=.001;bedrock.receiveShadow=true;group.add(bedrock);
  if(level.nativeVisuals)bedrock.visible=false;
  const signs=[];
  for(const sign of level.signs){
    const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=sign.style==='hub-industrial-plaque'?310:512;
    const c=canvas.getContext('2d');c.textAlign='center';c.textBaseline='middle';
    if(sign.style==='park-enamel'){
      c.fillStyle='#e4d6b6';c.fillRect(0,0,1024,512);c.strokeStyle='#6a5741';c.lineWidth=14;c.strokeRect(12,12,1000,488);c.fillStyle='#554634';c.font='bold 150px Microsoft YaHei';c.fillText(tr(sign.text),512,260,950);
    }else if(sign.style==='hub-industrial-plaque'){
      c.fillStyle='#c1b085';c.fillRect(0,0,canvas.width,canvas.height);c.strokeStyle='#786e54';c.lineWidth=16;c.strokeRect(12,12,1000,286);
      // Industrial sign drawn as typography on an actual mounted plaque.
      c.fillStyle='#34372c';c.font='900 182px Georgia';c.fillText(sign.textLines[0],512,120,960);
      c.font='bold 60px Arial';c.fillText(sign.textLines[1],512,250,910);
      for(const[x,y]of[[30,30],[994,30],[30,280],[994,280]]){c.fillStyle='#3d3c30';c.fillRect(x-5,y-5,10,10);}
    }else{c.font='bold 360px Arial';c.fillStyle='#913b26';c.fillText(sign.text,512,256);}
    const t=new THREE.CanvasTexture(canvas);t.colorSpace=THREE.SRGBColorSpace;
    const m=new THREE.Mesh(new THREE.PlaneGeometry(sign.width,sign.height??sign.width/2),new THREE.MeshStandardMaterial({map:t,transparent:sign.style!=='hub-industrial-plaque',roughness:1,depthWrite:sign.style==='hub-industrial-plaque',polygonOffset:true,polygonOffsetFactor:-2}));
    m.position.set(sign.x,sign.y,sign.z);m.rotation.y=sign.rotation;m.userData.anchor={x:sign.x-Math.sin(sign.rotation)*.12,y:sign.y,z:sign.z-Math.cos(sign.rotation)*.12};group.add(m);signs.push(m);
  }
  const ring=new THREE.Mesh(new THREE.RingGeometry(1.25,1.29,64),new THREE.MeshBasicMaterial({color:0xa7d196,transparent:true,opacity:.4,side:THREE.DoubleSide}));ring.rotation.x=-Math.PI/2;ring.position.set(level.exit.x,level.exit.y+.016,level.exit.z);group.add(ring);
  if(level.nativeVisuals||level.mapId==='hub-house-reference'||park)ring.visible=false;
  const iron=new THREE.MeshStandardMaterial({color:0x514a3d,metalness:.5,roughness:.8});
  for(const a of level.cables??[[10.957,15.07,-36.26,8.275,14.947,-2.565],[8.275,14.947,-2.565,16.475,17.025,9.425],[16.475,17.025,9.425,29.98,17.1,33.9]]){
    const path=new THREE.CatmullRomCurve3([new THREE.Vector3(...a.slice(0,3)),new THREE.Vector3((a[0]+a[3])/2,Math.min(a[1],a[4])-1.1,(a[2]+a[5])/2),new THREE.Vector3(...a.slice(3))]);group.add(new THREE.Mesh(new THREE.TubeGeometry(path,30,.015,5,false),iron));
  }
  // Put the existing three lights inside furnished rooms, under real ceilings.
  // Fixtures follow their supporting voxels so a breached roof cannot leave
  // a floating lamp illuminating the missing room.
  const fixtures=[];
  const housing=new THREE.MeshStandardMaterial({color:0x394344,roughness:.64,metalness:.42});
  const diffuser=new THREE.MeshStandardMaterial({color:0xf1eee5,emissive:0xffecd1,emissiveIntensity:2.8,roughness:.48});
  const housingGeometry=new THREE.BoxGeometry(.72,.10,.22),tubeGeometry=new THREE.BoxGeometry(.62,.035,.13);
  for(const[x,y,z]of level.fixtures??[[-8.3,7.66,-12],[5.7,7.66,-5.8],[-29,9.46,-33.3]]){
    const fixture=new THREE.Group();fixture.position.set(x,y,z);group.add(fixture);
    const shell=new THREE.Mesh(housingGeometry,housing);shell.receiveShadow=true;fixture.add(shell);
    const tube=new THREE.Mesh(tubeGeometry,diffuser);tube.position.y=-.067;fixture.add(tube);
    // Keep lights outside the hideable fixture. Three excludes descendants of
    // invisible groups from its light array, recompiling every lit material
    // when a ceiling falls. Zero intensity extinguishes a broken lamp while
    // preserving its shader light count and the original world-space position.
    const light=new THREE.PointLight(0xffecd1,36,6,2);light.position.set(x,y-.18,z);group.add(light);
    fixtures.push({group:fixture,anchor:{x,y:y+.11,z},light});
  }
  let fixtureWorld=null,fixtureRevision=-1;
  const update=(world,camera)=>{
    park?.update(world,camera);
    if(world===fixtureWorld&&world.revision===fixtureRevision)return;
    fixtureWorld=world;fixtureRevision=world.revision;
    for(const fixture of fixtures){const p=fixture.anchor;const active=Boolean(world.get(Math.floor(p.x/CELL),Math.floor(p.y/CELL),Math.floor(p.z/CELL)));fixture.group.visible=active;fixture.light.intensity=active?36:0;}
  };
  update(level.world);
  return{ring,signs,fixtures,lights:[...fixtures.map(f=>f.light),...(park?.lights??[])],ready:backdrop.ready,update,dispose(){park?.dispose();backdrop.dispose();scene.remove(group);const geometries=new Set(),materials=new Set(),textures=new Set();group.traverse(o=>{if(o.geometry)geometries.add(o.geometry);for(const m of o.material?Array.isArray(o.material)?o.material:[o.material]:[]){materials.add(m);if(m.map)textures.add(m.map);}});geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());textures.forEach(t=>t.dispose());}};
}

export function makeTool(camera){
  const group=new THREE.Group();camera.add(group);group.position.set(.43,-.4,-.75);
  const steel=new THREE.MeshStandardMaterial({color:0xa69f96,metalness:.40,roughness:.50}),black=new THREE.MeshStandardMaterial({color:0x403e43,roughness:.64,metalness:.36});
  const wood=new THREE.MeshStandardMaterial({color:0xc48b4d,roughness:.82});wood.userData.voxelWood=true;
  const rubber=new THREE.MeshStandardMaterial({color:0x242a27,roughness:1}),hands=handMaterials();
  function box(parent,w,h,d,x,y,z,mat){const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);m.position.set(x,y,z);parent.add(m);return m;}
  function cylinder(parent,r,h,x,y,z,mat,axis='y',r2=r){
    const m=new THREE.Mesh(new THREE.CylinderGeometry(r2,r,h,16),mat);m.position.set(x,y,z);if(axis==='z')m.rotation.x=Math.PI/2;else if(axis==='x')m.rotation.z=Math.PI/2;parent.add(m);return m;
  }
  const hammer=new THREE.Group();hammer.scale.setScalar(.76);
  // Grip is the rotation pivot. The striking faces lie on +/-Z, toward the target.
  cylinder(hammer,.027,.84,0,.18,0,wood,'y',.022);cylinder(hammer,.032,.24,0,-.08,0,rubber);
  function bevelBox(parent,w,h,d,x,y,z,mat){
    const shape=new THREE.Shape();shape.moveTo(-w/2,-h/2);shape.lineTo(w/2,-h/2);shape.lineTo(w/2,h/2);shape.lineTo(-w/2,h/2);shape.closePath();
    const g=new THREE.ExtrudeGeometry(shape,{depth:d-.014,bevelEnabled:true,bevelSegments:2,steps:1,bevelSize:.007,bevelThickness:.007,curveSegments:1});g.translate(0,0,-(d-.014)/2);
    const m=new THREE.Mesh(g,mat);m.position.set(x,y,z);parent.add(m);return m;
  }
  bevelBox(hammer,.14,.145,.30,0,.56,0,steel);
  bevelBox(hammer,.15,.155,.045,0,.56,-.165,steel);bevelBox(hammer,.15,.155,.045,0,.56,.165,steel);
  box(hammer,.145,.015,.22,0,.642,0,steel);
  cylinder(hammer,.035,.075,0,.462,0,black);
  for(let i=0;i<9;i++)cylinder(hammer,.033,.005,0,-.18+i*.024,0,black);
  group.add(hammer);
  const gun=new THREE.Group();gun.rotation.x=.03;gun.position.set(-.12,.055,-.1);
  cylinder(gun,.027,.88,0,.045,-.35,steel,'z');cylinder(gun,.028,.7,0,-.03,-.29,black,'z');
  cylinder(gun,.034,.018,0,.045,-.792,black,'z');box(gun,.1,.14,.28,0,-.01,.09,black);
  cylinder(gun,.062,.25,0,-.04,-.3,wood,'z');for(let i=0;i<8;i++)cylinder(gun,.065,.008,0,-.04,-.4+i*.028,black,'z');
  // Taper the neck into the butt so the rear stock does not conceal the grip.
  for(let i=0;i<12;i++){const t=i/11;box(gun,.043+.022*t,.046+.066*t,.025,.008*t,.010+.006*t,.215+i*.024,wood);}
  box(gun,.070,.112,.025,.008,.016,.504,rubber);
  const grip=box(gun,.066,.18,.08,0,-.17,.13,wood);grip.rotation.x=-.32;
  box(gun,.012,.026,.12,0,.079,-.73,black);box(gun,.014,.035,.016,0,.083,-.78,steel);
  box(gun,.022,.018,.04,0,.09,.07,steel);box(gun,.1,.012,.28,0,.066,.09,steel);
  const guard=new THREE.Mesh(new THREE.TorusGeometry(.052,.007,6,16),black);guard.position.set(0,-.14,.018);guard.rotation.y=Math.PI/2;gun.add(guard);
  for(const z of[.0,.14,.2])cylinder(gun,.006,.104,0,-.01,z,steel,'x');
  group.add(gun);
  const bomb=new THREE.Group();bomb.position.set(-.1,0,0);const olive=new THREE.MeshStandardMaterial({color:0x74815a,roughness:.95});
  for(let x=0;x<3;x++)cylinder(bomb,.026,.26,-.055+x*.055,0,0,olive);
  box(bomb,.185,.21,.07,0,0,.035,black);const screen=box(bomb,.12,.035,.006,0,.067,.075,new THREE.MeshStandardMaterial({color:0xc2c97b,emissive:0x4c5825,emissiveIntensity:.5}));
  for(let x=0;x<3;x++)for(let y=0;y<4;y++)box(bomb,.026,.018,.005,-.04+x*.04,.025-y*.032,.075,rubber);
  const wire=new THREE.Mesh(new THREE.TorusGeometry(.068,.003,6,18,Math.PI*1.4),new THREE.MeshStandardMaterial({color:0x9e4d31}));wire.position.set(.045,.07,0);bomb.add(wire);group.add(bomb);
  const launcher=new THREE.Group();launcher.position.set(-.1,.02,-.03);
  cylinder(launcher,.069,.92,0,.015,-.18,olive,'z');
  cylinder(launcher,.079,.05,0,.015,-.63,black,'z');
  cylinder(launcher,.092,.13,0,.015,.32,black,'z',.064);
  cylinder(launcher,.098,.27,0,.015,-.81,olive,'z',.025);
  cylinder(launcher,.052,.08,0,.015,-.97,steel,'z',.009);
  for(const z of[-.34,.07])cylinder(launcher,.072,.05,0,.015,z,wood,'z');
  const launchGrip=box(launcher,.067,.17,.085,0,-.166,.13,wood);launchGrip.rotation.x=-.32;
  box(launcher,.034,.12,.055,-.092,.07,-.08,black);
  cylinder(launcher,.035,.20,-.094,.14,-.13,black,'z');
  box(launcher,.018,.09,.018,0,.09,-.51,steel);
  box(launcher,.18,.023,.17,0,.015,.21,black);
  const grenade=new THREE.Group();grenade.position.set(-.045,0,0);
  for(let y=0;y<4;y++)for(let x=-1;x<=1;x++)for(let z=-1;z<=1;z++)
    box(grenade,.039,.039,.039,x*.041,-.062+y*.041,z*.041,olive);
  box(grenade,.064,.040,.064,0,.100,0,black);
  box(grenade,.023,.18,.035,.074,.024,0,steel);
  box(grenade,.085,.018,.035,.031,.123,0,steel);
  const pin=new THREE.Mesh(new THREE.TorusGeometry(.031,.005,4,12),steel);pin.position.set(-.056,.108,.018);grenade.add(pin);
  group.add(launcher,grenade);
  const originals=[hammer,gun,bomb,launcher,grenade];
  const sockets=originals.map((model,index)=>addToolHands(model,index,hands));
  const models=originals.map((model,index)=>{
    detachToolHands(model,sockets[index]);
    const glovePivots=sockets[index].map(socket=>socket.hand);glovePivots.forEach(hand=>model.remove(hand));
    const voxels=voxelizeTool(model,{woodAxis:index===1||index===3?'z':'y'});glovePivots.forEach(hand=>voxels.add(hand));group.remove(model);group.add(voxels);return voxels;});
  const rig=attachArmRig(group,models,sockets,hands);
  function setAppearance(appearance){
    appearance=rig.setAppearance(appearance);
    const palette={glove:new THREE.Color(appearance.gloveColor),pad:new THREE.Color(appearance.gloveColor).multiplyScalar(.7),sleeve:new THREE.Color(appearance.bodyColor),cuff:new THREE.Color(appearance.outfitColor)};
    group.traverse(node=>{for(const material of Array.isArray(node.material)?node.material:[node.material]){
      const color=palette[material?.userData.characterPart];if(color)material.color.copy(color);
    }});
  }
  let disposed=false;
  function dispose(){
    if(disposed)return;disposed=true;
    const geometries=new Set(),materials=new Set();
    for(const root of [group,...originals])root.traverse(node=>{
      if(node.material?.userData?.firstPersonSkin)return;
      if(node.geometry)geometries.add(node.geometry);
      for(const material of Array.isArray(node.material)?node.material:[node.material])if(material)materials.add(material);
    });
    rig.dispose();geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());
    Object.values(hands).forEach(m=>m.dispose());group.removeFromParent();
  }
  return{group,models,updatePose:rig.update,armRigs:rig.rigs,setAppearance,dispose};
}
