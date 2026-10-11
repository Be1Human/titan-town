import {MATERIALS} from '../../materials.js';

// MagicaVoxel's public RIFF-like format; no native game DLL or model required.
// The limits guard allocations before parsing/decoding untrusted local files.
export const VOX_LIMITS=Object.freeze({bytes:32*1024*1024,models:1024,voxels:2_000_000,volume:32*1024*1024,nodes:8192,instances:2048});
const identity=[1,0,0,0,1,0,0,0,1],mul=(m,v)=>[0,1,2].map(i=>m[i*3]*v[0]+m[i*3+1]*v[1]+m[i*3+2]*v[2]);
const compose=(a,b)=>[0,1,2].flatMap(i=>[0,1,2].map(j=>a[i*3]*b[j]+a[i*3+1]*b[j+3]+a[i*3+2]*b[j+6]));
function defaultPalette(){
 const p=[[0,0,0,0]],levels=[255,204,153,102,51,0];
 for(const r of levels)for(const g of levels)for(const b of levels)if(r||g||b)p.push([r,g,b,255]);
 const ramp=[238,221,187,170,136,119,85,68,34,17];
 for(let axis=0;axis<4;axis++)for(const v of ramp)p.push(axis===3?[v,v,v,255]:[axis===0?v:0,axis===1?v:0,axis===2?v:0,255]);
 return p;
}
function rotation(value='4'){
 const n=Number(value),a=n&3,b=(n>>2)&3;
 if(!Number.isInteger(n)||n<0||n>127||a>2||b>2||a===b)throw Error('VOX 旋转编码无效');
 const r=Array(9).fill(0);r[a]=n&16?-1:1;r[3+b]=n&32?-1:1;r[6+3-a-b]=n&64?-1:1;return r;
}
export function parseVox(input,{limits=VOX_LIMITS}={}){
 const bytes=input instanceof ArrayBuffer?new Uint8Array(input):new Uint8Array(input.buffer,input.byteOffset,input.byteLength);
 if(bytes.length<20||bytes.length>limits.bytes)throw Error('VOX 文件为空、截断或超过 32 MB');
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),decoder=new TextDecoder('utf-8',{fatal:true});
 const text=(start,length)=>String.fromCharCode(...bytes.subarray(start,start+length));
 if(text(0,4)!=='VOX ')throw Error('请选择 MagicaVoxel .vox 文件');
 const version=view.getUint32(4,true);if(version!==150&&version!==200)throw Error('不支持的 VOX 版本：'+version);
 const models=[],nodes=new Map(),layers=new Map(),materials={},warnings=[],notes=[];let palette=defaultPalette(),size=null,total=0,pack=null;
 const cursor=(start,end)=>{
  let at=start;const need=n=>{if(n<0||at+n>end)throw Error('VOX 块内容截断');};
  const int=()=>{need(4);const n=view.getInt32(at,true);at+=4;return n;};
  const count=max=>{const n=int();if(n<0||n>max)throw Error('VOX 数量超出导入预算');return n;};
  const string=()=>{const n=count(65536);need(n);const s=decoder.decode(bytes.subarray(at,at+n));at+=n;return s;};
  const dict=()=>{const d=Object.create(null),n=count(4096);for(let i=0;i<n;i++)d[string()]=string();return {...d};};
  return {int,count,string,dict,get at(){return at;}};
 };
 function chunks(start,end,depth=0){
  if(depth>64)throw Error('VOX 块嵌套过深');
  for(let at=start;at<end;){
   if(at+12>end)throw Error('VOX 块头截断');
   const id=text(at,4),length=view.getUint32(at+4,true),children=view.getUint32(at+8,true),body=at+12,tail=body+length,next=tail+children;
   if(next>end||next<tail)throw Error('VOX 块尺寸无效');const c=cursor(body,tail);let node;
   if(id==='SIZE'){size=[c.int(),c.int(),c.int()];if(size.some(v=>v<1||v>256)||size.reduce((a,b)=>a*b,1)>limits.volume)throw Error('VOX 模型尺寸超出预算');}
   else if(id==='PACK'){pack=c.count(limits.models);}
   else if(id==='XYZI'){
    if(!size)throw Error('VOX XYZI 缺少 SIZE');const n=c.count(limits.voxels);total+=n;
    if(total>limits.voxels||models.length>=limits.models||c.at+n*4!==tail)throw Error('VOX 体素数量或块长度无效');
    const cells=bytes.slice(c.at,tail);for(let i=0;i<cells.length;i+=4)if(cells[i]>=size[0]||cells[i+1]>=size[1]||cells[i+2]>=size[2]||!cells[i+3])throw Error('VOX 体素坐标或颜色索引无效');
    models.push({id:models.length,size,xyzi:cells});size=null;
   }else if(id==='RGBA'){
    if(length!==1024)throw Error('VOX RGBA 调色板长度无效');palette=Array.from({length:256},(_,i)=>i?[...bytes.subarray(body+(i-1)*4,body+i*4)]:[0,0,0,0]);
   }else if(id==='MATL'){const index=c.count(255);materials[index]=c.dict();}
   else if(id==='NOTE'){const n=c.count(256);for(let i=0;i<n;i++)notes.push(c.string());}
   else if(id==='LAYR'){const index=c.int();layers.set(index,c.dict());c.int();}
   else if(['nTRN','nGRP','nSHP'].includes(id)){
    const index=c.int(),attributes=c.dict();node={id:index,type:id,attributes};
    if(id==='nTRN'){node.child=c.int();c.int();node.layer=c.int();const n=c.count(4096);if(!n)throw Error('VOX 变换节点缺少帧');node.frames=Array.from({length:n},c.dict);if(n>1)warnings.push('动画变换只导入第 0 帧');}
    if(id==='nGRP'){const n=c.count(limits.nodes);node.children=Array.from({length:n},c.int);}
    if(id==='nSHP'){const n=c.count(limits.models);if(!n)throw Error('VOX 形状节点缺少模型');node.models=Array.from({length:n},()=>({id:c.int(),attributes:c.dict()}));if(n>1)warnings.push('动画形状只导入第 0 帧');}
    if(nodes.has(index)||nodes.size>=limits.nodes)throw Error('VOX 节点重复或数量过多');nodes.set(index,node);
   }else if(id==='TDCZ')throw Error('不支持 TDCZ 压缩扩展，请从 MagicaVoxel 导出标准 SIZE/XYZI VOX');
   else if(id==='MATT')warnings.push('旧版 MATT 外观未转换；物理材质按名称或导入设置映射');
   else if(id==='IMAP')warnings.push('IMAP 重排未转换，按 XYZI 索引读取；请核对颜色或重新导出标准 VOX');
   if(children)chunks(tail,next,depth+1);at=next;
  }
 }
 if(text(8,4)!=='MAIN'||view.getUint32(12,true)!==0||20+view.getUint32(16,true)!==bytes.length)throw Error('VOX MAIN 长度无效');
 chunks(20,bytes.length);if(!models.length)throw Error('VOX 没有可导入的 XYZI 模型');if(pack!==null&&pack!==models.length)throw Error('VOX PACK 与实际模型数量不一致');
 const referenced=new Set();for(const n of nodes.values())for(const child of n.children??(n.child===undefined?[]:[n.child]))referenced.add(child);
 const instances=[];const visiting=new Set(),visited=new Set();
 function walk(id,r=identity,t=[0,0,0],name='',hidden=false,depth=0){
  if(depth>128||visiting.has(id))throw Error('VOX 场景节点循环或层级过深');const n=nodes.get(id);if(!n)throw Error('VOX 引用了不存在的节点');visiting.add(id);
  name=n.attributes._name??name;hidden||=n.attributes._hidden==='1'||layers.get(n.layer)?._hidden==='1';
  if(n.type==='nTRN'){
   const frame=n.frames.find(f=>!f._f||f._f==='0')??n.frames[0],p=(frame._t??'0 0 0').trim().split(/\s+/).map(Number);
   if(p.length!==3||p.some(v=>!Number.isSafeInteger(v)||Math.abs(v)>8192))throw Error('VOX 位移无效');
   walk(n.child,compose(r,rotation(frame._r)),mul(r,p).map((v,i)=>v+t[i]),name,hidden,depth+1);
  }else if(n.type==='nGRP')for(const child of n.children)walk(child,r,t,name,hidden,depth+1);
  else {const m=n.models.find(m=>!m.attributes._f||m.attributes._f==='0')??n.models[0];if(!models[m.id])throw Error('VOX 引用了不存在的模型');if(!hidden){if(instances.length>=limits.instances)throw Error('VOX 实例数量过多');instances.push({modelId:m.id,name:name||'model-'+m.id,nodeId:id,r,t});}}
  visiting.delete(id);visited.add(id);
 }
 if(nodes.size){const roots=[...nodes.keys()].filter(id=>!referenced.has(id));if(!roots.length)throw Error('VOX 场景没有根节点');for(const id of roots)walk(id);if(visited.size!==nodes.size)throw Error('VOX 含不可达或循环的场景节点');}
 else for(const m of models)instances.push({modelId:m.id,name:'model-'+m.id,r:identity,t:[0,0,0]});
 if(!instances.length)throw Error('VOX 没有可见模型');
 return {version,models,instances,palette,materials,notes,warnings:[...new Set(warnings)]};
}
const aliases=[['glass',/glass|windowpane|玻璃/],['metal',/metal|steel|iron|alumin|金属|钢|铁/],['wood',/wood|timber|plank|doorblade|framework|木|树干/],['leaf',/leaves|foliage|leaf|树叶/],['brick',/brick|masonry|砖/],['concrete',/concrete|cement|水泥|混凝土/],['stone',/stone|rock|石/],['plaster',/plaster|drywall|wall|灰泥|墙/]];
export function resolveVoxMaterial(properties={},name='',{defaultMaterial='plaster',material='auto',paletteOverrides={},index=0}={}){
 const override=paletteOverrides[index]??(material==='auto'?null:material);
 if(override){if(!Object.hasOwn(MATERIALS,override))throw Error('未知破坏材质：'+override);return override;}
 const explicit=properties._physical??properties._material;if(explicit&&Object.hasOwn(MATERIALS,explicit))return explicit;
 if(properties._type==='_glass')return 'glass';if(properties._type==='_metal'||Number(properties._metal)>.5)return 'metal';
 for(const [value,pattern]of aliases)if(pattern.test(name.toLowerCase()))return value;
 if(!Object.hasOwn(MATERIALS,defaultMaterial))throw Error('未知默认破坏材质：'+defaultMaterial);return defaultMaterial;
}
const bounded=(value,fallback,min=0,max=1)=>Number.isFinite(Number(value))?Math.max(min,Math.min(max,Number(value))):fallback;
const base64=bytes=>{let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);};
export function importVoxAsset(input,{assetId='imported/vox',name='VOX 物件',cellSize=.1,authorship='user-supplied',...options}={}){
 if(!Number.isFinite(cellSize)||cellSize<.025||cellSize>.4)throw Error('体素尺寸应为 0.025–0.4 米');
 const parsed=parseVox(input),models=[],parts=[],mapping={},appearance={};let totalVolume=0,totalCells=0;
 for(let i=1;i<256;i++){
  const p=parsed.materials[i]??{},rgba=parsed.palette[i],glass=p._type==='_glass',emit=p._type==='_emit';
  appearance[i]={rgba:[...rgba],roughness:bounded(p._rough,.9),metalness:p._type==='_metal'?bounded(p._metal??p._weight,1):0,opacity:glass?bounded(p._alpha??(1-Number(p._trans??.5)),.5,.05,1):rgba[3]/255,emission:emit?Math.pow(10,bounded(p._flux,0,-3,3))*bounded(p._emit??p._weight,1)*.1:0};
 }
 const names=new Set();
 for(const instance of parsed.instances){
  const source=parsed.models[instance.modelId],cells=new Map();let modelName=instance.name;for(let n=2;names.has(modelName);n++)modelName=instance.name+'-'+n;names.add(modelName);
  for(let i=0;i<source.xyzi.length;i+=4){
   const index=source.xyzi[i+3],v=[source.xyzi[i]+.5,source.xyzi[i+1]+.5,source.xyzi[i+2]+.5].map((v,a)=>v-Math.floor(source.size[a]/2)),p=mul(instance.r,v).map((v,a)=>v+instance.t[a]),q=[Math.floor(p[0]),Math.floor(p[2]),Math.floor(-p[1])];
   const mat=resolveVoxMaterial(parsed.materials[index],name+' '+modelName+' '+(parsed.notes[index-1]??''),{...options,index});
   cells.set(q.join(','),{x:q[0],y:q[1],z:q[2],mat,paletteIndex:index});mapping[modelName+'/'+index]=mat;
  }
  if(!cells.size)continue;
  const list=[...cells.values()],min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];for(const c of list)for(const [a,k]of ['x','y','z'].entries()){min[a]=Math.min(min[a],c[k]);max[a]=Math.max(max[a],c[k]+1);}
  const size=max.map((v,a)=>v-min[a]),volume=size.reduce((a,b)=>a*b,1);totalVolume+=volume;totalCells+=list.length;
  if(totalVolume>VOX_LIMITS.volume||totalCells>VOX_LIMITS.voxels)throw Error('变换后的 VOX 资产超出导入预算');
  const materials=['',...new Set(list.map(c=>c.mat))],dense=new Uint8Array(volume),colors=new Uint8Array(volume);
  for(const c of list){const x=c.x-min[0],y=c.y-min[1],z=c.z-min[2];dense[x+z*size[0]+y*size[0]*size[2]]=materials.indexOf(c.mat);colors[x+size[0]*(y+size[1]*z)]=c.paletteIndex;}
  const runs=[];for(let i=0;i<dense.length;){let end=i+1;while(end<dense.length&&dense[end]===dense[i])end++;runs.push(end-i,dense[i]);i=end;}
  models.push({name:modelName,origin:min.map(v=>v*cellSize),size,materials,runs,count:list.length,nativePaletteBase64:base64(colors)});
  parts.push({name:modelName,modelId:instance.modelId,nodeId:instance.nodeId??null,cells:list});
 }
 if(!models.length)throw Error('VOX 模型没有实体体素');
 const used=new Set();for(const part of parts)for(const c of part.cells)used.add(c.paletteIndex);for(const i of Object.keys(appearance))if(!used.has(Number(i)))delete appearance[i];
 const resource={schema:'crew-voxel-resource-v1',assetId,authorship,cellSize,models,palette:Object.fromEntries(parsed.palette.map((p,i)=>[i,p])),paletteAppearance:appearance,source:{format:'MagicaVoxel VOX',version:parsed.version,name,axisConversion:'Z-up to Y-up: x,z,-y',frame:0},materialMapping:mapping};
 return {resource,parts,report:{models:models.length,voxels:totalCells,cellSize,mapping,warnings:parsed.warnings}};
}

export function voxPropData(asset,{object=null,maxCells=200_000}={}){
 const selected=object?asset.parts.filter(p=>p.name===object):asset.parts;if(!selected.length)throw Error('没有找到指定的 VOX 部件');
 const cells=new Map();for(const part of selected)for(const c of part.cells){cells.set(`${c.x},${c.y},${c.z}`,{...c});if(cells.size>maxCells)throw Error('物件超过 20 万体素，请按部件拆分导入');}
 return {cells:[...cells.values()],cellSize:asset.resource.cellSize,palette:asset.resource.paletteAppearance,assetIdentity:{assetId:asset.resource.assetId,models:selected.map(p=>p.name),source:asset.resource.source}};
}
