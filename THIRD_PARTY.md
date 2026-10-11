# Third-party sources and licenses

**English** | [简体中文](THIRD_PARTY.zh-CN.md)

The license of this repository's code is in `LICENSE` (kept in English). It **does not cover** the third-party content below, which remains under its original licenses.

## Runtime dependencies (`vendor/`)

| Name | Version | License | Source | Notes |
| --- | --- | --- | --- | --- |
| three.js | 0.180 | MIT (`vendor/THREE-LICENSE.txt`) | <https://github.com/mrdoob/three.js> | Contains one local patch, see `vendor/THREE-PATCHES.md` |
| Rapier (`@dimforge/rapier3d-simd-compat`) | 0.21.0 | Apache-2.0 (`vendor/RAPIER-LICENSE.txt`) | <https://github.com/dimforge/rapier> | Unmodified; checksums in `vendor/RAPIER-NOTICE.md` |

## Model and animation assets

The buildings, props and titan skeleton in the scene were converted (voxelized, recolored, recombined) from the CC0 packs below. The original files are not distributed with the repository; the original license texts are in `licenses/`, and per-file SHA-256 values are in `assets/voxel-models/titan-town/import.json`.

| Pack | Author | License | Page | Archive SHA-256 |
| --- | --- | --- | --- | --- |
| LowPoly Medieval Village Pack (Dec 2020) | Quaternius | CC0 1.0 | <https://opengameart.org/content/lowpoly-medieval-village-pack> | `c38d8632c3c883043809a5db9b2f47b7033e298ab4bd073bb5c29ad323df60fc` |
| Fantasy Town Kit 2.0 | Kenney (www.kenney.nl) | CC0 1.0 | <https://opengameart.org/content/fantasy-town-kit> | `1a7530c09f4d2fa2cdee259876f089334f8b1f27fa86a0c4f54ef86cdd8676ef` |
| Universal Animation Library [Standard] | Quaternius | CC0 1.0 | <https://opengameart.org/content/universal-animation-library> | `18ff1a7215f4852b320203e8aaf02a1578b5c8eef9027fbaedfcedc7b85a3ac2` |

The titan skeleton and animation clips come from `AnimationLibrary_Godot_Standard.glb` in the third pack (SHA-256 `1b7bf67866360665426bb99e4c71bd619f19b408453c24e30f0c3071601eee5c`). The converted result is `assets/characters/titan-rig/titan-rig.json`, and the modifications are recorded in that file's `source.modifications` field. The titans' proportions, facial features, hair and variants are generated procedurally at runtime.

## Character voxel base models (attribution required)

The two player / townsperson voxel base models in `src/reference-people-data.js` are based on *Voxel Character Models (.vox)* by JoshMckay:

- Author: JoshMckay
- Source: <https://opengameart.org/content/voxel-character-models-vox>
- License: Creative Commons Attribution 4.0 International (CC BY 4.0), <https://creativecommons.org/licenses/by/4.0/>
- Files used: `chr_peasant_guy_blackhair.vox` (SHA-256 `0c8786df831393d4b3e6ba7923b62154de0864f22f48009523f43e1cafb758f2`), `chr_peasant_girl_orangehair.vox` (SHA-256 `7a35c27f6ea5aa3d336b22524ee6be1cc63c9fd29640b94245be1dc58979f769`)
- Modifications: converted to JSON voxel data, rebuilt hair, lowered the head, added joints, animation and vertex occlusion; each character's clothing colors are assigned procedurally by profession.

## Original content

The town layout, titan AI, grapple gear, mission and campaign rules, voxel engine, rendering pipeline, sound synthesis and all UI text are original to this project. The project is a style homage only and uses no names, characters, designs, logos, models, textures or audio from any official work; it is not affiliated with any official work.
