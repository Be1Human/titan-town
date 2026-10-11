import {expandSkinPixels} from './skin-file.js';
// Unfolded cuboid UV rectangles for the 64x64 skin layout, including both
// caps. Negative-X is the right limb seen on the left of a front view.
// Base and outer-layer rectangles are separate.
export function skinFace(name,face,slim=true,outer=false){
 const arm=slim?3:4;
 const parts={head:[0,0,8,8,8,32,0],spine:[16,16,8,12,4,16,32],leftShoulder:[40,16,arm,12,4,40,32],rightShoulder:[32,48,arm,12,4,48,48],leftHip:[0,16,4,12,4,0,32],rightHip:[16,48,4,12,4,0,48]};
 const [bx,by,w,h,d,ox,oy]=parts[name],x=outer?ox:bx,y=outer?oy:by;
 return [[x+d+w,y+d,d,h],[x,y+d,d,h],[x+d,y,w,d],[x+d+w,y,w,d],[x+d,y+d,w,h],[x+d+w+d,y+d,w,h]][face];
}
// Only user-supplied indexed skins (appearance.customSkin) are sampled here;
// the default skin is drawn procedurally in slim-skin.js.
export function skinPixels(custom){return custom?expandSkinPixels(custom):new Uint8ClampedArray(64*64*4);}
export function skinSlim(custom){return custom?.slim??true;}
export function sampleSkin(name,face,u,v,custom,layer='composite'){
 const colors=[false,true].map(outer=>{const[x,y,w,h]=skinFace(name,face,custom.slim,outer),at=(y+Math.max(0,Math.min(h-1,Math.floor(v*h))))*64+x+Math.max(0,Math.min(w-1,Math.floor(u*w))),n=parseInt(custom.pixels.slice(at*2,at*2+2),16)*8;return [0,2,4,6].map(i=>parseInt(custom.palette.slice(n+i,n+i+2),16));});
 const[base,over]=colors,alpha=over[3]/255;return '#'+base.slice(0,3).map((c,i)=>Math.round(layer==='base'?c:c*(1-alpha)+over[i]*alpha).toString(16).padStart(2,'0')).join('');
}
