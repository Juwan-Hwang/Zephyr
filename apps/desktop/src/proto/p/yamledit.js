// #490 在应用里直接编辑订阅 YAML
import { html, icon, ICONS } from './_kit.js';

const YAML = `mixed-port: 7890
allow-lan: false
mode: rule
log-level: info

proxies:
  - name: "🇭🇰 香港 03 IPLC"
    type: vless
    server: hk03.example.net
    port: 443
    uuid: 3f1c…e9a2
    tls: true

proxy-groups:
  - name: "🚀 节点选择"
    type: select
    proxies: ["♻️ 自动选择", "🇭🇰 香港 03 IPLC", DIRECT]

rules:
  - DOMAIN-SUFFIX,openai.com,🤖 AI 服务
  - GEOIP,CN,DIRECT
  - MATCH,🚀 节点选择`;

function hl(line) {
  const esc = line.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  if (/^\s*#/.test(esc)) return `<span class=y-c>${esc}</span>`;
  return esc
    .replace(/^(\s*-?\s*)([A-Za-z][\w-]*)(:)/, '$1<span class=y-k>$2</span>$3')
    .replace(/("[^"]*")/g, '<span class=y-s>$1</span>')
    .replace(/: (\d+|true|false)$/, ': <span class=y-n>$1</span>')
    .replace(/^(\s*- )(DOMAIN-SUFFIX|GEOIP|MATCH)/, '$1<span class=y-r>$2</span>');
}

export async function post() {
  const lines = YAML.split('\n');
  const el = html(`<div class="proto-dialog fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[var(--zephyr-bg-overlay)] backdrop-blur-md">
    <div class="glass-card proto-yaml-card">
      <div class="flex items-center justify-between gap-4 px-5 pt-5 pb-3">
        <div class="min-w-0">
          <h3 class="dialog-title">编辑 config.yaml</h3>
          <p class="text-2xs text-[var(--text-muted)] mt-0.5">保存后立即生效</p>
        </div>
        <button class="text-[var(--text-secondary)]" aria-label="关闭">${icon(ICONS.x, 'w-5 h-5')}</button>
      </div>
      <div class="proto-yaml-warn mx-5">${icon(ICONS.alert, 'w-3.5 h-3.5 shrink-0')}<span>更新订阅后，这里的修改会被覆盖。如果要长期保留，可以使用覆写。</span></div>
      <div class="proto-yaml-editor mx-5 mt-3">
        <div class="proto-yaml-gutter">${lines.map((_, i) => `<div>${i + 1}</div>`).join('')}</div>
        <pre class="proto-yaml-code">${lines.map((l) => `<div>${hl(l) || ' '}</div>`).join('')}</pre>
      </div>
      <div class="flex items-center justify-between gap-3 px-5 py-4">
        <button class="btn-ghost text-xs">使用覆写</button>
        <div class="flex gap-2"><button class="btn-ghost">取消</button><button class="btn-primary">保存</button></div>
      </div>
    </div>
  </div>`);
  document.body.appendChild(el);
}
