import {MATERIAL_IDS,CELL} from '../../voxel-world.js';
// The collider and source removal wait for an exact visible surface. This
// worker changes scheduling only; it runs the same surface and palette kernels.
export class CollapseVisualPreparation{
  constructor({workerFactory=()=>new Worker(new URL('./collapse-visual-worker.js',import.meta.url),{type:'module'})}={}){
    this.pending=new Map();this.sequence=0;this.stats={prepared:0,workerMs:0,errors:0,lastError:null};
    try{this.worker=workerFactory();this.worker.onmessage=({data})=>{const token=this.pending.get(data.id);if(!token)return;this.pending.delete(data.id);if(data.error)this.fail(token,data.error);else{token.geometry=data.geometry;token.state='ready';this.stats.prepared++;this.stats.workerMs+=data.workerMs;}};this.worker.onerror=event=>{this.stats.lastError=event.message||'Geometry worker failed';for(const token of this.pending.values())this.fail(token,this.stats.lastError);this.pending.clear();this.worker.terminate();this.worker=null;};}
    catch(error){this.stats.lastError=error.message;this.worker=null;}
  }
  fail(token,message){token.state='failed';token.error=message;this.stats.errors++;this.stats.lastError=message;}
  *prepare(cells,center,cellSize=CELL,palette){
    if(!this.worker)return {state:'failed',error:this.stats.lastError};
    const packed=new Int32Array(cells.length*6);
    for(let i=0;i<cells.length;i++){const c=cells[i],j=i*6;packed[j]=c.x;packed[j+1]=c.y;packed[j+2]=c.z;packed[j+3]=MATERIAL_IDS[c.mat];packed[j+4]=c.paletteIndex??0;packed[j+5]=c.sourceShape??0;if((i+1)%256===0)yield 'visual-packing';}
    const token={id:++this.sequence,owner:this,state:'waiting',started:performance.now()};this.pending.set(token.id,token);
    try{this.worker.postMessage({id:token.id,packed,center,cellSize,palette},[packed.buffer]);}catch(error){this.pending.delete(token.id);this.fail(token,error.message);}return token;
  }
  poll(token){if(token.state==='waiting'&&performance.now()-token.started>10000){this.pending.delete(token.id);this.fail(token,'Geometry worker timed out; using visible mesh fallback');}return token.state;}
  cancel(token){if(!token)return;this.pending.delete(token.id);token.geometry=null;token.state='cancelled';}
  clear(){for(const token of this.pending.values())this.cancel(token);this.pending.clear();}
  dispose(){this.clear();this.worker?.terminate();this.worker=null;}
}
