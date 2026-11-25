// Injected before the page scripts: fakes Tauri's __TAURI_INTERNALS__ IPC.
(() => {
  const PORT = 19090;
  const now = Math.floor(Date.now() / 1000);
  const OVR = (window.__PROTO_OVERRIDES__ = window.__PROTO_OVERRIDES__ || {});
  const settings = Object.assign({
    auto_update: false, auto_update_client: false, autostart: true, theme: null,
    last_config: '奇迹机场.yaml', custom_args: [], dns_nameservers: null, dns_fallbacks: null,
    auto_apply: false, ui_scale: 1, config_order: ['奇迹机场.yaml', '闪电云.yaml', '自建 VPS.yaml'],
    last_proxy_selection: {}, primary_group_preference: {}, subscription_user_agent: null,
    hide_timeout_nodes: false, mode: 'rule', tun_enabled: false, mixed_port: 7890, socks_port: null,
    http_port: null, ipv6: false, allow_lan: false, unified_delay: true, dns_rewrite_enabled: true,
    theme_mode: 'dark', app_opacity: 100, node_scroll: true, failover_enabled: false,
    network_optim_auto_apply: false, lightweight_mode: false, silent_start: false, encrypt_configs: false,
    log_app_enabled: true, log_core_enabled: true, log_retention_days: 7, log_max_file_mb: 10,
    copy_env_format: 'cmd', home_page_mode: 'minimal', schema_version: 99, close_to_tray: true,
    global_shortcut: null, latency_timeout: 5000,
  }, OVR.settings || {});
  const GB = 1024 ** 3;
  const configs = [
    { name: '奇迹机场.yaml', url_display: 'https://sub.miracle.example/api/v1/client/subscribe?token=••••', sub_info: `upload=${Math.round(3.2 * GB)}; download=${Math.round(58.6 * GB)}; total=${200 * GB}; expire=${now + 86400 * 23}`, last_updated: now - 3600 * 5, auto_update_interval: 720 },
    { name: '闪电云.yaml', url_display: 'https://flash.example.net/link/••••?clash=1', sub_info: `upload=${Math.round(1.1 * GB)}; download=${Math.round(12.4 * GB)}; total=${100 * GB}; expire=${now + 86400 * 71}`, last_updated: now - 86400, auto_update_interval: 1440 },
    { name: '自建 VPS.yaml', url_display: null, sub_info: null, last_updated: now - 86400 * 9 },
  ];
  let cbId = 1;
  const callbacks = {};
  const log = (...a) => { (window.__MOCK_LOG__ = window.__MOCK_LOG__ || []).push(a.join(' ')); };
  const table = {
    get_settings: () => settings,
    save_settings: (a) => { Object.assign(settings, a?.settings || {}); return null; },
    patch_settings: (a) => { for (const [k, v] of Object.entries(a?.patch || {})) settings[k] = v; return settings; },
    start_core: () => ({ secret: 'proto', port: PORT, active_config: settings.last_config }),
    get_core_version: () => 'v1.19.17',
    get_core_uptime: () => 3600 * 3 + 1260,
    get_app_version: () => '2.5.0',
    get_portable_mode: () => false,
    list_configs: () => configs,
    get_sys_proxy: () => ({ enable: true, server: '127.0.0.1:7890', bypass: 'localhost;127.*;10.*;172.16.*;192.168.*;<local>' }),
    has_sysproxy_ownership: () => true,
    enable_sysproxy: () => null,
    disable_sysproxy: () => null,
    is_machine_key_persisted: () => true,
    is_process_elevated: () => false,
    can_elevate_as_self: () => true,
    get_tray_icon_mode: () => 'normal',
    get_tray_menu_state: () => ({}),
    get_scheduler_status: () => ({ running: true, next: [] }),
    take_pending_deep_links: () => [],
    heartbeat: () => null,
    write_frontend_log: () => null,
    read_config: () => '',
    read_config_file: () => 'proxies: []\n',
    prism_apply: () => ({ stats: { succeeded: 0, total: 0 }, rule_annotations: [] }),
    prism_status: () => ({}),
    prism_list_rules: () => [],
    override_apply_all: () => [],
    'plugin:autostart|is_enabled': () => true,
    'plugin:window|is_maximized': () => !!OVR.maximized,
    'plugin:event|listen': () => cbId++,
    'plugin:event|unlisten': () => null,
    get_process_icon: () => null,
    read_core_log: () => ({ lines: [], next_offset: 0, file_size: 0, has_more: false }),
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
    transformCallback(fn, once) { const id = cbId++; callbacks[id] = fn; window[`_${id}`] = fn; return id; },
    unregisterCallback(id) { delete callbacks[id]; },
    convertFileSrc: (p) => p,
    async invoke(cmd, args) {
      const custom = OVR.invoke && OVR.invoke[cmd];
      if (custom) return typeof custom === 'function' ? custom(args) : custom;
      if (cmd in table) return table[cmd](args);
      log('UNMOCKED', cmd, JSON.stringify(args || {}).slice(0, 200));
      if (/^(list|prism_list|get_.*s$)/.test(cmd)) return [];
      return null;
    },
  };
  window.__internal_unstable_listeners_object_id__ = {};
  window.__MOCK_SETTINGS__ = settings;
  window.__MOCK_CONFIGS__ = configs;
})();
