// Three.js Material.copy() does not retain custom fallback vertex attributes.
// Cached voxel meshes omit per-vertex style data and use these defaults instead.
export function copyMaterialAttributeDefaults(target,source){
  if(source.defaultAttributeValues)target.defaultAttributeValues=Object.fromEntries(
    Object.entries(source.defaultAttributeValues).map(([name,value])=>[name,value?.slice?value.slice():value])
  );
  else delete target.defaultAttributeValues;
  return target;
}

// Material.copy() deep-copies metadata and clipping planes. Most capture
// materials stay unchanged for hundreds of frames. Compare the actual public
// inputs copied by their Three material class before doing that allocation.
// Texture objects are shared: their content/UV changes already reach the clone.
const ignoredCaptureKeys=new Set(['uuid','id','version','userData','_listeners','onBeforeCompile','customProgramCacheKey','toneMapped','blending','defaultAttributeValues']);
function equalCaptureValue(a,b){
  if(Object.is(a,b))return true;
  if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;
  if(a.equals)return a.equals(b);
  if(Array.isArray(a)||ArrayBuffer.isView(a)){
    if(a.length!==b.length)return false;
    for(let i=0;i<a.length;i++)if(!equalCaptureValue(a[i],b[i]))return false;
    return true;
  }
  // Defines and default attributes are small dictionaries of scalar/array
  // values; compare values as well as keys to catch in-place authoring edits.
  const keys=Object.keys(a);if(keys.length!==Object.keys(b).length)return false;
  return keys.every(key=>Object.hasOwn(b,key)&&equalCaptureValue(a[key],b[key]));
}
export const materialAttributeDefaultsEqual=(a,b)=>equalCaptureValue(a.defaultAttributeValues,b.defaultAttributeValues);
const captureComparators=new Map();
export function captureMaterialKeys(clone){
  const keys=Object.keys(clone).filter(key=>!ignoredCaptureKeys.has(key)),signature=JSON.stringify(keys);
  let compare=captureComparators.get(signature);
  if(compare===undefined){
    // Specialize public field loads for this Three material schema. Values,
    // nested arrays and dictionaries retain the same exact comparison below.
    // Keys are JSON-encoded property names, never executable author content.
    try{const body=keys.map(key=>`a=source[${JSON.stringify(key)}];b=clone[${JSON.stringify(key)}];if(a!==b&&!equal(a,b))return true;`).join('');compare=new Function('equal',`return function(source,clone){let a,b;${body}return !equal(source.defaultAttributeValues,clone.defaultAttributeValues);}`)(equalCaptureValue);}catch{compare=null;}
    captureComparators.set(signature,compare);
  }
  Object.defineProperty(keys,'compare',{value:compare});return keys;
}
export function captureMaterialChanged(source,clone,keys){
  if(keys.compare)return keys.compare(source,clone);
  for(const key of keys){const a=source[key],b=clone[key];if(a===b)continue;if(a?.equals&&b&&a.equals(b))continue;if(!equalCaptureValue(a,b))return true;}
  return !equalCaptureValue(source.defaultAttributeValues,clone.defaultAttributeValues);
}
