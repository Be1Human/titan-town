import * as THREE from '../vendor/three.module.js';
import {createSlimWorker} from './slim-worker.js';

// Read the actual standard body geometry and UVs. This deliberately owns no
// separate sleeve/glove palette: imported skins and painted edits are shared.
export function createFirstPersonSkin(appearance){
  if(appearance.template!=='crew-01'||appearance.silhouette!=='human')return null;
  const worker=createSlimWorker(appearance),parts={},outerParts={};
  const material=new THREE.MeshStandardMaterial({map:worker.skinAtlas.texture,roughness:.94});
  material.name='first-person shared character skin';
  material.userData.firstPersonSkin=true;
  const outerMaterial=worker.clothingMesh.material.clone();outerMaterial.userData.firstPersonSkin=true;
  function armGeometry(source,side){
    const box=worker.boxes.find(b=>b.name===`${side}Shoulder`),forearm=worker.boxes.find(b=>b.name===`${side}Hand`),centerY=(box.center[1]+box.size[1]/2+forearm.center[1]-forearm.size[1]/2)/2,armLength=box.center[1]+box.size[1]/2-(forearm.center[1]-forearm.size[1]/2),positions=[],normals=[],uvs=[],indices=[],remap=new Map();
    const p=source.attributes.position,n=source.attributes.normal,uv=source.attributes.uv,tags=source.attributes.characterPart;
    for(let i=0;i<p.count;i++)if(tags.getX(i)===box.part||tags.getX(i)===forearm.part){
      remap.set(i,positions.length/3);
      // Rotate the intact arm toward the camera. The distal glove surrounds
      // the tool grip; the shoulder end remains anchored outside the view.
      positions.push((p.getX(i)-box.center[0])/appearance.armSize,-(p.getZ(i)-box.center[2])/appearance.armSize,(p.getY(i)-centerY)/armLength*.46+.17);
      normals.push(n.getX(i),-n.getZ(i),n.getY(i));uvs.push(uv.getX(i),uv.getY(i));
    }
    for(let i=0;i<source.index.count;i+=3){
      const triangle=[0,1,2].map(k=>remap.get(source.index.getX(i+k)));
      if(triangle.every(v=>v!==undefined))indices.push(...triangle);
    }
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
    geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));geometry.setIndex(indices);
    geometry.computeBoundingBox();geometry.computeBoundingSphere();return geometry;
  }
  for(const side of ['left','right']){parts[side]=armGeometry(worker.mesh.geometry,side);outerParts[side]=armGeometry(worker.clothing.geometry,side);}
  let disposed=false;
  return {parts,outerParts,material,outerMaterial,atlas:worker.skinAtlas,dispose(){if(disposed)return;disposed=true;Object.values(parts).concat(Object.values(outerParts)).forEach(g=>g.dispose());material.dispose();outerMaterial.dispose();worker.dispose();}};
}
