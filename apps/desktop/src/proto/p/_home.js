import { $, html, icon, ICONS, until } from './_kit.js';

export async function homeParts() {
  await until(() => $('#sys-proxy-toggle'));
  const page = $('[data-page="home"]');
  const hero = $('#home-hero');
  const sysCard = $('#sys-proxy-toggle').closest('.glass-card');
  const grid = sysCard.nextElementSibling;
  return { page, hero, sysCard, grid };
}

const arrow = '<svg aria-hidden="true" class="w-3.5 h-3.5 text-[var(--text-muted)] dropdown-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

export const SUBS = [
  { name: 'config', used: '61.8 GB / 200 GB', left: '剩 23 天', on: true },
  { name: 'subscription', used: '13.5 GB / 100 GB', left: '剩 71 天' },
  { name: 'backup-sub', used: '未提供流量信息', left: '' },
];

export function subSelect({ open = false, width = 168, compact = false } = {}) {
  const el = html(`<div class="proto-sub-select relative shrink-0" style="width:${width}px">
    <button type="button" class="select-common w-full flex items-center justify-between gap-2 ${compact ? 'proto-sub-compact' : ''}">
      <span class="flex items-center gap-2 min-w-0">${icon(ICONS.layers, 'w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]')}<span class="truncate">config</span></span>${arrow}
    </button>
    <div class="proto-sub-menu ${open ? '' : 'hidden'} absolute top-[calc(100%+6px)] rounded-lg border border-[var(--zephyr-border-default)] bg-[var(--zephyr-bg-elevated)] shadow-2xl z-30 p-1">
      ${SUBS.map((s) => `<button type="button" class="dropdown-option proto-sub-opt w-full text-start px-3 py-2 rounded-[var(--radius-dropdown-option)] ${s.on ? 'active' : ''}">
        <span class="block text-xs font-semibold text-[var(--text-primary)]">${s.name}</span>
        <span class="block text-2xs text-[var(--text-muted)] mt-0.5">${s.used}${s.left ? ' · ' + s.left : ''}</span>
      </button>`).join('')}
    </div>
  </div>`);
  return el;
}
