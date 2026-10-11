// Bounded, indexed 64x64 skin data; serializable with an appearance in a room.
// Source PNGs are decoded by the browser, never used as external texture URLs.
export function indexSkinPixels(rgba,{slim=true}={}){
 if(rgba.length!==64*64*4)throw Error('请选择 64 × 64 的 PNG 皮肤。');
 const colors=new Map();let palette='',pixels='';
 for(let i=0;i<rgba.length;i+=4){const color=Array.from(rgba.slice(i,i+4),n=>n.toString(16).padStart(2,'0')).join('');if(!colors.has(color)){if(colors.size===256)throw Error('皮肤最多使用 256 种颜色，请使用像素绘图模式保存。');colors.set(color,colors.size);palette+=color;}pixels+=colors.get(color).toString(16).padStart(2,'0');}
 return {palette,pixels,slim};
}
export function expandSkinPixels(custom){
 const data=new Uint8ClampedArray(64*64*4);for(let i=0;i<4096;i++){const at=parseInt(custom.pixels.slice(i*2,i*2+2),16)*8;for(let c=0;c<4;c++)data[i*4+c]=parseInt(custom.palette.slice(at+c*2,at+c*2+2),16);}return data;
}
