// @ts-check
/**
 * Update dialog (Settings → About → Check for Updates).
 *
 * One dialog walks through every state of an update: checking, up to date,
 * update available (versions + release notes), installing (progress), done,
 * and the two failures (check / install) with a retry. A single controller
 * owns the state, so repeated clicks never start a second check or download:
 * reopening the dialog while work is running only shows its progress.
 *
 * @module ui/update-dialog
 */

import { invoke, listen, openUrl, getCurrentWindow } from '../api.js';
import { COMMANDS } from '@zephyr/shared';
import { translations } from '../i18n.js';
import { appStore } from './state.js';
import { escapeHtml, sanitizeHtml } from '../utils/sanitize.js';
import { markdownToHtml } from '../utils/markdown.js';
import { createFocusTrap } from '../utils/focus-trap.js';
import { normalizeVersion, isRemoteNewer } from '../utils/version-utils.js';
import { settingsLogger } from '../utils/logger.js';
import { showNotification } from './notifications.js';
import { sendOSNotification } from './os-notification.js';

const DIALOG_ID = 'update-dialog';
/** What UPDATE_CLIENT returns when the latest release is the running one. */
const CLIENT_ALREADY_CURRENT = 'Already up to date';
const RELEASES_URL = 'https://github.com/Juwan-Hwang/Zephyr/releases/latest';

/**
 * @typedef {'idle'|'checking'|'latest'|'available'|'installing'|'done'|'check-failed'|'install-failed'} UpdatePhase
 * @typedef {{
 *   phase: UpdatePhase,
 *   app: string, core: string, portable: boolean,
 *   coreLatest: { version: string, url: string } | null,
 *   clientLatest: { version: string, notes: string } | null,
 *   target: 'core'|'client'|null, coreDone: boolean, clientCurrent: boolean,
 *   progress: number, stage: string, error: string, warning: string, checkError: string,
 * }} UpdateState
 * @typedef {{ onCoreUpdated?: (result: any) => Promise<void> | void, closeQuits?: () => boolean }} UpdateDeps
 */

/** @returns {UpdateState} */
function freshState() {
    return {
        phase: 'idle', app: '', core: '', portable: false,
        coreLatest: null, clientLatest: null, target: null, coreDone: false, clientCurrent: false,
        progress: 0, stage: '', error: '', warning: '', checkError: '',
    };
}

/** @type {UpdateState} */
let state = freshState();
/** @type {UpdateDeps} */
let deps = {};
/** @type {HTMLElement | null} */
let dialog = null;
/** @type {ReturnType<typeof createFocusTrap> | null} */
let trap = null;

/** @returns {Record<string, string>} */
function tr() {
    const all = /** @type {any} */ (translations);
    return all[appStore.get('currentLang')] || all.en;
}

/** @param {string} key @param {string} fallback */
function t(key, fallback) {
    const v = tr()[key];
    return typeof v === 'string' && v ? v : fallback;
}

/** @param {string} v */
function showVersion(v) {
    if (!v) return '–';
    return v.startsWith('v') ? v : `v${v}`;
}

/** Whether work is running that the dialog must not restart. */
function isBusy() {
    return state.phase === 'checking' || state.phase === 'installing';
}

/**
 * Readable text for a rejection: Error, plain string, or an `{ message }` object.
 * @param {unknown} err
 */
function errorText(err) {
    /** @type {unknown} */
    let msg = err;
    if (err && typeof err === 'object') msg = /** @type {{ message?: unknown }} */ (err).message;
    return typeof msg === 'string' && msg ? msg : t('unknown', 'Unknown');
}

/**
 * Map the backend's English status text to a short localized stage.
 * @param {string} text
 */
export function stageFromStatus(text) {
    const s = String(text || '').toLowerCase();
    if (s.includes('restarting') || s.includes('core ready')) return 'restarting';
    if (s.includes('opening installer') || s.includes('installer launched')) return 'opening';
    if (s.includes('verif') || s.includes('signature')) return 'verifying';
    if (s.includes('extract') || s.includes('writing')) return 'installing';
    if (s.includes('download')) return 'downloading';
    return 'preparing';
}

// ── Actions ────────────────────────────────────────────────────────────────

/**
 * @template T
 * @param {PromiseSettledResult<T>} r
 * @returns {T | null}
 */
const settledValue = (r) => (r.status === 'fulfilled' ? r.value : null);

/**
 * Whether `remote` is newer than the installed `local` version.
 * @param {unknown} remote @param {string} local
 */
function isNewer(remote, local) {
    // A published version that isn't one ("nightly") is reported as unreadable, never as newer.
    if (typeof remote !== 'string' || !isVersion(remote) || !isVersion(local)) return false;
    return isRemoteNewer(normalizeVersion(remote), normalizeVersion(local));
}

/**
 * Whether an installed version reads as one (1.19.0, v1.19.0-alpha). Other
 * output — an error line, a build hash, a tag ending in "-" — would compare
 * as 0.0.0 or as a release and mislead. Exactly three numeric parts, as the
 * core updater accepts: a "v1.20" tag would be offered and then refused.
 * @param {string} v
 */
const isVersion = (v) => /^\d+\.\d+\.\d+([-+][0-9A-Za-z]+([.+-][0-9A-Za-z]+)*)?$/.test(normalizeVersion(v));

/**
 * Whether a published core tag is one the core updater installs: a "v", three
 * numeric parts, an optional "-" pre-release, at most 25 characters. A bare
 * "1.20.0" or a "+build" tag would be offered and then refused; a tag ending
 * in "." or "-" is not one the comparison reads either.
 * @param {string} v
 */
const isCoreTag = (v) => v.length <= 25 && /^v\d+\.\d+\.\d+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$/.test(v);

/**
 * Why the check is incomplete, or '' when every version was read. A lookup
 * that failed, an installed version that is missing or not a version number
 * while a newer one is published, or a published version that is not a
 * version number, means the comparison never happened.
 * @param {PromiseSettledResult<unknown>[]} lookups
 * @param {any} core @param {any} client
 */
function checkProblem(lookups, core, client) {
    const failed = lookups.find((r) => r.status === 'rejected');
    if (failed) return errorText(/** @type {PromiseRejectedResult} */ (failed).reason);
    if ((core?.version && !isVersion(state.core)) || (client?.version && !isVersion(state.app))) {
        return t('updLocalUnknown', 'Couldn’t read the installed version.');
    }
    // A published version that is empty or not a number (a "nightly" tag)
    // never compares as newer, so it must not read as up to date either.
    if ((core && !isCoreTag(String(core.version ?? ''))) || (client && !isVersion(String(client.version ?? '')))) {
        return t('updRemoteUnknown', 'Couldn’t read the latest version.');
    }
    return '';
}

/** Fetch the latest core and client versions once. */
async function runCheck() {
    if (isBusy()) return;
    state = { ...freshState(), phase: 'checking' };
    render();

    // invoke() throws synchronously without IPC: an async wrapper turns that
    // into a failed lookup instead of leaving "checking" up.
    const call = async (/** @type {string} */ cmd) => invoke(cmd);
    const [coreRes, clientRes, appRes, localCoreRes, portableRes] = await Promise.allSettled([
        call(COMMANDS.GET_LATEST_VERSION),
        call(COMMANDS.GET_LATEST_CLIENT_VERSION),
        call(COMMANDS.GET_APP_VERSION),
        call(COMMANDS.GET_CORE_VERSION),
        call(COMMANDS.GET_PORTABLE_MODE),
    ]);
    /** @type {any} */
    const core = settledValue(coreRes);
    /** @type {any} */
    const client = settledValue(clientRes);
    state.app = String(settledValue(appRes) || '');
    state.core = String(settledValue(localCoreRes) || '');
    // Unknown portable mode is treated as portable: the releases page always
    // works, while the installer path fails on a portable build.
    state.portable = portableRes.status === 'rejected' || !!settledValue(portableRes);

    if (isCoreTag(String(core?.version ?? '')) && isNewer(core.version, state.core)) {
        state.coreLatest = { version: String(core.version), url: String(core.download_url || '') };
    }
    if (isNewer(client?.version, state.app)) {
        state.clientLatest = { version: String(client.version), notes: String(client.release_notes || '') };
    }
    // A source that could not be read is not "up to date". With an update
    // found the problem is still shown, so the other row isn't taken as current.
    // Portable mode only matters for installing an app update.
    const lookups = [coreRes, clientRes, appRes, localCoreRes];
    if (state.clientLatest) lookups.push(portableRes);
    state.error = checkProblem(lookups, core, client);
    state.checkError = state.error;
    if (state.coreLatest || state.clientLatest) state.phase = 'available';
    else state.phase = state.error ? 'check-failed' : 'latest';
    render();
}

/**
 * Which updates the primary button installs, in order. The app installer
 * leaves an existing core in place, so with both updates the core goes first.
 * @returns {('core'|'client')[]}
 */
function pickTargets() {
    /** @type {('core'|'client')[]} */
    const targets = [];
    if (state.coreLatest) targets.push('core');
    if (state.clientLatest && !state.portable) targets.push('client');
    return targets;
}

/**
 * Install the core update and refresh the app after. The backend keeps the
 * page alive (closing it in lightweight mode only hides it) until runInstall
 * ends the hold.
 */
async function installCore() {
    const result = await invoke(COMMANDS.UPDATE_CORE, { url: state.coreLatest?.url || '' });
    try {
        await deps.onCoreUpdated?.(result);
    } catch (err) {
        // The core is updated either way. Say what may differ: the saved
        // proxy choices and overrides, or only the app's view of them.
        settingsLogger.warn('[update] post-update refresh failed', err);
        state.warning = /** @type {any} */ (err)?.recovery
            ? t('updRecoveryWarn', 'The core is updated, but some proxy choices, patches or overrides couldn’t be restored. Check them, or restart Zephyr.')
            : t('updRefreshWarn', 'The core is updated, but the app couldn’t refresh its state. Restart Zephyr if something looks off.');
    }
    try {
        state.core = String(await invoke(COMMANDS.GET_CORE_VERSION) || state.coreLatest?.version || '');
    } catch {
        state.core = state.coreLatest?.version || state.core;
    }
    // Installed: the done view shows the new version alone, not "v1 → v1".
    state.coreLatest = null;
    state.coreDone = true;
}

/** Whether the user can see the window right now (not hidden to the tray, not behind another app). */
async function windowSeen() {
    let visible = true;
    try { visible = await getCurrentWindow().isVisible(); } catch { /* non-Tauri */ }
    return visible && document.hasFocus();
}

/**
 * What a background install's outcome says, or null while it has none.
 * @returns {{ msg: string, type: 'error'|'warning'|'success', title: string } | null}
 */
function outcomeNote() {
    if (state.phase === 'install-failed') {
        // Everything the failed page shows: what went through, the reason,
        // and a recovery or partial-check warning.
        const msg = [state.coreDone ? coreDoneAppFailedText() : '', state.error, state.warning]
            .filter(Boolean).join(' ');
        return { msg, type: 'error', title: t('updInstallFailed', 'Update failed') };
    }
    if (state.phase !== 'done') return null;
    const { title, desc } = doneText();
    if (!state.warning) return { msg: desc, type: 'success', title };
    // An opened installer still needs the user: keep that step next to a warning.
    const needsInstaller = state.target === 'client' && !state.clientCurrent;
    return { msg: [needsInstaller ? desc : '', state.warning].filter(Boolean).join(' '), type: 'warning', title };
}

/**
 * Tell the user how a background install ended when they can't see the
 * dialog: it was closed, or the window is hidden to the tray or behind another
 * app. An unseen window gets an OS notification; the toast stays the fallback.
 */
async function notifyOutcome() {
    const note = outcomeNote();
    if (!note) return;
    // Only the dialog that was open when the install ended shows its outcome:
    // one reopened meanwhile starts a new check and replaces it.
    const shownIn = dialog;
    const seen = await windowSeen();
    if (dialog && dialog === shownIn && seen) return;
    if (seen) {
        showNotification(note.msg, note.type, note.title);
        return;
    }
    if (await sendOSNotification(note.title, note.msg).catch(() => false)) return;
    // No system notification. The user may have come back while it was
    // being sent, past the focus event a listener added now would wait for.
    if (await windowSeen()) {
        showNotification(note.msg, note.type, note.title);
        return;
    }
    // A toast in a hidden window would time out unseen, so show it when the
    // window comes back. Kept in storage too: in lightweight mode the hidden
    // page may be destroyed first, and the page that replaces it shows the
    // note on load.
    try { localStorage.setItem(PENDING_NOTE_KEY, JSON.stringify(note)); } catch { /* storage unavailable */ }
    window.addEventListener('focus', () => { void showPendingUpdateNote(true); }, { once: true });
}

/**
 * The address a release-note link opens in the browser, or '' for none. A
 * relative link resolves against the releases page, as on GitHub; an in-page
 * fragment or a non-web scheme opens nothing.
 * @param {string} href
 */
export function releaseNoteHref(href) {
    if (!href || href.startsWith('#')) return '';
    try {
        const url = new URL(href, RELEASES_URL);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
    } catch {
        return '';
    }
}

const PENDING_NOTE_KEY = 'zephyr.updateNotePending';

/**
 * Show the outcome of a background update the user has not seen yet (see
 * `notifyOutcome`), once. Called when the window comes back (`seen`) and when
 * a page loads; a page loaded hidden (silent start, lightweight mode) keeps
 * the note until the window comes back, as a toast there would time out unseen.
 * @param {boolean} [seen] the window is known to be in front (a focus event)
 */
export async function showPendingUpdateNote(seen = false) {
    try {
        if (!localStorage.getItem(PENDING_NOTE_KEY)) return;
    } catch { return; /* storage unavailable */ }
    if (!seen && !(await windowSeen())) {
        window.addEventListener('focus', () => { void showPendingUpdateNote(true); }, { once: true });
        return;
    }
    /** @type {{ msg: string, type: 'error'|'warning'|'success', title: string } | null} */
    let note = null;
    try {
        const raw = localStorage.getItem(PENDING_NOTE_KEY);
        localStorage.removeItem(PENDING_NOTE_KEY);
        note = raw ? JSON.parse(raw) : null;
    } catch { /* storage unavailable or malformed */ }
    if (note && typeof note.msg === 'string') showNotification(note.msg, note.type, note.title);
}

const coreDoneAppFailedText = () => t('updCoreDoneAppFailed', 'The core is updated, but the app update didn’t finish.');

const networkBusyText = () => t('updNetworkBusy', 'Another network change is in progress. Try again when it finishes.');

/** Follow the backend's download progress; resolves to the unlisten handle, if any. */
async function listenProgress() {
    try {
        return await listen('core-download-status', (/** @type {{ payload: { component?: string, progress?: number, status_text?: string } }} */ event) => {
            const p = event.payload || {};
            if (p.component && p.component !== state.target) return;
            if (state.phase !== 'installing') return;
            const pct = Number(p.progress);
            if (Number.isFinite(pct)) state.progress = Math.max(0, Math.min(100, pct));
            if (p.status_text) state.stage = stageFromStatus(p.status_text);
            renderProgress();
        });
    } catch (err) {
        settingsLogger.warn('[update] progress listener unavailable', err);
        return undefined;
    }
}

/**
 * Install one update. A core update stops and restarts the core: it must not
 * overlap a TUN, mode or subscription change, which hold the same lock.
 * @param {'core'|'client'} target
 */
async function installTarget(target) {
    state.target = target;
    state.progress = 0;
    state.stage = 'preparing';
    render();
    if (target === 'client') {
        // The backend looks up the release again before downloading; when it
        // turns out to be the running version, no installer opens.
        const result = await invoke(COMMANDS.UPDATE_CLIENT);
        if (result === CLIENT_ALREADY_CURRENT) {
            state.clientCurrent = true;
            state.clientLatest = null;
        }
        return;
    }
    if (appStore.get('isNetworkUpdating')) throw new Error(networkBusyText());
    appStore.set('isNetworkUpdating', true);
    try {
        await installCore();
    } finally {
        appStore.set('isNetworkUpdating', false);
    }
}

/**
 * Install the targets in order while following progress.
 * @param {('core'|'client')[]} targets
 * @returns {Promise<string | null>} The failure, or null when all installed.
 */
async function installAll(targets) {
    const unlisten = await listenProgress();
    /** @type {string | null} */
    let failure = null;
    try {
        // In order: the app installer must not replace a core mid-update.
        for (const target of targets) await installTarget(target);
    } catch (err) {
        failure = errorText(err);
    }
    // Stay "installing" until the listener is gone: closing the dialog while
    // finished would reset the state and lose the result before it's reported.
    if (unlisten) {
        try { await unlisten(); } catch { /* already gone */ }
    }
    return failure;
}

/** A version the check could not read stays reported, whatever the install did. */
function keepPartialCheckWarning() {
    if (!state.checkError) return;
    const partial = `${t('updPartialCheck', 'Not every version could be checked:')} ${state.checkError}`;
    if (!state.warning.includes(partial)) state.warning = state.warning ? `${state.warning} ${partial}` : partial;
}

/** Mark the install done. */
function finishDone() {
    state.progress = 100;
    state.phase = 'done';
    keepPartialCheckWarning();
}

/** Download and install the picked updates, reporting progress. */
async function runInstall() {
    if (isBusy()) return;
    const targets = pickTargets();
    if (!targets.length) return;
    if (targets[0] === 'core' && appStore.get('isNetworkUpdating')) {
        state.phase = 'install-failed';
        state.error = networkBusyText();
        keepPartialCheckWarning();
        render();
        return;
    }
    state.phase = 'installing';
    state.error = '';
    state.clientCurrent = false;
    // A retry after the app installer failed installs only the app: keep the
    // earlier core result so the outcome still names it.
    if (targets[0] === 'core') {
        state.warning = '';
        state.coreDone = false;
    }

    const failure = await installAll(targets);
    if (failure === null) finishDone();
    else {
        state.phase = 'install-failed';
        state.error = failure;
        keepPartialCheckWarning();
    }
    render();
    await notifyOutcome();
    // Recovery, the outcome and any app installer are done: a core update's
    // page hold can end now.
    if (targets[0] === 'core') {
        try { await invoke(COMMANDS.END_UPDATE_HOLD); } catch { /* the hold lapses on its own */ }
    }
}

// ── Rendering ──────────────────────────────────────────────────────────────

const ICONS = {
    spinner: '<svg class="upd-spin w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg>',
    check: '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
    arrow: '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>',
    alert: '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>',
};

/**
 * @param {'accent'|'success'|'danger'|'muted'} tone
 * @param {string} icon
 * @param {string} title
 * @param {string} [sub]
 */
function statusHead(tone, icon, title, sub = '') {
    return `<div class="upd-head">
        <div class="upd-badge" data-tone="${tone}">${icon}</div>
        <div class="min-w-0">
            <p class="upd-title">${escapeHtml(title)}</p>
            ${sub ? `<p class="upd-sub">${escapeHtml(sub)}</p>` : ''}
        </div>
    </div>`;
}

/** Version rows: current → latest for each part. */
function versionRows() {
    const row = (/** @type {string} */ label, /** @type {string} */ cur, /** @type {string|null} */ next) => `
        <div class="upd-row">
            <span class="upd-row-label">${escapeHtml(label)}</span>
            <span class="upd-row-value">${next
                ? `<span class="text-[var(--text-muted)]">${escapeHtml(showVersion(cur))}</span><span class="upd-arrow" aria-hidden="true">→</span><span class="upd-new">${escapeHtml(showVersion(next))}</span>`
                : escapeHtml(showVersion(cur))}</span>
        </div>`;
    return `<div class="upd-rows">
        ${row(t('appVersion', 'App'), state.app, state.clientLatest?.version || null)}
        ${row(t('coreVersion', 'Core'), state.core, state.coreLatest?.version || null)}
    </div>`;
}

function stageLabel() {
    const target = state.target === 'core' ? 'core' : 'client';
    switch (state.stage) {
        case 'downloading': return t('updStageDownloading', 'Downloading…');
        case 'verifying': return t('updStageVerifying', 'Verifying the download…');
        case 'installing': return t('updStageInstalling', 'Installing…');
        case 'restarting': return t('updStageRestarting', 'Restarting the core…');
        case 'opening': return t('updStageOpening', 'Opening the installer…');
        default: return target === 'core' ? t('updStagePreparingCore', 'Preparing the core update…') : t('updStagePreparing', 'Preparing…');
    }
}

function availableBody() {
    let sub = '';
    if (state.clientLatest && state.portable) sub = t('updPortableHint', 'The portable version can’t update itself. Download the new version from the releases page.');
    else if (state.coreLatest && state.clientLatest) sub = t('updBothHint', 'The core updates first, then the new app package downloads.');
    else if (state.clientLatest) sub = t('updClientHint', 'Zephyr downloads and verifies the installer, then opens it.');
    else sub = t('updCoreHint', 'The core restarts once, so connections drop for a moment.');
    const partial = state.error
        ? `<p class="upd-error">${escapeHtml(t('updPartialCheck', 'Not every version could be checked:'))} ${escapeHtml(state.error)}</p>`
        : '';
    const notes = state.clientLatest?.notes ? sanitizeHtml(markdownToHtml(state.clientLatest.notes)) : '';
    return statusHead('accent', ICONS.arrow, t('updAvailable', 'Update available'), sub)
        + versionRows()
        + partial
        + (notes ? `<div class="upd-notes-label">${escapeHtml(t('updReleaseNotes', 'What’s new'))}</div><div class="upd-notes custom-scrollbar">${notes}</div>` : '');
}

function installingBody() {
    return statusHead('accent', ICONS.spinner, state.target === 'core'
        ? t('updInstallingCore', 'Updating the core')
        : t('updInstallingApp', 'Downloading the update'))
        + `<div class="upd-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(state.progress)}">
            <div class="upd-progress-bar" style="width:${state.progress}%"></div>
        </div>
        <div class="upd-progress-meta"><span id="upd-stage">${escapeHtml(stageLabel())}</span><span id="upd-pct" class="tabular-nums">${Math.round(state.progress)}%</span></div>
        <p class="upd-hint">${escapeHtml(deps.closeQuits?.()
            ? t('updKeepOpenHint', 'Keep Zephyr open until the update finishes. Closing the window quits it.')
            : t('updBackgroundHint', 'Closing this window won’t stop the update.'))}</p>`;
}

/**
 * Title and line for a finished install. The app installer runs last, so with
 * both updates the result still says the core was updated.
 */
function doneText() {
    if (state.target !== 'client') {
        return { title: t('updCoreDone', 'Core updated'), desc: t('updCoreDoneDesc', 'The new core is running.') };
    }
    if (state.clientCurrent) {
        if (state.coreDone) return { title: t('updCoreDone', 'Core updated'), desc: t('updCoreDoneDesc', 'The new core is running.') };
        // With a version unread, only the app is known to be current; the
        // warning below names what couldn't be checked.
        if (state.checkError) return { title: t('updAppUpToDate', 'The app is up to date'), desc: '' };
        return { title: t('updUpToDate', 'You’re up to date'), desc: t('updUpToDateDesc', 'Zephyr and its core are on the latest versions.') };
    }
    const desc = state.coreDone
        ? t('updBothDoneDesc', 'The core is updated. Follow the installer to finish updating the app.')
        : t('updClientDoneDesc', 'Follow the installer to finish the update.');
    return { title: t('updClientDone', 'Installer opened'), desc };
}

function doneBody() {
    const { title, desc } = doneText();
    const rows = state.coreDone ? versionRows() : '';
    const warning = state.warning ? `<p class="upd-error">${escapeHtml(state.warning)}</p>` : '';
    return statusHead('success', ICONS.check, title, desc) + rows + warning;
}

/** A failed install; when the core went through first, say so and show its version. */
function failedInstallBody() {
    const desc = state.coreDone ? coreDoneAppFailedText() : t('updInstallFailedHint', 'The reason is below.');
    const rows = state.coreDone ? versionRows() : '';
    const warning = state.warning ? `<p class="upd-error">${escapeHtml(state.warning)}</p>` : '';
    return statusHead('danger', ICONS.alert, t('updInstallFailed', 'Update failed'), desc)
        + rows + `<p class="upd-error">${escapeHtml(state.error)}</p>` + warning;
}

function bodyHTML() {
    switch (state.phase) {
        case 'checking':
            return statusHead('muted', ICONS.spinner, t('updChecking', 'Checking for updates…'));
        case 'latest':
            return statusHead('success', ICONS.check, t('updUpToDate', 'You’re up to date'), t('updUpToDateDesc', 'Zephyr and its core are on the latest versions.'))
                + versionRows();
        case 'available':
            return availableBody();
        case 'installing':
            return installingBody();
        case 'done':
            return doneBody();
        case 'check-failed':
            return statusHead('danger', ICONS.alert, t('updCheckFailed', 'Couldn’t check for updates'), t('updFailedHint', 'Check your network or proxy, then try again.'))
                + `<p class="upd-error">${escapeHtml(state.error)}</p>`;
        case 'install-failed':
            return failedInstallBody();
        default:
            return '';
    }
}

/**
 * Buttons for an available update. A portable build can't install the app, so
 * it gets the releases page; when the core has an update too, that one can
 * still be installed here and the button says so.
 * @returns {{ id: string, label: string, kind: 'primary'|'ghost' }[]}
 */
function availableActions() {
    const later = { id: 'upd-later', label: t('updLater', 'Later'), kind: /** @type {const} */ ('ghost') };
    const releases = { id: 'upd-releases', label: t('updOpenReleases', 'Open releases page') };
    if (state.clientLatest && state.portable) {
        if (!state.coreLatest) return [later, { ...releases, kind: 'primary' }];
        return [later, { ...releases, kind: 'ghost' }, { id: 'upd-install', label: t('updInstallCore', 'Update core only'), kind: 'primary' }];
    }
    return [later, { id: 'upd-install', label: t('updInstall', 'Download and update'), kind: 'primary' }];
}

/** @returns {{ id: string, label: string, kind: 'primary'|'ghost' }[]} */
function actions() {
    const close = { id: 'upd-close', label: t('close', 'Close'), kind: /** @type {const} */ ('ghost') };
    switch (state.phase) {
        case 'available':
            return availableActions();
        case 'check-failed':
            return [close, { id: 'upd-retry-check', label: t('retry', 'Retry'), kind: 'primary' }];
        case 'install-failed':
            return [close, { id: 'upd-retry-install', label: t('retry', 'Retry'), kind: 'primary' }];
        case 'latest':
        case 'done':
            return [{ id: 'upd-close', label: t('done', 'Done'), kind: 'primary' }];
        default:
            return [close];
    }
}

/** Update only the progress bits, so a stream of events doesn't rebuild the dialog. */
function renderProgress() {
    if (!dialog) return;
    const bar = /** @type {HTMLElement | null} */ (dialog.querySelector('.upd-progress-bar'));
    if (!bar) { render(); return; }
    bar.style.width = `${state.progress}%`;
    dialog.querySelector('.upd-progress')?.setAttribute('aria-valuenow', String(Math.round(state.progress)));
    const pct = dialog.querySelector('#upd-pct');
    if (pct) pct.textContent = `${Math.round(state.progress)}%`;
    const stage = dialog.querySelector('#upd-stage');
    if (stage) stage.textContent = stageLabel();
}

function render() {
    if (!dialog) return;
    const body = dialog.querySelector('#upd-body');
    const foot = dialog.querySelector('#upd-actions');
    if (!body || !foot) return;
    const hadFocus = dialog.contains(document.activeElement);
    // A dual update moves from the core to the app within "installing".
    const target = state.target || '';
    const phaseChanged = dialog.dataset.phase !== state.phase || dialog.dataset.target !== target;
    dialog.dataset.phase = state.phase;
    dialog.dataset.target = target;
    // eslint-disable-next-line no-unsanitized/property -- every dynamic value goes through escapeHtml / sanitizeHtml
    body.innerHTML = bodyHTML(); // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
    // Screen readers hear the new status once per phase or step, not every progress tick.
    const status = dialog.querySelector('#upd-status');
    if (status && phaseChanged) status.textContent = body.querySelector('.upd-title')?.textContent || '';
    // eslint-disable-next-line no-unsanitized/property -- labels escaped via escapeHtml
    foot.innerHTML = actions().map((a) => `<button type="button" id="${a.id}" class="${a.kind === 'primary' ? 'btn-primary' : 'btn-ghost'}">${escapeHtml(a.label)}</button>`).join(''); // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
    if (hadFocus) {
        const primary = /** @type {HTMLElement | null} */ (foot.querySelector('.btn-primary') || foot.querySelector('button'));
        primary?.focus();
    }
}

function closeDialog() {
    if (!dialog) return;
    trap?.deactivate();
    trap = null;
    dialog.remove();
    dialog = null;
    document.body.style.overflow = '';
    // Finished states start over next time; running work keeps its state.
    if (!isBusy()) state = freshState();
}

function buildDialog() {
    const el = document.createElement('div');
    el.id = DIALOG_ID;
    // One step under the shared modal, so a confirmation (a deep link, say)
    // that opens while this dialog is up shows on top of it.
    el.style.zIndex = 'calc(var(--z-modal) - 1)';
    el.className = 'fixed inset-0 flex items-center justify-center bg-[var(--zephyr-bg-overlay)] backdrop-blur-md';
    // eslint-disable-next-line no-unsanitized/property -- static markup, title escaped
    el.innerHTML = `
        <div class="upd-card glass-card" role="dialog" aria-modal="true" aria-labelledby="upd-dialog-title">
            <div class="flex items-center justify-between">
                <h3 id="upd-dialog-title" class="dialog-title">${escapeHtml(t('checkUpdate', 'Check for Updates'))}</h3>
                <button type="button" id="upd-x" class="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors" aria-label="${escapeHtml(t('close', 'Close'))}">
                    <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
            </div>
            <p id="upd-status" class="sr-only" aria-live="polite"></p>
            <div id="upd-body" class="upd-body custom-scrollbar"></div>
            <div id="upd-actions" class="upd-actions"></div>
        </div>`; // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
    el.addEventListener('click', (e) => {
        const target = /** @type {HTMLElement} */ (e.target);
        if (target === el) { closeDialog(); return; }
        // Release-note links open in the system browser, never inside the app.
        const link = target.closest('.upd-notes a');
        if (link) {
            e.preventDefault();
            const href = releaseNoteHref(link.getAttribute('href') || '');
            if (href) openUrl(href).catch((err) => settingsLogger.warn('Failed to open release-note link', err));
            return;
        }
        const id = target.closest('button')?.id;
        if (id === 'upd-x' || id === 'upd-close' || id === 'upd-later') closeDialog();
        else if (id === 'upd-install' || id === 'upd-retry-install') void runInstall();
        else if (id === 'upd-retry-check') void runCheck();
        else if (id === 'upd-releases') {
            openUrl(RELEASES_URL).catch((err) => settingsLogger.warn('Failed to open releases page', err));
            closeDialog();
        }
    });
    el.querySelector('.upd-card')?.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    return el;
}

/**
 * Open the update dialog. Starts a fresh check unless one is already running
 * or an update is being installed, in which case the dialog shows that work.
 * A result that finished while the dialog was closed is not shown again.
 * @param {UpdateDeps} [options]
 */
export function openUpdateDialog(options = {}) {
    deps = options;
    const wasOpen = !!dialog;
    if (!dialog) {
        dialog = buildDialog();
        document.body.appendChild(dialog);
        document.body.style.overflow = 'hidden';
        trap = createFocusTrap(dialog, {
            onEscape: () => closeDialog(),
            // Escape belongs to a shared modal open on top.
            passEscape: () => {
                const shared = document.getElementById('modal-bg');
                return !!shared && !shared.classList.contains('hidden');
            },
        });
        render();
        trap.activate();
    }
    if (isBusy() || wasOpen) render();
    else void runCheck();
}

/** Test hook: drop the dialog and all state. */
export function _resetUpdateDialogForTests() {
    if (dialog) { trap?.deactivate(); dialog.remove(); }
    dialog = null;
    trap = null;
    state = freshState();
    deps = {};
}
