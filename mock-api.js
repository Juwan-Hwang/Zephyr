/**
 * Zephyr Demo — Comprehensive Mock API Layer (v2)
 *
 * Complete mock implementation for ALL 146+ Tauri IPC commands and mihomo REST APIs.
 * Simulates a fully functional proxy client in browser environment.
 *
 * Key fixes in v2:
 *  - transformCallback properly stores & invokes callback functions
 *  - Event system (listen/emit) fully functional with callback dispatch
 *  - Traffic stream outputs valid JSON (fixes "too many parse errors")
 *  - All 146 invoke handlers implemented (zero "Unhandled command" warnings)
 *  - Rule library operations persist state correctly
 *  - closeAllConnections works via fetch interception
 */

import {
  MOCK_PROXIES, MOCK_CONFIG, MOCK_RULES, MOCK_SETTINGS,
  MOCK_VERSION, MOCK_CONFIG_LIST, getOSPaths, generateTrafficTick, generateLogLine,
  getProxySet
} from './mock-data.js';

// ═══════════════════════════════════════════════════════════════════════════
//  Mutable State Management
// ═══════════════════════════════════════════════════════════════════════════

let currentOS = 'windows';
let proxyState = JSON.parse(JSON.stringify(MOCK_PROXIES));
let configState = JSON.parse(JSON.stringify(MOCK_CONFIG));
let sysProxyEnabled = false;
let tunEnabled = false;
let autostartEnabled = false;
let currentMode = 'rule';
let selectedProxy = '🔀 自动选择';
let coreRunning = true;
let uiScale = 1.0;

// Mutable settings state - supports last_config and last_proxy_selection
let settingsState = {
  ...MOCK_SETTINGS,
  last_config: 'config.yaml',
  last_proxy_selection: {},
  theme: 'dark'
};

// In-memory stores
const subscriptions = [
  { id: 'sub-1', name: '默认订阅', url: 'https://example.com/subscription', enabled: true, updated: '2026-04-17T10:00:00Z', nodes: 24 },
  { id: 'sub-2', name: '备用订阅', url: 'https://backup.example.com/sub', enabled: false, updated: '2026-04-16T08:00:00Z', nodes: 18 },
];

const ruleLibrary = [
  { id: 'rule-1', name: 'AI 服务规则', rules: ['DOMAIN-SUFFIX,openai.com,AI', 'DOMAIN-SUFFIX,anthropic.com,AI'], created: '2026-04-15' },
  { id: 'rule-2', name: '流媒体规则', rules: ['DOMAIN-SUFFIX,netflix.com,Stream', 'DOMAIN-SUFFIX,youtube.com,Stream'], created: '2026-04-14' },
];

const ruleGroups = [
  { id: 'group-1', name: '默认分组', rules: ['rule-1', 'rule-2'], created: '2026-04-15' },
];

const overrides = [
  { id: 'ov-1', name: '广告拦截', ext: '.yaml', type: 'script', enabled: true, content: 'payload:\n  - DOMAIN-SUFFIX,ad.com,REJECT', created: '2026-04-15' },
  { id: 'ov-2', name: '分流增强', ext: '.yaml', type: 'script', enabled: false, content: 'payload:\n  - DOMAIN-KEYWORD,openai,Proxy', created: '2026-04-14' },
];

const connections = new Map();
let connectionIdCounter = 1;

// KV store
const kvStore = new Map();

// Scheduler state
let schedulerStatus = { enabled: false, interval: 3600, last_run: null };

// Tray state
let trayMenuState = { sysProxy: true, tun: false, mode: 'rule' };

// Plugin store
const plugins = new Map();

// Script sandbox
let scriptSandbox = { enabled: true, limits: { cpu: 5000, memory: 64 } };

// Smart config
let smartConfigData = { enabled: false, interval: 300, history: [] };

// Failover policy
let failoverPolicy = { max_failures: 3, cooldown: 60 };

// Trace stats
let traceStats = { total_traces: 0, cache_hits: 0, cache_misses: 0 };

// Prism state
let prismState = { watching: false, rules: [], profiles: [] };

// ═══════════════════════════════════════════════════════════════════════════
//  Callback & Event System
// ═══════════════════════════════════════════════════════════════════════════

/** Store for transformCallback functions — maps callbackId -> function */
const callbackStore = new Map();

/** Store for event listeners — maps eventId -> { event, callbackId } */
const eventListeners = new Map();

/** Counter for generating unique IDs */
let callbackCounter = 0;
let eventCounter = 0;

/**
 * Simulate emitting a Tauri event to all listeners of that event type.
 * This is the core of making the event system work.
 */
function emitTauriEvent(event, payload) {
  for (const [listenerId, entry] of eventListeners) {
    if (entry.event === event) {
      const fn = callbackStore.get(entry.callbackId);
      if (fn) {
        try {
          fn({ event, id: listenerId, payload });
        } catch (e) {
          console.warn('[Mock API] Event callback error:', e);
        }
      }
    }
  }
}

// Initialize mock connections
function initConnections() {
  const domains = ['google.com', 'github.com', 'api.openai.com', 'reddit.com', 'twitter.com'];
  for (let i = 0; i < 5; i++) {
    const id = `conn-${connectionIdCounter++}`;
    connections.set(id, {
      id,
      metadata: {
        host: domains[i],
        sourceIP: '192.168.1.100',
        sourcePort: 54000 + i,
        destinationIP: `142.250.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`,
        destinationPort: 443,
        process: ['Chrome', 'Firefox', 'Electron'][Math.floor(Math.random() * 3)],
        type: 'HTTP'
      },
      upload: Math.floor(Math.random() * 10000),
      download: Math.floor(Math.random() * 50000),
      start: Date.now() - Math.floor(Math.random() * 60000),
      chains: ['🇯🇵 日本-东京-01'],
      rule: 'GLOBAL'
    });
  }
}
initConnections();

// ═══════════════════════════════════════════════════════════════════════════
//  Tauri IPC Handlers — Complete (146 commands)
// ═══════════════════════════════════════════════════════════════════════════

const INVOKE_HANDLERS = {

  // ─── Window Management ─────────────────────────────────────────────
  'show_main_window': () => null,
  'plugin:window|close': () => { window.parent?.postMessage?.({ type: 'zephyr-close' }, '*'); return null; },
  'plugin:window|minimize': () => { window.parent?.postMessage?.({ type: 'zephyr-minimize' }, '*'); return null; },
  'plugin:window|maximize': () => { window.parent?.postMessage?.({ type: 'zephyr-maximize' }, '*'); return null; },
  'plugin:window|set_title': () => null,
  'plugin:window|set_visible': () => null,
  'plugin:window|is_visible': () => true,
  'plugin:window|set_focus': () => null,

  // ─── Settings ──────────────────────────────────────────────────────
  'get_settings': () => ({ ...settingsState, theme: localStorage.getItem('zephyr-theme') || settingsState.theme }),
  'save_settings': (args) => {
    if (args?.settings) {
      settingsState = { ...settingsState, ...args.settings };
      if (args.settings.theme) localStorage.setItem('zephyr-theme', args.settings.theme);
    }
    return null;
  },
  'set_ui_scale': (args) => { if (args?.scale) uiScale = args.scale; return null; },

  // ─── Proxy Memory ──────────────────────────────────────────────────
  'update_proxy_selection': (args) => {
    if (args?.profileName && args?.nodeName) {
      settingsState.last_proxy_selection = settingsState.last_proxy_selection || {};
      settingsState.last_proxy_selection[args.profileName] = args.nodeName;
    }
    return null;
  },

  // ─── Config Management ─────────────────────────────────────────────
  'list_configs': () => [...MOCK_CONFIG_LIST],
  'read_config': () => ({
    content: `# Mihomo Configuration
mode: ${currentMode}
log-level: info
mixed-port: 7890
external-controller: 127.0.0.1:9090

proxies:
  - name: "香港-01"
    type: ss
    server: hk1.example.com
    port: 443
    cipher: aes-256-gcm
    password: "password"

proxy-groups:
  - name: GLOBAL
    type: select
    proxies:
      - 香港-01
      - DIRECT
`
  }),
  'read_config_file': () => ({ content: '# Mock config file content' }),
  'write_config_file': () => null,
  'update_config': () => null,
  'update_config_url': (args) => {
    const sub = subscriptions.find(s => s.id === args?.id);
    if (sub && args?.url) sub.url = args.url;
    return null;
  },
  'update_subscription_interval': (args) => {
    const item = MOCK_CONFIG_LIST.find(c => c.name === args?.name);
    if (item && args?.interval !== undefined) item.auto_update_interval = args.interval;
    return null;
  },
  'rename_config': (args) => {
    const item = MOCK_CONFIG_LIST.find(c => c.name === args?.old_name);
    if (item && args?.new_name) item.name = args.new_name;
    return null;
  },

  // ─── Core Management ───────────────────────────────────────────────
  'start_core': (args) => {
    coreRunning = true;
    if (args?.configPath) {
      settingsState.last_config = args.configPath;
      const newProxySet = getProxySet(args.configPath);
      proxyState = JSON.parse(JSON.stringify(newProxySet));
      console.log('[Mock API] Switched proxy set to:', args.configPath, '(nodes:', Object.keys(proxyState.proxies).length, ')');
    }
    return { port: 9090, pid: 12345, secret: 'mock-secret-' + Date.now() };
  },
  'stop_core': () => { coreRunning = false; return null; },
  'get_core_version': () => MOCK_VERSION.version,
  'update_core': () => null,
  'get_latest_version': () => ({ version: '1.19.0', name: 'Meta' }),
  'get_latest_client_version': () => ({ version: '0.5.0', download_url: '', notes: '' }),
  'get_latest_client_versions': () => ({ latest: '0.5.0', current: '0.5.0' }),
  'update_client': () => null,
  'update_geo_data': () => ({ success: true, message: 'Geo data updated' }),
  'is_machine_key_persisted': () => true,

  // ─── System Proxy ──────────────────────────────────────────────────
  'enable_sysproxy': () => { sysProxyEnabled = true; emitTauriEvent('tray-sysproxy-changed', { enabled: true }); return null; },
  'disable_sysproxy': () => { sysProxyEnabled = false; emitTauriEvent('tray-sysproxy-changed', { enabled: false }); return null; },
  'get_sys_proxy': () => sysProxyEnabled,

  // ─── Tray ──────────────────────────────────────────────────────────
  'get_tray_status': () => ({ sysProxy: sysProxyEnabled, tun: tunEnabled, mode: currentMode }),
  'get_tray_proxy_status': () => ({ proxy: selectedProxy, group: 'GLOBAL' }),
  'get_tray_menu_state': () => trayMenuState,
  'set_tray_menu_state': (args) => { if (args) Object.assign(trayMenuState, args); return null; },
  'change_tray_icon': () => null,
  'update_tray_full_menu': () => null,
  'update_tray_toggle_states': () => null,

  // ─── TUN ───────────────────────────────────────────────────────────
  'set_tun_enabled': () => { tunEnabled = true; emitTauriEvent('tray-tun-changed', { enabled: true }); return null; },
  'disable_tun_cmd': () => { tunEnabled = false; emitTauriEvent('tray-tun-changed', { enabled: false }); return null; },
  'release_tun_toggle': () => null,
  'restart_core_as_root_cmd': () => null,
  'kill_all_mihomo_as_root_cmd': () => null,
  'get_configs': () => ({ tun: tunEnabled, mixed_port: 7890, mode: currentMode }),

  // ─── Autostart ─────────────────────────────────────────────────────
  'plugin:autostart|enable': () => { autostartEnabled = true; return null; },
  'plugin:autostart|disable': () => { autostartEnabled = false; return null; },
  'plugin:autostart|is_enabled': () => autostartEnabled,

  // ─── Subscriptions ─────────────────────────────────────────────────
  'download_sub': (args) => {
    const name = args?.name;
    const configItem = MOCK_CONFIG_LIST.find(c => c.name === name);
    if (configItem) {
      configItem.last_updated = Math.floor(Date.now() / 1000);
      configItem.modified = new Date().toISOString();
    }
    const sub = subscriptions.find(s => s.id === args?.id);
    if (sub) {
      sub.updated = new Date().toISOString();
      sub.nodes = Math.floor(Math.random() * 20) + 10;
    }
    return { success: true, nodes: sub?.nodes || 0 };
  },
  'download_sub_batch': (args) => {
    const results = [];
    if (args?.items) {
      for (const item of args.items) {
        const configItem = MOCK_CONFIG_LIST.find(c => c.name === item.name);
        if (configItem) {
          configItem.last_updated = Math.floor(Date.now() / 1000);
          configItem.modified = new Date().toISOString();
        }
        results.push({ name: item.name, success: true });
      }
    }
    return results;
  },
  'get_config_url': (args) => {
    const sub = subscriptions.find(s => s.id === args?.id);
    return { url: sub?.url || '' };
  },
  'delete_config': (args) => {
    const idx = subscriptions.findIndex(s => s.id === args?.id);
    if (idx > -1) subscriptions.splice(idx, 1);
    const cfgIdx = MOCK_CONFIG_LIST.findIndex(c => c.name === args?.name);
    if (cfgIdx > -1) MOCK_CONFIG_LIST.splice(cfgIdx, 1);
    return null;
  },
  'fetch_text': (args) => ({ content: '# Fetched content from ' + (args?.url || 'unknown') }),
  'exempt_uwp_apps': () => null,

  // ─── Rule Library ──────────────────────────────────────────────────
  'rule_list': () => ({ rules: ruleLibrary }),
  'rule_read': (args) => ruleLibrary.find(r => r.id === args?.id) || null,
  'rule_extract_from_profile': (args) => {
    const configName = args?.profile || settingsState.last_config;
    const proxySet = getProxySet(configName);
    const extractedRules = [];
    for (const [name, proxy] of Object.entries(proxySet.proxies)) {
      if (proxy.type !== 'Direct' && proxy.type !== 'Reject') {
        extractedRules.push({ type: 'DOMAIN-SUFFIX', payload: `${name.toLowerCase().replace(/[^a-z0-9]/g, '')}.example.com`, proxy: name });
      }
    }
    return { rules: extractedRules };
  },
  'rule_create': (args) => {
    const newRule = {
      id: `rule-${Date.now()}`,
      name: args?.name || '新规则',
      rules: args?.rules || [],
      created: new Date().toISOString()
    };
    ruleLibrary.push(newRule);
    return { id: newRule.id };
  },
  'rule_update': (args) => {
    const rule = ruleLibrary.find(r => r.id === args?.id);
    if (rule) {
      if (args?.name) rule.name = args.name;
      if (args?.rules) rule.rules = args.rules;
    }
    return null;
  },
  'rule_delete': (args) => {
    const idx = ruleLibrary.findIndex(r => r.id === args?.id);
    if (idx > -1) ruleLibrary.splice(idx, 1);
    return null;
  },
  'rule_rename': (args) => {
    const rule = ruleLibrary.find(r => r.id === args?.id);
    if (rule && args?.name) rule.name = args.name;
    return null;
  },
  'RULE_GET_ALL': () => ({ rules: ruleLibrary }),
  'RULE_APPLY_TO_PROFILE': () => ({ success: true }),
  'rule_import_text': (args) => {
    const lines = (args?.text || '').split('\n').filter(l => l.trim());
    const rules = lines.map(l => {
      const parts = l.split(',');
      return { type: parts[0] || 'DOMAIN-SUFFIX', payload: parts[1] || '', proxy: parts[2] || 'GLOBAL' };
    });
    const newRule = { id: `rule-${Date.now()}`, name: args?.name || '导入规则', rules, created: new Date().toISOString() };
    ruleLibrary.push(newRule);
    return { id: newRule.id, count: rules.length };
  },
  'rule_import_file': () => ({ id: `rule-${Date.now()}`, count: 5 }),
  'rule_import_url': () => ({ id: `rule-${Date.now()}`, count: 8 }),
  'rule_group_list': () => ({ groups: ruleGroups }),
  'rule_group_create': (args) => {
    const group = { id: `group-${Date.now()}`, name: args?.name || '新分组', rules: args?.rules || [], created: new Date().toISOString() };
    ruleGroups.push(group);
    return { id: group.id };
  },
  'rule_group_rename': (args) => {
    const group = ruleGroups.find(g => g.id === args?.id);
    if (group && args?.name) group.name = args.name;
    return null;
  },
  'rule_group_delete': (args) => {
    const idx = ruleGroups.findIndex(g => g.id === args?.id);
    if (idx > -1) ruleGroups.splice(idx, 1);
    return null;
  },
  'rule_group_move': () => null,
  'rule_get_auto_apply': () => false,
  'rule_set_auto_apply': (args) => { /* store but no-op in mock */ return null; },
  'open_prism_folder': () => getOSPaths(currentOS).config_dir,

  // ─── Override System ───────────────────────────────────────────────
  'override_list': () => ({ overrides }),
  'override_create': (args) => {
    const ov = {
      id: `ov-${Date.now()}`,
      name: args?.name || '新覆盖',
      ext: args?.ext || '.yaml',
      type: args?.type || 'script',
      enabled: true,
      content: args?.content || '',
      created: new Date().toISOString().slice(0, 10),
    };
    overrides.push(ov);
    return { id: ov.id };
  },
  'override_update': (args) => {
    const ov = overrides.find(o => o.id === args?.id);
    if (ov) {
      if (args?.name !== undefined) ov.name = args.name;
      if (args?.ext !== undefined) ov.ext = args.ext;
      if (args?.type !== undefined) ov.type = args.type;
    }
    return null;
  },
  'override_delete': (args) => {
    const idx = overrides.findIndex(o => o.id === args?.id);
    if (idx > -1) overrides.splice(idx, 1);
    return null;
  },
  'override_get_content': (args) => {
    const ov = overrides.find(o => o.id === args?.id);
    return ov ? { content: ov.content } : { content: '' };
  },
  'override_set_content': (args) => {
    const ov = overrides.find(o => o.id === args?.id);
    if (ov && args?.content !== undefined) ov.content = args.content;
    return null;
  },
  'override_reorder': (args) => {
    if (args?.ids) {
      const ordered = args.ids.map(id => overrides.find(o => o.id === id)).filter(Boolean);
      overrides.length = 0;
      overrides.push(...ordered);
    }
    return null;
  },
  'override_toggle': (args) => {
    const ov = overrides.find(o => o.id === args?.id);
    if (ov && args?.enabled !== undefined) ov.enabled = args.enabled;
    return null;
  },
  'override_test': (args) => {
    const ov = overrides.find(o => o.id === args?.id);
    return { success: true, id: args?.id, name: ov?.name || '', applied: 0 };
  },
  'override_refresh_remote': (args) => {
    const ov = overrides.find(o => o.id === args?.id);
    if (ov) ov.content = '# Refreshed remote content\n' + (ov.content || '');
    return { success: true };
  },
  'override_apply_all': () => {
    const applied = overrides.filter(o => o.enabled).length;
    return { success: true, applied };
  },
  'override_export': () => {
    const data = overrides.map(o => ({ name: o.name, ext: o.ext, type: o.type, enabled: o.enabled, content: o.content }));
    return { data: JSON.stringify(data) };
  },
  'override_import': (args) => {
    try {
      const items = JSON.parse(args?.data || '[]');
      let count = 0;
      for (const item of items) {
        overrides.push({
          id: `ov-${Date.now()}-${count}`,
          name: item.name || '导入覆盖',
          ext: item.ext || '.yaml',
          type: item.type || 'script',
          enabled: item.enabled ?? true,
          content: item.content || '',
          created: new Date().toISOString().slice(0, 10),
        });
        count++;
      }
      return { success: true, count };
    } catch {
      return { success: false, count: 0 };
    }
  },

  // ─── Settings (partial) ───────────────────────────────────────────
  'patch_settings': (args) => {
    if (args?.settings) {
      settingsState = { ...settingsState, ...args.settings };
    }
    return null;
  },
  'update_last_config': (args) => {
    if (args?.config) settingsState.last_config = args.config;
    return null;
  },
  'update_primary_group_preference': (args) => {
    if (args?.group) settingsState.primary_group = args.group;
    return null;
  },

  // ─── Prism Engine ──────────────────────────────────────────────────
  'prism_apply': () => { emitTauriEvent('prism-event', { type: 'applied' }); return null; },
  'prism_rebuild': () => null,
  'prism_status': () => ({ active: false, rules_count: 0 }),
  'prism_list_rules': () => ({ rules: [] }),
  'prism_preview_rules': (args) => ({ rules: [{ type: 'DOMAIN-SUFFIX', payload: 'preview.example.com', proxy: 'GLOBAL' }] }),
  'prism_is_prism_rule': () => false,
  'prism_validate_config': () => ({ valid: true, errors: [] }),
  'prism_start_watching': () => { prismState.watching = true; return null; },
  'prism_stop_watching': () => { prismState.watching = false; return null; },
  'prism_is_watching': () => prismState.watching,
  'prism_get_stats': () => ({ applied: 0, skipped: 0, errors: 0 }),
  'prism_insert_rule': () => null,
  'prism_insert_rule_str': () => null,
  'prism_toggle_group': () => null,
  'prism_trace_report': () => ({ traces: [] }),
  'prism_trace_report_text': () => 'No traces available',
  'prism_list_profiles': () => ({ profiles: prismState.profiles }),
  'prism_get_core_info': () => ({ version: MOCK_VERSION.version, running: coreRunning }),
  'prism_read_raw_profile': () => ({ content: '# Raw profile content' }),

  // ─── Logs ──────────────────────────────────────────────────────────
  'read_core_log': () => {
    const lines = [];
    for (let i = 0; i < 100; i++) lines.push(generateLogLine());
    return lines.join('\n');
  },

  // ─── File/Folder ───────────────────────────────────────────────────
  'open_config_folder': () => getOSPaths(currentOS).config_dir,

  // ─── Events (Tauri plugin:event) ───────────────────────────────────
  'plugin:event|listen': (args) => {
    // args = { event: string, handler: callbackId }
    // The handler callbackId was registered via transformCallback
    const eventId = `evt-${++eventCounter}`;
    if (args?.event && args?.handler) {
      eventListeners.set(eventId, { event: args.event, callbackId: args.handler });
      console.log('[Mock API] Event listener registered:', args.event, '->', eventId);
    }
    return eventId;
  },
  'plugin:event|unlisten': (args) => {
    if (args?.id) {
      eventListeners.delete(args.id);
    }
    return null;
  },

  // ─── Opener ────────────────────────────────────────────────────────
  'plugin:opener|open_url': () => null,

  // ─── Notifications ─────────────────────────────────────────────────
  'rate_limited_send_notification': (args) => {
    // Show a browser notification as fallback
    if (args?.title && 'Notification' in window) {
      try { new Notification(args.title, { body: args.body || '' }); } catch {}
    }
    return null;
  },

  // ─── Shortcuts ─────────────────────────────────────────────────────
  'rate_limited_register_shortcut': () => null,
  'rate_limited_unregister_shortcut': () => null,

  // ─── Scheduler ─────────────────────────────────────────────────────
  'get_scheduler_status': () => schedulerStatus,
  'trigger_auto_update': () => {
    schedulerStatus.last_run = new Date().toISOString();
    return { success: true };
  },

  // ─── Updater ───────────────────────────────────────────────────────
  'update_subscription_user_agent': () => null,

  // ─── Misc ──────────────────────────────────────────────────────────
  'smart_config': () => smartConfigData,
  'get_portable_mode': () => false,
  'get_app_version': () => '0.5.0',

  // ─── Smart Proxy Selector ──────────────────────────────────────────
  'smart_score': (args) => ({ name: args?.name || 'node', score: Math.floor(Math.random() * 100) }),
  'smart_config_save': (args) => { if (args) Object.assign(smartConfigData, args); return null; },
  'smart_next_interval': () => 300,
  'smart_rank': () => ({ rankings: Object.keys(proxyState.proxies).slice(0, 5).map(n => ({ name: n, score: Math.floor(Math.random() * 100) })) }),
  'smart_select_best': () => ({ name: Object.keys(proxyState.proxies)[1] || 'DIRECT' }),
  'smart_clear_history': () => { smartConfigData.history = []; return null; },
  'smart_score_at': () => ({ score: 50 }),
  'smart_validate_config': () => ({ valid: true }),
  'smart_scheduler_config': () => ({ interval: 300, enabled: false }),
  'smart_trim_history': () => ({ trimmed: 0 }),

  // ─── Failover ──────────────────────────────────────────────────────
  'failover_report': () => ({ failures: [], recovered: 0 }),
  'failover_get_policy': () => failoverPolicy,
  'failover_set_policy': (args) => { if (args) Object.assign(failoverPolicy, args); return null; },
  'failover_failure_count': () => 0,
  'failover_reset': () => { failoverPolicy = { max_failures: 3, cooldown: 60 }; return null; },

  // ─── KV Store ──────────────────────────────────────────────────────
  'kv_get': (args) => kvStore.get(args?.key) ?? null,
  'kv_set': (args) => { if (args?.key !== undefined) kvStore.set(args.key, args.value); return null; },
  'kv_delete': (args) => { kvStore.delete(args?.key); return null; },
  'kv_keys': () => ({ keys: Array.from(kvStore.keys()) }),

  // ─── Trace Advanced ────────────────────────────────────────────────
  'trace_statistics': () => traceStats,
  'trace_filter_by_source': () => ({ traces: [] }),

  // ─── Plugin System ─────────────────────────────────────────────────
  'plugin_discover': () => ({ plugins: [] }),
  'plugin_load': (args) => { plugins.set(args?.name || 'unknown', { loaded: true }); return null; },
  'plugin_unload': (args) => { plugins.delete(args?.name); return null; },
  'plugin_enable': () => null,
  'plugin_delete': () => null,
  'plugin_list_loaded': () => ({ plugins: Array.from(plugins.keys()) }),
  'plugin_execute_hook': () => ({ result: null }),
  'plugin_list_hooks': () => ({ hooks: [] }),
  'plugin_execute': () => ({ output: '' }),
  'plugin_list_permissions': () => ({ permissions: [] }),
  'plugin_check_permission': () => true,

  // ─── Script Engine ─────────────────────────────────────────────────
  'script_execute': (args) => ({ output: `Executed: ${args?.script || 'unnamed'}`, success: true }),
  'script_validate': () => ({ valid: true, errors: [] }),
  'script_get_sandbox': () => scriptSandbox,
  'script_set_sandbox': (args) => { if (args) Object.assign(scriptSandbox, args); return null; },
  'script_get_limits': () => scriptSandbox.limits,
  'script_set_limits': (args) => { if (args) Object.assign(scriptSandbox.limits, args); return null; },
  'script_grant_plugin': () => null,
  'script_revoke_plugin': () => null,
  'script_check_plugin_permission': () => true,
  'script_is_sandbox_safe': () => true,
};

// ═══════════════════════════════════════════════════════════════════════════
//  Inject into Tauri Internals
// ═══════════════════════════════════════════════════════════════════════════

const _target = window.__DEMO_INTERNALS_TARGET__ || window.__TAURI_INTERNALS__;

const mockInvoke = (cmd, args) => {
  const handler = INVOKE_HANDLERS[cmd];
  if (handler) {
    return Promise.resolve(handler(args));
  }
  console.warn('[Mock API] Unhandled command:', cmd);
  return Promise.resolve(null);
};

const mockTransformCallback = (fn) => {
  if (fn === undefined) {
    // Cleanup callback — return a no-op ID
    return '__mock_cleanup__';
  }
  const id = `__mock_cb_${++callbackCounter}__`;
  callbackStore.set(id, fn);
  return id;
};

if (_target) {
  _target.invoke = mockInvoke;
  _target.transformCallback = mockTransformCallback;
} else {
  window.__TAURI_INTERNALS__ = {
    invoke: mockInvoke,
    transformCallback: mockTransformCallback,
    metadata: { currentWindow: { label: 'main' } },
  };
}

// Expose emitTauriEvent globally for internal use
window.__MOCK_EMIT__ = emitTauriEvent;

// Mark demo environment
window.__AETHER_DEMO__ = true;

// ═══════════════════════════════════════════════════════════════════════════
//  Fetch Interception for Mihomo REST API
// ═══════════════════════════════════════════════════════════════════════════

const originalFetch = window.fetch;

window.fetch = async function(input, init) {
  const url = typeof input === 'string' ? input : input.url;

  // Only intercept mihomo API calls
  if (!url.includes('127.0.0.1:9090') && !url.includes('localhost:9090')) {
    return originalFetch.call(this, input, init);
  }

  const method = (init?.method || 'GET').toUpperCase();
  const path = url.replace(/^https?:\/\/[^/]+/, '');

  console.log('[Mock API] Fetch:', method, path);

  // ─── GET endpoints ─────────────────────────────────────────────────
  if (method === 'GET') {
    if (path === '/proxies' || path.startsWith('/proxies?')) {
      return mockResponse(proxyState);
    }
    if (path === '/configs') {
      return mockResponse(configState);
    }
    if (path === '/rules') {
      return mockResponse(MOCK_RULES);
    }
    if (path === '/connections') {
      const conns = Array.from(connections.values());
      const totalUp = conns.reduce((sum, c) => sum + c.upload, 0);
      const totalDown = conns.reduce((sum, c) => sum + c.download, 0);
      return mockResponse({
        downloadTotal: totalDown,
        uploadTotal: totalUp,
        connections: conns
      });
    }
    if (path === '/version') {
      return mockResponse(MOCK_VERSION);
    }
    if (path.includes('/delay')) {
      const delay = Math.floor(Math.random() * 300 + 50);
      return mockResponse({ delay });
    }

    // ─── Traffic Stream (JSON format — critical fix) ─────────────────
    if (path === '/traffic') {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const interval = setInterval(() => {
            const tick = generateTrafficTick();
            // CRITICAL: Must be valid JSON, one object per line
            // websocket.js processLine() calls JSON.parse(trimmed)
            const json = JSON.stringify({ up: tick.up, down: tick.down }) + '\n';
            controller.enqueue(encoder.encode(json));
          }, 1000);
          setTimeout(() => { clearInterval(interval); controller.close(); }, 300000);
        }
      });
      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }
      });
    }

    // ─── Log Stream ──────────────────────────────────────────────────
    if (path === '/logs') {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const interval = setInterval(() => {
            const log = generateLogLine();
            // Log stream also expects JSON format
            const json = JSON.stringify({ type: 'info', payload: log }) + '\n';
            controller.enqueue(encoder.encode(json));
          }, 2000);
          setTimeout(() => { clearInterval(interval); controller.close(); }, 300000);
        }
      });
      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }
      });
    }
  }

  // ─── PUT endpoints ─────────────────────────────────────────────────
  if (method === 'PUT') {
    if (path.startsWith('/proxies/') && path.includes('/delay')) {
      return mockResponse({ delay: Math.floor(Math.random() * 300 + 50) });
    }
    if (path.startsWith('/proxies/') && !path.includes('/delay')) {
      const proxyName = decodeURIComponent(path.replace(/^\/proxies\//, ''));
      try {
        const body = JSON.parse(init?.body || '{}');
        const selectedName = body.name;
        if (selectedName && proxyState.proxies[proxyName]) {
          proxyState.proxies[proxyName].now = selectedName;
          selectedProxy = selectedName;
          // Emit tray event for proxy change
          emitTauriEvent('tray-proxy-changed', { group: proxyName, name: selectedName });
        }
      } catch {}
      return mockResponse(null);
    }
    if (path.startsWith('/configs')) {
      try {
        const body = JSON.parse(init?.body || '{}');
        if (body.mode) {
          currentMode = body.mode;
          emitTauriEvent('tray-mode-changed', { mode: currentMode });
        }
        Object.assign(configState, body);
      } catch {}
      return mockResponse(null);
    }
  }

  // ─── PATCH endpoints ───────────────────────────────────────────────
  if (method === 'PATCH') {
    if (path === '/configs') {
      try {
        const body = JSON.parse(init?.body || '{}');
        if (body.mode) {
          currentMode = body.mode;
          emitTauriEvent('tray-mode-changed', { mode: currentMode });
        }
        if (body.tun) {
          tunEnabled = body.tun.enable === true;
        }
        Object.assign(configState, body);
      } catch {}
      return mockResponse(null);
    }
  }

  // ─── DELETE endpoints ──────────────────────────────────────────────
  if (method === 'DELETE') {
    if (path.startsWith('/connections/')) {
      const connId = path.replace(/^\/connections\//, '');
      connections.delete(connId);
      return mockResponse(null);
    }
    if (path === '/connections') {
      connections.clear();
      return mockResponse(null);
    }
  }

  return mockResponse(null);
};

function mockResponse(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  Simulated Periodic Events
// ═══════════════════════════════════════════════════════════════════════════

// Simulate core-download-status event (progress)
setTimeout(() => {
  emitTauriEvent('core-download-status', { status: 'done', progress: 100 });
}, 2000);

console.log(`[Mock API] v3 initialized — ${Object.keys(INVOKE_HANDLERS).length} handlers, event system active, JSON traffic stream`);
