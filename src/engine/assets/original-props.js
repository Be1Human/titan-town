// Original procedural models authored for this project.
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
function builder(cellSize=.05){
  const cells=new Map();
  const set=(x,y,z,mat)=>cells.set(`${x},${y},${z}`,{x,y,z,mat});
  const box=(x,y,z,w,h,d,mat)=>{for(let yy=y;yy<y+h;yy++)for(let zz=z;zz<z+d;zz++)for(let xx=x;xx<x+w;xx++)set(xx,yy,zz,mat);};
  return {cellSize,set,box,finish:()=>[...cells.values()]};
}
export function createOriginalPlank({length=4.8,width=.55,thickness=.15,cellSize=.05}={}){
  const b=builder(cellSize),l=Math.round(length/cellSize),w=Math.round(width/cellSize),h=Math.max(2,Math.round(thickness/cellSize));
  for(let z=0;z<l;z++)for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    if((z===0||z===l-1)&&(x===0||x===w-1))continue;
    b.set(x,y,z,(x===0||x===w-1)&&y===0?'darkwood':'wood');
  }
  return {cells:b.finish(),cellSize};
}
export function createOriginalLog({length=5.9,radius=.28,cellSize=.05,seed=31}={}){
  const b=builder(cellSize),r=radius/cellSize,l=Math.round(length/cellSize);
  for(let z=0;z<l;z++){
    const taper=1-.09*z/Math.max(1,l-1),offset=Math.sin(z*.032+seed)*.45;
    for(let y=-Math.ceil(r);y<=Math.ceil(r);y++)for(let x=-Math.ceil(r);x<=Math.ceil(r);x++){
      const d=Math.hypot(x+.5-offset,y+.5),limit=r*taper;
      if(d>limit)continue;
      b.set(x,y,z,d>limit-1||((z+seed)%19===0&&x>r*.4)?'darkwood':'wood');
    }
  }
  return {cells:b.finish(),cellSize};
}
export function createOriginalPallet({cellSize=.05}={}){
  const b=builder(cellSize),w=Math.round(1.7/cellSize),d=Math.round(1.15/cellSize);
  for(const x of [0,Math.floor(w/2)-1,w-3])b.box(x,0,0,3,5,d,'darkwood');
  for(let z=0;z<d;z+=5)b.box(0,5,z,w,2,Math.min(4,d-z),'wood');
  return {cells:b.finish(),cellSize};
}
export function createOriginalCrate({cellSize=.05}={}){
  const b=builder(cellSize),w=19,h=15,d=17;
  b.box(0,0,0,w,2,d,'wood');
  for(let y=2;y<h;y++)for(let z=0;z<d;z++)for(let x=0;x<w;x++){
    if(x>1&&x<w-2&&z>1&&z<d-2)continue;
    b.set(x,y,z,y===h-1||y%6===0?'darkwood':'wood');
  }
  return {cells:b.finish(),cellSize};
}
export function originalYardProps(){
  return [
    {id:'yard-log',name:'待加工的长树干',...createOriginalLog(),position:{x:-4.8,y:1.13,z:9.4},density:.4,strength:1},
    {id:'yard-plank-1',name:'细木板',...createOriginalPlank(),position:{x:5.5,y:1.87,z:8.4},density:.4,strength:1},
    {id:'yard-plank-2',name:'细木板',...createOriginalPlank(),position:{x:6.15,y:1.87,z:8.4},density:.4,strength:1},
    {id:'yard-pallet',name:'搬运托盘',...createOriginalPallet(),position:{x:7.9,y:.995,z:12.3},density:.5,strength:1.25},
    {id:'yard-crate',name:'空木箱',...createOriginalCrate(),position:{x:6,y:1.21,z:13.4},density:.5,strength:1},
  ];
}
export function installOriginalProps(physics,props=[]){
  const admitted=[],rejected=[];
  for(const prop of props){
    if(physics.entries.has(prop.id))continue;
    const entry=physics.addPersistent(prop.cells,{...prop,cellSize:clamp(prop.cellSize??.05,.025,.4)});
    if(entry){entry.name=prop.name;admitted.push(entry);}else rejected.push(prop.id);
  }
  return {admitted,rejected};
}
