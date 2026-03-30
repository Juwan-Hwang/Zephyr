# Zephyr

<div align="center">

![Zephyr Logo](src-tauri/icons/icon.png)

**A modern, high-performance GUI client for Mihomo core**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub release](https://img.shields.io/github/v/release/USER/Zephyr?include_prereleases)](https://github.com/USER/Zephyr/releases)
[![GitHub Downloads](https://img.shields.io/github/downloads/USER/Zephyr/total)](https://github.com/USER/Zephyr/releases)

[English](#features) | [简体中文](#功能特性)

</div>

---

## Features

- 🚀 **Real-time Traffic Monitoring** - Visual chart of downstream and upstream speeds
- 🎯 **Advanced Node Selection** - Multi-column layouts for high-resolution displays
- ⚡ **Fast Latency Testing** - Integrated latency checks with optimistic UI updates
- 🔒 **Security-First Design** - SSRF protection and SHA256 integrity verification
- 🖥️ **Cross-Platform** - Windows, macOS (Intel & Apple Silicon), Linux
- 📡 **Subscription Management** - Multiple formats, auto-updates, UA spoofing
- 🎨 **Modern UI** - Built with Tauri + Tailwind CSS for native performance

## Screenshots

> TODO: Add screenshots here

## Installation

### Download

Download the latest release from [GitHub Releases](https://github.com/USER/Zephyr/releases):

| Platform | Download |
|----------|----------|
| Windows | `.exe` (NSIS Installer) |
| macOS | `.dmg` (Universal Binary) |
| Linux | `.deb`, `.AppImage` |

### Build from Source

#### Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) (1.70+)
- [Node.js](https://nodejs.org/) (18+)
- [Tauri Prerequisites](https://tauri.app/v1/guides/getting-started/prerequisites)

#### Build Steps

```bash
# Clone the repository
git clone https://github.com/USER/Zephyr.git
cd Zephyr

# Install dependencies
npm install

# Development mode
npm run tauri dev

# Build for production
npm run tauri build
```

## Development

```bash
# Run in development mode with hot reload
npm run tauri dev

# Build CSS (Tailwind)
npm run build:css

# Run tests
npm test

# Lint code
npm run lint
```

## Project Structure

```
Zephyr/
├── src/              # Frontend source (HTML, CSS, JS)
├── src-tauri/        # Tauri/Rust backend
│   ├── src/          # Rust source code
│   ├── icons/        # App icons for all platforms
│   └── tauri.conf.json
├── .github/
│   └── workflows/    # GitHub Actions CI/CD
└── package.json
```

## Security

Zephyr takes security seriously:

- **SSRF Mitigation** - DNS resolution validation for subscription URLs
- **Supply Chain Security** - SHA256 integrity verification for Mihomo core updates
- **Safe Persistence** - Deep configuration merging to prevent data loss
- **No Hardcoded Secrets** - All credentials are runtime-generated

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [Mihomo](https://github.com/MetaCubeX/mihomo) - The core proxy engine
- [Tauri](https://tauri.app) - Build smaller, faster, and more secure desktop apps
- [Tailwind CSS](https://tailwindcss.com) - A utility-first CSS framework

---

## 功能特性

- 🚀 **实时流量监控** - 上下行速度可视化图表
- 🎯 **高级节点选择** - 支持高分屏多列布局
- ⚡ **快速延迟测试** - 集成延迟检测与乐观 UI 更新
- 🔒 **安全优先设计** - SSRF 防护与 SHA256 完整性校验
- 🖥️ **跨平台支持** - Windows、macOS (Intel & Apple Silicon)、Linux
- 📡 **订阅管理** - 多格式支持、自动更新、UA 伪装
- 🎨 **现代化界面** - 基于 Tauri + Tailwind CSS 构建原生高性能应用

## 致谢

- [Mihomo](https://github.com/MetaCubeX/mihomo) - 核心代理引擎
- [Tauri](https://tauri.app) - 构建更小、更快、更安全的桌面应用
- [Tailwind CSS](https://tailwindcss.com) - 实用优先的 CSS 框架
