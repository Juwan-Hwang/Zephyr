// @ts-check
/**
 * Settings > Proxy: "Latency Test Address" and "Download Speed Test".
 *
 * Each row shows its current value; the value opens a small dialog. The four
 * common latency addresses and the three test files are choice cards (four or
 * more single-choice options with a line of detail each); the per-node time
 * limit is a segmented control (three short options).
 *
 * @module ui/settings/speed-settings
 */

import { setLatencyTestUrl } from '../../api.js';
import { DEFAULT_LATENCY_TEST_URL } from '../../latency-defaults.js';
import { t } from '../../i18n.js';
import { escapeHtml } from '../../utils/sanitize.js';
import { createFocusTrap } from '../../utils/focus-trap.js';
import { getSettingsCached } from '../cache.js';
import { saveSettingsChecked } from '../settings-helpers.js';
import { showNotification } from '../notifications.js';
import { resetExitIp } from '../exit-ip.js';
import { Bus, Events } from '../events.js';
import {
    SPEED_TEST_FILES, SPEED_TEST_SECS, DEFAULT_SPEED_TEST_URL,
    readSpeedTestSettings, saveSpeedTestSettings, isValidSpeedTestUrl,
} from '../speed-test.js';

/** Common latency test addresses; the first is the built-in default. */
export const LATENCY_PRESETS = Object.freeze([
    { id: 'google', labelKey: 'latencyPresetGoogle', label: 'Google', host: 'www.gstatic.com', url: DEFAULT_LATENCY_TEST_URL },
    { id: 'cloudflare', labelKey: '', label: 'Cloudflare', host: 'cp.cloudflare.com', url: 'https://cp.cloudflare.com/generate_204' },
    { id: 'apple', labelKey: '', label: 'Apple', host: 'captive.apple.com', url: 'https://captive.apple.com/hotspot-detect.html' },
    { id: 'xiaomi', labelKey: 'latencyPresetXiaomi', label: 'Xiaomi', host: 'connect.rom.miui.com', url: 'https://connect.rom.miui.com/generate_204' },
]);

/** @param {typeof LATENCY_PRESETS[number]} p */
const presetLabel = (p) => (p.labelKey ? t(p.labelKey) || p.label : p.label);

/** @param {string} url */
function hostOf(url) {
    try { return new URL(url).host; } catch { return url; }
}

/** @param {string} url */
function isHttpUrl(url) {
    try {
        const u = new URL(url);
        return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
    } catch {
        return false;
    }
}

/** @returns {Promise<string>} */
async function readLatencyUrl() {
    try {
        const s = /** @type {any} */ (await getSettingsCached());
        const v = typeof s?.latency_test_url === 'string' ? s.latency_test_url.trim() : '';
        return v || DEFAULT_LATENCY_TEST_URL;
    } catch {
        return DEFAULT_LATENCY_TEST_URL;
    }
}

/**
 * @param {string} id
 * @param {string} text
 */
function setValue(id, text) {
    const span = document.querySelector(`#${id} > span`);
    if (span) span.textContent = text;
}

/** Show the current values on the two rows. */
let renderSeq = 0;
export async function renderSpeedSettingRows() {
    // A render that started earlier and finishes later must not show older values.
    const seq = ++renderSeq;
    const lat = await readLatencyUrl();
    const { url, maxSecs, file } = await readSpeedTestSettings();
    if (seq !== renderSeq) return;
    const p = LATENCY_PRESETS.find((x) => x.url === lat);
    setValue('btn-latency-test-url', p ? presetLabel(p) : hostOf(lat));
    setValue('btn-speed-test-setting', `${file ? file.label : hostOf(url)} · ${t('speedTestSecs', { secs: String(maxSecs) })}`);
}

/** The close of each open dialog, by id. */
/** @type {Map<string, () => void>} */
const openDialogs = new Map();

/**
 * Open a dialog with `body` and Cancel / Save. `onSave` returns false to keep
 * it open (an invalid address).
 * @param {{ id: string, title: string, sub?: string, body: string, onReady?: (root: HTMLElement) => void, onSave: (root: HTMLElement) => Promise<boolean> }} opts
 */
function openDialog({ id, title, sub = '', body, onReady, onSave }) {
    // Opened again before the first one closed: close that one properly
    // (its focus trap with it), not just its markup.
    openDialogs.get(id)?.();
    document.getElementById(id)?.remove();
    const modal = document.createElement('div');
    modal.id = id;
    modal.className = 'fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[var(--zephyr-bg-overlay)] backdrop-blur-md';
    // eslint-disable-next-line no-unsanitized/property -- every dynamic part is escaped by the callers
    modal.innerHTML = `
        <div class="glass-card speed-dialog-panel w-[440px] max-w-[90vw] p-6" role="dialog" aria-modal="true" aria-labelledby="${id}-title">
            <h3 id="${id}-title" class="dialog-title mb-1">${escapeHtml(title)}</h3>
            ${sub ? `<p class="text-xs text-[var(--text-secondary)] mb-5">${escapeHtml(sub)}</p>` : '<div class="mb-4"></div>'}
            ${body}
            <div class="flex gap-3 justify-end mt-6">
                <button type="button" class="btn-ghost" data-act="cancel">${escapeHtml(t('cancel') || 'Cancel')}</button>
                <button type="button" class="btn-primary" data-act="save">${escapeHtml(t('save') || 'Save')}</button>
            </div>
        </div>`; // nosemgrep: js-innerhtml-assignment — escaped above
    document.body.appendChild(modal);
    const close = () => {
        if (openDialogs.get(id) === close) openDialogs.delete(id);
        trap.deactivate();
        modal.remove();
    };
    openDialogs.set(id, close);
    // The checked choice takes focus first, so arrow keys start from it.
    const checked = /** @type {HTMLElement|null} */ (modal.querySelector('[role="radio"][aria-checked="true"]'));
    const trap = createFocusTrap(modal, { onEscape: close, ...(checked ? { initialFocus: checked } : {}) });
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    modal.querySelector('[data-act="cancel"]')?.addEventListener('click', close);
    const saveBtn = /** @type {HTMLButtonElement | null} */ (modal.querySelector('[data-act="save"]'));
    saveBtn?.addEventListener('click', async () => {
        // One write at a time: a second Save waits for the first to report.
        if (saveBtn.disabled) return;
        saveBtn.disabled = true;
        try {
            if (await onSave(modal)) close();
        } finally {
            saveBtn.disabled = false;
        }
    });
    // Choice cards / segmented radios: clicking one checks it.
    modal.querySelectorAll('[role="radiogroup"]').forEach((group) => {
        group.querySelectorAll('[role="radio"]').forEach((r) => r.addEventListener('click', () => {
            group.querySelectorAll('[role="radio"]').forEach((x) => {
                x.setAttribute('aria-checked', x === r ? 'true' : 'false');
                x.classList.toggle('active', x === r);
            });
            group.dispatchEvent(new CustomEvent('choice', { detail: /** @type {HTMLElement} */ (r).dataset.value }));
        }));
    });
    onReady?.(modal);
    trap.activate();
}

/**
 * @param {{ value: string, title: string, desc: string, checked: boolean }[]} items
 * @param {string} label
 */
function choiceGrid(items, label) {
    return `<div class="choice-grid" role="radiogroup" aria-label="${escapeHtml(label)}">${items.map((i) => `<button type="button" role="radio" class="choice-card" aria-checked="${i.checked}" data-value="${escapeHtml(i.value)}"><span class="choice-card-title">${escapeHtml(i.title)}</span><span class="choice-card-desc">${escapeHtml(i.desc)}</span></button>`).join('')}</div>`;
}

/**
 * Whether the saved settings can be read now. A dialog opened on defaults
 * after a failed read would save them over the user's own values.
 */
async function settingsReadable() {
    try {
        await getSettingsCached();
        return true;
    } catch (e) {
        showNotification(String(e), 'error');
        return false;
    }
}

export async function openLatencyUrlDialog() {
    if (!(await settingsReadable())) return;
    const current = await readLatencyUrl();
    const id = 'latency-url-modal';
    openDialog({
        id,
        title: t('latencyTestUrl'),
        sub: t('latencyTestUrlDesc'),
        body: `
            <span class="speed-setting-label">${escapeHtml(t('latencyTestUrlCommon'))}</span>
            ${choiceGrid(LATENCY_PRESETS.map((p) => ({ value: p.url, title: presetLabel(p), desc: p.host, checked: p.url === current })), t('latencyTestUrlCommon'))}
            <label class="speed-setting-label mt-4" for="${id}-input">${escapeHtml(t('latencyTestUrlField'))}</label>
            <input id="${id}-input" type="text" spellcheck="false" autocomplete="off" class="form-control form-control-md form-control-mono w-full text-xs" value="${escapeHtml(current === DEFAULT_LATENCY_TEST_URL ? '' : current)}" placeholder="${escapeHtml(DEFAULT_LATENCY_TEST_URL)}" aria-describedby="${id}-hint">
            <p id="${id}-hint" class="edit-field-hint mt-1.5">${escapeHtml(t('latencyTestUrlHint'))}</p>`,
        onReady: (root) => {
            const input = /** @type {HTMLInputElement} */ (root.querySelector(`#${id}-input`));
            root.querySelector('.choice-grid')?.addEventListener('choice', (e) => {
                const v = /** @type {CustomEvent} */ (e).detail;
                input.value = v === DEFAULT_LATENCY_TEST_URL ? '' : v;
            });
            input.addEventListener('input', () => {
                const v = input.value.trim() || DEFAULT_LATENCY_TEST_URL;
                root.querySelectorAll('.choice-card').forEach((c) => c.setAttribute('aria-checked', String(/** @type {HTMLElement} */ (c).dataset.value === v)));
            });
        },
        onSave: async (root) => {
            const input = /** @type {HTMLInputElement} */ (root.querySelector(`#${id}-input`));
            const v = input.value.trim();
            if (v && !isHttpUrl(v)) {
                showNotification(t('testUrlInvalid'), 'warning');
                input.focus();
                return false;
            }
            // Saved as parsed (`https:example.com` → `https://example.com/`), the
            // form the test itself accepts, so the row shows what is tested.
            const url = v ? new URL(v).href : '';
            try {
                await saveSettingsChecked({ latency_test_url: !url || url === DEFAULT_LATENCY_TEST_URL ? null : url });
            } catch {
                showNotification(t('saveFailed') || 'Save failed', 'error');
                return false;
            }
            setLatencyTestUrl(url);
            await renderSpeedSettingRows();
            return true;
        },
    });
}

export async function openSpeedTestDialog() {
    if (!(await settingsReadable())) return;
    const { url, maxSecs, file } = await readSpeedTestSettings();
    const id = 'speed-test-modal';
    const custom = file ? '' : url;
    openDialog({
        id,
        title: t('speedTestSetting'),
        body: `
            <span class="speed-setting-label">${escapeHtml(t('speedTestFile'))}</span>
            ${choiceGrid([
                ...SPEED_TEST_FILES.map((f) => ({ value: f.url, title: f.label, desc: f.host, checked: file?.url === f.url })),
                { value: 'custom', title: t('speedTestCustom'), desc: custom ? hostOf(custom) : t('speedTestCustomDesc'), checked: !file },
            ], t('speedTestFile'))}
            <div id="${id}-custom" class="${file ? 'hidden' : ''} mt-3">
                <input id="${id}-input" type="text" spellcheck="false" autocomplete="off" class="form-control form-control-md form-control-mono w-full text-xs" value="${escapeHtml(custom)}" placeholder="https://" aria-label="${escapeHtml(t('speedTestCustomDesc'))}">
            </div>
            <span class="speed-setting-label mt-4">${escapeHtml(t('speedTestMaxSecs'))}</span>
            <div class="seg-tabs w-full" role="radiogroup" aria-label="${escapeHtml(t('speedTestMaxSecs'))}">
                ${SPEED_TEST_SECS.map((s) => `<button type="button" role="radio" class="seg-tab flex-1 justify-center${s === maxSecs ? ' active' : ''}" aria-checked="${s === maxSecs}" data-value="${s}">${escapeHtml(t('speedTestSecs', { secs: String(s) }))}</button>`).join('')}
            </div>`,
        onReady: (root) => {
            const wrap = root.querySelector(`#${id}-custom`);
            root.querySelector('.choice-grid')?.addEventListener('choice', (e) => {
                const isCustom = /** @type {CustomEvent} */ (e).detail === 'custom';
                wrap?.classList.toggle('hidden', !isCustom);
                if (isCustom) /** @type {HTMLInputElement|null} */ (root.querySelector(`#${id}-input`))?.focus();
            });
        },
        onSave: async (root) => {
            const pick = /** @type {HTMLElement|null} */ (root.querySelector('.choice-grid [aria-checked="true"]'))?.dataset.value || DEFAULT_SPEED_TEST_URL;
            const secs = Number(/** @type {HTMLElement|null} */ (root.querySelector('.seg-tabs [aria-checked="true"]'))?.dataset.value) || maxSecs;
            let chosen = pick;
            if (pick === 'custom') {
                const input = /** @type {HTMLInputElement} */ (root.querySelector(`#${id}-input`));
                chosen = input.value.trim();
                if (!isValidSpeedTestUrl(chosen)) {
                    showNotification(t('testUrlInvalid'), 'warning');
                    input.focus();
                    return false;
                }
                chosen = new URL(chosen).href;
            }
            try {
                await saveSpeedTestSettings({ url: chosen, maxSecs: secs });
            } catch {
                showNotification(t('saveFailed') || 'Save failed', 'error');
                return false;
            }
            await renderSpeedSettingRows();
            return true;
        },
    });
}

/**
 * Taken when Restore Defaults queues its settings write: a move of the IP
 * switch after this lands after that write, so the reset must not undo it.
 * @returns {number}
 */
export function speedSettingsResetToken() {
    return exitIpToggleEpoch;
}

/**
 * Restore Defaults saved the defaults of these settings: use them now.
 * @param {number} [token] from speedSettingsResetToken() when the write was queued
 */
export function afterSpeedSettingsReset(token = exitIpToggleEpoch) {
    setLatencyTestUrl('');
    // The reset stored off, even when a newer move is still queued: a failed
    // newer save then puts the switch back to what is stored.
    exitIpSaved = false;
    // The switch moved after the reset's write was queued: that save lands
    // after the reset's and reports itself, so the switch is left as it is.
    if (exitIpToggleEpoch === token) {
        const toggle = /** @type {HTMLInputElement | null} */ (document.getElementById('setting-show-exit-ip'));
        exitIpResetEpoch = ++exitIpToggleEpoch;
        exitIpUnpublished = false;
        // The saved value is known now (off), even when the first read failed.
        if (toggle) {
            toggle.checked = false;
            toggle.disabled = false;
        }
        // Always: a lookup the switch started while the reset ran must not land.
        resetExitIp();
        Bus.emit(Events.EXIT_IP_SETTING_CHANGED, false);
    }
    void renderSpeedSettingRows();
}

/** Bumped by every change of the switch (and a reset): an older read must not overwrite it. */
let exitIpToggleEpoch = 0;
/** The epoch of the last reset. */
let exitIpResetEpoch = 0;
/** The value last saved, which a failed save puts back. */
let exitIpSaved = false;
/** A save succeeded but left telling the pages to a newer move, which has not told them yet. */
let exitIpUnpublished = false;

/** Wire the two rows. Returns a cleanup function. */
export function initSpeedSettings() {
    const lat = document.getElementById('btn-latency-test-url');
    const spd = document.getElementById('btn-speed-test-setting');
    const onLat = () => { void openLatencyUrlDialog(); };
    const onSpd = () => { void openSpeedTestDialog(); };
    lat?.addEventListener('click', onLat);
    spd?.addEventListener('click', onSpd);
    void renderSpeedSettingRows();
    // The values are written here, not by the translation pass: redraw them in the new language.
    const offLang = Bus.on(Events.I18N_APPLIED, () => { void renderSpeedSettingRows(); });
    const stopIp = initExitIpToggle();
    return () => {
        lat?.removeEventListener('click', onLat);
        spd?.removeEventListener('click', onSpd);
        if (typeof offLang === 'function') offLang();
        stopIp();
        // A dialog still open goes with the page (its focus trap too).
        for (const close of [...openDialogs.values()]) close();
    };
}

/**
 * "Show IP address": the home pages show the address websites see, under
 * the current node.
 * @returns {() => void}
 */
export function initExitIpToggle() {
    const toggle = /** @type {HTMLInputElement | null} */ (document.getElementById('setting-show-exit-ip'));
    if (!toggle) return () => {};
    const readAt = exitIpToggleEpoch;
    // Not clickable until the saved value is known: a failed save puts that
    // value back, so a guessed one could turn a saved "on" off on screen only.
    toggle.disabled = true;
    let stopped = false;
    void (async () => {
        // Tried until it answers (more slowly after a few misses): the switch
        // must not stay dead for the rest of the session.
        for (let attempt = 0; !stopped; attempt++) {
            if (attempt) await new Promise((r) => setTimeout(r, attempt < 3 ? 2000 : 10_000));
            if (stopped) return;
            try {
                const s = await getSettingsCached();
                if (stopped) return;
                if (exitIpToggleEpoch === readAt) { // a reset meanwhile is newer
                    const on = !!(/** @type {any} */ (s)?.show_exit_ip);
                    exitIpSaved = on;
                    toggle.checked = on;
                }
                toggle.disabled = false;
                return;
            } catch { /* tried again below */ }
        }
    })();
    const onChange = async () => {
        const on = toggle.checked;
        const mine = ++exitIpToggleEpoch;
        try {
            await saveSettingsChecked({ show_exit_ip: on });
            // Queued before the reset's write, so the reset's "off" landed
            // after it and is what is stored and shown.
            if (exitIpResetEpoch > mine) return;
            // Saved, so a later failed save puts this value back.
            exitIpSaved = on;
            // A newer move is on screen: its own save reports.
            if (mine !== exitIpToggleEpoch) {
                exitIpUnpublished = true;
                return;
            }
            exitIpUnpublished = false;
            resetExitIp();
            Bus.emit(Events.EXIT_IP_SETTING_CHANGED, on);
        } catch {
            // Put back what is saved, unless the switch has been moved again since.
            if (mine === exitIpToggleEpoch) {
                toggle.checked = exitIpSaved;
                // An earlier save left reporting to this one: report what is saved.
                if (exitIpUnpublished) {
                    exitIpUnpublished = false;
                    resetExitIp();
                    Bus.emit(Events.EXIT_IP_SETTING_CHANGED, exitIpSaved);
                }
            }
            showNotification(t('saveFailed'), 'error');
        }
    };
    toggle.addEventListener('change', onChange);
    return () => {
        stopped = true;
        toggle.removeEventListener('change', onChange);
    };
}
