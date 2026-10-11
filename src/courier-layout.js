// Shared, renderer-independent packing contract. The host owns cargo identity,
// size and mass; a client's request contains only an id and a desired slot.
export const CARGO_SIZES=Object.freeze({S:Object.freeze([1,1]),M:Object.freeze([2,1]),L:Object.freeze([2,2])});
export const BODY_DOCKS=Object.freeze(['shoulder-left','shoulder-right','hip-left','hip-right']);
export const CARGO_MASS=Object.freeze({S:3,M:6,L:12});
export const RACK_LIMITS=Object.freeze({columns:2,rows:4,extendedRows:6,maxKg:40,extendedMaxKg:50});
export function validateCargoLayout(items=[],extended=false){
 if(!Array.isArray(items)||items.length>16)throw Error('货物清单无效');
 const occupied=new Set(),ids=new Set(),rows=extended?6:4;
 const layout=items.map(item=>{
  if(!item||typeof item.id!=='string'||!item.id||item.id.length>96||ids.has(item.id))throw Error('货物编号重复或无效');
  ids.add(item.id);if(!Object.hasOwn(CARGO_SIZES,item.size))throw Error('不支持的货物尺寸');const size=CARGO_SIZES[item.size];
  const value={id:item.id,size:item.size,dock:item.dock};
  if(item.dock==='back'){
   const {col,row}=item;if(!Number.isInteger(col)||!Number.isInteger(row)||col<0||row<0||col+size[0]>2||row+size[1]>rows)throw Error('货物超出背架格位');
   Object.assign(value,{col,row});
   for(let x=col;x<col+size[0];x++)for(let y=row;y<row+size[1];y++){const k=`${x}:${y}`;if(occupied.has(k))throw Error('背架格位已占用');occupied.add(k);}
  }else{
   if(!BODY_DOCKS.includes(item.dock)||item.size!=='S')throw Error('肩部和髋部底座只接受 S 件');
   if(occupied.has(item.dock))throw Error('底座已占用');occupied.add(item.dock);
  }
  return Object.freeze(value);
 });
 for(const item of layout)if(item.dock==='back'&&item.row>0)for(let x=item.col;x<item.col+CARGO_SIZES[item.size][0];x++)if(!occupied.has(`${x}:${item.row-1}`))throw Error('货物下方缺少支撑，请先卸上层');
 return Object.freeze(layout);
}
export function placeCargo(items,item,extended=false,target=null){
 const layout=validateCargoLayout(items,extended);
 if(layout.some(p=>p.id===item.id))throw Error('这件货物已经挂载');
 if(!Object.hasOwn(CARGO_SIZES,item.size))throw Error('这件物品不适合背架，请手抬或使用小车');
 if(target)return validateCargoLayout([...layout,{dock:target.dock,col:target.col,row:target.row,id:item.id,size:item.size}],extended);
 // Lowest slots first, then waist, then arms. Never silently shuffle cargo.
 const candidates=[];for(let row=0;row<(extended?6:4);row++)for(let col=0;col<2;col++)candidates.push({dock:'back',col,row});
 candidates.push(...['hip-left','hip-right','shoulder-left','shoulder-right'].map(dock=>({dock})));
 for(const slot of candidates)try{return validateCargoLayout([...layout,{id:item.id,size:item.size,...slot}],extended);}catch{}
 throw Error('没有合适的空格位，请先卸货或调整位置');
}
export function removeCargo(items,id,extended=false){
 if(!items.some(p=>p.id===id))throw Error('这件货物没有挂载');
 return validateCargoLayout(items.filter(p=>p.id!==id),extended);
}
export function cargoLoad(items,extended=false,massOf=item=>CARGO_MASS[item.size]){
 const layout=validateCargoLayout(items,extended);let kg=0,momentX=0,momentY=0,used=0;
 for(const item of layout){const mass=massOf(item);if(!Number.isFinite(mass)||mass<=0||mass>50)throw Error('货物重量无效');kg+=mass;
  const [w,h]=CARGO_SIZES[item.size];if(item.dock==='back'){used+=w*h;momentX+=mass*(item.col+w/2-1)*.19;momentY+=mass*(item.row+h/2)*.19;}else{momentX+=mass*(item.dock.endsWith('left')?-.355:.355);momentY+=mass*(item.dock.startsWith('shoulder')?.48:0);}
 }
 const maxKg=extended?50:40,centerX=kg?momentX/kg:0,centerY=kg?momentY/kg:0;
 return {kg,maxKg,count:layout.length,usedBackCells:used,backCells:extended?12:8,centerX,centerY,overweight:kg>maxKg,speedFactor:Math.max(.45,1-kg/maxKg*.4-Math.abs(centerX)*.25),canSprint:kg<maxKg*.7,lean:Math.min(.12,centerY*kg/maxKg*.15)};
}
