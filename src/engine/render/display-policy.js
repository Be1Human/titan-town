// Reduce expensive lighting separately from the visible raster. Hardware low
// quality must not turn a 1080p viewport into a stretched 810p picture.
export function displayPixelRatio({width,height,devicePixelRatio=1,high=true,software=false}){
 const budget=2073600;
 const ratio=Math.min(devicePixelRatio,high?1.25:1,Math.sqrt(budget/(Math.max(1,width)*Math.max(1,height))));
 return ratio*(software&&!high?.75:1);
}

export function verticalFovForAspect(aspect,horizontal=90){
 return 2*Math.atan(Math.tan(horizontal*Math.PI/360)/aspect)*180/Math.PI;
}
