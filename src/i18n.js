// @ts-check
/**
 * Zephyr i18n System
 *
 * Features: interpolation (@@var@@), CLDR pluralization via Intl.PluralRules,
 * fallback chain, QA mode, RTL detection, ja/ko skeletons,
 * HTML lang/dir attributes, locale attribute introspection.
 */

import { invoke } from './api.js';
import { i18nLogger } from './utils/logger.js';

// ---------------------------------------------------------------------------
// RTL language detection
// ---------------------------------------------------------------------------

/**
 * Check whether a language code is right-to-left.
 * @param {string} lang - ISO 639-1 language code.
 * @returns {boolean}
 */
export function isRTL(lang) {
    return ['ar', 'he', 'fa', 'ur'].includes(lang);
}

// ---------------------------------------------------------------------------
// Translation data
// ---------------------------------------------------------------------------

export const translations = {
    en: {
        home: "Home",
        proxies: "Proxies",
        settings: "Settings",
        downstream: "Downstream",
        upstream: "Upstream",
        sysProxy: "System Proxy Control",
        proxyStatusReady: "Ready to protect your traffic",
        proxyStatusActive: "Proxy Active",
        traffic: "Real-time Traffic",
        proxiesTitle: "Proxy Nodes",
        sortDefault: "Default",
        sortLatency: "By Latency",
        sortName: "By Name",
        latency: "Latency",
        testLatency: "Test Latency",
        settingsTitle: "Settings",
        general: "General",
        language: "Language",
        languageDesc: "Select interface language",
        minToTray: "Hide on Close",
        minToTrayDesc: "Hide to tray instead of quitting when closing window",
        autoCheckUpdate: "Auto Check Core Updates",
        autoCheckUpdateDesc: "Automatically check for core updates on startup",
        confirm: "Confirm",
        cancel: "Cancel",

        // Network & Routing
        networkRouting: "Network & Routing",
        unifiedDelay: "Unified Delay",
        unifiedDelayDesc: "Use uniform delay testing strategy",
        ipv6Support: "IPv6 Support",
        ipv6SupportDesc: "Enable IPv6 routing and connections",
        allowLan: "Allow LAN",
        allowLanDesc: "Allow local network devices to connect",
        geoData: "Geo Databases",
        geoDataDesc: "Update GeoIP and GeoSite routing databases",
        updateNow: "Update Now",

        // Core update status messages (keys match Rust backend)
        statusDownloadingCore: "Downloading core from GitHub...",
        statusDownloadingProgress: "Downloading core... {progress}%",
        statusPreparingUpdate: "Preparing to update Mihomo core...",
        statusVerifyingFile: "Verifying file integrity...",
        statusExtractingCore: "Download complete, extracting core...",
        statusWritingFiles: "Writing core files...",
        statusRestartingCore: "Update complete, restarting core...",
        statusCoreReady: "Core ready",
        statusFetchingVerify: "Fetching verification info...",
        statusDownloadingGeoIP: "Downloading GeoIP...",
        statusVerifyingGeoIP: "Verifying GeoIP...",
        statusDownloadingGeoSite: "Downloading GeoSite...",
        statusVerifyingGeoSite: "Verifying GeoSite...",
        statusApplyingUpdates: "Applying updates...",
        statusGeoUpdateComplete: "Geo database update complete",

        // Tunnels
        tunnels: "Port Forwarding",
        add: "Add",
        noTunnels: "No port forwarding rules configured",
        tunnelProtocol: "Protocol",
        tunnelNetwork: "Listen Network",
        tunnelTarget: "Target Address",
        invalidProtocol: "Invalid protocol. Use tcp, udp, or both.",
        invalidAddressFormat: "Invalid listen address format. Use host:port",
        invalidTargetFormat: "Invalid target address format. Use host:port",
        tunStartFailed: "TUN failed to start, restoring core...",

        core: "Mihomo Core",
        curVersion: "Current Version",
        checking: "Checking...",
        checkUpdate: "Check for Updates",
        subscriptions: "Subscriptions",
        subUrlPlaceholder: "Enter subscription URL...",
        modalSubTitle: "Subscription Name",
        notifSubSuccess: "Subscription added successfully",
        notifSubFailed: "Failed to download subscription",
        notifUpdateCheck: "Checking for updates...",
        notifNoUpdate: "Already up to date",
        notifUpdateFound: "Update found: ",
        notifUpdating: "Updating core...",
        notifUpdateSuccess: "Core updated and restarted!",
        notifGeoUpdating: "Updating Geo databases...",
        notifGeoUpdateSuccess: "Geo databases updated and core restarted!",
        notifDownloadingSub: "Downloading subscription...",
        notifSavingAndRestarting: "Saving and restarting core...",
        notifRestartSuccess: "Core restarted successfully!",
        proxyActive: "Proxy Active",
        proxyInactive: "System proxy disabled",
        disconnected: "Disconnected",
        loadingNodes: "Loading nodes...",
        failedToConnect: "Failed to connect to core. Ensure Mihomo is running.",
        noGroupsFound: "No proxy groups found",
        mode: "Running Mode",
        tunMode: "TUN Adapter (Global Route)",
        tunFailed: "Failed to start TUN: Please run as Administrator",
        tunFailedMac: "Failed to start TUN: Please enter password in the popup dialog to authorize",
        tunAuthCanceled: "Authorization canceled",
        tunAuthFailed: "Authorization failed",
        configuring: "Configuring network...",
        configuringTun: "Configuring TUN adapter...",
        configSuccess: "Configuration applied",
        virtualAdapter: "Virtual Adapter",
        rule: "Rule",
        global: "Global",
        direct: "Direct",
        nodeScrolling: "Node Name Scroll",
        nodeScrollingDesc: "Enable scrolling for long node names",
        themeColor: "Theme Color",
        themeColorDesc: "Customize the primary accent color",
        appOpacity: "App Opacity",
        appOpacityDesc: "Adjust main window background opacity",
        restoreDefaults: "Restore Defaults",
        restoreDefaultsDesc: "Reset all settings to default values",
        restoreDefaultsTitle: "Restore Defaults",
        restoreDefaultsConfirm: "Are you sure you want to restore all settings to default values?",
        autostart: "Launch at Login",
        autostartDesc: "Start the application automatically when you sign in",
        configFolder: "Config Folder",
        configFolderDesc: "Open the YAML directory for drag-and-drop imports",
        openFolder: "Open Folder",
        delete: "Delete",
        update: "Update",
        directModePrompt: "In Direct Mode, no traffic is proxied.",
        notifDeleteSuccess: "Config deleted successfully",
        notifDeleteFailed: "Failed to delete config",
        advanced: "Advanced",
        advancedTitle: "Advanced Settings",
        advancedSubtitle: "Dynamic Core Configuration Engine",
        customArgs: "Custom Startup Arguments",
        customArgsDesc: "Extra CLI flags for Mihomo (one per line)",
        applyAndRestart: "Apply & Restart Core",
        utilities: "System Utilities",
        uwpLoopback: "UWP Loopback Exemption",
        uwpLoopbackDesc: "Allow Windows Store apps to use local proxy",
        exemptUwp: "Exempt All UWP",
        notifUwpSuccess: "UWP Loopback exemption process started. Please check the UAC prompt.",
        notifUwpFailed: "Failed to remove UWP restriction",
        uwpExemptTitle: "UWP Loopback Exemption",
        uwpExemptDesc: "This will apply loopback exemption to all UWP apps, which requires Administrator privileges. Do you want to continue?",
        fakeClient: "Subscription Fake Client",
        fakeClientDesc: "Bypass UA sniffing when downloading subscriptions",
        fakeClientWarning: "Warning: Disabling this may cause incorrect config format from subscriptions.",
        custom: "Custom...",
        advancedSubmenu: "Settings Submenu",
        dnsRewrite: "DNS Rewrite (Anti-leak & Fake-IP)",
        dnsRewriteDesc: "Force standard DNS settings to prevent leaks",
        dnsConfigTitle: "DNS Server Configuration",
        dnsConfigDesc: "Customize DNS servers for DNS Rewrite feature",
        dnsNameservers: "Nameservers (DoH)",
        dnsNameserversHint: "One URL per line. Used for domestic resolution.",
        dnsFallbacks: "Fallback Servers (DoH)",
        dnsFallbacksHint: "One URL per line. Used as fallback for international domains.",
        invalidDnsFormat: "Invalid DNS server format. Use https://, tls://, or IP address",
        keyNotPersistedTitle: "Encryption Key Warning",
        keyNotPersistedMessage: "The encryption key could not be persisted. Subscription URLs and other sensitive data will be lost after restart. Please check if the application has write permissions.",
        notifDnsEnabled: "DNS Rewrite enabled",
        notifDnsDisabled: "DNS Rewrite disabled",
        rules: "Rules",
        rulesTitle: "Custom Rules",
        addRule: "Add Rule",
        saveRules: "Save & Apply",
        importSR: "Import SR",
        srPlaceholder: "Paste Shadowrocket Rule URL here...",
        searchRules: "Search rules...",
        type: "Type",
        value: "Value",
        policy: "Policy",
        valueEmpty: "Value cannot be empty",
        confirmAdd: "Confirm Add",
        updateAll: "Update All",
        notifRulesSaved: "Rules saved and applied",
        notifRulesLoadFailed: "Failed to load rules",
        notifRulesParseFailed: "Failed to save or parse rules",
        notifSRImportSuccess: "Shadowrocket rules imported",
        notifSRImportFailed: "Failed to import Shadowrocket rules",
        theme: "Theme",
        themeDesc: "Auto / Light / Dark appearance",
        themeLight: "Light",
        themeAuto: "Auto",
        themeDark: "Dark",
        addSubscription: "Add Subscription",
        urlPlaceholder: "Subscription URL",
        notifUpdateCount: "Updating {count} subscriptions...",
        notifUpdateAllComplete: "Update complete: {success} success, {fail} failed",
        notifNoSubToUpdate: "No subscriptions to update",
        notifSwitchTo: "Switched to",
        requireRestart: "Changes saved, restart core to take full effect",
        requireAppRestart: "Changes saved, restart app to take full effect",
        noProxiesToTest: "No proxies to test in current group",
        latencyTestFailed: "Latency test failed",
        timeout: "Timeout",
        unknown: "Unknown",
        switching: "Switching...",
        addPortForwarding: "Add Port Forwarding",
        // Tray Menu
        trayShow: "Show Zephyr",
        trayQuit: "Quit",
        traySysProxy: "System Proxy",
        trayTunMode: "TUN Mode",
        trayProxyMode: "Proxy Mode",
        traySubscriptions: "Subscriptions",
        trayProxies: "Proxies",

        // Rule buttons
        moveToTop: "Move to Top",
        moveToBottom: "Move to Bottom",
        ruleValuePlaceholder: "e.g. google.com",
        fakeClientCustomPlaceholder: "e.g. MyClient/1.0",
        modalInputPlaceholder: "Name...",
        // Additional translations for error messages
        errorPrefix: "Error",
        profilesImported: "Successfully imported {count} profile(s)",
        cannotDeleteActive: "Cannot delete the active configuration",
        confirmDelete: "Are you sure you want to delete this configuration?",
        githubHomepage: "GitHub Homepage",
        githubHomepageDesc: "Star & Contribute",

        // Error messages
        connectionLost: "Lost connection to core traffic monitor. Click to reconnect.",
        invalidJson: "Invalid JSON format",
        jsYamlError: "js-yaml is not loaded. Check internet connection.",
        jsYamlSaveError: "js-yaml is not loaded. Cannot save/load rules.",
        settingsRestored: "Settings restored to default",
        failedSaveSettings: "Failed to save settings to core",
        partialRestore: "Some settings failed to restore",
        restoreFailed: "Failed to restore defaults",
        configParseErrorTitle: "Configuration Parse Error",
        configParseErrorMsg: "Configuration file could not be parsed. Using empty config.",

        // Storage
        usedSpace: "used",
        totalSpace: "total",
        save: "Save",

        // Tunnel
        listen: "Listen",

        // Status
        loading: "Loading...",

        // Connections Page
        connections: "Connections",
        connectionsTitle: "Connections",
        searchConnections: "Search connections...",
        closeAll: "Close All",
        refresh: "Refresh",
        totalConn: "Total",
        dlTotal: "\u2193 Total",
        ulTotal: "\u2191 Total",
        activeConn: "Active",
        hostCol: "Host",
        ruleCol: "Rule",
        chainsCol: "Chains",
        dlCol: "\u2193 Download",
        ulCol: "\u2191 Upload",
        dlSpeedCol: "\u2193 DL Speed",
        dlTotalCol: "\u2193 DL Total",
        ulSpeedCol: "\u2191 UL Speed",
        ulTotalCol: "\u2191 UL Total",
        dlSpeedLabel: "Download Speed",
        ulSpeedLabel: "Upload Speed",
        totalLabel: "Total",
        activeTab: "Active",
        closedTab: "Closed",
        closedItems: "closed",
        clearAll: "Clear All",
        clearing: "Clearing...",
        connsCleared: "Closed history cleared",
        clearConnsFailed: "Failed to clear history",
        connClosed: "Connection closed",
        closeConnFailed: "Failed to close connection",
        closeConn: "Close Connection",
        noConnections: "No active connections",
        noConnectionsHint: "Connections will appear here as traffic flows through the proxy",
        noClosedConns: "No closed connections yet",
        noClosedConnsHint: "Closed connections will appear here after you close them",
        loadFailed: "Failed to load connections",
        closing: "Closing...",
        processLabel: "Process",
        typeLabel: "Type",
        sourceLabel: "Source",
        networkLabel: "Network",
        durationLabel: "Duration",
        closedAtLabel: "Closed at",
        connsClosed: "All connections closed",
        closeConnsFailed: "Failed to close connections",

        // Logs Page
        logs: "Logs",
        logsTitle: "Core Logs",
        noLogs: "No log entries yet. Start the core to see logs.",
        autoScroll: "Auto Scroll",
        searchLogs: "Search logs...",
        clearFilter: "Show All",
        logLevelAll: "All",
        logLevelDebug: "Debug",
        logLevelInfo: "Info",
        logLevelWarn: "Warn",
        logLevelError: "Error",
        logPaused: "Paused",
        logLines: "lines",

        // Deep Link
        deepLinkTitle: "Import from Deep Link",
        deepLinkConfirm: "Import configuration from",

        // Global Shortcut
        globalShortcut: "Global Shortcuts",
        globalShortcutDesc: "Configure keyboard shortcuts for quick actions",
        shortcutToggleWindow: "Toggle Window",
        shortcutToggleProxy: "Toggle System Proxy",
        shortcutToggleTun: "Toggle TUN Mode",
        shortcutModeRule: "Rule Mode",
        shortcutModeGlobal: "Global Mode",
        shortcutModeDirect: "Direct Mode",
        enableGlobalShortcuts: "Enable Global Shortcuts",
        tunEnabled: "TUN enabled",
        tunDisabled: "TUN disabled",
        tunToggleFailed: "TUN toggle failed",
        switchedTo: "Switched to",
        modeSwitchFailed: "Mode switch failed",
        modeRule: "Rule",
        modeGlobal: "Global",
        modeDirect: "Direct",

        // Client Update
        clientUpdate: "Client Update",
        clientUpdateDesc: "Check for Zephyr application updates",
        clientChecking: "Checking for updates...",
        clientUpdateAvailable: "Update Available",
        clientNewVersion: "A new version is available.",
        clientUpdateSuccess: "Update downloaded successfully",
        clientUpdateFailed: "Update check failed",
        clientUpToDate: "Client is up to date",
        clientNewVersionTag: "Latest version: {version}",

        // Auto update & core/client distinction
        autoUpdateClient: "Auto-check client updates",
        autoUpdateClientDesc: "Automatically check for Zephyr client updates on startup",
        coreUpdate: "Core Update",

        // Dual update notification
        bothUpdateAvailable: "Both core and client have updates",
        recommendFullVersion: "Recommend installing Full version",

        // Version display
        appVersion: "App",
        coreVersion: "Core",

        // Shortcut modal
        configure: "Configure",
        addShortcut: "Add Shortcut",
        selectAction: "Select action",
        shortcutSelectAction: "Please select an action",
        actionName: "Action name",
        clickToRecord: "Click to record",
        pressKeys: "Press keys...",
        shortcutEmpty: "Action and key are required",
        shortcutSaved: "Shortcut saved",
        shortcutCleared: "Shortcut cleared",
        shortcutFailed: "Failed to save shortcut",
        done: "Done",
        shortcutTooLong: "Shortcut too long",
        shortcutInvalidFormat: "Invalid shortcut format",
    },

    zh: {
        home: "首页",
        proxies: "代理节点",
        settings: "系统设置",
        downstream: "下载速度",
        upstream: "上传速度",
        sysProxy: "系统代理控制",
        proxyStatusReady: "已准备好保护您的流量",
        proxyStatusActive: "代理已激活",
        traffic: "实时流量监控",
        proxiesTitle: "节点选择",
        sortDefault: "默认排序",
        sortLatency: "按延迟",
        sortName: "按名称",
        latency: "延迟",
        testLatency: "测试延迟",
        settingsTitle: "设置",
        general: "常规设置",
        language: "语言",
        languageDesc: "选择界面显示语言",
        minToTray: "最小化到托盘",
        minToTrayDesc: "关闭窗口时隐藏到后台，而不是退出",
        autoCheckUpdate: "自动检查内核更新",
        autoCheckUpdateDesc: "启动时自动检查核心更新",
        confirm: "确定",
        cancel: "取消",

        // Network & Routing
        networkRouting: "网络与路由",
        unifiedDelay: "统一延迟",
        unifiedDelayDesc: "使用统一的延迟测试策略",
        ipv6Support: "IPv6 支持",
        ipv6SupportDesc: "允许路由和连接 IPv6 网络",
        allowLan: "局域网连接",
        allowLanDesc: "允许局域网内的其他设备连接此代理",
        geoData: "Geo 数据库",
        geoDataDesc: "更新 GeoIP 和 GeoSite 路由数据库",
        updateNow: "立即更新",

        // Core update status messages (keys match Rust backend)
        statusDownloadingCore: "正在从 GitHub 下载核心...",
        statusDownloadingProgress: "正在下载核心... {progress}%",
        statusPreparingUpdate: "正在准备更新 Mihomo 核心...",
        statusVerifyingFile: "正在验证文件完整性...",
        statusExtractingCore: "下载完成，正在解压核心...",
        statusWritingFiles: "正在写入核心文件...",
        statusRestartingCore: "更新完成，正在重启核心...",
        statusCoreReady: "核心已就绪",
        statusFetchingVerify: "正在获取校验信息...",
        statusDownloadingGeoIP: "正在下载 GeoIP...",
        statusVerifyingGeoIP: "正在验证 GeoIP...",
        statusDownloadingGeoSite: "正在下载 GeoSite...",
        statusVerifyingGeoSite: "正在验证 GeoSite...",
        statusApplyingUpdates: "正在应用更新...",
        statusGeoUpdateComplete: "Geo 数据库更新完成",

        // Tunnels
        tunnels: "代理端口转发",
        add: "添加",
        noTunnels: "暂无端口转发规则",
        tunnelProtocol: "协议",
        tunnelNetwork: "监听网络",
        tunnelTarget: "目标地址",
        invalidProtocol: "无效的协议。请使用 tcp、udp 或 both。",
        invalidAddressFormat: "无效的监听地址格式。请使用 主机:端口",
        invalidTargetFormat: "无效的目标地址格式。请使用 主机:端口",

        core: "内核管理",
        curVersion: "当前版本",
        checking: "正在检查...",
        checkUpdate: "检查更新",
        subscriptions: "订阅管理",
        subUrlPlaceholder: "输入订阅链接...",
        modalSubTitle: "订阅命名",
        notifSubSuccess: "订阅添加成功",
        notifSubFailed: "订阅下载失败",
        notifUpdateCheck: "正在检查更新...",
        notifNoUpdate: "当前已是最新版本",
        notifUpdateFound: "发现新版本",
        notifUpdating: "正在更新内核...",
        notifUpdateSuccess: "内核已更新并重启！",
        notifGeoUpdating: "正在更新 Geo 数据库...",
        notifGeoUpdateSuccess: "Geo 数据库已更新并重启核心！",
        notifDownloadingSub: "正在下载订阅...",
        notifSavingAndRestarting: "正在保存并重启核心...",
        notifRestartSuccess: "核心重启成功！",
        proxyActive: "代理已激活",
        proxyInactive: "系统代理已关闭",
        disconnected: "未连接",
        loadingNodes: "正在加载节点...",
        failedToConnect: "连接核心失败，请确保 Mihomo 已启动。",
        noGroupsFound: "未找到代理选择组",
        mode: "运行模式",
        tunMode: "TUN 虚拟网卡 (全局路由)",
        tunFailed: "开启 TUN 失败：请右键以管理员身份运行本程序",
        tunFailedMac: "开启 TUN 失败：请在弹出的密码框中输入开机密码授权",
        tunAuthCanceled: "授权已取消",
        tunAuthFailed: "授权失败",
        tunStartFailed: "TUN 启动失败，正在恢复核心...",
        configuring: "正在配置网络...",
        configuringTun: "正在配置虚拟网卡...",
        configSuccess: "配置已生效",
        virtualAdapter: "虚拟网卡模式",
        rule: "分流规则",
        global: "全局代理",
        direct: "直接连接",
        nodeScrolling: "节点名称滚动",
        nodeScrollingDesc: "开启长节点名称自动滚动效果",
        themeColor: "主题颜色",
        themeColorDesc: "自定义界面的主题强调色",
        appOpacity: "应用不透明度",
        appOpacityDesc: "调整主窗口的背景不透明度",
        restoreDefaults: "恢复默认设置",
        restoreDefaultsDesc: "将所有设置重置为默认值",
        restoreDefaultsTitle: "恢复默认设置",
        restoreDefaultsConfirm: "确定要将所有设置恢复为默认值吗？",
        autostart: "开机自启动",
        autostartDesc: "在您登录系统时自动启动应用",
        configFolder: "配置文件夹",
        configFolderDesc: "打开 YAML 配置目录，方便拖拽导入",
        openFolder: "打开文件夹",
        delete: "删除",
        update: "更新",
        directModePrompt: "当前处于直连模式，不通过代理。",
        notifDeleteSuccess: "配置文件已成功删除",
        notifDeleteFailed: "删除配置文件失败",
        advanced: "高级设置",
        advancedTitle: "高级配置",
        advancedSubtitle: "动态内核配置引擎",
        customArgs: "自定义启动参数",
        customArgsDesc: "传给 Mihomo 的额外命令行参数（每行一个）",
        applyAndRestart: "应用并重启内核",
        utilities: "系统工具集",
        uwpLoopback: "UWP 环回免除",
        uwpLoopbackDesc: "允许 Windows 商店应用使用本地代理",
        exemptUwp: "免除全部 UWP",
        notifUwpSuccess: "UWP 环回免除进程已启动，请在弹出的 UAC 窗口中确认。",
        notifUwpFailed: "解除 UWP 限制失败",
        uwpExemptTitle: "UWP 环回免除",
        uwpExemptDesc: "这将会对所有 UWP 应用应用环回免除，需要管理员权限。是否继续？",
        fakeClient: "启用订阅客户端伪装",
        fakeClientDesc: "下载订阅时修改 User-Agent 以绕过机场嗅探",
        fakeClientWarning: "警告：关闭此项可能导致部分机场返回不兼容的订阅格式",
        custom: "自定义...",
        advancedSubmenu: "设置子菜单",
        dnsRewrite: "DNS 覆写 (防泄漏 & Fake-IP)",
        dnsRewriteDesc: "强行修复 DNS 设置，防止泄漏并开启 Fake-IP",
        dnsConfigTitle: "DNS 服务器配置",
        dnsConfigDesc: "自定义 DNS 覆写功能使用的服务器",
        dnsNameservers: "主 DNS 服务器 (DoH)",
        dnsNameserversHint: "每行一个地址。用于国内域名解析。",
        dnsFallbacks: "备用 DNS 服务器 (DoH)",
        dnsFallbacksHint: "每行一个地址。用于国外域名解析。",
        invalidDnsFormat: "DNS 服务器格式无效。请使用 https://、tls:// 或 IP 地址",
        keyNotPersistedTitle: "加密密钥警告",
        keyNotPersistedMessage: "加密密钥无法持久化。订阅链接等敏感数据将在重启后丢失。请检查应用程序是否有写入权限。",
        notifDnsEnabled: "DNS 覆写已开启",
        notifDnsDisabled: "DNS 覆写已关闭",
        rules: "规则管理",
        rulesTitle: "自定义规则",
        addRule: "新增规则",
        saveRules: "保存并应用",
        importSR: "导入 SR 规则",
        srPlaceholder: "在此粘贴 Shadowrocket 规则链接...",
        searchRules: "搜索规则...",
        type: "类型",
        value: "值",
        policy: "策略",
        valueEmpty: "值不能为空",
        confirmAdd: "确认添加",
        updateAll: "全部更新",
        notifRulesSaved: "规则已保存并热重载",
        notifRulesLoadFailed: "加载规则失败",
        notifRulesParseFailed: "规则保存或解析失败",
        notifSRImportSuccess: "Shadowrocket 规则导入成功",
        notifSRImportFailed: "导入 Shadowrocket 规则失败",
        addSubscription: "添加订阅",
        urlPlaceholder: "订阅链接地址",
        theme: "主题",
        themeDesc: "自动 / 浅色 / 深色外观",
        themeLight: "浅色",
        themeAuto: "自动",
        themeDark: "深色",
        notifUpdateCount: "正在更新 {count} 个订阅...",
        notifUpdateAllComplete: "更新完成：{success} 成功，{fail} 失败",
        notifNoSubToUpdate: "没有可更新的订阅",
        notifSwitchTo: "已切换到",
        requireRestart: "更改已保存，需重启核心生效",
        requireAppRestart: "更改已保存，需重启应用生效",
        noProxiesToTest: "当前分组没有可测试的节点",
        latencyTestFailed: "延迟测试失败",
        timeout: "超时",
        unknown: "未知",
        switching: "切换中...",
        addPortForwarding: "添加端口转发",
        // Tray Menu
        trayShow: "显示主界面",
        trayQuit: "退出应用",
        traySysProxy: "系统代理",
        trayTunMode: "TUN 模式",
        trayProxyMode: "代理模式",
        traySubscriptions: "订阅选择",
        trayProxies: "节点选择",

        // Rule buttons
        moveToTop: "移至顶部",
        moveToBottom: "移至底部",
        ruleValuePlaceholder: "例如：google.com",
        fakeClientCustomPlaceholder: "例如：MyClient/1.0",
        modalInputPlaceholder: "名称...",
        // Additional translations for error messages
        errorPrefix: "错误",
        profilesImported: "成功导入 {count} 个配置文件",
        cannotDeleteActive: "无法删除当前使用的配置文件",
        confirmDelete: "确定要删除此配置文件吗？",
        githubHomepage: "GitHub 主页",
        githubHomepageDesc: "Star 与贡献",

        // Error messages
        connectionLost: "核心流量监控连接丢失，点击重连。",
        invalidJson: "JSON 格式无效",
        jsYamlError: "js-yaml 未加载，请检查网络连接。",
        jsYamlSaveError: "js-yaml 未加载，无法保存/加载规则。",
        settingsRestored: "设置已恢复为默认值",
        failedSaveSettings: "保存设置到核心失败",
        partialRestore: "部分设置恢复失败",
        restoreFailed: "恢复默认设置失败",
        configParseErrorTitle: "配置文件解析错误",
        configParseErrorMsg: "配置文件解析失败，将使用空配置。",

        // Storage
        usedSpace: "已用",
        totalSpace: "总计",
        save: "保存",

        // Tunnel
        listen: "监听",

        // Status
        loading: "加载中...",

        // Connections Page
        connections: "连接详情",
        connectionsTitle: "连接详情",
        searchConnections: "搜索连接...",
        closeAll: "全部关闭",
        refresh: "刷新",
        totalConn: "总数",
        dlTotal: "\u2193 下载总量",
        ulTotal: "\u2191 上传总量",
        activeConn: "活跃",
        hostCol: "主机",
        ruleCol: "规则",
        chainsCol: "链路",
        dlCol: "\u2193 下载量",
        ulCol: "\u2191 上传量",
        dlSpeedCol: "\u2193 下载速率",
        dlTotalCol: "\u2193 下载总量",
        ulSpeedCol: "\u2191 上传速率",
        ulTotalCol: "\u2191 上传总量",
        dlSpeedLabel: "下载速率",
        ulSpeedLabel: "上传速率",
        totalLabel: "总量",
        activeTab: "活跃连接",
        closedTab: "已关闭",
        closedItems: "条已关闭",
        clearAll: "清除全部",
        clearing: "正在清除...",
        connsCleared: "已清空关闭历史",
        clearConnsFailed: "清除失败",
        connClosed: "连接已关闭",
        closeConnFailed: "关闭连接失败",
        closeConn: "关闭连接",
        noConnections: "暂无活跃连接",
        noConnectionsHint: "流量经过代理时，连接将显示在此处",
        noClosedConns: "暂无已关闭的连接",
        noClosedConnsHint: "关闭连接后，记录将显示在这里",
        loadFailed: "加载连接失败",
        closing: "正在关闭...",
        processLabel: "进程",
        typeLabel: "类型",
        sourceLabel: "来源",
        networkLabel: "网络",
        durationLabel: "持续时间",
        closedAtLabel: "关闭时间",
        connsClosed: "已关闭所有连接",
        closeConnsFailed: "关闭连接失败",

        // Logs Page
        logs: "运行日志",
        logsTitle: "核心日志",
        noLogs: "暂无日志，启动核心后即可查看。",
        autoScroll: "自动滚动",
        searchLogs: "搜索日志...",
        clearFilter: "显示全部",
        logLevelAll: "全部",
        logLevelDebug: "调试",
        logLevelInfo: "信息",
        logLevelWarn: "警告",
        logLevelError: "错误",
        logPaused: "已暂停",
        logLines: "行",

        // Deep Link
        deepLinkTitle: "从 Deep Link 导入",
        deepLinkConfirm: "导入配置来自",

        // Global Shortcut
        globalShortcut: "全局快捷键",
        globalShortcutDesc: "配置快捷键以快速操作",
        shortcutToggleWindow: "切换窗口显示",
        shortcutToggleProxy: "切换系统代理",
        shortcutToggleTun: "切换 TUN 模式",
        shortcutModeRule: "规则模式",
        shortcutModeGlobal: "全局模式",
        shortcutModeDirect: "直连模式",
        enableGlobalShortcuts: "启用全局快捷键",
        tunEnabled: "TUN 已启用",
        tunDisabled: "TUN 已关闭",
        tunToggleFailed: "TUN 切换失败",
        switchedTo: "已切换到",
        modeSwitchFailed: "模式切换失败",
        modeRule: "规则",
        modeGlobal: "全局",
        modeDirect: "直连",

        // Client Update
        clientUpdate: "客户端更新",
        clientUpdateDesc: "检查 Zephyr 应用程序更新",
        clientChecking: "正在检查更新...",
        clientUpdateAvailable: "发现新版本",
        clientNewVersion: "有新版本可用。",
        clientUpdateSuccess: "更新下载成功",
        clientUpdateFailed: "更新检查失败",
        clientUpToDate: "客户端已是最新版本",
        clientNewVersionTag: "最新版本: {version}",

        // Auto update & core/client distinction
        autoUpdateClient: "自动检查软件更新",
        autoUpdateClientDesc: "启动时自动检查 Zephyr 客户端更新",
        coreUpdate: "内核更新",

        // Dual update notification
        bothUpdateAvailable: "内核和软件都有更新",
        recommendFullVersion: "推荐安装 Full 版本",

        // Version display
        appVersion: "软件",
        coreVersion: "内核",

        // Shortcut modal
        configure: "配置",
        addShortcut: "添加快捷键",
        selectAction: "选择操作",
        shortcutSelectAction: "请选择一个操作",
        actionName: "动作名称",
        clickToRecord: "点击录制",
        pressKeys: "按下按键...",
        shortcutEmpty: "动作名称和按键不能为空",
        shortcutSaved: "快捷键已保存",
        shortcutCleared: "快捷键已清除",
        shortcutFailed: "保存快捷键失败",
        done: "完成",
        shortcutTooLong: "快捷键过长",
        shortcutInvalidFormat: "快捷键格式无效",
    },

    ja: {
        home: "ホーム",
        proxies: "プロキシ",
        settings: "設定",
        confirm: "確認",
        cancel: "キャンセル",
        delete: "",
        language: "言語",
        languageDesc: "表示言語を選択",
        loading: "読み込み中...",
        errorPrefix: "エラー",
        unknown: "不明",

        // New keys (empty — fallback to English)
        save: "",
        globalShortcut: "",
        globalShortcutDesc: "",
        shortcutToggleWindow: "",
        shortcutToggleProxy: "",
        shortcutToggleTun: "",
        shortcutModeRule: "",
        shortcutModeGlobal: "",
        shortcutModeDirect: "",
        enableGlobalShortcuts: "",
        tunEnabled: "",
        tunDisabled: "",
        tunToggleFailed: "",
        switchedTo: "",
        modeSwitchFailed: "",
        modeRule: "",
        modeGlobal: "",
        modeDirect: "",
        clientUpdate: "",
        clientUpdateDesc: "",
        autoUpdateClient: "",
        autoUpdateClientDesc: "",
        clientChecking: "",
        clientUpdateAvailable: "",
        clientNewVersion: "",
        clientUpdateSuccess: "",
        clientUpdateFailed: "",
        clientUpToDate: "",
        clientNewVersionTag: "",
        bothUpdateAvailable: "",
        recommendFullVersion: "",
        coreUpdate: "",

        proxyActive: "",
        proxyInactive: "",

        // Version display
        appVersion: "",
        coreVersion: "",

        // Shortcut modal
        configure: "",
        addShortcut: "",
        selectAction: "",
        shortcutSelectAction: "",
        actionName: "",
        clickToRecord: "",
        pressKeys: "",
        shortcutEmpty: "",
        shortcutSaved: "",
        shortcutCleared: "",
        shortcutFailed: "",
        done: "",
        shortcutTooLong: "",
        shortcutInvalidFormat: "",

        // Logs Page
        logs: "ログ",
        logsTitle: "コアログ",
        noLogs: "ログがありません。コアを起動してください。",
        autoScroll: "自動スクロール",
        searchLogs: "ログを検索...",
        clearFilter: "すべて表示",
        logLevelAll: "すべて",
        logLevelDebug: "デバッグ",
        logLevelInfo: "情報",
        logLevelWarn: "警告",
        logLevelError: "エラー",
        logPaused: "一時停止",
        logLines: "行",
    },

    ko: {
        home: "홈",
        proxies: "프록시",
        settings: "설정",
        confirm: "확인",
        cancel: "취소",
        delete: "",
        language: "언어",
        languageDesc: "표시 언어 선택",
        loading: "로딩 중...",
        errorPrefix: "오류",
        unknown: "알 수 없음",

        // New keys (empty — fallback to English)
        save: "",
        globalShortcut: "",
        globalShortcutDesc: "",
        shortcutToggleWindow: "",
        shortcutToggleProxy: "",
        shortcutToggleTun: "",
        shortcutModeRule: "",
        shortcutModeGlobal: "",
        shortcutModeDirect: "",
        enableGlobalShortcuts: "",
        tunEnabled: "",
        tunDisabled: "",
        tunToggleFailed: "",
        switchedTo: "",
        modeSwitchFailed: "",
        modeRule: "",
        modeGlobal: "",
        modeDirect: "",
        clientUpdate: "",
        clientUpdateDesc: "",
        autoUpdateClient: "",
        autoUpdateClientDesc: "",
        clientChecking: "",
        clientUpdateAvailable: "",
        clientNewVersion: "",
        clientUpdateSuccess: "",
        clientUpdateFailed: "",
        clientUpToDate: "",
        clientNewVersionTag: "",
        bothUpdateAvailable: "",
        recommendFullVersion: "",
        coreUpdate: "",

        proxyActive: "",
        proxyInactive: "",

        // Version display
        appVersion: "",
        coreVersion: "",

        // Shortcut modal
        configure: "",
        addShortcut: "",
        selectAction: "",
        shortcutSelectAction: "",
        actionName: "",
        clickToRecord: "",
        pressKeys: "",
        shortcutEmpty: "",
        shortcutSaved: "",
        shortcutCleared: "",
        shortcutFailed: "",
        done: "",
        shortcutTooLong: "",
        shortcutInvalidFormat: "",

        // Logs Page
        logs: "로그",
        logsTitle: "코어 로그",
        noLogs: "로그가 없습니다. 코어를 시작하세요.",
        autoScroll: "자동 스크롤",
        searchLogs: "로그 검색...",
        clearFilter: "모두 보기",
        logLevelAll: "전체",
        logLevelDebug: "디버그",
        logLevelInfo: "정보",
        logLevelWarn: "경고",
        logLevelError: "오류",
        logPaused: "일시 정지",
        logLines: "줄",
    },
};

// ---------------------------------------------------------------------------
// Language state
// ---------------------------------------------------------------------------

/**
 * Detect system language from navigator.
 * @returns {string} Detected language code, defaults to 'en'.
 */
export function detectSystemLanguage() {
    const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
    // Only return a language that we actually have translations for
    const langKey = /** @type {'en'|'zh'|'ja'|'ko'} */(lang);
    return translations[langKey] ? lang : 'en';
}

/**
 * Current active language. Initialized from localStorage or system detection.
 * Mutable so UI modules can react to language changes.
 */
const _savedLang = typeof localStorage !== 'undefined' ? localStorage.getItem('lang') : null;
export let currentLang = _savedLang || detectSystemLanguage();
if (_savedLang === null && typeof localStorage !== 'undefined') {
    localStorage.setItem('lang', currentLang);
}

// ---------------------------------------------------------------------------
// QA mode
// ---------------------------------------------------------------------------

let _qaMode = false;

/**
 * Enable or disable QA mode. When enabled, `t()` returns the raw key
 * wrapped in `**` markers so translators can spot untranslated strings.
 * @param {boolean} enabled
 */
export function setQAMode(enabled) {
    _qaMode = !!enabled;
}

/**
 * @returns {boolean} Whether QA mode is currently active.
 */
export function isQAMode() {
    return _qaMode;
}

// ---------------------------------------------------------------------------
// CLDR plural category resolver (Intl.PluralRules)
// ---------------------------------------------------------------------------

/** @type {Map<string, Intl.PluralRules>} */
const _pluralRulesCache = new Map();

/**
 * Obtain a cached Intl.PluralRules instance for the given locale.
 * Falls back to 'en' if the locale is unsupported.
 * @param {string} lang
 * @returns {Intl.PluralRules}
 */
function _getPluralRules(lang) {
    let rules = _pluralRulesCache.get(lang);
    if (!rules) {
        try {
            rules = new Intl.PluralRules(lang);
        } catch {
            rules = new Intl.PluralRules('en');
        }
        _pluralRulesCache.set(lang, rules);
    }
    return rules;
}

/**
 * Determine the CLDR plural category for a given count + language.
 * Uses Intl.PluralRules for full CLDR-compliant pluralization across all locales.
 * @param {number} count
 * @param {string} lang
 * @returns {'zero'|'one'|'two'|'few'|'many'|'other'}
 */
function pluralCategory(count, lang) {
    const n = Math.abs(Number(count));
    if (!Number.isFinite(n)) return 'other';
    return _getPluralRules(lang).select(n);
}

// ---------------------------------------------------------------------------
// Interpolation engine
// ---------------------------------------------------------------------------

const INTERPOLATE_RE = /@@(\w+)@@/g;

/**
 * Replace all `@@variable@@` placeholders in a template string.
 * Logs a warning for any unresolved placeholders.
 * @param {string} template
 * @param {Object<string, *>} vars
 * @param {string} [key] - Translation key (used in warning messages)
 * @returns {string}
 */
function interpolate(template, vars, key) {
    if (!vars || typeof template !== 'string') return template;
    return template.replace(INTERPOLATE_RE, (_match, varName) => {
        if (Object.prototype.hasOwnProperty.call(vars, varName)) {
            return vars[varName];
        }
        i18nLogger.warn(`Missing interpolation: key="${key}", variable="${varName}"`);
        return _match;
    });
}

// ---------------------------------------------------------------------------
// Fallback chain resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a translation key through the fallback chain: currentLang -> en.
 * @param {string} key
 * @returns {{ value: string, found: boolean }}
 */
function resolveKey(key) {
    const langKey = /** @type {'en'|'zh'|'ja'|'ko'} */(currentLang);
    const primary = /** @type {Record<string, string>} */(translations[langKey]);
    if (primary && Object.prototype.hasOwnProperty.call(primary, key)) {
        return { value: primary[key], found: true };
    }
    const fallback = /** @type {Record<string, string>} */(translations.en);
    if (fallback && Object.prototype.hasOwnProperty.call(fallback, key)) {
        return { value: fallback[key], found: true };
    }
    return { value: key, found: false };
}

// ---------------------------------------------------------------------------
// Core translation function
// ---------------------------------------------------------------------------

/**
 * Translate a key with optional interpolation and pluralization.
 *
 * Usage:
 *   t('hello')                                    // simple lookup
 *   t('greeting', { name: 'World' })              // interpolation
 *   t('items', 5)                                 // plural: one/other
 *   t('items', 5, { type: 'file' })               // plural + interpolation
 *
 * @param {string} key - Translation key.
 * @param {Object<string, *>|number} [optionsOrCount] - Interpolation vars OR a numeric count for pluralization.
 * @param {Object<string, *>} [extraVars] - Additional interpolation vars (used with count).
 * @returns {string}
 */
export function t(key, optionsOrCount, extraVars) {
    // QA mode: return raw key wrapped in markers
    if (_qaMode) {
        return `**${key}**`;
    }

    // Resolve the raw value through fallback chain
    const { value } = resolveKey(key);

    // Pluralization path: second argument is a number
    if (typeof optionsOrCount === 'number') {
        const count = optionsOrCount;
        // value must be a plural object like { one: "...", other: "..." }
        if (typeof value === 'object' && value !== null) {
            const category = pluralCategory(count, currentLang);
            /** @type {Record<string, string>} */
            const pluralObj = value;
            const template = pluralObj[category] || pluralObj.other || pluralObj.one || '';
            return interpolate(template, { count, ...extraVars }, key);
        }
        // Fallback: value is a plain string, inject count as @@count@@
        return interpolate(value, { count, ...extraVars }, key);
    }

    // Interpolation path: second argument is an object
    if (optionsOrCount && typeof optionsOrCount === 'object') {
        return interpolate(value, optionsOrCount, key);
    }

    // Simple lookup
    return value;
}

// ---------------------------------------------------------------------------
// HTML lang / dir attribute management
// ---------------------------------------------------------------------------

/**
 * Set `lang` and `dir` attributes on the <html> element for a given language.
 * Uses BCP 47 format for the lang attribute and detects RTL/LTR direction.
 * @param {string} language - ISO 639-1 language code (e.g. 'en', 'zh', 'ar')
 */
export function setHTMLAttributes(language) {
    const html = document.documentElement;
    html.setAttribute('lang', language);
    html.setAttribute('dir', isRTL(language) ? 'rtl' : 'ltr');
}

/**
 * Get locale attributes for a given locale string.
 * Returns an object with `dir` and `lang` properties, useful for
 * programmatic attribute application (e.g. in React, Vue, or SSR contexts).
 * @param {string} locale - BCP 47 locale string (e.g. 'en-US', 'ar-SA')
 * @returns {{ dir: 'rtl'|'ltr', lang: string }}
 */
export function getLocAttributes(locale) {
    const lang = locale.slice(0, 2).toLowerCase();
    return {
        dir: isRTL(lang) ? 'rtl' : 'ltr',
        lang: locale,
    };
}

// ---------------------------------------------------------------------------
// Language setter
// ---------------------------------------------------------------------------

/**
 * Set the active language, persist to localStorage, update HTML attributes,
 * and re-apply DOM translations.
 * @param {string} lang
 */
export function setLanguage(lang) {
    const langKey = /** @type {'en'|'zh'|'ja'|'ko'} */(lang);
    if (!translations[langKey]) {
        i18nLogger.warn(`Unknown language "${lang}", falling back to "en"`);
        lang = 'en';
    }
    currentLang = lang;
    if (typeof localStorage !== 'undefined') {
        localStorage.setItem('lang', lang);
    }
    setHTMLAttributes(lang);
    applyTranslations();
}

// ---------------------------------------------------------------------------
// DOM translation applier
// ---------------------------------------------------------------------------

/**
 * Walk all `[data-i18n]` and `[data-i18n-placeholder]` elements and replace
 * their text content / placeholder with the corresponding translated string.
 * Updates HTML lang/dir attributes and dispatches an `i18n-applied` CustomEvent when done.
 */
export function applyTranslations() {
    setHTMLAttributes(currentLang);

    document.querySelectorAll('[data-i18n]').forEach((el) => {
        const key = el.getAttribute('data-i18n');
        if (!key) return;
        const translated = t(key);
        if (translated !== key || _qaMode) {
            el.textContent = translated;
        }
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
        const inputEl = /** @type {HTMLInputElement} */ (el);
        const key = inputEl.getAttribute('data-i18n-placeholder');
        if (!key) return;
        const translated = t(key);
        if (translated !== key || _qaMode) {
            inputEl.placeholder = translated;
        }
    });

    document.querySelectorAll('[data-latency-label]').forEach(el => {
        el.textContent = t('latency');
    });

    if (typeof invoke === 'function') {
        /** @type {HTMLInputElement|null} */
        const sysProxyToggle = document.querySelector('#sys-proxy-toggle');
        /** @type {HTMLInputElement|null} */
        const tunToggle = document.querySelector('#tun-proxy-toggle');

        /** @type {any} */
        const win = window;
        const sysProxyEnabled = sysProxyToggle?.checked ?? win._currentSysProxyEnabled ?? false;
        const tunEnabled = tunToggle?.checked ?? win._currentTunEnabled ?? false;

        invoke('update_tray_toggle_states', {
            sysProxyEnabled,
            tunEnabled,
        }).catch(e => i18nLogger.warn("Failed to update tray menu", e));
    }

    window.dispatchEvent(new CustomEvent('i18n-applied'));
}

// ---------------------------------------------------------------------------
// Backend status message mapper (preserved for backward compatibility)
// ---------------------------------------------------------------------------

/**
 * Map backend status messages to localized strings.
 * Backend sends English status as key, frontend maps to current language.
 * @param {string} statusText
 * @param {number|null} [progress]
 * @returns {string}
 */
export function mapStatusMessage(statusText, progress = null) {
    // Handle progress messages
    if (statusText.includes('Downloading core...') && progress !== null) {
        return t('statusDownloadingProgress').replace('{progress}', String(progress));
    }

    /** @type {Record<string, string>} */
    const statusMap = {
        'Downloading core from GitHub...': 'statusDownloadingCore',
        'Preparing to update Mihomo core...': 'statusPreparingUpdate',
        'Verifying file integrity...': 'statusVerifyingFile',
        'Download complete, extracting core...': 'statusExtractingCore',
        'Writing core files...': 'statusWritingFiles',
        'Update complete, restarting core...': 'statusRestartingCore',
        'Core ready': 'statusCoreReady',
        'Fetching verification info...': 'statusFetchingVerify',
        'Downloading GeoIP...': 'statusDownloadingGeoIP',
        'Verifying GeoIP...': 'statusVerifyingGeoIP',
        'Downloading GeoSite...': 'statusDownloadingGeoSite',
        'Verifying GeoSite...': 'statusVerifyingGeoSite',
        'Applying updates...': 'statusApplyingUpdates',
        'Geo database update complete': 'statusGeoUpdateComplete',
    };

    const key = statusMap[statusText];
    return key ? t(key) : statusText;
}
