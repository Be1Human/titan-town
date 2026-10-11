import * as T from '../vendor/three.module.js';

// Cosmetic equipment and its deterministic packing rules. Gameplay can supply
// the same layout to every peer; preview layouts never create gameplay cargo.
import {CARGO_SIZES,BODY_DOCKS,validateCargoLayout,cargoLoad} from './courier-layout.js';
export {CARGO_SIZES,BODY_DOCKS,validateCargoLayout} from './courier-layout.js';
// An oversized visual study, separate from the networked parcel inventory.
export const FRIDGE_PREVIEW=Object.freeze({kind:'fridge',width:.80,height:1.65,depth:.65});
export function courierPreviewLayout(mode){
 if(mode==='empty'||mode==='off'||mode==='fridge')return [];
 if(mode==='light')return [{id:'parcel-1',size:'M',dock:'back',col:0,row:0},{id:'parcel-2',size:'S',dock:'hip-left'},{id:'parcel-3',size:'S',dock:'hip-right'}];
 const rows=mode==='extended'?6:4;
 const items=[];for(let row=0;row<rows;row++)for(let col=0;col<2;col++)items.push({id:`back-${col}-${row}`,size:'S',dock:'back',col,row});
 if(mode==='mixed')items.splice(0,8,{id:'large',size:'L',dock:'back',col:0,row:0},{id:'medium',size:'M',dock:'back',col:0,row:2},{id:'small-left',size:'S',dock:'back',col:0,row:3},{id:'small-right',size:'S',dock:'back',col:1,row:3});
 return [...items,...BODY_DOCKS.map(dock=>({id:dock,size:'S',dock}))];
}

// Default adapter anchors. Instances derive fitted positions from the current
// body dimensions (courier.fit.anchors); +Z is forward.
export const COURIER_ANCHORS=Object.freeze({
 back:{bone:'spine',origin:[0,-.34,-.3005],cell:.19,columns:2},
 'hip-left':{bone:'hips',origin:[-.31,-.06,-.045],size:'S'},
 'hip-right':{bone:'hips',origin:[.31,-.06,-.045],size:'S'},
 'shoulder-left':{bone:'leftShoulder',origin:[-.26,-.19,-.005],size:'S'},
 'shoulder-right':{bone:'rightShoulder',origin:[.26,-.19,-.005],size:'S'},
});

export function createCourierRig(worker,appearance){
 const roots=[],groups=new Map(),material=new T.MeshStandardMaterial({vertexColors:true,roughness:.86});
 const a=appearance,steel='#424b49',trim='#b6b7a2',strap='#554737',yellow='#d4ae4d',pad='#827354';
 let current=[],extended=false,oversized=null,visible=true,disposed=false;
 // Actual rest-pose dimensions already contain the appearance proportions.
 // Build around those surfaces once; multiplying them again would detach docks.
 const body=worker.boxes?.find(b=>b.name==='spine'),arm=worker.boxes?.find(b=>b.name==='leftShoulder'),head=worker.boxes?.find(b=>b.name==='head'),pelvis=worker.boxes?.find(b=>b.role==='pelvis');
 const fitted=Boolean(body&&arm&&head),bw=body?.size[0]??.4,bh=body?.size[1]??.5,bd=body?.size[2]??.34,aw=arm?.size[0]??.15,ad=arm?.size[2]??.19;
 // Keep the cuff on the upper arm even when the whole limb is shortened.
 const shoulderDockY=fitted?-Math.min(.19,arm.size[1]*.58):-.19;
 const scales=fitted?{spine:[1,1,1],hips:[1,1,1],leftShoulder:[1,1,1],rightShoulder:[1,1,1]}:{spine:[a.torsoWidth,a.torsoHeight,a.torsoDepth],hips:[a.torsoWidth,1,a.torsoDepth],leftShoulder:[a.armSize,a.armLength,a.armSize],rightShoulder:[a.armSize,a.armLength,a.armSize]};
 let fit=null;
 function resolveFit(){
  // The loading shelf starts below the buttocks, measured in the torso
  // equipment bone's space. Derive it from the pelvis even on custom bodies.
  const pelvisBottom=pelvis&&body?pelvis.center[1]-pelvis.size[1]/2-body.center[1]:-bh/2-.085;
  const base=pelvisBottom-.030;
  const occupiedRows=current.filter(item=>item.dock==='back').reduce((rows,item)=>Math.max(rows,item.row+CARGO_SIZES[item.size][1]),0);
  // Ordinary empty/light racks follow the approved torso. Capacity remains
  // four rows; higher cargo extends the supports without shrinking parcels.
  const high=oversized?base+FRIDGE_PREVIEW.height:extended?base+6*.19:Math.max(bh/2-.054,base+occupiedRows*.19);
  const frameTop=oversized||extended?high+.05:Math.max(bh/2-.004,high+.05);
  // Taller racks also clear the back of the head, rather than clipping it.
  const aboveHead=frameTop>bh/2,railZ=aboveHead?Math.min(-bd/2-.06,-(head?.size[2]??.46)/2-.040):-bd/2-.06;
  const cargoDepth=oversized?FRIDGE_PREVIEW.depth:.225,cargoZ=railZ-.018-cargoDepth/2;
  return{bodyWidth:bw,bodyHeight:bh,bodyDepth:bd,armWidth:aw,armDepth:ad,pelvisBottom,base,high,railZ,cargoZ,cargoDepth,aboveHead,frameTop,anchors:{
   back:{bone:'spine',origin:[0,base,cargoZ],cell:.19,columns:2},
   'hip-left':{bone:'hips',origin:[-(bw/2+.025+.085),-.06,-.045],size:'S'},
   'hip-right':{bone:'hips',origin:[bw/2+.025+.085,-.06,-.045],size:'S'},
   'shoulder-left':{bone:'leftShoulder',origin:[-(aw+.025+.085),shoulderDockY,-.005],size:'S'},
   'shoulder-right':{bone:'rightShoulder',origin:[aw+.025+.085,shoulderDockY,-.005],size:'S'},
  }};
 }
 function root(bone){if(groups.has(bone))return groups.get(bone);const group=new T.Group();group.name=`courier-${bone}`;group.scale.fromArray(scales[bone]);(worker.equipmentBones?.[bone]||worker.bones[bone]).add(group);roots.push(group);groups.set(bone,group);return group;}
 function batch(bone,name){const geometries=[];
  function box(p,s,color){const g=new T.BoxGeometry(...s).toNonIndexed();g.translate(...p);const c=new T.Color(color),colors=[];for(let i=0;i<g.attributes.position.count;i++)colors.push(c.r,c.g,c.b);g.setAttribute('color',new T.Float32BufferAttribute(colors,3));geometries.push(g);}
  function line(from,to,width,depth,color){const start=new T.Vector3(...from),end=new T.Vector3(...to),g=new T.BoxGeometry(width,start.distanceTo(end),depth).toNonIndexed();g.applyQuaternion(new T.Quaternion().setFromUnitVectors(new T.Vector3(0,1,0),end.clone().sub(start).normalize()));g.translate(...start.add(end).multiplyScalar(.5).toArray());const c=new T.Color(color);g.setAttribute('color',new T.Float32BufferAttribute(Array.from({length:g.attributes.position.count},()=>[c.r,c.g,c.b]).flat(),3));geometries.push(g);}
  function finish(){if(!geometries.length)return;const geometry=new T.BufferGeometry();for(const key of ['position','normal','color']){const values=[];for(const g of geometries)values.push(...g.attributes[key].array);geometry.setAttribute(key,new T.Float32BufferAttribute(values,3));}for(const g of geometries)g.dispose();geometry.computeBoundingBox();geometry.computeBoundingSphere();const mesh=new T.Mesh(geometry,material);mesh.name=name;mesh.castShadow=true;mesh.receiveShadow=true;mesh.raycast=()=>{};root(bone).add(mesh);}
  return{box,line,finish};
 }
 function plate(b,p,size=[.16,.17],axis='z'){
  const s=axis==='x'?[.025,size[1],size[0]]:[size[0],size[1],.025];b.box(p,s,steel);
  for(const sign of [-1,1]){const q=[...p];q[axis==='x'?2:0]+=sign*(size[0]/2-.018);b.box(q,axis==='x'?[.033,size[1]-.018,.018]:[.018,size[1]-.018,.033],trim);}
  b.box([p[0],p[1]+size[1]/2-.02,p[2]],axis==='x'?[.037,.03,.045]:[.045,.03,.037],yellow);
 }
 function equipment(){
  const b=batch('spine','courier-harness-back-frame'),{base,high,railZ,cargoZ,cargoDepth,frameTop}=fit,rows=Math.min(extended?6:4,Math.max(1,Math.floor((frameTop-base)/.19))),front=bd/2,back=-bd/2,strapX=bw*.34,top=bh/2-.011,railX=oversized?.29:.165,trayWidth=oversized?FRIDGE_PREVIEW.width+.08:.425;
  const frontStrapBottom=Math.max(base,-bh/2+.055),frontStrapX=bw*.415;
  for(const sign of [-1,1]){
   // Slim front webbing follows the clothing edges; the full rear strap and
   // frame stays still carry the rack. Join both across the shoulder surface.
   b.line([sign*frontStrapX,frontStrapBottom,front+.008],[sign*frontStrapX,top,front+.008],.018,.012,strap);
   b.line([sign*frontStrapX,top,front+.008],[sign*strapX,top,back-.008],.018,.022,strap);
   b.line([sign*strapX,top,back-.008],[sign*strapX,base,back-.008],.042,.022,strap);
   b.box([sign*frontStrapX,bh*.25,front+.016],[.026,.032,.009],trim);
   b.box([sign*frontStrapX,bh*.25,front+.022],[.012,.018,.006],strap);
   b.box([sign*railX,(frameTop+base-.0325)/2,railZ],[oversized?.055:.035,frameTop-base+.0325,.036],steel);
   b.box([sign*railX,frameTop-.0275,railZ],[.06,.055,.05],yellow);
   // Three stays visibly bridge the back pad to the frame. This includes the
   // deeper head-clearance offset of an extended rack.
   for(const y of [base+.08,0,Math.min(high-.08,bh/2-.08)])b.line([sign*strapX,y,back-.012],[sign*railX,y,railZ],.036,.036,steel);
  }
  b.box([0,0,back-.011],[Math.min(bw*.9,.36),bh*.70,.026],pad);
  const trayFront=back+.012,trayRear=cargoZ-cargoDepth/2-.012,trayCenter=(trayFront+trayRear)/2;
  b.box([0,base-.015,trayCenter],[trayWidth,.042,trayFront-trayRear],steel);
  b.box([0,base+.013,trayRear],[trayWidth,.035,.024],trim);
  if(oversized){
   // Shelf brackets and two large crossmembers transfer the load into the
   // body-connected stays. The appliance feet sit directly on the shelf.
   for(const sign of [-1,1])b.line([sign*railX,base+.24,railZ],[sign*railX,base-.008,trayRear+.07],.04,.04,steel);
   for(const y of [base+.45,base+1.21])b.box([0,y,railZ-.01],[.66,.055,.034],trim);
  }else{
   for(let row=0;row<=rows;row++)b.box([0,Math.min(base+row*.19,frameTop-.011),railZ-.01],[.38,.022,.034],trim);
   b.box([0,frameTop-.011,railZ-.01],[.38,.022,.034],trim);
   b.box([0,(frameTop+base)/2,railZ-.013],[.018,frameTop-base,.025],steel);
  }
  // Small yellow tabs visibly identify each of the eight/twelve cells.
  if(!oversized)for(let row=0;row<rows;row++)for(const col of [-1,1])b.box([col*.095,base+.025+row*.19,railZ-.035],[.032,.022,.013],yellow);
  b.finish();
  const belt=batch('hips','courier-load-belt');
  belt.box([0,.055,front+.008],[bw+.026,.026,.012],strap);belt.box([0,.055,back-.012],[bw+.026,.075,.026],strap);
  for(const sign of [-1,1]){belt.box([sign*(bw/2+.012),.055,0],[.026,.075,bd+.026],strap);plate(belt,[sign*(bw/2+.0125),-.06,-.045],[.16,.175],'x');
   // Vertical mounting strip connects the low hip plate to the waist belt.
   belt.box([sign*(bw/2+.012),-.015,-.045],[.026,.17,.08],steel);
   const x=fit.anchors[sign<0?'hip-left':'hip-right'].origin[0],inner=sign*bw/2;
   if(current.some(item=>item.dock===(sign<0?'hip-left':'hip-right')))belt.box([(inner+x+sign*.085)/2,-.1575,-.045],[Math.abs(x+sign*.085-inner),.025,.18],steel);
  }
  // A small offset buckle leaves the outfit's central waist motif readable.
  belt.box([-frontStrapX,.055,front+.018],[.034,.032,.010],trim);
  belt.box([-frontStrapX,.055,front+.025],[.018,.017,.006],strap);
  // Keep tool sockets on the rear belt instead of across the abdomen.
  for(const sign of [-1,1]){const x=sign*bw*.325;belt.box([x,.025,back-.040],[.075,.065,.045],steel);belt.box([x,.025,back-.070],[.04,.042,.019],strap);belt.box([x,.053,back-.084],[.038,.012,.012],yellow);}
  belt.finish();
  for(const side of ['left','right']){const sign=side==='left'?-1:1,s=batch(side+'Shoulder',`courier-${side}-shoulder-dock`),center=sign*aw/2;
   // A closed band hugs all four arm faces instead of hanging beside the sleeve.
   for(const face of [-1,1]){s.box([center,shoulderDockY,face*(ad/2+.006)],[aw+.012,.024,.016],strap);s.box([center+face*(aw/2+.006),shoulderDockY,0],[.016,.024,ad+.012],strap);}
   plate(s,[sign*(aw+.0125),shoulderDockY,-.005],[.16,.16],'x');
   const x=fit.anchors[`shoulder-${side}`].origin[0];if(current.some(item=>item.dock===`shoulder-${side}`))s.box([(sign*aw+x+sign*.085)/2,shoulderDockY-.0965,-.005],[Math.abs(x+sign*.085-sign*aw),.023,.175],steel);s.finish();
  }
 }
 function parcel(b,p,dimensions,index,axis='z'){
  const [w,h,d]=dimensions,color=['#b38148','#be925c','#a87b47'][index%3],tape='#d9bf86',ink='#433f32';
  b.box(p,[w,h,d],color);
  // Packing tape wraps both depth faces and top/bottom, with a separate
  // dark restraint belt anchored around the parcel, never floating.
  for(const sign of [-1,1]){
   b.box([p[0],p[1],p[2]+sign*(d/2+.001)],[.032,h,.005],tape);
   b.box([p[0],p[1]+sign*(h/2+.001),p[2]],[.032,.005,d],tape);
   b.box([p[0],p[1]-h*.22,p[2]+sign*(d/2+.004)],[w,.017,.007],steel);
   b.box([p[0]+sign*(w/2+.001),p[1]-h*.22,p[2]],[.005,.017,d],steel);
  }
  // Label appears on the exposed face of each mounted object.
  if(axis==='x'){
   const x=p[0]+Math.sign(p[0])*(w/2+.005);b.box([x,p[1]+h*.12,p[2]],[.006,h*.34,d*.48],'#efe5c9');b.box([x+Math.sign(x)*.004,p[1]+h*.17,p[2]],[.006,.008,d*.33],ink);
  }else{
   const z=p[2]-d/2-.007;b.box([p[0]-w*.20,p[1]+h*.17,z],[w*.30,h*.30,.005],'#efe5c9');
   for(let i=0;i<3;i++)b.box([p[0]-w*.20,p[1]+h*.22-i*.014,z-.004],[w*.20,.005,.004],ink);
  }
 }
 function cargo(){const batches=new Map();const get=bone=>{if(!batches.has(bone))batches.set(bone,batch(bone,`courier-cargo-${bone}`));return batches.get(bone);};
  for(const [i,item]of current.entries()){
   if(item.dock==='back'){const [w,h]=CARGO_SIZES[item.size],anchor=fit.anchors.back;parcel(get(anchor.bone),[(item.col+w/2-1)*anchor.cell,anchor.origin[1]+(item.row+h/2)*anchor.cell,anchor.origin[2]],[w*anchor.cell-.012,h*anchor.cell-.012,.225],i);}
   else{const anchor=fit.anchors[item.dock];parcel(get(anchor.bone),anchor.origin,[.17,.17,.155],i,'x');}
  }for(const b of batches.values())b.finish();
 }
 function refrigerator(){
  if(!oversized)return;
  const b=batch('spine','courier-oversized-fridge'),{width:w,height:h,depth:d}=FRIDGE_PREVIEW,{base,cargoZ:z}=fit,bottom=base+.006,front=z-d/2,inner=z+d/2;
  const bodyBottom=bottom+.05,bodyTop=base+h,bodyHeight=bodyTop-bodyBottom;
  b.box([0,bodyBottom+bodyHeight/2,z],[w,bodyHeight,d],'#cee4da');
  // Door faces outward, away from the player. Pixel-sized trim provides clean
  // shapes without adding a dense voxel surface or many separate draw calls.
  const split=bodyTop-.48;
  for(const [lo,hi] of [[bodyBottom+.025,split-.014],[split+.014,bodyTop-.025]]){
   b.box([0,(lo+hi)/2,front-.009],[w-.045,hi-lo,.022],'#edf1df');
   b.box([-.28,(lo+hi)/2,front-.032],[.028,Math.min(.24,hi-lo-.08),.03],steel);
  }
  b.box([.21,bodyTop-.13,front-.024],[.13,.042,.012],'#b69658');
  for(const x of [-.29,.29])for(const q of [-1,1])b.box([x,bottom+.025,z+q*(d/2-.07)],[.08,.05,.09],steel);
  // Two closed restraint loops contact all four appliance faces, with the
  // rear segments against the supporting frame and visible outward buckles.
  for(const y of [base+.45,base+1.21]){
   b.box([0,y,front-.031],[w+.02,.07,.022],strap);
   b.box([0,y,inner+.006],[w+.02,.07,.018],strap);
   for(const q of [-1,1])b.box([q*(w/2+.006),y,z-.0155],[.018,.07,d+.051],strap);
   b.box([.18,y,front-.055],[.09,.09,.026],yellow);
   b.box([.18,y,front-.071],[.046,.046,.012],steel);
  }
  // A third short band joins the restraint assembly to the vertical rails.
  for(const q of [-1,1])b.box([q*.29,base+.45,inner+.008],[.07,.10,.022],steel);
  b.finish();
 }
 function clear(){for(const r of roots){for(const m of r.children)m.geometry?.dispose();r.clear();}}
 function rebuild(){fit=resolveFit();clear();equipment();cargo();refrigerator();setVisible(visible);}
 function setLayout(items=[],options={}){const nextExtended=options.extended??extended,nextOversized=options.oversized??null;
  if(nextOversized!==null&&nextOversized!=='fridge')throw Error('未知超大件预览');
  const next=validateCargoLayout(items,nextExtended);if(nextOversized&&next.length)throw Error('冰箱独占背负装备，请先卸下包裹');
  if(nextExtended===extended&&nextOversized===oversized&&JSON.stringify(next)===JSON.stringify(current))return snapshot();current=next;extended=nextExtended;oversized=nextOversized;rebuild();return snapshot();}
 function setVisible(value){visible=!!value;for(const r of roots)r.visible=visible;}
 function snapshot(){return{visible,extended,oversizedPreview:oversized?{...FRIDGE_PREVIEW}:null,backCells:extended?12:8,usedBackCells:current.filter(p=>p.dock==='back').reduce((n,p)=>n+CARGO_SIZES[p.size][0]*CARGO_SIZES[p.size][1],0),count:current.length,load:cargoLoad(current,extended),items:current.map(p=>({...p})),drawCalls:roots.reduce((n,r)=>n+r.children.length,0)};}
 function dispose(){if(disposed)return;disposed=true;clear();for(const r of roots)r.removeFromParent();material.dispose();}
 rebuild();return{setLayout,setVisible,snapshot,dispose,roots,get fit(){return fit;}};
}
