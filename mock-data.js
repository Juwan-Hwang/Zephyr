/**
 * Zephyr Demo — Comprehensive Mock Data
 */

const OS_PATHS = {
  windows: { config_dir: 'C:\\Users\\Demo\\.config\\mihomo', config_file: 'C:\\Users\\Demo\\.config\\mihomo\\config.yaml' },
  macos: { config_dir: '/Users/demo/.config/mihomo', config_file: '/Users/demo/.config/mihomo/config.yaml' },
  linux: { config_dir: '/etc/mihomo', config_file: '/etc/mihomo/config.yaml' },
};
export const getOSPaths = (os) => OS_PATHS[os] || OS_PATHS.windows;

// ═══════════════════════════════════════════════════════════════════════════
//  Proxy data per profile — each subscription has different nodes
// ═══════════════════════════════════════════════════════════════════════════

const PROXY_SETS = {
  'config.yaml': {
    proxies: {
      GLOBAL: { name: 'GLOBAL', type: 'Selector', now: '🔀 自动选择', all: ['🔀 自动选择', '🇭🇰 香港-01', '🇯🇵 日本-东京-01', '🇸🇬 新加坡-01', '🇺🇸 美国-硅谷-01', 'DIRECT'] },
      '🇭🇰 香港-01': { name: '🇭🇰 香港-01', type: 'Shadowsocks', udp: true, history: [{ delay: 89 }] },
      '🇯🇵 日本-东京-01': { name: '🇯🇵 日本-东京-01', type: 'VMess', udp: true, history: [{ delay: 68 }] },
      '🇸🇬 新加坡-01': { name: '🇸🇬 新加坡-01', type: 'Trojan', udp: true, history: [{ delay: 156 }] },
      '🇺🇸 美国-硅谷-01': { name: '🇺🇸 美国-硅谷-01', type: 'VLESS', udp: true, history: [{ delay: 178 }] },
      DIRECT: { name: 'DIRECT', type: 'Direct', udp: true, history: [{ delay: 5 }] },
      REJECT: { name: 'REJECT', type: 'Reject', udp: false, history: [] },
    }
  },
  'subscription.yaml': {
    proxies: {
      GLOBAL: { name: 'GLOBAL', type: 'Selector', now: '🇹🇼 台湾-02', all: ['🇹🇼 台湾-02', '🇰🇷 韩国-首尔-01', '🇯🇵 日本-大阪-01', '🇩🇪 德国-法兰克福-01', '🇬🇧 英国-伦敦-01', '🇫🇷 法国-巴黎-01', '🇨🇦 加拿大-多伦多-01', 'DIRECT'] },
      '🇹🇼 台湾-02': { name: '🇹🇼 台湾-02', type: 'Shadowsocks', udp: true, history: [{ delay: 45 }] },
      '🇰🇷 韩国-首尔-01': { name: '🇰🇷 韩国-首尔-01', type: 'VMess', udp: true, history: [{ delay: 72 }] },
      '🇯🇵 日本-大阪-01': { name: '🇯🇵 日本-大阪-01', type: 'Trojan', udp: true, history: [{ delay: 55 }] },
      '🇩🇪 德国-法兰克福-01': { name: '🇩🇪 德国-法兰克福-01', type: 'VLESS', udp: true, history: [{ delay: 210 }] },
      '🇬🇧 英国-伦敦-01': { name: '🇬🇧 英国-伦敦-01', type: 'Shadowsocks', udp: true, history: [{ delay: 195 }] },
      '🇫🇷 法国-巴黎-01': { name: '🇫🇷 法国-巴黎-01', type: 'VMess', udp: true, history: [{ delay: 220 }] },
      '🇨🇦 加拿大-多伦多-01': { name: '🇨🇦 加拿大-多伦多-01', type: 'Trojan', udp: true, history: [{ delay: 185 }] },
      DIRECT: { name: 'DIRECT', type: 'Direct', udp: true, history: [{ delay: 5 }] },
      REJECT: { name: 'REJECT', type: 'Reject', udp: false, history: [] },
    }
  },
  'backup-sub.yaml': {
    proxies: {
      GLOBAL: { name: 'GLOBAL', type: 'Selector', now: '🇺🇸 美国-洛杉矶-01', all: ['🇺🇸 美国-洛杉矶-01', '🇺🇸 美国-纽约-01', '🇦🇺 澳大利亚-悉尼-01', '🇮🇳 印度-孟买-01', '🇧🇷 巴西-圣保罗-01', '🇮🇳 印度-孟买-01', 'DIRECT'] },
      '🇺🇸 美国-洛杉矶-01': { name: '🇺🇸 美国-洛杉矶-01', type: 'VLESS', udp: true, history: [{ delay: 165 }] },
      '🇺🇸 美国-纽约-01': { name: '🇺🇸 美国-纽约-01', type: 'Shadowsocks', udp: true, history: [{ delay: 180 }] },
      '🇦🇺 澳大利亚-悉尼-01': { name: '🇦🇺 澳大利亚-悉尼-01', type: 'VMess', udp: true, history: [{ delay: 280 }] },
      '🇮🇳 印度-孟买-01': { name: '🇮🇳 印度-孟买-01', type: 'Trojan', udp: true, history: [{ delay: 310 }] },
      '🇧🇷 巴西-圣保罗-01': { name: '🇧🇷 巴西-圣保罗-01', type: 'VLESS', udp: true, history: [{ delay: 350 }] },
      DIRECT: { name: 'DIRECT', type: 'Direct', udp: true, history: [{ delay: 5 }] },
      REJECT: { name: 'REJECT', type: 'Reject', udp: false, history: [] },
    }
  }
};

export const MOCK_PROXIES = PROXY_SETS['config.yaml'];

export function getProxySet(configName) {
  return PROXY_SETS[configName] || PROXY_SETS['config.yaml'];
}

export const MOCK_CONFIG = {
  mode: 'rule', 'log-level': 'info', 'mixed-port': 7890, 'allow-lan': false,
  'external-controller': '127.0.0.1:9090', secret: '',
  tun: { enable: false, stack: 'system', 'auto-route': true },
  dns: { enable: true, 'fake-ip-range': '198.18.0.1/16', nameserver: ['223.5.5.5'] }
};

export const MOCK_RULES = {
  rules: [
    { type: 'DOMAIN-SUFFIX', payload: 'openai.com', proxy: '🤖 AI 服务' },
    { type: 'DOMAIN-SUFFIX', payload: 'google.com', proxy: '🎯 流媒体' },
    { type: 'GEOIP', payload: 'CN', proxy: 'DIRECT' },
    { type: 'MATCH', payload: '', proxy: 'GLOBAL' },
  ]
};

export const MOCK_SETTINGS = {
  last_config: 'config.yaml', auto_start: false, language: 'zh-CN', theme: 'dark'
};

export const MOCK_VERSION = { meta: true, version: '1.19.0' };

export const MOCK_CONFIG_LIST = [
  { name: 'config.yaml', size: 4096, modified: '2026-04-17T10:00:00Z', is_active: true },
  { name: 'subscription.yaml', size: 1024, modified: '2026-04-16T08:00:00Z', is_active: false, url_display: 'https://example.com/subscription', last_updated: 1713340800, auto_update_interval: 86400 },
  { name: 'backup-sub.yaml', size: 2048, modified: '2026-04-15T06:00:00Z', is_active: false, url_display: 'https://backup.example.com/sub', last_updated: 1713254400, auto_update_interval: 0 }
];

// Traffic generator
let trafficCounter = 0;
export const generateTrafficTick = () => {
  trafficCounter++;
  return {
    up: Math.floor(Math.random() * 50000 + 5000),
    down: Math.floor(Math.random() * 200000 + 20000)
  };
};

// Log generator
export const generateLogLine = () => {
  const domains = ['google.com', 'github.com', 'api.openai.com'];
  const domain = domains[Math.floor(Math.random() * domains.length)];
  return `[INFO] ${new Date().toISOString()} connection: ${domain} => 日本-东京-01`;
};
