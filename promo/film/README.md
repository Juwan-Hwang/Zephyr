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
# 1. 依赖仓库与素材
git clone https://github.com/Juwan-Hwang/PingFang-SF  # 取 PingFangSF.ttf → film/fonts/
git clone -b demo https://github.com/Juwan-Hwang/Zephyr app && (cd app && git apply ../patches/demo-mock-api.patch)
git clone https://github.com/Leonxlnx/earshot repos/Leonxlnx_earshot
(cd film && npm i)
sh provision.sh
# 2. 录制 → 3D → 渲染 → 声音 → 编码
python3 capture2.py console lang minimal proxies prism theme close
python3 r3d_seq.py open 5.85 film/frames/open --sub 3
python3 r3d_seq.py end 6.6 film/frames/end --sub 3
python3 render_film.py --comp comp2.html --out film/out2/frames --workers 3
(cd film && python3 music2.py && python3 sound2.py)
ffmpeg -framerate 30 -i film/out2/frames/%05d.jpg -i film/audio/mix2.wav -c:v libx264 -crf 16 -pix_fmt yuv420p \
  -c:a aac -b:a 256k -af loudnorm=I=-14:TP=-1:LRA=9 -shortest -movflags +faststart deliver/Zephyr-promo-v3.mp4
```

## demo mock 修复（`patches/demo-mock-api.patch`，针对 `demo` 分支）

- 补上 `switch_mode`（之前未实现 → 控制台切换全局/规则无效）。
- `get_tray_proxy_status` 按 `tray.rs` 返回 `"tun" | "running"`（之前返回对象，托盘同步会把 TUN 周期性复位为关闭）。
- TUN 开关同步写入 `configState.tun`；补充宣传片演示数据（连接、Prism 示例脚本）。

## 镜头结构

3D 光线→Z 落定 → Z 化为标题 logo → 控制台（系统代理、测速、模式、TUN）→ 14 种语言（含 RTL）→ 窗口形变为简洁首页 → 节点名承接到代理页 → 光标定点切到 Prism（智能补全）→ 编辑行化为光线 → 十一层安全 → 窗口自光线升起（深色）→ 关窗收入托盘 → 平台信息折叠成光线 → 3D 收尾。
