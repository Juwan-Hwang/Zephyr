# Zephyr 便携版使用说明

## 什么是便携版？

便携版（Portable）无需安装，解压后即可运行，所有数据（配置、订阅、核心、缓存）都存放在程序所在目录，不会写入系统目录（如 Windows 的 AppData、Linux 的 ~/.config）。

## 下载

从 [Releases](https://github.com/Juwan-Hwang/Zephyr/releases) 下载：
- **Windows**: `Zephyr-windows-portable.zip`
- **Linux**: `Zephyr-linux-portable.tar.gz` (包含 AppImage + 数据目录)

## 使用方法

### Windows

1. 解压 `Zephyr-windows-portable.zip` 到任意目录（如 U 盘、桌面）
2. 确保目录中有 `.portable` 标记文件
3. 运行 `Zephyr.exe`

目录结构：
```
Zephyr/
├── Zephyr.exe
├── .portable          ← 便携模式标记（必须有）
├── core/              ← mihomo 核心和 Geo 数据
├── profiles/          ← 订阅配置文件
├── prism/             ← Prism 规则数据
├── settings.json      ← 应用设置
└── .machine_key       ← 加密密钥
```

### Linux (AppImage)

1. 解压 `Zephyr-linux-portable.tar.gz`
2. 确保 `.portable` 文件与 `.AppImage` 在同一目录
3. 运行 `./Zephyr-*.AppImage`

```bash
tar xzf Zephyr-linux-portable.tar.gz
cd Zephyr
chmod +x Zephyr-*.AppImage
./Zephyr-*.AppImage
```

目录结构：
```
Zephyr/
├── Zephyr-*.AppImage
├── .portable          ← 便携模式标记
├── core/
├── profiles/
├── prism/
├── settings.json
└── .machine_key
```

## 便携版 vs 安装版

| 特性 | 便携版 | 安装版 |
|------|--------|--------|
| 安装步骤 | 解压即用 | 需要安装程序 |
| 数据位置 | 程序目录 | 系统目录 |
| 开机自启 | ❌ 不支持 | ✅ 支持 |
| 客户端更新 | ❌ 不支持（需手动下载） | ✅ 支持 |
| 系统代理 | ✅ 支持 | ✅ 支持 |
| TUN 模式 | ✅ 支持 | ✅ 支持 |

## 注意事项

1. **`.portable` 标记文件**：必须存在才能启用便携模式。如果删除，程序会退回安装版行为（数据写入系统目录）。

2. **WebView2 (Windows)**：便携版依赖系统已安装的 WebView2 Runtime。如果无法启动，请从微软官网下载安装 [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)。

3. **多实例**：便携版可以复制到多个位置同时运行，但注意：
   - 系统代理端口（默认 7890）会冲突
   - TUN 模式同一时间只能有一个实例启用

4. **U 盘性能**：mihomo 核心会频繁读写 `cache.db`，在低速 U 盘上可能影响性能。

5. **路径限制**：避免将便携版放在含中文或空格的路径下，可能导致 mihomo 核心启动失败。

## 从安装版迁移到便携版

1. 下载便携版并解压
2. 复制安装版的配置：
   - **Windows**: `%AppData%\com.zephyr.desktop\` 下的 `profiles/`、`prism/`、`settings.json`
   - **Linux**: `~/.config/com.zephyr.desktop/` 下的对应文件
3. 粘贴到便携版目录
4. 确保有 `.portable` 标记文件
5. 运行便携版

## 故障排查

### 启动后数据仍写入系统目录
- 检查 `.portable` 文件是否存在
- 检查文件权限（Linux/macOS）

### Linux AppImage 无法启动
```bash
# 检查执行权限
chmod +x Zephyr-*.AppImage

# 检查 .portable 文件是否存在
ls -la .portable
```

### Windows 提示缺少 WebView2
从 [微软官网](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) 下载安装 Evergreen Standalone Installer。
