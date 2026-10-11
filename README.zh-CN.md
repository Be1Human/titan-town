# Titan Town · 墙内小镇

[English](README.md) | **简体中文**

一个浏览器里运行的可破坏体素围城小游戏：被高墙包围的中世纪小镇，每栋房子都能被砸开、塌落；地面巨人会看、会听、会拆房子，城墙上的投石巨猿盯着开阔地。你戴着飞索腰具（钩索摆荡 + 喷气），在 3 条命内完成 7 个任务，最终夺回城墙。

> 风格致敬，不含任何官方角色、名称、模型或贴图。巨人、飞索腰具、地图与文案均为原创设定，与任何官方作品无关。

![menu](screenshots/menu.png)
![in game](screenshots/ingame.png)

## 运行

需要 Node.js 22+ 和支持 WebGL2 / WebAssembly SIMD 的现代浏览器（Chrome、Edge、Firefox 最新版）。无第三方 npm 依赖。

```bash
npm install     # 无依赖，仅生成锁文件元数据
npm start       # http://127.0.0.1:4173/
```

换端口：`PORT=4273 npm start`（PowerShell：`$env:PORT=4273; npm start`）。想让局域网访问可设 `HOST=0.0.0.0`。

## 语言

游戏界面提供英文与简体中文，默认跟随浏览器语言；可在主菜单点击语言按钮切换，或在地址后加 `?lang=en` / `?lang=zh`（例如 `http://127.0.0.1:4173/game.html?lang=zh`）。游戏内帮助面板列出全部按键。

## 操作

| 键位 | 作用 |
| --- | --- |
| W A S D / 鼠标 | 移动 / 观察 |
| Shift / 空格 / Ctrl | 冲刺 / 跳跃（准星有钩点时发射钩索）/ 蹲伏 |
| 数字键 / 滚轮、鼠标左键、R | 切换工具、使用、引爆炸药 |
| E / B | 互动、补给 / 拔出双刃 |
| M 或 Tab / Esc / V / H | 地图 / 暂停 / 切换视角 / 帮助 |
| F5 / F9 | 保存 / 读取 |

## 测试

```bash
npm test        # 体素引擎、刚体、支撑坍塌与小镇/巨人/任务逻辑，约 30 秒
```

## 目录

```
game.html, style.css, main-menu.css   页面与样式
server.js                              静态服务器（白名单路径，无依赖）
src/                                   体素引擎 + 渲染 + 巨人 AI + 任务（原生 ES module）
src/i18n.js                            中英文小字典与语言切换
assets/                                小镇场景、预制体、体素模型、巨人骨骼数据
vendor/                                three.js（含小补丁）、Rapier（WASM）
licenses/                              第三方素材原始许可证
tests/                                 node:test 单元测试
DESIGN.md                              需求与设计说明（英文，中文见 DESIGN.zh-CN.md）
THIRD_PARTY.md                         第三方来源、许可证与校验值（英文，中文见 THIRD_PARTY.zh-CN.md）
```

## 许可证

见 [LICENSE](LICENSE)（代码，英文原文）与 [THIRD_PARTY.zh-CN.md](THIRD_PARTY.zh-CN.md)（素材与依赖）。英文版：[DESIGN.md](DESIGN.md)、[THIRD_PARTY.md](THIRD_PARTY.md)。
