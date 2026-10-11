// Authoring proportions stay unchanged; production actors use metre-scale
// bodies large enough to read beside the game's doors, furniture and cargo.
export const GAME_CHARACTER_SCALE=1.25;
export const gameCharacterScale=appearance=>appearance?.template==='crew-01'&&appearance?.silhouette==='human'?GAME_CHARACTER_SCALE:1;
