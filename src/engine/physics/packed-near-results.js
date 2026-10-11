// Project transport layout, not the native 0x48 ABI: indices, normal XYZ,
// position XYZ, penetration, fast flag. Float64 preserves existing scalar
// values (including signed zero) without per-contact object-graph cloning.
export const NEAR_RESULT_STRIDE=10;
export class PackedNearResults {
  constructor(){this.values=new Float64Array(NEAR_RESULT_STRIDE*256);this.count=0;this.pairs=[];}
  begin(index){this.pairs.push(index,this.count,0);}
  push(indexA,indexB,nx,ny,nz,px,py,pz,penetration,fast){
    const at=this.count*NEAR_RESULT_STRIDE;if(at+NEAR_RESULT_STRIDE>this.values.length){const next=new Float64Array(this.values.length*2);next.set(this.values);this.values=next;}
    this.values[at]=indexA;this.values[at+1]=indexB;this.values[at+2]=nx;this.values[at+3]=ny;this.values[at+4]=nz;this.values[at+5]=px;this.values[at+6]=py;this.values[at+7]=pz;this.values[at+8]=penetration;this.values[at+9]=fast?1:0;this.count++;
  }
  end(){this.pairs[this.pairs.length-1]=this.count-this.pairs[this.pairs.length-2];}
  append(values){if(values.length%NEAR_RESULT_STRIDE)throw Error('Invalid bulk near result');const needed=this.count*NEAR_RESULT_STRIDE+values.length;if(needed>this.values.length){let length=this.values.length;while(length<needed)length*=2;const next=new Float64Array(length);next.set(this.values);this.values=next;}this.values.set(values,this.count*NEAR_RESULT_STRIDE);this.count+=values.length/NEAR_RESULT_STRIDE;}
  finish(){return{pairs:Uint32Array.from(this.pairs),values:this.values.subarray(0,this.count*NEAR_RESULT_STRIDE),count:this.count};}
}
export function unpackNearResults(packet){
  const {pairs,values,count}=packet;if(values.length!==count*NEAR_RESULT_STRIDE||pairs.length%3)throw Error('Invalid near result packet');const results=[];
  for(let p=0;p<pairs.length;p+=3){const index=pairs[p],start=pairs[p+1],length=pairs[p+2];if(start+length>count)throw Error('Invalid near pair range');const contacts=[];
    for(let i=start;i<start+length;i++){const at=i*NEAR_RESULT_STRIDE;contacts.push({indexA:values[at],indexB:values[at+1],normal:{x:values[at+2],y:values[at+3],z:values[at+4]},point:{x:values[at+5],y:values[at+6],z:values[at+7]},penetration:values[at+8],...(values[at+9]?{fast:true}:{})});}results.push({index,contacts});
  }return results;
}
