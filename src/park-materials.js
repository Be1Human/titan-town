import {MATERIAL_KEYS} from './voxel-world.js';
import {styleVoxelMaterial} from './voxel-material.js';

// Match the reference's integer palette sampling, while retaining the park's
// own colours. This is surface colour, not a sharpening or edge filter.
export const PARK_CELL_COLOR_GLSL=`
 float parkCellHash(vec3 p){p=fract(p*.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);}
 vec3 parkCellColor(vec3 palette,vec3 point,vec3 face,float cell,float profile,float strength){
  vec3 grid=floor(point/max(cell,.001)-normalize(face)*.15);
  vec2 tile=abs(face.y)>.5?grid.xz:abs(face.x)>.5?grid.zy:grid.xy;
  vec2 surface=abs(face.y)>.5?point.xz:abs(face.x)>.5?point.zy:point.xy;
  vec2 footprint=max(fwidth(surface),vec2(.0001));
  // Related source cells share pigment. Independent noise at every cell turns
  // subpixel foliage and paths into grain instead of readable voxel clusters.
  float pigment=floor(parkCellHash(vec3(floor(tile/3.),37.))*5.)/4.;
  if(profile>.5&&profile<1.5){
   // Long, discrete fibres stay connected over several cells.
   vec2 fibre=vec2(floor(tile.x/2.),floor(tile.y/12.));
   pigment=floor(parkCellHash(vec3(fibre,7.))*6.)/5.;
  }else if(profile>1.5&&profile<2.5){
   vec2 brick=surface;brick.x+=mod(floor(brick.y/.2),2.)*.25;
   vec2 fraction=fract(brick/vec2(.5,.2));
   vec2 edge=min(fraction,1.-fraction)*vec2(.5,.2);
   float joint=max(1.-smoothstep(.009-footprint.x,.009+footprint.x,edge.x),1.-smoothstep(.009-footprint.y,.009+footprint.y,edge.y));
   pigment=floor(parkCellHash(vec3(floor(brick/vec2(.5,.2)),23.))*5.)/4.;
   return mix(palette*mix(1.-strength,1.,pigment),vec3(.25,.24,.21),joint*.8);
  }
  return palette*mix(1.-strength,1.,pigment);
 }
`;

export function applyParkMaterials(bank,profiles){
 for(let i=1;i<bank.length;i++){
  const material=bank[i],id=MATERIAL_KEYS[i],profile=profiles[id]?.appearance;if(!material||!profile)continue;
  material.roughness=profile.roughness;material.metalness=profile.metalness;
  styleVoxelMaterial(material,{cell:.1,grain:profile.grain,wood:['wood','darkwood'].includes(id),profile:['wood','darkwood'].includes(id)?'wood':id==='brick'?'brick':'plain'});
  const cellCompile=material.onBeforeCompile,cellKey=material.customProgramCacheKey();
  const pigmentStrength=({leaf:.32,plaster:.10,stone:.16,brick:.18,concrete:0,wood:.28,darkwood:.28,roof:.12,metal:.03,rust:.08,dark:.03,glass:0,fuel:.03})[id]??.08;
  material.onBeforeCompile=function(shader,renderer){
   cellCompile.call(this,shader,renderer);
   shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\n'+PARK_CELL_COLOR_GLSL)
    .replace(/diffuseColor\.rgb=voxelFinishColor\([^;]+;/,'diffuseColor.rgb=parkCellColor(diffuseColor.rgb,voxelPoint,voxelNormal,voxelCell,'+material.userData.voxelStyle.finishProfile.toFixed(1)+','+pigmentStrength.toFixed(3)+');');
  };
  material.customProgramCacheKey=()=>cellKey+'-park-integer-palette-v4-'+pigmentStrength;
  material.userData.parkFinish={sampling:'integer-cell',filter:'nearest',detailFade:false};
  if(id==='concrete'){
   const compile=material.onBeforeCompile,key=material.customProgramCacheKey();
   material.onBeforeCompile=shader=>{compile(shader);shader.fragmentShader=shader.fragmentShader.replace('normal=voxelShoulderNormal',`if(voxelFace.y>.5){vec2 paver=voxelPoint.xz;float row=floor(paver.y/.3);paver.x+=mod(row,2.)*.3;vec2 tile=floor(paver/vec2(.6,.3));vec2 edge=min(fract(paver/vec2(.6,.3)),1.-fract(paver/vec2(.6,.3)))*vec2(.6,.3);vec2 footprint=max(fwidth(paver),vec2(.0001));float joint=max(1.-smoothstep(.006-footprint.x,.006+footprint.x,edge.x),1.-smoothstep(.006-footprint.y,.006+footprint.y,edge.y));float shade=.88+.12*voxelHash(vec3(tile,57.));diffuseColor.rgb*=shade*(1.-joint*.15);}\nnormal=voxelShoulderNormal`);};
   material.customProgramCacheKey=()=>key+'-park-pavers-v1';
  }
  material.userData.authorship='project-original-park';
 }
}
