// Module script that runs before main.js: installs the promo-film mock API,
// then layers the commands current main needs on top, then loads the
// prototype named by ?proto=.
import './demo/mock-api.js';

const target = window.__DEMO_INTERNALS_TARGET__;
const promoInvoke = target.invoke;
const now = Math.floor(Date.now() / 1000);
const GB = 1024 ** 3;
const q = new URLSearchParams(location.search);
const homeMode = q.get('home') || 'minimal';
const theme = q.get('theme') || 'light';

const settings = {
  auto_update: false, auto_update_client: false, autostart: true, theme: null,
  last_config: 'config.yaml', custom_args: [], auto_apply: false, ui_scale: 1,
  config_order: ['config.yaml', 'subscription.yaml', 'backup-sub.yaml'],
  last_proxy_selection: {}, primary_group_preference: {}, hide_timeout_nodes: false,
  mode: 'rule', tun_enabled: false, mixed_port: 7890, ipv6: false, allow_lan: false,
  unified_delay: true, theme_mode: theme, app_opacity: 100, node_scroll: true,
  failover_enabled: false, lightweight_mode: false, silent_start: false,
  log_app_enabled: true, log_core_enabled: true, log_retention_days: 7, log_max_file_mb: 10,
  copy_env_format: 'cmd', home_page_mode: homeMode, close_to_tray: true, latency_timeout: 5000,
  sysproxy_bypass: null, latency_test_url: null,
};

const configs = [
  { name: 'config.yaml', size: 4096, is_active: true, url_display: 'https://sub.example.com/api/v1/client/subscribe?token=••••', sub_info: `upload=${Math.round(3.2 * GB)}; download=${Math.round(58.6 * GB)}; total=${200 * GB}; expire=${now + 86400 * 23}`, last_updated: now - 3600 * 5, auto_update_interval: 43200 },
  { name: 'subscription.yaml', size: 1024, is_active: false, url_display: 'https://example.com/subscription', sub_info: `upload=${Math.round(1.1 * GB)}; download=${Math.round(12.4 * GB)}; total=${100 * GB}; expire=${now + 86400 * 71}`, last_updated: now - 86400, auto_update_interval: 86400 },
  { name: 'backup-sub.yaml', size: 2048, is_active: false, url_display: 'https://backup.example.com/sub', last_updated: now - 86400 * 3, auto_update_interval: 0 },
];

const OVR = (window.__PROTO_INVOKE__ = window.__PROTO_INVOKE__ || {});
const base = {
  get_settings: () => settings,
  save_settings: (a) => { Object.assign(settings, a?.settings || {}); return null; },
  patch_settings: (a) => { Object.assign(settings, a?.patch || a || {}); return settings; },
  list_configs: () => configs,
  get_core_uptime: () => 3600 * 3 + 1260,
  get_app_version: () => '2.5.0',
  get_core_version: () => 'v1.19.17',
  'plugin:window|is_maximized': () => !!window.__PROTO_MAXIMIZED__,
  'plugin:autostart|is_enabled': () => true,
};
target.invoke = (cmd, args) => {
  if (cmd in OVR) return Promise.resolve(typeof OVR[cmd] === 'function' ? OVR[cmd](args) : OVR[cmd]);
  if (cmd in base) return Promise.resolve(base[cmd](args));
  return promoInvoke(cmd, args);
};
window.__PROTO_SETTINGS__ = settings;
window.__PROTO_CONFIGS__ = configs;

// Prototype loader: proto/p/<name>.js may export pre() (before app init)
// and post() (after the app is up). CSS may live in proto/p/<name>.css.
const name = window.__PROTO__;
if (name) {
  const shared = document.createElement('link');
  shared.rel = 'stylesheet';
  shared.href = 'proto/proto.css';
  document.head.appendChild(shared);
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = `proto/p/${name.replace(/-.*$/, '')}.css`;
  css.onerror = () => css.remove();
  document.head.appendChild(css);
  try {
    let mod;
    try { mod = await import(`./p/${name}.js`); } catch { mod = await import(`./p/${name.replace(/-.*$/, '')}.js`); }
    if (mod.pre) await mod.pre();
    window.__PROTO_POST__ = mod.post || null;
  } catch (e) {
    if (!String(e).includes('Failed to fetch')) console.error('[proto]', e);
  }
}
