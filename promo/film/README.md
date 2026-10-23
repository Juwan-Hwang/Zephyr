# Zephyr 宣传片 · 制作工程（v3）

成片：`deliver/Zephyr-promo-v3.mp4`（1920×1080 · 30fps · 47s · 124 BPM · −14 LUFS）

所有 UI 镜头均为真实应用实录：控制台及其余页面窗口 **1082×691**，简洁首页 **930×680**（2× DPR）。品牌使用 Argon v9 logo，字体 PingFang-SF。

## 流程

| 步骤 | 文件 | 说明 |
|---|---|---|
| 环境 | `provision.sh` | Playwright/Chromium、音频库；启动 app(8765) 与合成页(8766) 静态服务 |
| 实录 | `capture.py` `capture2.py` | Chromium 虚拟时间 / 实时慢放录制真实前端（demo 分支 mock 后端），输出 webp 序列 + 鼠标轨迹/点击/DOM 测量 |
| 3D | `film/z3d.html` `r3d.py` `r3d_seq.py` | three.js 0.170 渲染 Argon v9 Z 标（开场与结尾），3× 子帧运动模糊 |
| 动效 | `film/mspring.js` | 移植自 motiondivision/motion（MIT）的 spring / cubic-bezier / backOut / anticipate / circ |
| 合成 | `film/comp2.html` | 可 seek 的时间线：连续路径镜头、元素承接转场、字幕、托盘、安全清单、平台页 |
| 渲染 | `render_film.py` `stills.py` | 多 worker 逐帧截图（含镜头运动模糊）；`stills.py` 出检查拼图 |
| 声音 | `film/music2.py` `film/sound2.py` | 程序化配乐（124 BPM，按时间线编曲）+ earshot 音效按事件对位混音 |

## 复现

```bash
sh reproduce.sh              # 用分支内已提交的实录素材与 3D 帧，按原参数重新合成、配乐、编码
RECAPTURE=1 sh reproduce.sh  # 额外从 app/ 快照重新录制 UI、重新渲染 3D
```

分支内已包含 v3 的全部输入，因此可以完整复现：

- `app/`：录制用的前端快照（Zephyr UI、Argon v9 logo、demo mock 及修复补丁）。2026-10-23 已按主仓库 main（135143e，即 v2.5.0 界面）刷新：源码取自 apps/desktop/src，令牌与 UnoCSS 样式按仓库 build:css 步骤重新生成，mock 补齐了现行界面新增的命令。
- `footage2/`：UI 实录序列，含鼠标轨迹、点击时刻与 DOM 测量。
- `film/frames/`：3D 开场与结尾帧。
- `film/fonts/PingFangSF.ttf`、`film/node_modules/three@0.170.0`。

配乐与音效使用固定随机种子，`requirements.txt` 锁定了各依赖的版本。`film/out2/frames/` 存有 v3 渲染出的全部 1414 帧，`deliver/` 存有成片。

## demo mock 修复（`patches/demo-mock-api.patch`，针对 `demo` 分支）

- 补上 `switch_mode`（之前未实现 → 控制台切换全局/规则无效）。
- `get_tray_proxy_status` 按 `tray.rs` 返回 `"tun" | "running"`（之前返回对象，托盘同步会把 TUN 周期性复位为关闭）。
- TUN 开关同步写入 `configState.tun`；补充宣传片演示数据（连接、Prism 示例脚本）。

## 镜头结构

3D 光线→Z 落定 → Z 化为标题 logo → 控制台（系统代理、测速、模式、TUN）→ 14 种语言（含 RTL）→ 窗口形变为简洁首页 → 节点名承接到代理页 → 光标定点切到 Prism（智能补全）→ 编辑行化为光线 → 十三层安全 → 窗口自光线升起（深色）→ 关窗收入托盘 → 平台信息折叠成光线 → 3D 收尾。
