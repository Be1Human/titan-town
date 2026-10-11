// WebGL receives the tight dirty region, rather than a view over the full
// lighting atlas. Channel values and XYZ layout remain byte-for-byte identical.
export function packVolumeRegion(source,size,channels,{min,max},target){
  const [w,h,d]=max.map((n,a)=>n-min[a]),length=w*h*d*channels;
  if(w<=0||h<=0||d<=0||length>target.length||min.some((n,a)=>!Number.isInteger(n)||n<0||max[a]>size[a]))throw Error('Invalid volume upload region');
  let write=0;const row=w*channels;
  for(let z=min[2];z<max[2];z++)for(let y=min[1];y<max[1];y++){
    const start=(min[0]+size[0]*(y+size[1]*z))*channels;
    target.set(source.subarray(start,start+row),write);write+=row;
  }
  return {data:target.subarray(0,length),width:w,height:h,depth:d};
}

// The bundled Three copy path queries five UNPACK parameters for every copy.
// On ANGLE these readbacks can wait behind earlier GPU draws. Track actual
// pixelStorei writes instead, and scope the cached queries to our own copies.
const trackers=new WeakMap();
export class PackedVolumeUploader{
  constructor(renderer){
    this.renderer=renderer;const gl=this.gl=renderer.getContext?.();if(!gl)return;let tracker=trackers.get(gl);
    if(!tracker){
      const names=['UNPACK_ROW_LENGTH','UNPACK_IMAGE_HEIGHT','UNPACK_SKIP_PIXELS','UNPACK_SKIP_ROWS','UNPACK_SKIP_IMAGES','UNPACK_ALIGNMENT','UNPACK_FLIP_Y_WEBGL','UNPACK_PREMULTIPLY_ALPHA_WEBGL'];
      const values=new Map(names.map(name=>[gl[name],gl.getParameter(gl[name])])),original=gl.pixelStorei;
      const wrapped=function(parameter,value){original.call(gl,parameter,value);if(values.has(parameter))values.set(parameter,value);};
      tracker={values,original,wrapped,users:0};trackers.set(gl,tracker);gl.pixelStorei=wrapped;
    }
    this.tracker=tracker;tracker.users++;
  }
  copy(source,target,region,position){
    if(!this.tracker)return this.renderer.copyTextureToTexture(source,target,region,position);
    const gl=this.gl,values=this.tracker.values,saved=new Map(values),query=gl.getParameter;
    gl.getParameter=function(parameter){return values.has(parameter)?values.get(parameter):query.call(gl,parameter);};
    try{return this.renderer.copyTextureToTexture(source,target,region,position);}
    finally{gl.getParameter=query;for(const [parameter,value]of saved)if(values.get(parameter)!==value)gl.pixelStorei(parameter,value);}
  }
  dispose(){const tracker=this.tracker;if(!tracker)return;this.tracker=null;if(--tracker.users===0){if(this.gl.pixelStorei===tracker.wrapped)this.gl.pixelStorei=tracker.original;trackers.delete(this.gl);}}
}
