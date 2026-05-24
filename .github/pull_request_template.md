# Pull Request

## 描述
<!-- 描述这个 PR 做了什么 -->

## 变更类型
- [ ] Bug 修复
- [ ] 新功能
- [ ] 性能优化
- [ ] 代码重构
- [ ] 文档更新
- [ ] 其他：

## 安全检查清单
<!-- 所有项必须勾选才能合并 -->

### XSS 防护
- [ ] 所有 `innerHTML` 赋值已审查
- [ ] 动态数据使用 `escapeHtml()` 或 `html` 模板标签包裹
- [ ] 外部输入 HTML 使用 `sanitizeHtml()` 或 `DOMPurify`
- [ ] 没有使用 `eval()` 或 `new Function()`
- [ ] 没有使用 `document.write()`

### 代码质量
- [ ] ESLint 检查通过 (`pnpm run lint`)
- [ ] TypeScript 类型检查通过 (`pnpm run typecheck`)
- [ ] 测试通过 (`pnpm run test`)

### 前端特定
- [ ] 新功能已测试主流浏览器 (Chrome, Firefox, Safari)
- [ ] 响应式布局已测试
- [ ] 深色模式已测试

## 测试
<!-- 描述如何测试这些变更 -->

## 截图（如适用）
<!-- 添加截图说明 UI 变更 -->

## 相关 Issue
<!-- 链接相关 Issue，如 Fixes #123 -->
