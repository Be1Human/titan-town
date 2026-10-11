import * as THREE from '../../../vendor/three.module.js';
export function transferFragmentGeometry(geometry){
  const attributes=Object.fromEntries(Object.entries(geometry.attributes).map(([name,a])=>[name,{array:a.array,itemSize:a.itemSize,normalized:a.normalized}]));
  return {attributes,index:geometry.index?.array,groups:geometry.groups.map(g=>({...g})),box:geometry.boundingBox&&{min:geometry.boundingBox.min.toArray(),max:geometry.boundingBox.max.toArray()},sphere:geometry.boundingSphere&&{center:geometry.boundingSphere.center.toArray(),radius:geometry.boundingSphere.radius},userData:geometry.userData};
}
export function restoreFragmentGeometry(data){
  const g=new THREE.BufferGeometry();for(const [name,a]of Object.entries(data.attributes))g.setAttribute(name,new THREE.BufferAttribute(a.array,a.itemSize,a.normalized));
  if(data.index)g.setIndex(new THREE.BufferAttribute(data.index,1));for(const group of data.groups)g.addGroup(group.start,group.count,group.materialIndex);
  if(data.box)g.boundingBox=new THREE.Box3(new THREE.Vector3().fromArray(data.box.min),new THREE.Vector3().fromArray(data.box.max));
  if(data.sphere)g.boundingSphere=new THREE.Sphere(new THREE.Vector3().fromArray(data.sphere.center),data.sphere.radius);
  g.userData=data.userData;return g;
}
