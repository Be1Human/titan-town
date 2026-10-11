# 第三方来源与许可证

[English](THIRD_PARTY.md) | **简体中文**

本仓库代码的许可证见 `LICENSE`（保持英文原文），**不覆盖**下列第三方内容；它们各自遵循原许可证。

## 运行时依赖（`vendor/`）

| 名称 | 版本 | 许可证 | 来源 | 说明 |
| --- | --- | --- | --- | --- |
| three.js | 0.180 | MIT（`vendor/THREE-LICENSE.txt`） | <https://github.com/mrdoob/three.js> | 含一处本地修补，见 `vendor/THREE-PATCHES.md` |
| Rapier（`@dimforge/rapier3d-simd-compat`） | 0.21.0 | Apache-2.0（`vendor/RAPIER-LICENSE.txt`） | <https://github.com/dimforge/rapier> | 未修改，校验值见 `vendor/RAPIER-NOTICE.md` |

## 模型与动画素材

场景中的建筑、道具与巨人骨骼由下列 CC0 素材包转换而来（体素化、重新着色、重新组合）。原始文件未随仓库分发；原始许可证文本在 `licenses/`，逐文件 SHA-256 在 `assets/voxel-models/titan-town/import.json`。

| 素材包 | 作者 | 许可证 | 页面 | 压缩包 SHA-256 |
| --- | --- | --- | --- | --- |
| LowPoly Medieval Village Pack (Dec 2020) | Quaternius | CC0 1.0 | <https://opengameart.org/content/lowpoly-medieval-village-pack> | `c38d8632c3c883043809a5db9b2f47b7033e298ab4bd073bb5c29ad323df60fc` |
| Fantasy Town Kit 2.0 | Kenney (www.kenney.nl) | CC0 1.0 | <https://opengameart.org/content/fantasy-town-kit> | `1a7530c09f4d2fa2cdee259876f089334f8b1f27fa86a0c4f54ef86cdd8676ef` |
| Universal Animation Library [Standard] | Quaternius | CC0 1.0 | <https://opengameart.org/content/universal-animation-library> | `18ff1a7215f4852b320203e8aaf02a1578b5c8eef9027fbaedfcedc7b85a3ac2` |

巨人骨骼与动画片段来自第三个素材包的 `AnimationLibrary_Godot_Standard.glb`（SHA-256 `1b7bf67866360665426bb99e4c71bd619f19b408453c24e30f0c3071601eee5c`），转换结果为 `assets/characters/titan-rig/titan-rig.json`，修改说明记录在该文件的 `source.modifications` 字段。巨人的比例、五官、头发和变体由运行时程序生成。

## 角色体素底模（需要署名）

`src/reference-people-data.js` 中两个玩家/镇民体素底模基于 JoshMckay 的 *Voxel Character Models (.vox)*：

- 作者：JoshMckay
- 来源：<https://opengameart.org/content/voxel-character-models-vox>
- 许可证：Creative Commons Attribution 4.0 International（CC BY 4.0），<https://creativecommons.org/licenses/by/4.0/>
- 使用的文件：`chr_peasant_guy_blackhair.vox`（SHA-256 `0c8786df831393d4b3e6ba7923b62154de0864f22f48009523f43e1cafb758f2`）、`chr_peasant_girl_orangehair.vox`（SHA-256 `7a35c27f6ea5aa3d336b22524ee6be1cc63c9fd29640b94245be1dc58979f769`）
- 修改：转为 JSON 体素数据，重建头发、下移头部、加入关节、动画与顶点遮蔽；各角色的衣着颜色由程序按职业着色。

## 原创内容

小镇布局、巨人 AI、飞索腰具、任务与战役规则、体素引擎、渲染管线、音效合成与全部 UI 文案均为本项目原创。项目只做风格致敬，不使用任何官方作品的名称、角色、造型、标志、模型、贴图或音频，与任何官方作品无关。
