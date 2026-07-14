# UnoCSS 迁移计划 — 全量审计报告

> 审计时间：2026-07-16
> 审计方法：逐项对照 `UNOCSS_MIGRATION_PLAN.md` 的每个章节，grep/read 实际代码验证
> 审计结论：PR4 本身完整，但 PR1-3 的设计债清理存在重大缺口

---

## 一、PR1: 等价迁移

| 计划项 | 状态 | 证据 |
|--------|------|------|
| §1.1 移除 tailwindcss，安装 unocss | ✅ 已完成 | 根 `package.json` 有 `unocss@^66.7.5`、`@unocss/cli@^66.7.5`、`@unocss/preset-wind4@^66.7.5`，无 tailwindcss |
| §1.2 `uno.config.js` presetWind4 + dark:'class' | ✅ 已完成 | `presetWind4({ dark: 'class' })` |
| §1.2 `preflights: { reset, theme, property }` | ⚠️ **缺失** | uno.config.js 中无 `preflights` 配置，依赖默认行为 |
| §1.2 `cli.entry.patterns` 扫描 `src/**/*.{html,js}` | ✅ 已完成 | `patterns: ['src/**/*.{html,js}']` |
| §1.2 `theme.colors.accent` | ✅ 已完成 | 已定义且扩展了 success/danger/warning/info 等语义色 |
| §1.2 `theme.text.fontSize['2xs']` | ✅ 已完成 | 已定义 |
| §1.3 build:uno 脚本含 `--preflights` | ⚠️ **缺失** | 实际为 `unocss --config ./uno.config.js --minify`，无 `--preflights` |
| §1.4 styles.css 单入口 `@import` | ✅ 已完成 | `@import "./uno-generated.css"` + `@import "./tokens-variables.css"` + `@import "./tokens-theme.css"` |
| §1.4 `@apply` 全部手动展开 (D5) | ✅ 已完成 | `grep @apply` = 0 处 |
| §1.5 删除 `tailwind.config.js` | ✅ 已完成 | 文件不存在 |
| §1.6 index.html 引用 `styles.css` | ✅ 已完成 | `<link rel="stylesheet" href="styles.css" />` |

**PR1 结论**：核心迁移完成，但 `preflights` 配置和 `--preflights` CLI 标志缺失（可能依赖默认行为工作，但不符合计划）。

---

## 二、PR2: Token 收敛

| 计划项 | 状态 | 证据 |
|--------|------|------|
| §2.1 `primitive.json` radius: control/surface/overlay/full/dropdown-option | ✅ 已完成 | 5 个圆角值全部定义 |
| §2.1 `component.json` 各组件 radius 引用 token | ✅ 已完成 | button→control, input→control, card→surface, modal→overlay, panel→surface, badge→control, dropdown→surface |
| §2.1 HTML 中圆角收敛到 4 值 (D1) | ❌ **未完成** | `index.html` 仍有大量 `rounded-lg`/`rounded-md`/`rounded-sm`/`rounded-2xl` 混用，未替换为 token 引用 |
| §2.2 消除 `bg-indigo-600` | ✅ 已完成 | grep 全站无匹配 |
| §2.2 消除 `text-black/60` | ❌ **未完成** | `index.html:86` 仍有 `text-black/60` |
| §2.2 消除 `bg-[#ff5f57]` | ✅ 已完成 | grep 全站无匹配，已映射到 `--zephyr-color-close-btn` |
| §2.2 消除 `text-rose-500` | ✅ 已完成 | grep JS 无匹配，已映射到 `text-danger` |
| §2.2 消除 `text-green-400` | ✅ 已完成 | grep JS 无匹配，已映射到 `text-success` |
| §2.3 `semantic.json` surface 三层 | ✅ 已完成 | page/raised/elevated/input/overlay 全部定义 |
| §2.4 修复 btn-success 语义 (D3/D4) | ❌ **未完成** | `.btn-success` 仍用 `var(--color-accent)`，不是 `var(--zephyr-color-success)` |

**PR2 结论**：Token 定义层完成（primitive/semantic/component 三层），但消费层未跟进 — HTML 圆角未收敛，btn-success 颜色未修复，text-black/60 未消除。

---

## 三、PR3: 组件级重构

| 计划项 | 状态 | 证据 |
|--------|------|------|
| §3.1 组件载体边界分类 | ✅ 已完成 | shortcuts（静态组合）+ CSS（交互状态）+ tokens（常量）三层分载 |
| §3.2 `shortcuts: surface-1/2/3, panel, panel-interactive` | ⚠️ **定义但未消费** | uno.config.js 中已定义，但 grep HTML/JS 全站 `surface-1`/`surface-2`/`surface-3` = **0 处使用** |
| §3.3 Button 状态矩阵 | ✅ 已完成 | `.btn` base + 6 个变体（ghost/accent/danger/warning/success/primary）+ hover/active + disabled + loading + keyframes |
| §3.4 Form 组件统一 | ✅ 已完成 | `.form-control` + `.form-control-sm/md/lg` + `.form-control-mono` + `::placeholder` |
| §3.5 Status 组件 | ✅ 已完成 | `.status-dot` + `--online/offline/error/warning` + `.latency-badge` + `--fast/medium/slow` |
| §3.6 Danger Zone 隔离 | ✅ 已完成 | `.danger-zone` + `.danger-zone__title` |
| §3.7 shortcuts/rules/safelist 消费情况 | ❌ **shortcuts 未消费，rules/safelist 未定义** | `rules: {}` 不存在，`safelist: []` 不存在 |

**PR3 结论**：CSS 类全部定义完成，但 UnoCSS 的核心优势（shortcuts）定义了却没人用。HTML/JS 仍在手写 `border border-[var(--zephyr-border-subtle)] bg-[var(--zephyr-surface-raised)]` 而非用 `surface-2`。

---

## 四、PR4: 动效与可访问性

| 计划项 | 状态 | 证据 |
|--------|------|------|
| §4.1 focus-visible 统一 | ✅ 已完成 | 全局 outline + button box-shadow + form-control border+shadow，完整 disabled guards |
| §4.1 跨端 focus token | ✅ 已完成 | semantic.json focus.color/ring-alpha/ring-soft-alpha/border-alpha + styles.css platform adapter |
| §4.2 Disabled 状态 (D6) | ✅ 已完成 | opacity + cursor，覆盖 button/input/select/textarea/btn/form-control/dropdown-item/role=button |
| §4.3 Loading 状态 | ✅ 已完成 | aria-busy + spinner + keyframes + reduced-motion 豁免 |
| §4.4 Reduced Motion | ✅ 已完成 | 全局 * override + 装饰动画关闭 + 进度指示器豁免 + scrolling-text overflow-x:auto + tabindex=0 |
| §4.5 Transition 统一 (D10) | ⚠️ **CSS 层完成，HTML/JS 层未完成** | CSS 有 `.form-control/.glass-card/...` → `var(--zephyr-time-standard)`，但 HTML/JS 有 **72 处 `duration-XXX`** + **156 处 `transition-colors/all/transform`** 直接写在内联 class 中，覆盖 CSS |
| §4.6 验收清单 | ✅ 代码层全部覆盖 | WCAG 对比度为人工验证步骤 |

**PR4 结论**：PR4 自身范围全部完成。但 D10（transition token 消费）只在 CSS 类层面统一，HTML/JS 内联 `duration-300` 等硬编码值未被替换，导致 token 不生效。

---

## 五、设计债 D1-D10 汇总

| # | 债 | 计划 PR | 状态 | 说明 |
|---|-----|--------|------|------|
| D1 | 圆角失控 | PR2 | ❌ **未修** | HTML 仍混用 `rounded-lg/md/sm/2xl`，未替换为 token |
| D2 | Surface 无层级 | PR2/PR3 | ⚠️ **半成品** | shortcuts 定义了，但 HTML/JS 0 处消费 |
| D3 | accent 色滥用 | PR2 | ❌ **未修** | btn-success 仍用 accent 色 |
| D4 | btn-success 语义错误 | PR2 | ❌ **未修** | 同 D3 |
| D5 | @apply 硬编码值 | PR1 | ✅ **已修** | 0 处残留 |
| D6 | 无 disabled/loading | PR3/PR4 | ✅ **已修** | 完整状态矩阵 |
| D7 | focus-visible 仅全局 | PR4 | ✅ **已修** | 统一体系 |
| D8 | hardcoded 颜色 | PR2 | ⚠️ **半修** | 4/5 已消除，`text-black/60` 残留 |
| D9 | glass-card 重复定义 | PR1/PR3 | ❌ **未修** | styles.css 中 10 处定义未合并 |
| D10 | transition 不消费 token | PR4 | ❌ **未修** | HTML/JS 72 处 duration-XXX + 156 处 transition-XXX 硬编码 |

**汇总**：✅ 已修 3 条 | ⚠️ 半修 2 条 | ❌ 未修 5 条

---

## 六、UnoCSS 优势发挥程度

| 功能 | 定义 | 消费 | 评价 |
|------|------|------|------|
| `presetWind4` | ✅ | ✅ | dark mode + CLI 扫描正常工作 |
| `theme.colors` | ✅ | ✅ | success/danger/warning/info/accent 语义色已定义且在 HTML/JS 使用 |
| `shortcuts` | ✅ surface-1/2/3, panel | ❌ **0 处使用** | 定义了等于白定义，HTML/JS 仍手写一长串 utility |
| `rules` | ❌ 不存在 | — | 计划提到但未实现 |
| `safelist` | ❌ 不存在 | — | 计划提到但未实现 |

**结论**：UnoCSS 最核心的差异化能力 — `shortcuts`（用语义化 class 替代一长串 utility）— 虽然定义了但完全没消费。等于换了个引擎但没开新功能。

---

## 七、需要在 PR4 上补齐的清单

以下 7 项在 PR4 分支上直接补齐：

1. **D3/D4**: `.btn-success` 颜色从 `--color-accent` 改为 `--zephyr-color-success`
2. **D8**: `index.html:86` `text-black/60` 替换为 `text-[var(--zephyr-text-tertiary)]`
3. **D9**: 合并 `.glass-card` 的 10 处定义为统一结构
4. **D10**: HTML/JS 中 `duration-300`/`duration-200` 等替换为 `duration-[var(--zephyr-time-standard)]` 等 token 引用
5. **D2/shortcuts**: HTML/JS 中手写的 surface 组合 class 替换为 `surface-2`/`surface-3` shortcut
6. **§1.2/§1.3**: uno.config.js 加 `preflights` 配置，build:uno 脚本加 `--preflights` 标志
7. **D1**: HTML 中 `rounded-lg/md/sm/2xl` 替换为 `rounded-[var(--zephyr-radius-control)]` 等 token 引用
