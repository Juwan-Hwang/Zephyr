// Shared helpers for UI prototypes: markup copied from the app's own
// settings rows, dialogs and controls so additions look native.

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await wait(60);
  }
  return null;
}

export function html(str) {
  const t = document.createElement('template');
  t.innerHTML = str.trim();
  return t.content.firstElementChild;
}

const svgOpen = (cls) => `<svg aria-hidden="true" class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">`;
export const icon = (paths, cls = 'w-5 h-5') => `${svgOpen(cls)}${paths}</svg>`;

export const ICONS = {
  bypass: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  lan: '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  pencil: '<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/>',
  layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  package: '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 8.7 5 8.7-5"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};

export const divider = () => '<div class="h-px bg-[var(--zephyr-bg-muted)]"></div>';

export function settingRow({ id = '', iconPaths, title, desc, control }) {
  return `<div ${id ? `id="${id}"` : ''} class="proto-new flex items-center justify-between gap-4">
    <div class="flex items-center gap-4 min-w-0">
      <div class="text-[var(--text-secondary)]">${icon(iconPaths)}</div>
      <div class="min-w-0">
        <p class="text-sm font-semibold text-[var(--text-primary)]">${title}</p>
        <p class="text-2xs text-[var(--text-muted)]">${desc}</p>
      </div>
    </div>
    ${control}
  </div>`;
}

export const valueButton = (text) => `<button type="button" class="text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors flex items-center gap-1 shrink-0 max-w-[260px]"><span class="truncate">${text}</span>${icon(ICONS.chevron, 'w-4 h-4 shrink-0')}</button>`;
export const toggle = (on) => `<label class="ios-switch shrink-0"><input type="checkbox" ${on ? 'checked' : ''}><span class="switch-slider"></span></label>`;

/** Insert a setting row (plus divider) after the row that contains `anchorSel`. */
export function insertRowAfter(anchorSel, rowHtml) {
  const anchor = $(anchorSel);
  let row = anchor;
  while (row && !(row.parentElement && row.parentElement.classList.contains('glass-card'))) row = row.parentElement;
  if (!row) throw new Error('anchor row not found: ' + anchorSel);
  const frag = document.createRange().createContextualFragment(divider() + rowHtml);
  row.after(frag);
  return row.nextElementSibling.nextElementSibling;
}

export function dialog({ title, sub = '', body, primary = '保存', secondary = '取消', width = 420 }) {
  const el = html(`<div class="proto-dialog fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[var(--zephyr-bg-overlay)] backdrop-blur-md">
    <div class="glass-card p-6 border-accent/20 shadow-2xl shadow-accent/10" style="width:${width}px">
      <h3 class="dialog-title mb-1">${title}</h3>
      ${sub ? `<p class="text-xs text-[var(--text-secondary)] mb-5">${sub}</p>` : ''}
      ${body}
      <div class="flex gap-3 justify-end mt-6">
        ${secondary ? `<button class="btn-ghost">${secondary}</button>` : ''}
        <button class="btn-primary">${primary}</button>
      </div>
    </div>
  </div>`);
  document.body.appendChild(el);
  return el;
}

export async function scrollSettingsTo(sel, block = 'center') {
  const el = await until(() => $(sel));
  el?.scrollIntoView({ block, behavior: 'instant' });
  await wait(250);
}
