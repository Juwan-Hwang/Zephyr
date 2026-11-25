# Zephyr UI 定稿交接说明

这份文档给接手的人（或 AI）看，不需要看之前的聊天记录。写于 2026-11-25。

这个分支 `handoff/ui-final` **只用来交接，不要合并**。它基于旧的 main（59c2851），上面是原型提交，再加一个 `handoff/` 目录。真正要合并的代码在 `ui/final-design`（PR #2518）和 `wip/ui-final-all`（写了一半的大 PR）。

## 一、分支一览

| 分支 | 内容 | 状态 |
|---|---|---|
| `ui/final-design` | PR #2518：侧栏、文字对比度、选择卡片、节点卡片 | 已开 PR，CI 全过，**没合并**，保持原样 |
| `pr-assets/ui-final` | 只放 #2518 描述里引用的截图 | 保持原样，删了 PR 描述里的图会失效 |
| `wip/ui-final-all` | 在 `ui/final-design` 上继续做「定稿全部落地」：下载测速和出口 IP 的后端 | 做了一半，见第四节 |
| `handoff/ui-final`（本分支） | 原型代码 + 全部截图 + 设计页面 + 截图脚本 + 本文档 | 只交接 |

原型提交（本分支上 59c2851 之后的 8 个 `proto:` 提交，最新 1f5583f）以前只在本地分支 `proto/ui-suggestions` 上，现在随本分支推到了远程。`proto/ui-suggestions` 本身没有另外推送，内容和本分支的原型部分完全一样。

## 二、用户的决定和偏好（全部要遵守）

### UI 定稿

- **侧栏**：保留 main 原来的图标，每个图标旁边加两个字的名字（首页、节点、订阅、连接、规则、日志、设置）。**不要「隐藏边栏」按钮**，也不要再加任何图标。展开和收起用四种方式：
  1. 拖侧栏右边缘（悬停出现 2 px 蓝线，拖过中点吸附切换，双击也切换，可键盘操作）；
  2. 快捷键 macOS ⌃⌘S、Windows / Linux Ctrl+B（输入框和编辑器里不拦）；
  3. 右键侧栏，菜单只有一项「收起边栏 / 展开边栏」，右边写快捷键；
  4. 窗口窄于 860 px 自动收起，这时展开是浮层。
  - 用户否决过：纯文字侧栏、图标下方小字、换新图标、底部「隐藏边栏」图标按钮。
- **右上角关闭按钮**：保留原来的红点，不要改成灰色 ×。
- **选择卡片**（带辉光的新组件）：只用于 4 个及以上选项的单选；少于 4 个继续用原来的分段滑块（`.seg-tabs`）。
- **节点卡片最小宽度**：200 px。
- **控制台首页**：用方案 B；删掉「控制台」标题，开关长条顶到页面最上面。去掉和「当前节点」重复的「节点延迟」指标卡。
- **简洁首页**：从上到下是开关条 → 流量卡 → 当前节点条。**不要把「最快节点」放在开关条下面，也不要放在流量卡下面**。最快节点变成节点条里的「延迟较低」，点一下切换，窗口多宽放几个。
- **出口 IP**：不要手动点击查询。设置里加开关，打开后自动查询，切换节点时自动刷新。首页不要胶囊式展示；定稿放在节点条第二行（「21 ms · IP · 地区」）。
- **测速按钮**：「测试延迟」放在「测试下载速度」前面（节点页顶部和节点卡悬停按钮都一样）。空间不够时**先折叠下载测速**（只留图标），尽量保留「测试延迟」的文字。
- **不要单键快捷键**。
- **不在代理组旁显示命中规则**。改为：在连接页点开一条连接，可以直接编辑相关规则或用连接信息添加规则。
- **文案**：自然、简洁，像 Apple / Google 系统设置里的真实文案，不要 AI 腔，不写实现细节和黑话。详细规则见 `handoff/notes/zephyr-ui-decisions.md` 的「文案规则」。
- **大窗口**：不同窗口尺寸下都要协调，特别注意大窗口的留白、卡片比例、对齐、裁切、重叠。**必须看实际截图检查**，不能只凭代码推断。
- **截图分辨率**参考演示视频分支 `promo/film-v3` 的规格（`promo/film/capture.py`：1080×690，DPR 2）。原型截图用的是 DPR 2，简洁首页 930×680，控制台和其他页 1082×691，另外检查最小窗口 720×540 和 1440×900。
- 用户审美要求很高，允许大幅改设计，但要有专业判断，不是从现成选项里勉强挑。

更完整的取舍、否决理由、各尺寸的布局数值都在 `handoff/notes/zephyr-ui-decisions.md`，图文版在 `handoff/pages/zephyr-ui-final.html`。

### 工作原则

- 只有确认根因才修；不确定就如实说调查了什么、还缺什么证据，不编理由。
- 结论要有测试、CI、实测或截图支持。
- 用户说继续时，一直推进到工作流终点，不要反复问要不要继续。

## 三、定稿清单和状态

| 项目 | 状态 | 在哪里 |
|---|---|---|
| 侧栏：原图标 + 两字名字，四种方式展开收起，14 种语言的短名字 | 已落地 | #2518（`ui/final-design`） |
| 文字对比度达到 WCAG AA | 已落地 | #2518 |
| 选择卡片组件（4 个及以上选项），订阅「自动更新」改用它 | 已落地 | #2518 |
| 节点卡片最小宽度 200 px，悬停重测按钮平时不占位 | 已落地 | #2518 |
| 右上角红点 | 不用改（main 原样） | — |
| 下载测速后端（隐藏 select 组 + 回环 listener + 下载命令） | 做了一半 | `wip/ui-final-all` |
| 出口 IP 查询后端（`lookup_exit_ip`） | 做了一半（命令已写，没接设置和前端） | `wip/ui-final-all` |
| 下载测速前端（顶部按钮、卡片结果、进度、确认弹窗、按速度排序、Esc 停止） | 没开始（只有原型） | 原型 `apps/desktop/src/proto/p/fspeed.js` |
| 「下载测速」设置（测速文件 4 选 1 用选择卡片，每节点 10/20/30 秒用分段控件） | 没开始（只有原型） | 原型 |
| 「测试延迟」在前、空间不够先折叠下载测速 | 没开始（依赖下载测速前端） | 原型 `final.css` |
| 「测速地址」改名「延迟测试地址」，地址选择改用选择卡片 | 没开始 | 原型 |
| 简洁首页重新排版（开关条 → 流量卡 → 节点条，「延迟较低」，按窗口缩放的规则） | 没开始（只有原型） | 原型 `p/fhome.js`、`p/final.css` |
| 控制台首页方案 B（去标题、开关条置顶、4 列网格、订阅用量移到底行） | 没开始（只有原型） | 原型 `p/final.js`、`p/final.css` |
| 出口 IP 设置开关 + 节点条第二行展示 + 切换节点刷新 | 没开始（后端命令有了） | 原型 `p/exitip.js` |
| 连接页点开连接后编辑 / 添加规则 | 没开始（只有原型） | 原型 `p/connrule.js` |
| 内核停止横幅（页面顶部，节点条显示「已停止」） | 没开始（只有原型） | 原型 `p/coredown.js` |

用户的要求是：**以上全部（包括需要后端的）放进一个大 PR**，按第六节的工作流评审合并。#2518 目前只含纯界面部分；接手后可以在 `wip/ui-final-all` 上把剩下的做完，再决定是把它并进 #2518 的分支一起走工作流，还是关掉 #2518、从新分支开一个大 PR。两种做法都要保证最后是一个 PR。

## 四、`wip/ui-final-all` 的状态（如实）

分支 = `ui/final-design`（794f6ce）+ 两个 WIP 提交：

1. `2a78946 wip: download speed test and exit IP backend`
   - 新文件 `apps/desktop/src-tauri/src/speed_test.rs`（约 430 行，含 7 个单元测试）。
   - `core/core_process.rs`：生成运行配置时调用 `speed_test::inject_for_runtime`。
   - `lib.rs`：注册命令 `speed_test_port`、`speed_test_cancel`、`speed_test_download`、`lookup_exit_ip`。
   - `packages/shared/src/index.js`：加了这四个命令名常量。
2. `wip: clippy pedantic cleanups in speed_test.rs` — 上一个任务刚在修的 clippy 警告（不用 `as` 转换、改名去掉 shadow、`#[must_use]`、`Eq` 等）。

交接时实测（在 2 号提交上跑的）：

- `cargo clippy --workspace --all-targets -- -D warnings`（就是 pre-push 钩子里的命令）：**通过**。修之前是 17 个错误。
- `cargo test` 结果见本文末尾「交接时的检查结果」。
- 没跑 `pnpm test`、eslint、类型检查，也没在真机上跑过应用。

后端做到哪一步：

- **原理**：mihomo 的 REST API 只能测延迟，测不了经过某个节点的下载。所以每份运行配置都注入：
  - 一个隐藏的 select 组 `ZEPHYR-SPEED-TEST`（`include-all: true` 包含所有节点，`proxies: [DIRECT]` 兜底，`hidden: true`）；
  - 一个回环 mixed listener `zephyr-speed-test`（`127.0.0.1:<本次运行随机空闲端口>`，`proxy: ZEPHYR-SPEED-TEST`，`udp: false`）。
  - 用户配置里已经有同名组 / listener，或 `proxy-groups` / `listeners` 不是列表时，什么都不注入，测速不可用（`speed_test_port` 返回 `None`）。
- **测一个节点**：前端先 `PUT /proxies/ZEPHYR-SPEED-TEST {"name": "<节点名>"}`，再调 `speed_test_download(url, max_secs, max_bytes, id)`。下载走这个 listener，所以不影响用户自己的选择，规则也不会把它分到 DIRECT。过程中发 `speed-test-progress` 事件；结果取每秒速度的最高值（不足 900 ms 的窗口不算，下载太短就取平均）。`speed_test_cancel` 让正在进行的下载停下。上限 60 秒、1 GiB，只允许 http/https 地址。
- **出口 IP**：`lookup_exit_ip(port)` 经本地代理端口请求 `https://www.cloudflare.com/cdn-cgi/trace`，解析 `ip=` 和 `loc=`。
- **还没做的**：前端全部（按钮、卡片结果、确认弹窗、排序、设置项、i18n）；测全部节点时「先测延迟、超时跳过、一次一个」的调度；设置项持久化；出口 IP 的设置开关、自动查询和切换节点时刷新；`speed_test.rs` 之外的测试（比如 `core_process` 注入后的快照）。

### 用 mihomo 在本地验证这个方法

`handoff/notes/mihomo-speedtest-check/` 里有交接前跑过的配置和日志：

- `config.yaml`：两个节点 `n1`（direct）和 `n2`（指向 `127.0.0.1:1` 的死节点），用户的 `PROXY` 组和 `MATCH,PROXY` 规则，加上注入的隐藏组和 listener（端口 17999）。`secret: s` 是测试用的假值。
- `mihomo-run-2026-11-25.log`：日志显示 `Mixed(http+socks)[zephyr-speed-test] proxy listening at: 127.0.0.1:17999`，经 listener 的请求是 `using ZEPHYR-SPEED-TEST[n1]`；把组切到 `n2` 后请求就去连 `127.0.0.1:1` 并失败，说明下载确实跟着隐藏组的选择走，而不是用户的 `PROXY` 组。

自己复现：

```sh
mkdir -p /tmp/mh && cp handoff/notes/mihomo-speedtest-check/config.yaml /tmp/mh/
mihomo -d /tmp/mh &          # 原机器上的二进制在 converters/bin/mihomo（不在仓库里）
curl -s -H 'Authorization: Bearer s' -X PUT 127.0.0.1:19090/proxies/ZEPHYR-SPEED-TEST -d '{"name":"n1"}'
curl -x http://127.0.0.1:17999 -o /dev/null -w '%{speed_download}\n' https://speed.cloudflare.com/__down?bytes=10000000
curl -s -H 'Authorization: Bearer s' -X PUT 127.0.0.1:19090/proxies/ZEPHYR-SPEED-TEST -d '{"name":"n2"}'
curl -x http://127.0.0.1:17999 https://www.cloudflare.com/cdn-cgi/trace   # 应失败
```

注意：listener 端口不能和 `external-controller` 端口相同（之前试过一次撞端口，listener 起不来）。

## 五、本分支里的东西

- `apps/desktop/src/proto/`：原型代码。`boot.js` / `bootstrap.js` 是模拟 Tauri 的启动层，`demo/mock-api.js`、`demo/mock-data.js` 是模拟数据，`p/*.js|css` 是每个原型，定稿入口 `?proto=final`（`final.js`、`fhome.js`、`fspeed.js`、`final.css`）。`index.html` 里多了 3 行引入原型层，`styles.css` 有原型用的样式。字体 `PingFangSF.ttf`（67 MB）和远程 `promo/film-v3` 分支里的是同一个文件，没有增加仓库体积。
- `handoff/screenshots/`：全部截图，WebP，原始分辨率。每个文件夹有 `README.md`，在 GitHub 上点开就能直接看图。
  - `final/` 定稿（196 张）、`window-sizes/` 各窗口尺寸改前改后（32）、`window-sizes-trial/` 尺寸规则试验版（30）、`previous-round/` 353e083 版（168）、`before-visual-review/` 看图修改前（70）、`look-crops/` 局部放大（23）、`pr-2518/` PR 并排截图原图（26）、`main-baseline/` main 基线（8）、`early-prototypes/` 最早一批（7 + snap 子目录 20）、`misc/`（1）。
  - `sidebar-collapse-animation.webp`：侧栏收起展开的动图（由录屏帧合成）。
- `handoff/pages/`：自包含的 HTML（图片内嵌）。GitHub 不渲染 HTML，下载后用浏览器打开。
  - `zephyr-ui-final.html`：定稿设计说明（每项改前改后、理由、实现对照、文案对照）。
  - `zephyr-ui-prototypes.html`：最早的全部原型和取舍。
  - `zephyr-issue-suggestions.html`：从 issue 整理出的建议和取舍。
  - `zephyr-subscription-converter-research.html`：订阅转换调研（和 UI 无关，顺带存档）。
- `handoff/notes/zephyr-ui-decisions.md`：取舍记录（已定、否决、文案规则、各尺寸布局数值）。
- `handoff/notes/pr-2518-review-rounds/`：#2518 每轮评审机器人意见的原始导出（JSON / 文本），处理下一轮时可以对照。
- `handoff/notes/mihomo-speedtest-check/`：见上一节。
- `handoff/tools/proto-tools/`：原型截图脚本。`handoff/tools/ui-pr-tools/`：给真实组件截图（#2518 用）的脚本、PR 描述草稿 `body.md`、i18n 工具。

路径说明：脚本里原来的本机绝对路径都换成了 `WORK` 环境变量（默认当前目录）。原机器上 `WORK=/home/sprite`，下面是各目录的对应关系。job 文件里个别 `/tmp/...` 只是截图输出目录，可以随意改。`proto-tools/urls.txt` 里的 uguu.se 链接是临时图床，已经过期，仅作记录。

## 六、PR 工作流（必须严格执行，不跳步）

1. 所有定稿内容放**一个**大 PR。
2. 开 PR 后看 CI 和**所有**评论：代码行评论、非代码行评论、评审机器人（CodeRabbit、Qodo、CodeAnt、Mergestorm、SonarCloud、Codecov、Sourcery、cubic 等）。
3. 每条意见认真判断：真问题就修并补测试（确认去掉修复后测试会失败）；即使超出本 PR 范围或是遗留问题，只要真实且值得修也修。不修的要写明理由。不全盘接受，也不忽略。
4. 修完 **amend** 提交，强推；**关掉旧 PR，从原分支重开新 PR**（为了拿到新一轮机器人评论）。
5. 重开后**等 25 分钟**，再看所有评论，回到第 3 步。
6. 循环到没有需要修的意见，再 **squash 合并**。
7. 提交信息、PR 描述和其他任何地方都**不提 issue**（不写 `#123` 指向 issue、不写 fixes/closes）。
8. 不用 `--no-verify`，pre-commit 和 pre-push 钩子要正常跑过。pre-push 跑 `cargo clippy --workspace --all-targets -- -D warnings`、`cargo test --workspace`、`pnpm test`。
9. 用户说继续就一直推进到合并标准，不要中途反复询问。可以参考之前 #2485、#2256 的处理方式（PR 描述中文、提交信息格式如 `fix(desktop)：……`）。

## 七、环境说明

- **gh**：装在持久目录 `~/.local/opt/gh`，`~/.local/bin/gh` 是软链接，登录信息在 `~/.config/gh/hosts.yml`（账号 Juwan-Hwang，HTTPS）。token 失效时用 `gh auth login` 走设备授权，需要用户在 GitHub 页面输入授权码。
- **主仓库**：`$WORK/Zephyr`（main，本地 main 可能落后，先 `git fetch`）。worktree：
  - `wt-ui-pr` → `wip/ui-final-all`（大 PR 的工作区，`ui/final-design` 也从这里推）
  - `wt-ui-proto` → `proto/ui-suggestions`（原型）
  - `wt-handoff` → `handoff/ui-final`（本分支）
  - `wt-2256`、`wt-2485`、`wt-2486`：之前其他 PR 的工作区，和 UI 无关
  - `wt-winshow` → `fix/window-not-showing`（窗口不出现问题排查，没有改动）
  - `wt-bench-main`：基准测试用的 detached main
- **跑原型和截图**：
  1. `cd apps/desktop && pnpm install && pnpm run build:css`
  2. 在仓库根目录 `python3 -m http.server 5174 -d apps/desktop/src`，浏览器开 `http://127.0.0.1:5174/index.html?proto=final&home=minimal&theme=light`（`home=console` 看控制台首页，`theme=dark` 深色）。
  3. 截图：`cd handoff/tools/proto-tools && npm install && npx playwright install chromium && node batch.mjs jobs-final.json`，输出到 `out/`。`ONLY=<正则>` 只截部分，`BASE=` 改地址。`overlap.js` / `layout.js` 做重叠和布局检查。
  4. 页面：`python3 towebp.py` 把 `out/*.png` 转成 `web/*.webp`，再 `WORK=<上级目录> python3 build-final.py` 把 `page-final-src.html` 里的 `@名字` 换成内嵌图片，生成 `zephyr-ui-final.html`。
  5. `mock_mihomo.py [端口]` 是假的 mihomo 控制器，需要接近真实的节点数据时用。
- **给真实组件截图**（`ui-pr-tools`）：`sync.sh` 把 `wt-ui-pr/apps/desktop/src` 同步到一个静态站点目录并加上模拟层，起静态服务后 `node shoot.mjs <端口> <输出目录> <标签>`，`compose.py` 拼 main 和分支的并排图。
- **看截图**：截图要真的看过。原机器的做法是把图传到临时图床拿到链接，再用浏览器打开逐张看（`upload.sh`）。

## 交接时的检查结果

在 `wip/ui-final-all` 最新提交上实测（2026-11-25）：

- `cargo clippy --workspace --all-targets -- -D warnings`：通过（退出码 0）。
- `cargo test -p Zephyr speed_test`：7 个测试全部通过。完整的 `cargo test --workspace` 和 `pnpm test` 这次没有跑。
- 前端改动为零，所以 eslint 和类型检查和 `ui/final-design` 一样；但前端还没调用这些新命令。
