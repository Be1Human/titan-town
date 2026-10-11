# Titan Town Requirements and Design

**English** | [简体中文](DESIGN.zh-CN.md)

## 1. Goals

Build a "medieval town enclosed by high walls" on a voxel destruction engine, in a style that pays homage to the giants genre:

- Buildings, walls and props are all static voxels that tools and titans can cut away; disconnected parts go through support checks and collapse, and the debris becomes rigid bodies.
- Ground titans see, hear and tear houses apart; an ape on the wall throws stones; the player moves with grapple gear (hook swinging + gas jets).
- Gameplay is 7 missions within 3 lives (fetch supplies, find documents, rescue a villager, light the signal smoke, slay the titans, seal the gate breach, reclaim the wall); the more missions are completed, the higher the grade.
- Copyright boundary: a style homage only; no official characters, names, models or textures; every asset is CC0 / CC BY with its source recorded (see `THIRD_PARTY.md`). The project is not affiliated with any official work.

## 2. Architecture

Pure browser ES modules with no bundler; `server.js` is a zero-dependency static server (path allow-list).

| Layer | Location | Notes |
| --- | --- | --- |
| Voxel world | `src/voxel-world.js`, `src/engine/core` | 32³ chunks, 10 cm cells; materials, health and support checks; one occupancy drives display, collision, destruction and shadowing |
| Destruction and collapse | `src/engine/physics`, `src/rigid-fracture.js`, `src/support*.js` | Removes the actual voxels and patches hole walls; support is computed in a worker; disconnected chunks become rigid bodies |
| Physics | `src/rigid-world.js`, `vendor/rapier.js` | Rapier WASM (SIMD) manages rigid bodies and collisions; voxel fracture, damage and support are implemented by this project |
| Rendering | `src/render.js`, `src/lighting.js`, `src/engine/render` | three.js; voxel meshes, a voxel light volume, shadow caches and tone mapping; a visible fallback is kept on failure |
| Scene assets | `src/engine/assets/scene-assets.js`, `assets/` | The scene JSON references prefabs, prefabs reference voxel models and a named palette; `import.json` records third-party sources |
| Town and gameplay | `src/titan-town.js`, `titan-ai.js`, `titan-model.js`, `titan-missions.js`, `titan-campaign.js`, `grapple-gear.js`, `wall-ape.js`, `far-wall.js`, `titan-atmosphere.js` | Scene factory, titan AI (view cone / hearing / wandering / chasing / wall climbing), titan skeletal animation, missions and grading, grapple gear |
| UI | `game.html`, `src/game.js`, `src/i18n.js` | Menu, HUD, map, pause, saves (IndexedDB); English / Simplified Chinese text through a small dictionary module |

## 3. Key design decisions

- **One occupancy**: walls, floors and foundations have real volume (at least 3 cells thick) and room air is kept explicitly; display, collision, destruction and shadowing read the same voxels.
- **Local destruction**: keep the complete original surface, cut away only the cells that were actually removed and patch the hole walls; neighboring chunks, shadow and lighting caches are invalidated together.
- **Titan perception**: a view cone plus noise (destruction, explosions, sprinting) triggers detection; breaking line of sight or hiding in a house shakes them off; titans use skeletal hit volumes and the nape is the weak point.
- **Grapple**: the hook is swept in segments every frame and hits static voxels (DDA), rigid debris or titan bones; it detaches immediately when its anchor is destroyed, the anchor cell of a debris chunk disappears, or the titan falls.
- **Assets**: buildings and props are voxelized and modified CC0 models; the titan skeleton comes from a CC0 humanoid animation library, and proportions, facial features, hair and variants are generated at runtime.
- **Saves**: only the necessary state is stored (voxel differences, mission progress, lives); keys are namespaced per map.
- **Languages**: source strings are Chinese and double as dictionary keys in `src/i18n.js`; the language comes from `?lang=en|zh`, then the saved menu choice, then `navigator.language`. Gameplay logic never depends on the language.

## 4. Out of scope

Multiplayer, a character editor, multiple maps, VOX import, packaging as a desktop app.
