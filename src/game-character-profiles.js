import {CREW_CHARACTER_PRESETS,normalizeAppearance} from './character-config.js';

// Every production identity uses the same original body. Townsfolk differ by
// clothing and hair colours painted on the procedural skin.
export const STANDARD_GAME_APPEARANCE=CREW_CHARACTER_PRESETS[0].appearance;
export const GAME_ROLE_COLORS=Object.freeze({
 patrol:{bodyColor:'#5d6f8c',outfitColor:'#3f4a5c',hairColor:'#2b2b2b',hair:'short'},
 mechanic:{bodyColor:'#9a5a3c',outfitColor:'#5b4a36',hairColor:'#6b3f23'},
 porter:{bodyColor:'#6f8a5a',outfitColor:'#4a5a3a',hairColor:'#3a3226'},
 scout:{bodyColor:'#8a7a4a',outfitColor:'#d7b98e',hairColor:'#8c5a2b',hair:'short'},
 medic:{bodyColor:'#d9d2c0',outfitColor:'#a8483c',hairColor:'#1f1f1f'},
});
export function roleAppearance(role){return normalizeAppearance({...STANDARD_GAME_APPEARANCE,...GAME_ROLE_COLORS[role]});}
export function normalizeGameAppearance(input){
 const a=normalizeAppearance(input,STANDARD_GAME_APPEARANCE);
 if(a.template==='crew-01'&&a.silhouette==='human')return a;
 return normalizeAppearance({...STANDARD_GAME_APPEARANCE,width:a.width,height:a.height,...(a.customSkin?{customSkin:a.customSkin}:{})});
}
