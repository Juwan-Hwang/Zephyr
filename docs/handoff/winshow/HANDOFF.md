# 交接：Zephyr 窗口不出现、进程越点越多

这份文档给接手的人（或 AI）用，不需要看任何聊天记录。完整的调查过程和代码位置在同目录的 [REPORT.md](REPORT.md)，这里是要点和下一步。

**当前状态：** 已在 Windows 上稳定复现，最可能的根因已经找到，但验证根因的对照实验没跑完。**没有改任何产品代码，没有开修复 PR。** 本分支只用于交接，不要合并。

## 目录

| 路径（相对本目录） | 内容 |
|---|---|
| `REPORT.md` | 完整排查报告：复现过程、调用链、排除的方向、建议的日志 |
| `evidence/run-44563457902/probe.log` | 第一次探测（复现成功的那次）的完整日志 |
| `evidence/run-44563457902/*.png` | 同一次运行的 9 张截图，文件名对应场景 |
| `probe/run1/` | 第一次探测用的 `probe.ps1` 和 workflow `probe.yml`，产出了上面的证据 |
| `probe/control/` | 对照实验用的 `probe.ps1`、`lib.ps1`、workflow `probe.yml` 和补丁 `defer.patch`，**还没跑出结果** |

workflow 文件故意没放在 `.github/workflows/`，所以在主仓库里不会自动触发。怎么跑见下文。

本分支最后一个提交把 `defer.patch` 应用到了 `apps/desktop/src-tauri/src/lib.rs`。**那是对照实验的开关，不是修复。** 做修复时请从 main 新开分支，不要从本分支拉。

## 症状

用户反馈：Zephyr 有时「不在」，反复点图标窗口也不出来，任务管理器里却有一大堆 Zephyr 进程。反馈者自己没能复现，也没有日志。从「任务管理器」的说法判断是 Windows。

## 复现条件（已实测确认）

- 版本：v2.5.0 便携版（`Zephyr_x64-portable.zip`）。这条路径上的代码 v2.5.0 和 main 5f90f3f 一致。
- 设置：开「关闭到托盘」和「轻量模式」（`lightweight_mode`，默认关闭）。
- 操作：关掉主窗口（轻量模式下窗口会被销毁，不只是隐藏），再点图标启动一次。
- 结果：主实例主线程永久卡住，新建的 "Tauri Window" 一直 visible=False、hung=True；第二个进程不退出。之后每启动一次就多一个卡住的 Zephyr.exe。

对比：窗口可见时再启动（S1）、窗口只是隐藏时再启动（S2）都正常，第二个进程 1 秒内退出。

在 `probe.log` 里看 S3：16:15:12 第二次启动（pid 2644）20 秒不退出；16:15:35 主实例（pid 7884）变成 responding=False；之后 pid 7136、6992、7100 一个个堆起来；最后单实例消息窗口和主窗口对 3 秒超时的 SendMessageTimeout 都不回复。

## 目前最可能的根因

在 `apps/desktop/src-tauri/src/lib.rs` 的单实例插件回调里（main 5f90f3f 约 1779 行），直接调用 `show_or_recreate_main_window(app)`：

1. 窗口存在且被判为存活时，只调 `show()`，没问题（S1、S2）。
2. 窗口不存在或被判为已死时，走 `recreate_main_window(app)`，**在回调里同步重建 WebView2 窗口**。
3. 在 Windows 上，`tauri-plugin-single-instance` 2.4.2 的第二个进程用**不带超时的** `SendMessageW(WM_COPYDATA)` 把参数发给主实例，主实例在处理这条跨进程消息时同步执行回调。`tauri-runtime-wry` 在主线程上会内联执行建窗口，`wry` 0.57.0 建 WebView2 时又用 `wait_with_pump` 转嵌套消息循环等待。
4. 结果主线程卡死，第二个进程卡在 SendMessageW 上跟着一起卡住，后面每个新进程都一样。

Tauri 2.12.4 自己的文档（`WebviewWindowBuilder::new` 的 Known issues，引用 wry#583）写明：在 Windows 上从同步的处理函数里建窗口会死锁。

确定程度：

- 触发条件和现象：**确定**，实测复现。
- 卡死发生在「单实例回调里同步重建窗口」这条路径上：**很确定**（同一个回调，不进重建分支就正常）。
- 具体死锁机制：**未确认**。不知道 WebView2 初始化具体等在哪个调用上，也不知道「在跨进程 SendMessage 处理函数里」是不是必要条件，还是「销毁后立即重建」本身就会卡。

## 还差的对照实验

目的：把重建挪出回调，看是否还卡；同时抓主线程调用栈。

- `probe/control/defer.patch`：加环境变量开关 `ZEPHYR_PROBE_DEFER`。设了它，回调会从新线程用 `run_on_main_thread` 把 `show_or_recreate_main_window` 投递回事件循环，不再在回调里同步执行。
- `probe/control/probe.ps1`：用自己编译的 main（带上面的补丁）跑三组：A-inline（原路径，3 轮）、B-deferred（延后执行，5 轮）、A2-inline（再跑一次原路径确认可重复）。卡住时用 cdb 对主实例和第二个进程抓调用栈（`~0s; kn 60; ~*kn 25`）。
- `probe/control/probe.yml`：在 windows-latest 上 checkout 探测脚本和 main 5f90f3f，应用补丁，编译（保留行号调试信息，不 strip），再下载 v2.5.0 便携版，最后跑 `probe.ps1`，结果作为 artifact `probe-out` 上传。

上一次运行（45553471910）在编译阶段就被取消了，**没有任何结果**。

怎么跑：

1. 建一个只放探测文件的临时分支 `probe/winshow`（workflow 只在推到这个分支时触发）。分支根目录放 `probe/control/` 下的 `probe.ps1`、`lib.ps1`、`defer.patch`，把 `probe.yml` 放到 `.github/workflows/probe.yml`。workflow 里会把这个分支 checkout 到 `probe/`，把 main 5f90f3f checkout 到 `src/`。
2. 推送后在 Actions 里看 `probe-winshow`，大约 40 分钟。下载 artifact 看日志里的 `RESULT A-inline / B-deferred / A2-inline` 和 cdb 输出。
3. 跑完删掉临时分支。

怎么读结果：

- A 卡、B 五轮都不卡、A2 又卡：根因确认是「在单实例回调里同步重建」，按下面的修法修。
- B 也卡：根因是「销毁后立即重建」本身，修法要另找，先看 cdb 栈卡在哪个调用上。
- A 不卡：自己编译的版本和 v2.5.0 便携版行为不同，先查清差异，不要下结论。

## 另外两种可能（只靠读代码推出，没实测）

根据 `is_webview_alive`（`lib.rs` 627 至 657 行），默认设置的用户也可能进重建分支：

1. **WebView2 渲染进程崩溃后再点图标。** 崩溃时心跳被置为 `i64::MIN`，按代码会走同一条重建路径。
2. **最小化一段时间后再点图标。** 窗口隐藏时直接判为存活，但最小化的窗口 `is_visible()` 仍是 true。心跳超时是 45 秒（`HEARTBEAT_TIMEOUT_SECS` = 15 × 3）。如果 WebView2 在最小化时节流了前端 15 秒一次的心跳定时器，就会被判死而走重建。这一条纯属推测。第一次探测原本安排了「最小化 7 分钟后再启动」，但被前一个场景卡住，没跑到。

这两条应该在对照实验之后用同一套探测脚本补测，确认影响范围。

## 已经排除的方向

详细理由见 REPORT.md「排除或基本排除的方向」。简要：

- 第二个进程绕过单实例启动成完整实例：排除，堆起来的进程都卡在 SendMessageW、没有窗口。
- 退出清理卡住导致残留：插件在 `RunEvent::Exit` 先释放互斥量，解释不了堆积。
- 托盘菜单重建的锁顺序死锁：`tray.rs` 没有持锁跨主线程调用。
- 提权重启路径：`elevation.rs` 用的是带超时的 `SendMessageTimeout`。
- 窗口位置恢复到屏幕外：复现里是 visible=False，不是位置问题。
- 内核进程被当成 Zephyr：堆起来的是 `Zephyr.exe`，不是 `zephyr-mihomo.exe`。
- issue #217：是「创建内核目录失败」弹窗，无关。
- Linux、macOS：只看了代码，Linux 回调在 zbus 线程且有 25 秒 D-Bus 超时，不会无限堆积；没实测。

没查完的：128 个同步命令在主线程上执行，没有逐个审查是否会长时间阻塞（但那类阻塞窗口仍可见，症状不同）。

## 确认后怎么修

前提是对照实验确认 B-deferred 不卡。

1. 单实例回调里保留快速路径：窗口存活时直接 `show()`（已证明没问题）。
2. 慢速路径（销毁并重建）不在回调里同步执行，改为从新线程用 `run_on_main_thread` 投递回事件循环，让回调立刻返回，第二个进程的 SendMessageW 也就立刻返回。这与 Tauri 文档的建议一致。
3. deep link 参数的转发保持原样。
4. 回归：在 Windows CI 上用同一套探测脚本跑轻量模式关窗再启动，确认不再卡、不再堆进程。
5. 补单元测试，并确认去掉修复后测试会失败。
6. 可选：加 REPORT.md 末尾建议的日志（回调入口出口和耗时、走哪条路径、`is_webview_alive` 的判断依据、`recreate_main_window` 各步骤）。这一项要先问用户。

## 用户的原则（必须遵守）

- **只有确认根因才修。** 对照实验没结果之前不要改产品代码。确认不了就如实说明不确定性、查过什么、还缺哪些证据。不要编理由，不要牵强附会地修。修不好也没关系。
- 修复单独开 PR，从最新 main 拉分支，不要带上本交接目录。
- PR 工作流：
  1. 开 PR 后处理 CI 和所有评论，包括代码行外的评论和评审机器人的意见。逐条判断是否真实、是否值得修，不全盘接受也不忽略真问题；真问题即使超出本 PR 范围或是遗留问题也修。
  2. 修完 amend 提交，关闭旧 PR，从原分支重新开 PR，以触发新一轮机器人评论。
  3. 重开后等 25 分钟，再看全部评论，回到第 1 步。
  4. 循环到没有需要修的意见后，squash 合并。
  5. 严格按流程走，不跳步骤；中途被打断也继续推进到合并标准，不要反复询问是否继续。
- 提交信息、PR 描述和相关内容里**不提 issue**。
- 结论要有证据支撑：测试、CI、实测，而不是推测。
