// Immutable per-object appearance, kept separate from physical material IDs.
export function normalizeVoxelPalette(source){
 if(!source)return null;const result={};
 for(const [key,value]of Object.entries(source)){
  const index=Number(key);if(!Number.isInteger(index)||index<1||index>65535)throw Error('Invalid object palette index');
  if(!Array.isArray(value.rgba)||value.rgba.length!==4||value.rgba.some(v=>!Number.isInteger(v)||v<0||v>255))throw Error('Invalid object palette colour');
  const entry={rgba:Object.freeze([...value.rgba])};
  for(const [field,fallback,max]of [['roughness',.9,1],['metalness',0,1],['opacity',1,1],['emission',0,100]]){const n=value[field]??fallback;if(!Number.isFinite(n)||n<0||n>max)throw Error('Invalid object palette appearance');entry[field]=n;}
  result[index]=Object.freeze(entry);
 }
 return Object.freeze(result);
}
export function encodePaletteCells(cells){
 const runs=[];for(const c of [...cells].sort((a,b)=>a.y-b.y||a.z-b.z||a.x-b.x)){
  if(!c.paletteIndex)continue;const n=runs.length;
  if(n&&runs[n-4]===c.y&&runs[n-3]===c.z&&runs[n-5]+runs[n-2]===c.x&&runs[n-1]===c.paletteIndex)runs[n-2]++;
  else runs.push(c.x,c.y,c.z,1,c.paletteIndex);
 }return runs;
}
export function restorePaletteCells(cells,runs,palette){
 if(!cells||!runs)return cells;if(!palette||!Array.isArray(runs)||runs.length%5)return null;
 const map=new Map(cells.map(c=>[`${c.x},${c.y},${c.z}`,c]));let count=0;
 for(let i=0;i<runs.length;i+=5){const [x,y,z,length,index]=runs.slice(i,i+5);if(![x,y,z,length,index].every(Number.isSafeInteger)||length<1||!palette[index]||(count+=length)>cells.length)return null;
  for(let dx=0;dx<length;dx++){const cell=map.get(`${x+dx},${y},${z}`);if(!cell||cell.paletteIndex)return null;cell.paletteIndex=index;}
 }return cells;
}
