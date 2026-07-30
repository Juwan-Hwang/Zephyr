// @ts-check
/**
 * Zephyr i18n System
 *
 * Features: interpolation (@@var@@), CLDR pluralization via Intl.PluralRules,
 * fallback chain, QA mode, RTL detection, ja/ko skeletons,
 * HTML lang/dir attributes, locale attribute introspection.
 */

import { invoke } from './api.js';
import { COMMANDS } from '@zephyr/shared';
import { i18nLogger } from './utils/logger.js';
import { Bus, Events } from './ui/events.js';

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
        sortSmart: "Smart",
        latency: "Latency",
        testLatency: "Test Latency",
        hideTimeout: "Hide Timeout",
        hideTimeoutDesc: "Hide unavailable proxy nodes in the list",
        failover: "Failover",
        failoverDesc: "Auto-switch when current node fails consecutively",
        failoverSwitched: "Failover: switched from @@failed@@ to @@target@@",
        encryptConfigs: "Encrypt Configs",
        encryptConfigsDesc: "Encrypt config files with machine key, preventing use on other devices",
        encryptConfigsConfirmEnable: "Enabling encryption will immediately encrypt all existing config files. You will not be able to edit config files with an external editor. Continue?",
        encryptConfigsConfirmDisable: "Disabling encryption will immediately decrypt all config files to plaintext. Continue?",
        encryptConfigsEnabled: "Config files encrypted",
        encryptConfigsDisabled: "Config files decrypted",
        logSettings: "Log Settings",
        logSettingsDesc: "Persist and export application and core logs",
        logAppTab: "App Logs",
        logCoreTab: "Core Logs",
        logAppEnabled: "Persist App Logs",
        logCoreEnabled: "Persist Core Logs",
        logRetentionDays: "Retention Days",
        logMaxFileMb: "Max File Size",
        logDaysUnit: "days",
        logMbUnit: "MB",
        logExportTitle: "Export Logs",
        logExportFrom: "From",
        logExportTo: "To",
        logExportLevel: "Severity Level",
        logExportLevelAll: "All",
        logExportApp: "Export App Logs",
        logExportCore: "Export Core Logs",
        logExportAll: "Export All",
        logExport: "Export",
        logOpenFolder: "Open Log Folder",
        logExporting: "Exporting logs...",
        logExportSuccess: "Export completed",
        portSettings: "Port Settings",
        portSettingsDesc: "Configure proxy and DNS ports",
        portConfigTitle: "Port Configuration",
        portConfigDesc: "Set ports for proxy protocols",
        mixedPort: "Mixed Port",
        mixedPortHint: "HTTP & SOCKS5 combined port (0 to disable)",
        socksPort: "SOCKS5 Port",
        socksPortHint: "Standalone SOCKS5 proxy port (0 to disable)",
        redirPort: "Redir Port",
        redirPortHint: "Transparent proxy port, Linux only (0 to disable)",
        tproxyPort: "TProxy Port",
        tproxyPortHint: "TProxy port, Linux only (0 to disable)",
        portRangeError: "Port must be between 0 and 65535",
        portDuplicateError: "Ports must not duplicate each other",
        portAllDisabledError: "At least one proxy port (Mixed or SOCKS5) must be enabled",
        settingsTitle: "Settings",
        // New section titles (settings page UX refactor)
        settingsAppearance: "Appearance",
        settingsAppearanceDesc: "Interface language, theme, color and window transparency",
        settingsAppBehavior: "App Behavior",
        settingsAppBehaviorDesc: "Window lifecycle, startup and runtime behavior",
        settingsProxyBehavior: "Proxy Behavior",
        settingsProxyBehaviorDesc: "How proxy selection, testing and failover work",
        settingsNetwork: "Network",
        settingsNetworkDesc: "Local ports, DNS, LAN access and port forwarding",
        settingsSubscriptionRules: "Subscription & Rules",
        settingsSubscriptionRulesDesc: "Subscription download behavior and rule file management",
        settingsSecurityDiagnostics: "Security & Diagnostics",
        settingsSecurityDiagnosticsDesc: "Config encryption and log diagnostics",
        settingsCoreUpdates: "Core & Updates",
        settingsCoreUpdatesDesc: "Core engine, client updates and Geo data maintenance",
        settingsSystemCompatibility: "System & Compatibility",
        settingsSystemCompatibilityDesc: "System integration, platform compatibility and advanced entries",
        settingsAbout: "About",
        settingsAboutDesc: "Project links and danger zone",
        general: "General",
        language: "Language",
        languageDesc: "Select interface language",
        uiScale: "UI Scale",
        uiScaleDesc: "Adjust interface zoom level",
homePageMode: "Home Page Mode",
homePageModeDesc: "Switch between minimal and console dashboard",
homePageMinimal: "Minimal",
homePageConsole: "Console",
        minToTray: "Hide on Close",
        minToTrayDesc: "Hide to tray instead of quitting when closing window",
        lightweightMode: "Lightweight Mode",
        lightweightModeDesc: "Destroy WebView on close to save memory, tray click to restore",
        silentStart: "Silent Start",
        silentStartDesc: "Launch hidden in tray without showing the window",
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
        tunnelsDesc: "Forward local ports to remote servers",
        tunnelsList: "Rules",
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
        notifSubUpdateSuccess: "Subscription updated successfully",
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
        providerPollExhausted: "No nodes available from provider yet. The provider may still be downloading or failed to load.",
        retry: "Retry",
        failedToConnect: "Failed to connect to core. Ensure Mihomo is running.",
        restartCore: "Restart Core",
        restartingCore: "Restarting...",
        coreRestarted: "Core restarted",
        noGroupsFound: "No proxy groups found",
        mode: "Running Mode",
        tunMode: "TUN Adapter (Global Route)",
        tunFailed: "Failed to start TUN: Please run as Administrator",
        tunFailedMac: "Failed to start TUN: Please enter password in the popup dialog to authorize",
        tunAuthCanceled: "Authorization canceled",
        tunAuthFailed: "Authorization failed",
        tunLinuxPermissionPrompt: "TUN mode requires network capabilities and polkit rules.\nGrant permission now?",
        tunLinuxPermissionGranted: "Permission granted. Restarting core...",
        tunLinuxPermissionFailed: "Failed to grant permission",
        configuring: "Configuring network...",
        configuringTun: "Configuring TUN adapter...",
        configSuccess: "Configuration applied",
        configFallback: "Config '@@requested@@' is invalid or empty. Switched to '@@actual@@'.",
        configFallbackMinimal: "Config '@@requested@@' is invalid or empty. Using minimal config.",
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
        // Backup & Restore
        backupRestore: "Backup & Restore",
        backupRestoreDesc: "Export or import your configuration",
        exportBackup: "Export",
        importBackup: "Import",
        backupExportSuccess: "Backup exported to",
        backupImportConfirm: "Importing will replace your current configuration. Continue?",
        // Update progress component labels
        compCore: "Core Engine",
        compGeoData: "Geo Databases",
        compClient: "Client App",
        updateFailed: "Failed",
        delete: "Delete",
        rename: "Rename",
        edit: "Edit",
        editSubscription: "Edit Subscription",
        subscriptionUrl: "Subscription URL",
        subscriptionUrlPlaceholder: "Enter new URL to replace",
        autoUpdateInterval: "Auto Update",
        editUA: "Update User-Agent",
        uaUseGlobal: "Use Global",
        autoUpdateDisabled: "Disabled",
        subscriptionNameRequired: "Subscription name is required",
        autoUpdate12h: "Every 12 hours",
        autoUpdate1d: "Every day",
        autoUpdate3d: "Every 3 days",
        lastUpdated: "Last updated",
        lastUpdatedJustNow: "Just now",
        lastUpdatedMinutesAgo: "{m} min ago",
        lastUpdatedHoursAgo: "{h}h ago",
        lastUpdatedDaysAgo: "{d}d ago",
        lastUpdatedNever: "Never",
        notifUrlUpdated: "Subscription URL updated",
        notifSettingsSaved: "Settings saved",
        proxySwitchFailed: "Failed to switch proxy",
        update: "Update",
        directModePrompt: "In Direct Mode, no traffic is proxied.",
        notifDeleteSuccess: "Config deleted successfully",
        notifRenameSuccess: "Config renamed successfully",
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
        trayCopyEnv: "Copy Proxy Env",
        trayCopyEnvSuccess: "Proxy env vars copied",
        copyProxyEnv: "Copy Proxy Env",
        copyProxyEnvDesc: "Copy proxy env vars for terminal use",
        copyEnvFormat: "Shell Format",
        copyEnvCopied: "Copied",
        copy: "Copy",

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
        destCol: "Destination",
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
        logsTitle: "Logs",
        logTabCore: "Core Logs",
        noLogs: "No log entries yet. Start the core to see logs.",
        autoScroll: "Auto Scroll",
        searchLogs: "Search logs...",
        clearFilter: "Show All",
        logLevelAll: "All",
        logLevelDebug: "Debug",
        logLevelInfo: "Info",
        logLevelWarn: "Warn",
        logLevelError: "Error",
        logLevelFatal: "Fatal",
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
        notifSwitchFailed: "Failed to switch node",
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
        coreUpdateAvailable: "Core update available",
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

        // Rule Library (Prism Engine)
        ruleLibrary: "Rule Library",
        ruleLibraryTitle: "Rule Library",
        ruleLibraryDesc: "Manage extension rules for your subscriptions",
        ruleLibraryEmpty: "No extension rules yet",
        ruleLibraryEmptyHint: "You can extract rules from subscriptions, or import community-shared rule files.",
        ruleLibraryExtract: "Extract from Subscription",
        ruleLibraryImport: "Import Rules",
        ruleLibraryNewGroup: "New Group",
        ruleLibraryUngrouped: "Ungrouped",
        ruleLibraryEditGroup: "Edit Group Name",
        ruleLibraryMoveToGroup: "Move to Group",
        ruleLibraryCreateRule: "Create Rule",
        ruleLibraryCreateFile: "Create Rule File",
        ruleLibraryEditRule: "Edit Rule",
        ruleLibraryRenameRule: "Rename",
        ruleLibraryDeleteRule: "Delete Rule",
        ruleLibraryViewChanges: "View Impact on Config",
        ruleLibraryPreview: "Preview Changes",
        ruleLibraryValidate: "Check Syntax",
        ruleLibraryAutoApply: "Auto Apply Changes",
        ruleLibraryAutoApplyDesc: "Automatically apply when rule files change",
        ruleLibraryManageFiles: "Manage Rule Library Files",
        ruleLibraryManageFilesDesc: "Create, edit, and organize rule files",
        ruleLibraryActiveRules: "Active Rules",
        ruleLibraryActiveRulesDesc: "Rules currently in effect",
        ruleLibraryTrace: "Trace",
        ruleLibraryTraceDesc: "View rule matching trace",
        ruleLibraryExtracted: "Extracted from",
        ruleLibraryManual: "Manual",
        ruleLibraryImported: "Imported",
        ruleLibraryRules: "rules",
        ruleLibraryFiles: "files",
        ruleLibraryStatusReady: "Ready",
        ruleLibraryStatusCompiling: "Compiling",
        ruleLibraryStatusError: "Error",
        ruleLibraryApplied: "Rules applied",
        ruleLibrarySave: "Save",
        ruleLibraryAppliedStats: "rules applied in",
        ruleLibraryApplyFailed: "Apply failed",
        ruleLibraryImportHint: "Supports S-R / Surge / Clash rule formats",
        ruleLibraryImportHintBusy: "Importing large rule sets may cause a brief freeze — this is normal.",
        ruleLibraryImportApplying: "Importing rules in background...",
        ruleLibraryImportPaste: "Paste rules text",
        ruleLibraryImportFile: "Select file",
        ruleLibraryImportUrl: "Import from URL",
        ruleLibraryImportConfirm: "Import",
        ruleLibraryImportCancel: "Cancel",
        ruleLibrarySwitchToText: "Text Editor",
        ruleLibrarySwitchToVisual: "Visual Editor",
        ruleLibraryDeleteConfirm: "Are you sure you want to delete this rule set?",
        ruleLibraryDeleteTitle: "Delete Rule Set",
        ruleLibraryGroupName: "Group Name",
        ruleLibraryGroupNamePlaceholder: "Enter group name",
        ruleLibraryInsertRule: "Insert Rule",
        ruleLibraryInsertRulePlaceholder: "e.g. DOMAIN-SUFFIX,example.com,Proxy\nor JSON: {\"type\":\"DOMAIN-SUFFIX\",\"domain\":\"example.com\",\"policy\":\"Proxy\"}",
        ruleLibraryInsertPosition: "Insert Position",
        ruleLibraryInsertPositionHint: "Enter number:",
        ruleLibraryInsertPositionBeforePrism: "Before All Prism Rules (highest priority)",
        ruleLibraryInsertPositionAfterGroup: "After Group \"{group}\"",
        ruleLibraryInsertPositionAfterPrism: "After All Prism Rules",
        ruleLibraryInsertPositionAppend: "End of Rules (lowest priority)",
        ruleLibraryInsertPositionInvalid: "Invalid position number",
        ruleLibraryInsertSuccess: "Rule inserted",
        ruleLibrarySubscriptionExtract: "Extract Rules to Library",
        ruleLibrarySubscriptionBind: "Extension Rules",
        ruleLibraryLogTab: "App Logs",
        ruleLibraryLogEmpty: "No app events yet",
        ruleLibraryNoRules: "No rule files",
        ruleLibraryRemoved: "Removed",
        ruleLibraryDeleteGroup: "Delete Group",
        ruleLibraryDeleteGroupConfirm: "Are you sure you want to delete this group? Files will be moved to Ungrouped.",
        ruleLibraryDefaultImportName: "imported-rules",
        ruleLibraryDragToReorder: "Drag to reorder",
        ruleLibraryNoPatch: "No patch data found",
        ruleLibraryNoChanges: "No changes contributed by this file",
        ruleLibrarySelectProfile: "Select Profile",
        // Smart Proxy Selector
        smartProxy: "Node Scoring",
        smartProxyDesc: "Enable EMA scoring for proxy nodes",
        smartProxyConfigTitle: "Smart Proxy Settings",
        smartProxyWeightLatency: "Latency Weight",
        smartProxyWeightSuccess: "Success Rate Weight",
        smartProxyWeightStability: "Stability Weight",
        smartProxyHalfLife: "Half-life (hours)",
        smartProxyMinInterval: "Min Test Interval (s)",
        smartProxyMaxInterval: "Max Test Interval (s)",
        smartProxyScore: "Score",
        smartAutoTest: "Auto Speed Test",
        smartAutoTestDesc: "Periodically test all proxies to keep scores accurate",
        notifSwitchedBest: "Switched to best node: @@name@@ (score: @@score@@)",
        notifBestNode: "Best node: @@name@@ (score: @@score@@)",
        notifNoNodesForSelection: "No nodes available for selection",
        // Plugin System
        plugins: "Plugins",
        pluginVersion: "v@@version@@",
        pluginType: "@@type@@",
        pluginScope: "Scope: @@scope@@",
        pluginEnable: "Enable",
        pluginDisable: "Disable",
        pluginEditScript: "Edit Script",
        pluginUnload: "Unload",
        pluginUnloadTitle: "Unload Plugin",
        pluginUnloadConfirm: "Are you sure you want to unload \"@@name@@\"?",
        pluginDeleteFiles: "Also delete plugin files",
        pluginNoPlugins: "No plugins found. Place plugin folders in the plugins directory.",
        pluginScriptTitle: "Script Editor — @@name@@",
        pluginScriptRun: "Run",
        pluginScriptValidate: "Validate",
        pluginScriptOutput: "Output",
        pluginScriptSafe: "Script is safe",
        pluginScriptUnsafe: "Script contains unsafe code",
        pluginScriptSuccess: "Execution succeeded in @@ms@@ms",
        pluginScriptFailed: "Execution failed: @@error@@",
        pluginValidating: "Validating...",
        pluginScriptPlaceholder: "Plugin script content will be loaded here",
        pluginUnloadConfirmTitle: "Unload Plugin",
        pluginUnloadConfirmMsg: "This will stop the plugin and release its resources.",
        groupMismatchExplanation: "Current group: @@uiGroup@@ — Rules default to: @@effectiveGroup@@. Connections may use \"@@effectiveGroup@@\" instead of your selected node.",
        switchToEffectiveGroup: "Switch to rules default",
        effectiveGroupNotSwitchable: "Rules default is auto-select (not switchable)",
        observedGroupMismatch: "Actual traffic uses: @@observedGroup@@ — differs from current group @@uiGroup@@.",
        switchToObservedGroup: "Switch to traffic group",
        observedGroupNotSwitchable: "Traffic group is auto-select (not switchable)",
        // ── Override system ──
        overrideTitle: "Override Scripts",
        overrideSearchPlaceholder: "Search overrides...",
        overrideNew: "New",
        overrideNewJs: "New JS Override",
        overrideNewPrism: "New Prism YAML",
        overrideImportUrl: "Import from URL",
        overrideImportUrlPrompt: "Enter remote URL:",
        overrideInvalidUrl: "Invalid URL",
        overrideEnableAll: "Enable All",
        overrideDisableAll: "Disable All",
        overrideBack: "Back",
        overrideValidate: "Validate",
        overrideSaveAndRun: "Save & Run",
        overrideFullscreen: "Fullscreen",
        overrideOutput: "Output",
        overrideOutputPlaceholder: 'Click "Save & Run" to see output...',
        overrideCopy: "Copy",
        overrideCopied: "Copied",
        overrideClear: "Clear",
        overrideEditScript: "Edit Script",
        overrideLineCol: "Line @@line@@, Col @@col@@",
        overrideCharCount: "@@count@@ chars",
        overrideOutputLineCount: "Output (@@count@@ lines)",
        overrideScopeGlobal: "Global",
        overrideScopeNone: "None",
        overrideScopeTitle: "Override Scope",
        overrideNoProfiles: "No subscriptions found",
        overrideExportAll: "Export All",
        overrideImportFile: "Import from File",
        overrideExportEmpty: "No overrides to export",
        overrideExportSuccess: "Exported to: @@path@@",
        overrideImportInvalid: "Invalid export file format",
        overrideImportSuccess: "Imported @@count@@ overrides",
        overrideEnabled: "● Enabled",
        overrideDisabled: "○ Disabled",
        overrideFailed: "● Failed",
        overrideEnable: "Enable",
        overrideDisable: "Disable",
        overrideMoveUp: "Move Up",
        overrideMoveDown: "Move Down",
        overrideApplied: "Override applied and config reloaded",
        overrideNoMatch: "No overrides match your search",
        overrideEmpty: "No overrides yet. Click + to create one.",
        overrideDeleteConfirmTitle: 'Delete override "@@name@@"?',
        overrideDeleteConfirmMsg: "This action cannot be undone. The override script and execution logs will be deleted.",
        overrideValidating: "Validating...",
        overrideScriptSafe: "✓ Script safe",
        overrideScriptUnsafe: "Script may be unsafe",
        overrideExecuting: "Executing...",
        overrideExecSuccess: "✓ Execution successful",
        overrideExecFailed: "✗ Execution failed",
        overrideScriptLine: "Script line @@line@@, column @@col@@",
        overrideEngineInternal: "Engine internal (eval_script:@@line@@:@@col@@)",
        overrideNamePrompt: 'Enter override name:',
        overrideCreated: 'Override created',
        overrideCoreNotRunning: '⚠ Core not running, cannot validate',
        auto: 'Auto',
        dismiss: "Dismiss",

        // Network Optimization
        networkOptim: "Network Optimization",
        networkOptimDesc: "Optimize TCP parameters for better throughput",
        networkOptimApply: "Apply",
        networkOptimRevert: "Revert",
        networkOptimModalTitle: "Apply Network Optimizations",
        networkOptimModalDesc: "This will modify system TCP parameters to improve network performance, especially for high-latency connections (RTT > 25ms). All changes are fully reversible — you can click \"Revert\" at any time to restore system defaults.",
        networkOptimModalChanges: "Changes to be applied:",
        networkOptimChange1: "Enable TCP Fast Open (faster connection establishment)",
        networkOptimChange2: "Enable ECN (congestion signaling without packet loss)",
        networkOptimChange3: "Disable HyStart ACK train (better slow-start on WAN)",
        networkOptimChange4: "Increase TCP buffer limits (higher throughput on high-RTT paths)",
        networkOptimChange5: "Optimize TCP unsent data threshold (prevent bufferbloat)",
        networkOptimModalInfo: "All changes are fully reversible. Click \"Revert\" to restore system defaults at any time. Administrator privileges are required. Linux: changes persist across reboots (via /etc/sysctl.d). macOS: changes reset on reboot. Windows: changes are system-level and persist until reverted.",
        networkOptimAutoApply: "Auto-apply on startup",
        networkOptimRevertTitle: "Revert Network Optimizations",
        networkOptimRevertDesc: "This will restore all TCP parameters to system defaults. Administrator privileges are required.",
        networkOptimApplied: "Network optimizations applied successfully",
        networkOptimReverted: "Network optimizations reverted to defaults",
        networkOptimCanceled: "Operation canceled",
        networkOptimApplyFailed: "Failed to apply network optimizations",
        networkOptimRevertFailed: "Failed to revert network optimizations",

        // ── Console Dashboard ──
        consoleTitle: "Console",
        consoleUptimeRunning: "Core running —",
        consoleUptimeStopped: "Core stopped —",
        consoleUptimeFmt: "Uptime @@days@@d @@time@@",
        consoleDownSpeed: "Download Speed",
        consoleUpSpeed: "Upload Speed",
        consoleTotalTraffic: "Total Traffic",
consoleSessionTraffic: "Session Traffic",
        consoleActiveConn: "Active Connections",
        consoleConnUnit: "conn",
        consoleNodeLatency: "Node Latency",
        consolePeak: "Peak",
        consoleRealtimeTraffic: "Real-time Traffic",
        consoleDownload: "Download",
        consoleUpload: "Upload",
        consoleAvgMin: "1 min avg",
        consoleSessionDown: "Session DL",
        consoleSessionUp: "Session UL",
        consoleSampleInterval: "Sample interval",
        consoleSampleValue: "1s · 60pt window",
        consoleCurrentNode: "Current Node",
        consoleSwitch: "Switch",
        consoleTestLatency: "Test",
        consoleQuickControl: "Quick Controls",
        consoleSysProxy: "System Proxy",
        consoleTunAdapter: "TUN Adapter",
        consoleSortBySpeed: "Sort by Speed",
        consoleSortByTraffic: "Sort by Traffic",
        consoleSortByProcess: "Sort by Process",
        consoleSortHint: "Click to toggle sort",
        consoleCopyHint: "Click to copy",
        consoleSubUsage: "Subscription",
        consoleConnStatus: "Status",
        consoleStatusActive: "Active",
        consoleProxyMode: "Mode",
        consoleRecentEvents: "Recent Events",
        consoleLatencyExcellent: "Excellent",
        consoleLatencyFair: "Fair",
        consoleLatencyHigh: "High",
        consoleCurrentSub: "Current",
        consoleSystem: "System",
        consoleNodePicker: "Switch node",
        consoleAllLogs: "All Logs",
        consoleSubUsed: "used",
        consoleSubExpiry: "Expires",
        consoleSubDaysLeft: { one: "@@d@@ day left", other: "@@d@@ days left" },
        consoleSubLastUpdate: "Last update",
        consoleSubNextUpdate: "Next auto-update",
        consoleSubUpdateNow: "Update Now",
consoleSubUpdateOk: "Subscription updated successfully",
    consoleSubUpdateFail: "Subscription update failed",
    consoleSubUpdateBusy: "Update in progress, please wait",
        consoleSubManage: "Manage",
        consoleSubNoSub: "No subscription",
        consoleSubUpdating: "Updating…",
                consoleSubNodes: { one: "@@count@@ node", other: "@@count@@ nodes" },
        consoleSubJustNow: "Just now",
        consoleSubNever: "Never",
        consoleSubMinAgo: "@@m@@ min ago",
        consoleSubHoursAgo: "@@h@@h ago",
        consoleSubDaysAgo: "@@d@@d ago",
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
        sortSmart: "智能排序",
        latency: "延迟",
        testLatency: "测试延迟",
        hideTimeout: "隐藏超时节点",
        hideTimeoutDesc: "在节点列表中隐藏不可用的节点",
        failover: "故障转移",
        failoverDesc: "当前节点连续失败时自动切换到其他节点",
        failoverSwitched: "故障转移：已从 @@failed@@ 切换到 @@target@@",
        encryptConfigs: "加密配置文件",
        encryptConfigsDesc: "使用机器密钥加密配置文件，防止在其他设备上使用",
        encryptConfigsConfirmEnable: "启用加密将立即加密所有现有配置文件，加密后无法使用外部编辑器编辑配置文件。是否继续？",
        encryptConfigsConfirmDisable: "关闭加密将立即将所有配置文件解密为明文。是否继续？",
        encryptConfigsEnabled: "配置文件已加密",
        encryptConfigsDisabled: "配置文件已解密",
        logSettings: "日志设置",
        logSettingsDesc: "持久化和导出应用及核心日志",
        logAppTab: "应用日志",
        logCoreTab: "核心日志",
        logAppEnabled: "持久化应用日志",
        logCoreEnabled: "持久化核心日志",
        logRetentionDays: "保留天数",
        logMaxFileMb: "单文件大小上限",
        logDaysUnit: "天",
        logMbUnit: "MB",
        logExportTitle: "导出日志",
        logExportFrom: "起始日期",
        logExportTo: "结束日期",
        logExportLevel: "严重程度",
        logExportLevelAll: "全部",
        logExportApp: "导出应用日志",
        logExportCore: "导出核心日志",
        logExportAll: "导出全部日志",
        logExport: "导出",
        logOpenFolder: "打开日志文件夹",
        logExporting: "正在导出日志...",
        logExportSuccess: "导出完成",
        portSettings: "端口设置",
        portSettingsDesc: "配置代理和 DNS 端口",
        portConfigTitle: "端口配置",
        portConfigDesc: "设置代理协议端口",
        mixedPort: "混合端口",
        mixedPortHint: "HTTP 与 SOCKS5 混合代理端口（0 禁用）",
        socksPort: "SOCKS5 端口",
        socksPortHint: "独立 SOCKS5 代理端口（0 禁用）",
        redirPort: "透明代理端口",
        redirPortHint: "透明代理端口，仅 Linux（0 禁用）",
        tproxyPort: "TProxy 端口",
        tproxyPortHint: "TProxy 端口，仅 Linux（0 禁用）",
        portRangeError: "端口范围应为 0-65535",
        portDuplicateError: "端口不能重复",
        portAllDisabledError: "至少需要启用一个代理端口（混合或 SOCKS5）",
        settingsTitle: "设置",
        // New section titles (settings page UX refactor)
        settingsAppearance: "外观",
        settingsAppearanceDesc: "界面语言、主题、配色与窗口透明度",
        settingsAppBehavior: "应用行为",
        settingsAppBehaviorDesc: "窗口生命周期、启动与运行方式",
        settingsProxyBehavior: "代理行为",
        settingsProxyBehaviorDesc: "代理选择、测速与故障切换策略",
        settingsNetwork: "网络",
        settingsNetworkDesc: "本地端口、DNS、局域网访问与端口转发",
        settingsSubscriptionRules: "订阅与规则",
        settingsSubscriptionRulesDesc: "订阅下载行为与规则文件管理",
        settingsSecurityDiagnostics: "安全与诊断",
        settingsSecurityDiagnosticsDesc: "配置加密与日志诊断",
        settingsCoreUpdates: "核心与更新",
        settingsCoreUpdatesDesc: "核心引擎、客户端更新与 Geo 数据维护",
        settingsSystemCompatibility: "系统与兼容性",
        settingsSystemCompatibilityDesc: "系统集成、平台兼容与高级入口",
        settingsAbout: "关于",
        settingsAboutDesc: "项目链接与危险操作区",
        general: "常规设置",
        language: "语言",
        languageDesc: "选择界面显示语言",
        uiScale: "界面缩放",
        uiScaleDesc: "调整界面缩放比例",
homePageMode: "主页模式",
homePageModeDesc: "在极简主页和控制台仪表盘之间切换",
homePageMinimal: "极简",
homePageConsole: "控制台",
        minToTray: "最小化到托盘",
        minToTrayDesc: "关闭窗口时隐藏到后台，而不是退出",
        lightweightMode: "轻量模式",
        lightweightModeDesc: "关闭时销毁界面释放内存，点击托盘恢复",
        silentStart: "静默启动",
        silentStartDesc: "启动时隐藏到托盘，不显示窗口",
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
        tunnelsDesc: "将本地端口转发到远程服务器",
        tunnelsList: "规则列表",
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
        notifSubUpdateSuccess: "订阅更新成功",
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
        providerPollExhausted: "提供者尚无可用节点。提供者可能仍在下载或加载失败。",
        retry: "重试",
        failedToConnect: "连接核心失败，请确保 Mihomo 已启动。",
        restartCore: "重启内核",
        restartingCore: "正在重启...",
        coreRestarted: "内核已重启",
        noGroupsFound: "未找到代理选择组",
        mode: "运行模式",
        tunMode: "TUN 虚拟网卡 (全局路由)",
        tunFailed: "开启 TUN 失败：请右键以管理员身份运行本程序",
        tunFailedMac: "开启 TUN 失败：请在弹出的密码框中输入开机密码授权",
        tunAuthCanceled: "授权已取消",
        tunAuthFailed: "授权失败",
        tunLinuxPermissionPrompt: "TUN 模式需要网络权限和策略规则。\n是否现在授权？",
        tunLinuxPermissionGranted: "权限已授予，正在重启核心...",
        tunLinuxPermissionFailed: "授权失败",
        tunStartFailed: "TUN 启动失败，正在恢复核心...",
        configuring: "正在配置网络...",
        configuringTun: "正在配置虚拟网卡...",
        configSuccess: "配置已生效",
        configFallback: "配置 '@@requested@@' 无效或为空，已切换到 '@@actual@@'。",
        configFallbackMinimal: "配置 '@@requested@@' 无效或为空，正在使用最小配置。",
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
        // Backup & Restore
        backupRestore: "备份与恢复",
        backupRestoreDesc: "导出或导入您的配置",
        exportBackup: "导出",
        importBackup: "导入",
        backupExportSuccess: "备份已导出至",
        backupImportConfirm: "导入将覆盖当前配置，是否继续？",
        // Update progress component labels
        compCore: "核心引擎",
        compGeoData: "Geo 数据库",
        compClient: "客户端",
        updateFailed: "失败",
        delete: "删除",
        rename: "重命名",
        edit: "编辑",
        editSubscription: "编辑订阅",
        subscriptionUrl: "订阅链接",
        subscriptionUrlPlaceholder: "输入新链接以替换",
        autoUpdateInterval: "自动更新",
        editUA: "更新 UA",
        uaUseGlobal: "跟随全局",
        autoUpdateDisabled: "关闭",
        subscriptionNameRequired: "订阅名称不能为空",
        autoUpdate12h: "每12小时",
        autoUpdate1d: "每天",
        autoUpdate3d: "每3天",
        lastUpdated: "上次更新",
        lastUpdatedJustNow: "刚刚",
        lastUpdatedMinutesAgo: "{m}分钟前",
        lastUpdatedHoursAgo: "{h}小时前",
        lastUpdatedDaysAgo: "{d}天前",
        lastUpdatedNever: "从未",
        notifUrlUpdated: "订阅链接已更新",
        notifSettingsSaved: "设置已保存",
        proxySwitchFailed: "切换代理失败",
        update: "更新",
        directModePrompt: "当前处于直连模式，不通过代理。",
        notifDeleteSuccess: "配置文件已成功删除",
        notifRenameSuccess: "配置已重命名",
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
        trayCopyEnv: "复制代理环境变量",
        trayCopyEnvSuccess: "代理环境变量已复制",
        copyProxyEnv: "复制代理环境变量",
        copyProxyEnvDesc: "复制代理环境变量到剪贴板，方便终端使用",
        copyEnvFormat: "Shell 格式",
        copyEnvCopied: "已复制",
        copy: "复制",

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
        destCol: "目标地址",
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
        logsTitle: "日志",
        logTabCore: "核心日志",
        noLogs: "暂无日志，启动核心后即可查看。",
        autoScroll: "自动滚动",
        searchLogs: "搜索日志...",
        clearFilter: "显示全部",
        logLevelAll: "全部",
        logLevelDebug: "调试",
        logLevelInfo: "信息",
        logLevelWarn: "警告",
        logLevelError: "错误",
        logLevelFatal: "致命",
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
        notifSwitchFailed: "节点切换失败",
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
        coreUpdateAvailable: "内核有更新",
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

        // 规则库 (Prism 引擎)
        ruleLibrary: "规则库",
        ruleLibraryTitle: "规则库",
        ruleLibraryDesc: "管理订阅的扩展规则",
        ruleLibraryEmpty: "还没有扩展规则",
        ruleLibraryEmptyHint: "你可以从订阅中提取规则，或导入社区分享的规则文件。",
        ruleLibraryExtract: "从订阅提取",
        ruleLibraryImport: "导入规则",
        ruleLibraryNewGroup: "新建分组",
        ruleLibraryUngrouped: "未分组",
        ruleLibraryEditGroup: "编辑组名",
        ruleLibraryMoveToGroup: "移动到分组",
        ruleLibraryCreateRule: "创建规则",
        ruleLibraryCreateFile: "创建规则文件",
        ruleLibraryEditRule: "编辑规则",
        ruleLibraryRenameRule: "重命名",
        ruleLibraryDeleteRule: "删除规则",
        ruleLibraryViewChanges: "查看配置影响",
        ruleLibraryPreview: "预览变更",
        ruleLibraryValidate: "语法检查",
        ruleLibraryAutoApply: "自动应用变更",
        ruleLibraryAutoApplyDesc: "规则文件变更时自动应用",
        ruleLibraryManageFiles: "管理规则库文件",
        ruleLibraryManageFilesDesc: "创建、编辑和组织规则文件",
        ruleLibraryActiveRules: "生效规则",
        ruleLibraryActiveRulesDesc: "当前实际运行的规则",
        ruleLibraryTrace: "追踪",
        ruleLibraryTraceDesc: "查看规则匹配追踪",
        ruleLibraryExtracted: "提取自",
        ruleLibraryManual: "手动创建",
        ruleLibraryImported: "导入",
        ruleLibraryRules: "条规则",
        ruleLibraryFiles: "个文件",
        ruleLibraryStatusReady: "就绪",
        ruleLibraryStatusCompiling: "编译中",
        ruleLibraryStatusError: "错误",
        ruleLibraryApplied: "规则已应用",
        ruleLibrarySave: "保存",
        ruleLibraryAppliedStats: "条规则已应用，耗时",
        ruleLibraryApplyFailed: "应用失败",
        ruleLibraryImportHint: "支持 S-R / Surge / Clash 规则格式",
        ruleLibraryImportHintBusy: "导入大量规则时可能会短暂无响应，这是正常现象。",
        ruleLibraryImportApplying: "正在后台导入规则...",
        ruleLibraryImportPaste: "粘贴规则文本",
        ruleLibraryImportFile: "选择文件",
        ruleLibraryImportUrl: "从 URL 导入",
        ruleLibraryImportConfirm: "导入",
        ruleLibraryImportCancel: "取消",
        ruleLibrarySwitchToText: "文本编辑器",
        ruleLibrarySwitchToVisual: "可视化编辑",
        ruleLibraryDeleteConfirm: "确定要删除此规则集吗？",
        ruleLibraryDeleteTitle: "删除规则集",
        ruleLibraryGroupName: "分组名称",
        ruleLibraryGroupNamePlaceholder: "输入分组名称",
        ruleLibraryInsertRule: "插入规则",
        ruleLibraryInsertRulePlaceholder: "例如 DOMAIN-SUFFIX,example.com,Proxy\n或 JSON: {\"type\":\"DOMAIN-SUFFIX\",\"domain\":\"example.com\",\"policy\":\"Proxy\"}",
        ruleLibraryInsertPosition: "插入位置",
        ruleLibraryInsertPositionHint: "输入编号:",
        ruleLibraryInsertPositionBeforePrism: "所有 Prism 规则之前（最高优先级）",
        ruleLibraryInsertPositionAfterGroup: "分组 \"{group}\" 之后",
        ruleLibraryInsertPositionAfterPrism: "所有 Prism 规则之后",
        ruleLibraryInsertPositionAppend: "规则列表末尾（最低优先级）",
        ruleLibraryInsertPositionInvalid: "无效的位置编号",
        ruleLibraryInsertSuccess: "规则已插入",
        ruleLibrarySubscriptionExtract: "提取规则到规则库",
        ruleLibrarySubscriptionBind: "扩展规则",
        ruleLibraryLogTab: "应用日志",
        ruleLibraryLogEmpty: "暂无应用事件",
        ruleLibraryNoRules: "暂无规则文件",
        ruleLibraryRemoved: "已移除",
        ruleLibraryDeleteGroup: "删除分组",
        ruleLibraryDeleteGroupConfirm: "确定要删除此分组吗？文件将移至未分组。",
        ruleLibraryDefaultImportName: "导入的规则",
        ruleLibraryDragToReorder: "拖拽排序",
        ruleLibraryNoPatch: "未找到补丁数据",
        ruleLibraryNoChanges: "此文件未贡献任何变更",
        ruleLibrarySelectProfile: "选择配置",
        // 智能代理选择
        smartProxy: "节点评分",
        smartProxyDesc: "启用节点 EMA 评分",
        smartProxyConfigTitle: "智能代理设置",
        smartProxyWeightLatency: "延迟权重",
        smartProxyWeightSuccess: "成功率权重",
        smartProxyWeightStability: "稳定性权重",
        smartProxyHalfLife: "半衰期（小时）",
        smartProxyMinInterval: "最小测速间隔（秒）",
        smartProxyMaxInterval: "最大测速间隔（秒）",
        smartProxyScore: "评分",
        smartAutoTest: "自动测速",
        smartAutoTestDesc: "定期测试所有代理以保持评分准确",
        notifSwitchedBest: "已切换到最佳节点: @@name@@ (评分: @@score@@)",
        notifBestNode: "最佳节点: @@name@@ (评分: @@score@@)",
        notifNoNodesForSelection: "没有可选的节点",
        // 插件系统
        plugins: "插件",
        pluginVersion: "v@@version@@",
        pluginType: "@@type@@",
        pluginScope: "作用域: @@scope@@",
        pluginEnable: "启用",
        pluginDisable: "禁用",
        pluginEditScript: "编辑脚本",
        pluginUnload: "卸载",
        pluginUnloadTitle: "卸载插件",
        pluginUnloadConfirm: "确定要卸载「@@name@@」吗？",
        pluginDeleteFiles: "同时删除插件文件",
        pluginNoPlugins: "暂无插件。请将插件文件夹放入 plugins 目录。",
        pluginScriptTitle: "脚本编辑器 — @@name@@",
        pluginScriptRun: "运行",
        pluginScriptValidate: "验证",
        pluginScriptOutput: "输出",
        pluginScriptSafe: "脚本安全",
        pluginScriptUnsafe: "脚本包含不安全代码",
        pluginScriptSuccess: "执行成功，耗时 @@ms@@ms",
        pluginScriptFailed: "执行失败: @@error@@",
        pluginValidating: "验证中...",
        pluginScriptPlaceholder: "插件脚本内容将在此处加载",
        pluginUnloadConfirmTitle: "卸载插件",
        pluginUnloadConfirmMsg: "这将停止插件并释放其资源。",
        groupMismatchExplanation: "当前组: @@uiGroup@@ — 规则默认组: @@effectiveGroup@@。连接可能使用「@@effectiveGroup@@」而非您选择的节点。",
        switchToEffectiveGroup: "切换到规则默认组",
        effectiveGroupNotSwitchable: "规则默认为自动选择（不可切换）",
        observedGroupMismatch: "实际流量走: @@observedGroup@@ — 与当前组 @@uiGroup@@ 不一致。",
        switchToObservedGroup: "切换到流量组",
        observedGroupNotSwitchable: "流量组为自动选择（不可切换）",
        // ── Override system ──
        overrideTitle: "覆写脚本",
        overrideSearchPlaceholder: "搜索覆写...",
        overrideNew: "新建",
        overrideNewJs: "新建 JS 覆写",
        overrideNewPrism: "新建 Prism YAML",
        overrideImportUrl: "从 URL 导入",
        overrideImportUrlPrompt: "输入远程 URL：",
        overrideInvalidUrl: "无效的 URL",
        overrideEnableAll: "启用全部",
        overrideDisableAll: "禁用全部",
        overrideBack: "返回",
        overrideValidate: "验证",
        overrideSaveAndRun: "保存并执行",
        overrideFullscreen: "全屏",
        overrideOutput: "输出",
        overrideOutputPlaceholder: '点击"保存并执行"查看输出...',
        overrideCopy: "复制",
        overrideCopied: "已复制",
        overrideClear: "清空",
        overrideEditScript: "编辑脚本",
        overrideLineCol: "行 @@line@@, 列 @@col@@",
        overrideCharCount: "@@count@@ 字符",
        overrideOutputLineCount: "输出 (@@count@@ 行)",
        overrideScopeGlobal: "全局",
        overrideScopeNone: "无",
        overrideScopeTitle: "覆写作用域",
        overrideNoProfiles: "未找到订阅",
        overrideExportAll: "全部导出",
        overrideImportFile: "从文件导入",
        overrideExportEmpty: "没有可导出的覆写",
        overrideExportSuccess: "已导出至：@@path@@",
        overrideImportInvalid: "无效的导出文件格式",
        overrideImportSuccess: "已导入 @@count@@ 个覆写",
        overrideEnabled: "● 已启用",
        overrideDisabled: "○ 已禁用",
        overrideFailed: "● 应用失败",
        overrideEnable: "启用",
        overrideDisable: "禁用",
        overrideMoveUp: "上移",
        overrideMoveDown: "下移",
        overrideApplied: "覆写已应用，配置已重载",
        overrideNoMatch: "没有匹配的覆写",
        overrideEmpty: "暂无覆写。点击 + 新建。",
        overrideDeleteConfirmTitle: '删除覆写 "@@name@@"？',
        overrideDeleteConfirmMsg: "此操作不可撤销。覆写脚本和执行日志都将被删除。",
        overrideValidating: "正在验证...",
        overrideScriptSafe: "✓ 脚本安全",
        overrideScriptUnsafe: "脚本可能不安全",
        overrideExecuting: "执行中...",
        overrideExecSuccess: "✓ 执行成功",
        overrideExecFailed: "✗ 执行失败",
        overrideScriptLine: "脚本第 @@line@@ 行，第 @@col@@ 列",
        overrideEngineInternal: "引擎内部 (eval_script:@@line@@:@@col@@)",
        overrideNamePrompt: '输入覆写名称:',
        overrideCreated: '覆写已创建',
        overrideCoreNotRunning: '⚠ 核心未启动，无法验证',
        auto: '自动',
        dismiss: "关闭",

        // 网络优化
        networkOptim: "网络优化",
        networkOptimDesc: "优化 TCP 参数以提升吞吐量",
        networkOptimApply: "应用",
        networkOptimRevert: "回退",
        networkOptimModalTitle: "应用网络优化",
        networkOptimModalDesc: "此操作将修改系统 TCP 参数以提升网络性能，尤其适用于高延迟连接（RTT > 25ms）。所有修改均可完全回退 — 您可以随时点击\"回退\"恢复系统默认值。",
        networkOptimModalChanges: "将要应用的修改：",
        networkOptimChange1: "启用 TCP Fast Open（更快建立连接）",
        networkOptimChange2: "启用 ECN（无丢包的拥塞信号）",
        networkOptimChange3: "禁用 HyStart ACK train（WAN 路径更好的慢启动）",
        networkOptimChange4: "增大 TCP 缓冲区限制（高 RTT 路径更高吞吐量）",
        networkOptimChange5: "优化 TCP 未发送数据阈值（防止缓冲膨胀）",
        networkOptimModalInfo: "所有修改均可完全回退，点击\"回退\"即可随时恢复系统默认值。需要管理员权限。Linux：修改通过 /etc/sysctl.d 在重启后保留。macOS：修改在重启后自动失效。Windows：修改为系统级，在回退前一直有效。",
        networkOptimAutoApply: "启动时自动应用",
        networkOptimRevertTitle: "回退网络优化",
        networkOptimRevertDesc: "此操作将所有 TCP 参数恢复为系统默认值。需要管理员权限。",
        networkOptimApplied: "网络优化已成功应用",
        networkOptimReverted: "网络优化已回退为默认值",
        networkOptimCanceled: "操作已取消",
        networkOptimApplyFailed: "应用网络优化失败",
        networkOptimRevertFailed: "回退网络优化失败",

        // ── 控制台仪表盘 ──
        consoleTitle: "控制台",
        consoleUptimeRunning: "核心已运行 —",
        consoleUptimeStopped: "核心已停止 —",
        consoleUptimeFmt: "核心已运行 @@days@@ 天 @@time@@",
        consoleDownSpeed: "下载速度",
        consoleUpSpeed: "上传速度",
        consoleTotalTraffic: "总流量",
consoleSessionTraffic: "会话流量",
        consoleActiveConn: "活动连接",
        consoleConnUnit: "个",
        consoleNodeLatency: "节点延迟",
        consolePeak: "峰值",
        consoleRealtimeTraffic: "实时流量",
        consoleDownload: "下载",
        consoleUpload: "上传",
        consoleAvgMin: "1 分钟平均",
        consoleSessionDown: "会话总下载",
        consoleSessionUp: "会话总上传",
        consoleSampleInterval: "采样间隔",
        consoleSampleValue: "1s · 60 点滚动窗",
        consoleCurrentNode: "当前节点",
        consoleSwitch: "切换",
        consoleTestLatency: "测速",
        consoleQuickControl: "快捷控制",
        consoleSysProxy: "系统代理",
        consoleTunAdapter: "TUN 虚拟网卡",
        consoleSortBySpeed: "按速率排序",
        consoleSortByTraffic: "按流量排序",
        consoleSortByProcess: "按进程排序",
        consoleSortHint: "点击切换排序方式",
        consoleCopyHint: "点击复制",
        consoleSubUsage: "订阅用量",
        consoleConnStatus: "连接状态",
        consoleStatusActive: "活跃中",
        consoleProxyMode: "代理模式",
        consoleRecentEvents: "最近事件",
        consoleLatencyExcellent: "优秀",
        consoleLatencyFair: "一般",
        consoleLatencyHigh: "较高",
        consoleCurrentSub: "当前订阅",
        consoleSystem: "系统",
        consoleNodePicker: "切换节点",
        consoleAllLogs: "全部日志",
        consoleSubUsed: "已用",
        consoleSubExpiry: "到期时间",
        consoleSubDaysLeft: { other: "剩 @@d@@ 天" },
        consoleSubLastUpdate: "最近更新",
        consoleSubNextUpdate: "下次自动更新",
        consoleSubUpdateNow: "立即更新",
consoleSubUpdateOk: "订阅更新成功",
    consoleSubUpdateFail: "订阅更新失败",
    consoleSubUpdateBusy: "更新中，请稍候",
        consoleSubManage: "管理订阅",
        consoleSubNoSub: "暂无订阅",
        consoleSubUpdating: "更新中…",
        consoleSubNodes: { other: "@@count@@ 个节点" },
        consoleSubJustNow: "刚刚",
        consoleSubNever: "从未",
        consoleSubMinAgo: "@@m@@ 分钟前",
        consoleSubHoursAgo: "@@h@@ 小时前",
        consoleSubDaysAgo: "@@d@@ 天前",
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
        homePageMode: "ホームページモード",
        homePageModeDesc: "ミニマルとコンソールダッシュボードを切り替え",
        homePageMinimal: "ミニマル",
        homePageConsole: "コンソール",
        loading: "読み込み中...",
        errorPrefix: "エラー",
        unknown: "不明",
        providerPollExhausted: "プロバイダーからノードを取得できませんでした。ダウンロード中または読み込み失敗の可能性があります。",
        retry: "再試行",

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
        notifSwitchFailed: "ノードの切り替えに失敗しました",
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
        coreUpdateAvailable: "コアの更新があります",
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
        logsTitle: "ログ",
        logTabCore: "コアログ",
        noLogs: "ログがありません。コアを起動してください。",
        autoScroll: "自動スクロール",
        searchLogs: "ログを検索...",
        clearFilter: "すべて表示",
        logLevelAll: "すべて",
        logLevelDebug: "デバッグ",
        logLevelInfo: "情報",
        logLevelWarn: "警告",
        logLevelError: "エラー",
        logLevelFatal: "致命的",
        logPaused: "一時停止",
        logLines: "行",
        // スマートプロキシセレクター
        sortSmart: "スマート",
        smartProxy: "ノードスコアリング",
        smartProxyDesc: "プロキシノードのEMAスコアリングを有効化",
        smartProxyConfigTitle: "スマートプロキシ設定",
        smartProxyWeightLatency: "レイテンシ重み",
        smartProxyWeightSuccess: "成功率重み",
        smartProxyWeightStability: "安定性重み",
        smartProxyHalfLife: "半減期（時間）",
        smartProxyMinInterval: "最小テスト間隔（秒）",
        smartProxyMaxInterval: "最大テスト間隔（秒）",
        smartProxyScore: "スコア",
        smartAutoTest: "自動速度テスト",
        smartAutoTestDesc: "全プロキシを定期的にテストしてスコアを正確に保つ",
        // プラグインシステム
        plugins: "プラグイン",
        pluginVersion: "v@@version@@",
        pluginType: "@@type@@",
        pluginScope: "スコープ: @@scope@@",
        pluginEnable: "有効",
        pluginDisable: "無効",
        pluginEditScript: "スクリプト編集",
        pluginUnload: "アンロード",
        pluginUnloadTitle: "プラグインをアンロード",
        pluginUnloadConfirm: "「@@name@@」をアンロードしますか？",
        pluginDeleteFiles: "プラグインファイルも削除",
        pluginNoPlugins: "プラグインが見つかりません。pluginsディレクトリにプラグインフォルダを配置してください。",
        pluginScriptTitle: "スクリプトエディター — @@name@@",
        pluginScriptRun: "実行",
        pluginScriptValidate: "検証",
        pluginScriptOutput: "出力",
        pluginScriptSafe: "スクリプトは安全です",
        pluginScriptUnsafe: "スクリプトに安全でないコードが含まれています",
        pluginScriptSuccess: "@@ms@@msで実行成功",
        pluginScriptFailed: "実行失敗: @@error@@",
        pluginValidating: "検証中...",
        pluginScriptPlaceholder: "プラグインのスクリプト内容がここに読み込まれます",
        pluginUnloadConfirmTitle: "プラグインをアンロード",
        pluginUnloadConfirmMsg: "プラグインを停止し、リソースを解放します。",
        // ── Override system ──
        overrideTitle: "オーバーライドスクリプト",
        overrideSearchPlaceholder: "オーバーライドを検索...",
        overrideNew: "新規",
        overrideNewJs: "新規 JS オーバーライド",
        overrideNewPrism: "新規 Prism YAML",
        overrideImportUrl: "URL からインポート",
        overrideImportUrlPrompt: "リモート URL を入力:",
        overrideInvalidUrl: "無効な URL",
        overrideEnableAll: "すべて有効化",
        overrideDisableAll: "すべて無効化",
        overrideBack: "戻る",
        overrideValidate: "検証",
        overrideSaveAndRun: "保存して実行",
        overrideFullscreen: "全画面",
        overrideOutput: "出力",
        overrideOutputPlaceholder: '「保存して実行」をクリックして出力を表示...',
        overrideCopy: "コピー",
        overrideCopied: "コピー済み",
        overrideClear: "クリア",
        overrideEditScript: "スクリプト編集",
        overrideLineCol: "行 @@line@@, 列 @@col@@",
        overrideCharCount: "@@count@@ 文字",
        overrideOutputLineCount: "出力 (@@count@@ 行)",
        overrideScopeGlobal: "グローバル",
        overrideScopeNone: "なし",
        overrideScopeTitle: "オーバーライドスコープ",
        overrideNoProfiles: "サブスクリプションが見つかりません",
        overrideExportAll: "すべてエクスポート",
        overrideImportFile: "ファイルからインポート",
        overrideExportEmpty: "エクスポートするオーバーライドがありません",
        overrideExportSuccess: "エクスポート先: @@path@@",
        overrideImportInvalid: "無効なエクスポートファイル形式です",
        overrideImportSuccess: "@@count@@ 個のオーバーライドをインポートしました",
        overrideEnabled: "● 有効",
        overrideDisabled: "○ 無効",
        overrideFailed: "● 失敗",
        overrideEnable: "有効化",
        overrideDisable: "無効化",
        overrideMoveUp: "上へ移動",
        overrideMoveDown: "下へ移動",
        overrideApplied: "Overrides applied, config reloaded",
        overrideNoMatch: "一致するオーバーライドがありません",
        overrideEmpty: "オーバーライドがありません。+ をクリックして作成してください。",
        overrideDeleteConfirmTitle: 'オーバーライド "@@name@@" を削除しますか？',
        overrideDeleteConfirmMsg: "この操作は元に戻せません。オーバーライドスクリプトと実行ログがすべて削除されます。",
        overrideValidating: "検証中...",
        overrideScriptSafe: "✓ スクリプト安全",
        overrideScriptUnsafe: "スクリプトは安全でない可能性があります",
        overrideExecuting: "実行中...",
        overrideExecSuccess: "✓ 実行成功",
        overrideExecFailed: "✗ 実行失敗",
        overrideScriptLine: "スクリプトの @@line@@ 行目、@@col@@ 列目",
        overrideEngineInternal: "エンジン内部 (eval_script:@@line@@:@@col@@)",
        overrideNamePrompt: 'オーバーライド名を入力:',
        overrideCreated: 'オーバーライド作成済み',
        overrideCoreNotRunning: '⚠ コア未起動、検証不可',
        auto: '自動',
        dismiss: "閉じる",
        trayCopyEnv: "プロキシ環境変数をコピー",
        trayCopyEnvSuccess: "プロキシ環境変数をコピーしました",
        copyProxyEnv: "プロキシ環境変数をコピー",
        copyProxyEnvDesc: "ターミナル用にプロキシ環境変数をコピー",
        copyEnvFormat: "シェル形式",
        copyEnvCopied: "コピー済み",
        copy: "コピー",

        // ── コンソールダッシュボード ──
        consoleTitle: "コンソール",
        consoleUptimeRunning: "コア実行中 —",
        consoleUptimeStopped: "コア停止 —",
        consoleUptimeFmt: "実行時間 @@days@@日 @@time@@",
        consoleDownSpeed: "ダウンロード速度",
        consoleUpSpeed: "アップロード速度",
        consoleTotalTraffic: "総トラフィック",
        consoleSessionTraffic: "セッショントラフィック",
        consoleActiveConn: "アクティブ接続",
        consoleConnUnit: "件",
        consoleNodeLatency: "ノード遅延",
        consolePeak: "ピーク",
        consoleRealtimeTraffic: "リアルタイムトラフィック",
        consoleDownload: "ダウンロード",
        consoleUpload: "アップロード",
        consoleAvgMin: "1分平均",
        consoleSessionDown: "セッションDL",
        consoleSessionUp: "セッションUL",
        consoleSampleInterval: "サンプリング間隔",
        consoleSampleValue: "1s · 60ptウィンドウ",
        consoleCurrentNode: "現在のノード",
        consoleSwitch: "切替",
        consoleTestLatency: "テスト",
        consoleQuickControl: "クイック制御",
        consoleSysProxy: "システムプロキシ",
        consoleTunAdapter: "TUNアダプター",
        consoleSortBySpeed: "速度順",
        consoleSortByTraffic: "トラフィック順",
        consoleSortByProcess: "プロセス順",
        consoleSortHint: "クリックでソート切替",
        consoleCopyHint: "クリックでコピー",
        consoleSubUsage: "サブスクリプション",
        consoleConnStatus: "ステータス",
        consoleStatusActive: "アクティブ",
        consoleProxyMode: "モード",
        consoleRecentEvents: "最近のイベント",
        consoleLatencyExcellent: "優秀",
        consoleLatencyFair: "普通",
        consoleLatencyHigh: "高い",
        consoleCurrentSub: "現在",
        consoleSystem: "システム",
        consoleNodePicker: "ノード切替",
        consoleAllLogs: "全ログ",
        consoleSubUsed: "使用済",
        consoleSubExpiry: "有効期限",
        consoleSubDaysLeft: { other: "残り@@d@@日" },
        consoleSubLastUpdate: "最終更新",
        consoleSubNextUpdate: "次回自動更新",
        consoleSubUpdateNow: "今すぐ更新",
        consoleSubUpdateOk: "サブスクリプションの更新に成功しました",
        consoleSubUpdateFail: "サブスクリプションの更新に失敗しました",
        consoleSubUpdateBusy: "更新中です。お待ちください",
        consoleSubManage: "管理",
        consoleSubNoSub: "サブスクリプションなし",
        consoleSubUpdating: "更新中…",
        consoleSubNodes: { other: "@@count@@ノード" },
        consoleSubJustNow: "たった今",
        consoleSubNever: "なし",
        consoleSubMinAgo: "@@m@@分前",
        consoleSubHoursAgo: "@@h@@時間前",
        consoleSubDaysAgo: "@@d@@日前",
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
        homePageMode: "홈 페이지 모드",
        homePageModeDesc: "미니멀과 콘솔 대시보드 전환",
        homePageMinimal: "미니멀",
        homePageConsole: "콘솔",
        loading: "로딩 중...",
        errorPrefix: "오류",
        unknown: "알 수 없음",
        providerPollExhausted: "제공자에서 노드를 사용할 수 없습니다. 다운로드 중이거나 로드에 실패했을 수 있습니다.",
        retry: "재시도",

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
        notifSwitchFailed: "노드 전환에 실패했습니다",
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
        coreUpdateAvailable: "코어 업데이트 사용 가능",
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
        logsTitle: "로그",
        logTabCore: "코어 로그",
        noLogs: "로그가 없습니다. 코어를 시작하세요.",
        autoScroll: "자동 스크롤",
        searchLogs: "로그 검색...",
        clearFilter: "모두 보기",
        logLevelAll: "전체",
        logLevelDebug: "디버그",
        logLevelInfo: "정보",
        logLevelWarn: "경고",
        logLevelError: "오류",
        logLevelFatal: "치명적",
        logPaused: "일시 정지",
        logLines: "줄",
        trayCopyEnv: "프록시 환경변수 복사",
        trayCopyEnvSuccess: "프록시 환경변수 복사됨",
        copyProxyEnv: "프록시 환경변수 복사",
        copyProxyEnvDesc: "터미널 사용을 위해 프록시 환경변수 복사",
        copyEnvFormat: "셸 형식",
        copyEnvCopied: "복사됨",
        copy: "복사",

        // ── 콘솔 대시보드 ──
        consoleTitle: "콘솔",
        consoleUptimeRunning: "코어 실행 중 —",
        consoleUptimeStopped: "코어 중지됨 —",
        consoleUptimeFmt: "가동 시간 @@days@@일 @@time@@",
        consoleDownSpeed: "다운로드 속도",
        consoleUpSpeed: "업로드 속도",
        consoleTotalTraffic: "총 트래픽",
        consoleSessionTraffic: "세션 트래픽",
        consoleActiveConn: "활성 연결",
        consoleConnUnit: "개",
        consoleNodeLatency: "노드 지연",
        consolePeak: "피크",
        consoleRealtimeTraffic: "실시간 트래픽",
        consoleDownload: "다운로드",
        consoleUpload: "업로드",
        consoleAvgMin: "1분 평균",
        consoleSessionDown: "세션 DL",
        consoleSessionUp: "세션 UL",
        consoleSampleInterval: "샘플 간격",
        consoleSampleValue: "1s · 60pt 윈도우",
        consoleCurrentNode: "현재 노드",
        consoleSwitch: "전환",
        consoleTestLatency: "테스트",
        consoleQuickControl: "빠른 제어",
        consoleSysProxy: "시스템 프록시",
        consoleTunAdapter: "TUN 어댑터",
        consoleSortBySpeed: "속도순",
        consoleSortByTraffic: "트래픽순",
        consoleSortByProcess: "프로세스순",
        consoleSortHint: "클릭하여 정렬 전환",
        consoleCopyHint: "클릭하여 복사",
        consoleSubUsage: "구독",
        consoleConnStatus: "상태",
        consoleStatusActive: "활성",
        consoleProxyMode: "모드",
        consoleRecentEvents: "최근 이벤트",
        consoleLatencyExcellent: "우수",
        consoleLatencyFair: "보통",
        consoleLatencyHigh: "높음",
        consoleCurrentSub: "현재",
        consoleSystem: "시스템",
        consoleNodePicker: "노드 전환",
        consoleAllLogs: "전체 로그",
        consoleSubUsed: "사용됨",
        consoleSubExpiry: "만료일",
        consoleSubDaysLeft: { other: "남은 @@d@@일" },
        consoleSubLastUpdate: "최근 업데이트",
        consoleSubNextUpdate: "다음 자동 업데이트",
        consoleSubUpdateNow: "지금 업데이트",
        consoleSubUpdateOk: "구독 업데이트 성공",
        consoleSubUpdateFail: "구독 업데이트 실패",
        consoleSubUpdateBusy: "업데이트 중입니다. 잠시만 기다려 주세요",
        consoleSubManage: "관리",
        consoleSubNoSub: "구독 없음",
        consoleSubUpdating: "업데이트 중…",
        consoleSubNodes: { other: "@@count@@개 노드" },
        consoleSubJustNow: "방금",
        consoleSubNever: "없음",
        consoleSubMinAgo: "@@m@@분 전",
        consoleSubHoursAgo: "@@h@@시간 전",
        consoleSubDaysAgo: "@@d@@일 전",
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
 * @returns {{ value: unknown, found: boolean }}
 */
function resolveKey(key) {
    const langKey = /** @type {'en'|'zh'|'ja'|'ko'} */(currentLang);
    const primary = /** @type {Record<string, unknown>} */(translations[langKey]);
    if (primary && Object.prototype.hasOwnProperty.call(primary, key)) {
        return { value: primary[key], found: true };
    }
    const fallback = /** @type {Record<string, unknown>} */(translations.en);
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
            const pluralObj = /** @type {Record<string, string>} */ (value);
            const template = pluralObj[category] || pluralObj.other || pluralObj.one || '';
            return interpolate(template, { count, ...extraVars }, key);
        }
        // Fallback: value is a plain string, inject count as @@count@@
        return interpolate(typeof value === 'string' ? value : key, { count, ...extraVars }, key);
    }

    // Interpolation path: second argument is an object
    if (optionsOrCount && typeof optionsOrCount === 'object') {
        return interpolate(typeof value === 'string' ? value : key, optionsOrCount, key);
    }

    // Simple lookup
    return typeof value === 'string' ? value : key;
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
    let resolvedLang = /** @type {'en'|'zh'|'ja'|'ko'} */(lang);
    if (!translations[resolvedLang]) {
        i18nLogger.warn(`Unknown language "${lang}", falling back to "en"`);
        resolvedLang = 'en';
    }
    currentLang = resolvedLang;
    if (typeof localStorage !== 'undefined') {
        localStorage.setItem('lang', resolvedLang);
    }
    setHTMLAttributes(resolvedLang);
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

        invoke(COMMANDS.TRAY.UPDATE_TRAY_TOGGLE_STATES, {
            sysProxyEnabled,
            tunEnabled,
            currentMode: win._currentMode || 'rule',
        }).catch(e => i18nLogger.warn("Failed to update tray menu", e));
    }

    Bus.emit(Events.I18N_APPLIED);
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
