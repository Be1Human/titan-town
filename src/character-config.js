// This module is deliberately independent of rendering and the DOM so the
// exact same appearance validation can run in the multiplayer server.
import {CREW_SPECS} from './crew-character-specs.js';
import {SLIM_SKINS} from './skin-catalog.js';
export const DEFAULT_APPEARANCE=Object.freeze({
  bodyColor:'#c78550',hatColor:'#efba36',outfitColor:'#d7b98e',gloveColor:'#e1a679',faceColor:'#e1a679',hairColor:'#3a3226',eyeColor:'#33a6b8',
  width:1,height:1,faceSize:1,armSize:1,
  torsoWidth:1,torsoHeight:1,torsoDepth:1,shoulderWidth:1,headWidth:1,headHeight:1,
  armLength:1,gloveSize:1,legLength:1,legWidth:1,bootSize:1,hatWidth:1,hatHeight:1,eyeSpacing:1,eyeSize:1,facePosition:1,
  hat:'none',hair:'swept',outfit:'plain',prop:'hammer',expression:'neutral',faceStyle:'source',silhouette:'human',template:'reference-male',skin:'rookie',voxelEdits:Object.freeze([]),
});

const COLORS=['bodyColor','hatColor','outfitColor','gloveColor','faceColor','hairColor','eyeColor'];
// Compact local cell coordinates keep edited geometry attached to its joint.
export const CHARACTER_CELL=.025;
export const MAX_VOXEL_EDITS=256;
export const CHARACTER_PARTS=Object.freeze(['spine','head','leftShoulder','leftElbow','leftWrist','rightShoulder','rightElbow','rightWrist','leftHip','leftKnee','leftFoot','rightHip','rightKnee','rightFoot']);
export const CHARACTER_PART_LABELS=Object.freeze(['躯干','头部 / 头发','左上臂','左前臂','左手','右上臂','右前臂','右手','左大腿','左小腿','左脚','右大腿','右小腿','右脚']);
export const APPEARANCE_RANGES=Object.freeze({width:[.8,1.25],height:[.85,1.15],faceSize:[.8,1.2],armSize:[.8,1.2],torsoWidth:[.55,1.55],torsoHeight:[.65,2.1],torsoDepth:[.65,1.4],shoulderWidth:[.75,1.4],headWidth:[.65,1.3],headHeight:[.65,1.4],armLength:[.55,1.8],gloveSize:[.65,1.6],legLength:[.55,1.9],legWidth:[.65,1.45],bootSize:[.7,1.4],hatWidth:[.8,1.4],hatHeight:[.55,1.45],eyeSpacing:[.65,1.45],eyeSize:[.65,1.4],facePosition:[.75,1.25]});
const RANGES=APPEARANCE_RANGES;
const CHOICES={hat:['hardhat','cap','none'],hair:['swept','short','ponytail','none'],outfit:['plain','overalls','vest','satchel'],prop:['signature','hammer','ingot','clipboard','tape','none'],expression:['neutral','happy','surprised','angry','worried'],faceStyle:['cut-block','source'],silhouette:['human','rounded'],template:['reference-male','reference-female','procedural',...CREW_SPECS.map(s=>s.id)]};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const color=value=>typeof value==='string'&&/^#[\da-f]{6}$/i.test(value)?value.toLowerCase():null;

export function normalizeVoxelEdits(value){
  if(!Array.isArray(value))return [];
  const cells=new Map();
  for(const edit of value.slice(0,MAX_VOXEL_EDITS*2)){
    if(!Array.isArray(edit)||edit.length!==5)continue;
    const [part,x,y,z,paint]=edit;
    if(!Number.isInteger(part)||part<0||part>=CHARACTER_PARTS.length||![x,y,z].every(n=>Number.isInteger(n)&&Math.abs(n)<=32))continue;
    if(paint!==null&&!color(paint))continue;
    cells.set([part,x,y,z].join(','),[part,x,y,z,paint===null?null:color(paint)]);
  }
  return [...cells.values()].slice(0,MAX_VOXEL_EDITS).sort((a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2]||a[3]-b[3]);
}

export function normalizeAppearance(input,fallback=DEFAULT_APPEARANCE){
  input=object(input);fallback=object(fallback);const result={};
  for(const key of COLORS)result[key]=color(input[key])||color(fallback[key])||DEFAULT_APPEARANCE[key];
  for(const [key,[min,max]]of Object.entries(RANGES)){
    const candidate=Number.isFinite(input[key])?input[key]:Number.isFinite(fallback[key])?fallback[key]:DEFAULT_APPEARANCE[key];
    result[key]=Math.max(min,Math.min(max,candidate));
  }
  for(const [key,values]of Object.entries(CHOICES))result[key]=values.includes(input[key])?input[key]:values.includes(fallback[key])?fallback[key]:DEFAULT_APPEARANCE[key];
  result.skin=SLIM_SKINS.some(s=>s.id===input.skin)?input.skin:SLIM_SKINS.some(s=>s.id===fallback.skin)?fallback.skin:'rookie';
  result.voxelEdits=normalizeVoxelEdits(input.voxelEdits??fallback.voxelEdits);
  const custom=input.customSkin===null?null:input.customSkin??(input.skin!==undefined?null:fallback.customSkin);
  if(custom&&typeof custom.palette==='string'&&custom.palette.length>=8&&custom.palette.length<=2048&&custom.palette.length%8===0&&/^[0-9a-f]+$/i.test(custom.palette)&&typeof custom.pixels==='string'&&custom.pixels.length===8192&&/^[0-9a-f]+$/i.test(custom.pixels)){
    const count=custom.palette.length/8;let valid=true;for(let i=0;i<8192;i+=2)if(parseInt(custom.pixels.slice(i,i+2),16)>=count){valid=false;break;}
    if(valid)result.customSkin={palette:custom.palette.toLowerCase(),pixels:custom.pixels.toLowerCase(),slim:custom.slim!==false};
  }
  if(result.template==='crew-01'&&result.silhouette==='human'){result.prop='none';result.faceStyle='source';}
  return result;
}

export function appearanceKey(input){return JSON.stringify(normalizeAppearance(input));}

export const CHARACTER_PRESETS=Object.freeze([
  {id:'orange-builder',name:'原图 · 棕发男生',description:'按三视图重建层叠棕发，保留修长四肢与宽眼睛。',appearance:{...DEFAULT_APPEARANCE}},
  {id:'mint-carrier',name:'原图 · 橘发女生',description:'原始橘发、浅色袖子、蓝色服装与黑色腰带。',appearance:{...DEFAULT_APPEARANCE,template:'reference-female',bodyColor:'#bdc0ba',outfitColor:'#577c8a',hairColor:'#c1693c',hair:'ponytail',outfit:'overalls',prop:'ingot'}},
  {id:'yellow-inspector',name:'安全检查员',description:'保留修长身形，配安全帽与反光背心。',appearance:{...DEFAULT_APPEARANCE,template:'procedural',bodyColor:'#d79445',outfitColor:'#a8b766',gloveColor:'#6b6955',hat:'hardhat',hair:'short',outfit:'vest',prop:'clipboard'}},
  {id:'purple-surveyor',name:'工具师傅',description:'深色短发、紫色外套和斜挎工具袋。',appearance:{...DEFAULT_APPEARANCE,template:'procedural',bodyColor:'#847093',outfitColor:'#6a5541',hairColor:'#343b3e',hair:'short',eyeColor:'#648f73',outfit:'satchel',prop:'tape'}},
  ...CREW_SPECS.map(s=>({id:s.id,name:`${s.number} · ${s.name}`,description:s.description,appearance:{...DEFAULT_APPEARANCE,template:s.id,bodyColor:s.body,outfitColor:s.outfit,hairColor:s.hair,faceColor:'#efb581',gloveColor:'#efb581',eyeColor:s.id==='crew-03'?'#42556a':'#218e9b',hatColor:'#b1b5b6',hair:s.id==='crew-08'?'ponytail':'swept',outfit:s.costume==='jacket'?'satchel':s.costume==='shirt'?'plain':s.costume,prop:s.id==='crew-01'?'none':'signature',expression:s.expression}})),
].map(preset=>Object.freeze({...preset,appearance:Object.freeze(normalizeAppearance(preset.appearance))})));
export const CREW_CHARACTER_PRESETS=Object.freeze(CHARACTER_PRESETS.filter(p=>p.id.startsWith('crew-')));
