// @ts-check
/**
 * Tunnel management submodule for settings.
 *
 * Handles rendering the tunnel list, adding new tunnels via modal,
 * and deleting existing tunnels.
 *
 * @module ui/settings/tunnels
 */

import { appStore } from '../state.js';
import { showModal, showConfirmModal, showNotification } from '../notifications.js';
import { SVG_ICONS } from '../icons.js';
import { pasteWithFeedback, renderPasteButtonHtml } from '../../utils/clipboard.js';
import { translations } from '../../i18n.js';
import { escapeHtml } from '../../utils/sanitize.js';
import { Bus, Events } from '../events.js';
import { settingsLogger } from '../../utils/logger.js';

/**
 * Two tunnel rows are the same rule when address, target and network
 * all match (network is a list — compare it sorted, so order does not
 * matter). Used when a reload replaced the list objects while a
 * confirmation waited: identity no longer works, but the rule is
 * still recognisable.
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
function sameTunnel(a, b) {
    if (a.address !== b.address || a.target !== b.target) return false;
    const networks = (/** @type {any} */ t) => (Array.isArray(t.network) ? t.network : [t.network]).map(String).sort().join(',');
    return networks(a) === networks(b);
}

/**
 * A value's JSON with object keys sorted: two lists that differ only in the
 * order of their entries' properties (the core and the profile can write
 * them differently) give the same text.
 * @param {unknown} value
 * @returns {string}
 */
function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        const obj = /** @type {Record<string, unknown>} */ (value);
        const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const fields = keys.map((k) => JSON.stringify(k) + ':' + stableJson(obj[k]));
        return `{${fields.join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

/**
 * Validate an address string (IPv4:port, [IPv6]:port, hostname:port).
 * @param {string} addr
 * @returns {boolean}
 */
function isValidAddress(addr) {
    // IPv6 with port: [ipv6]:port
    const ipv6Match = addr.match(/^\[([0-9a-fA-F:]+)\]:(\d+)$/);
    if (ipv6Match) {
        const port = parseInt(ipv6Match[2], 10);
        const ipv6 = ipv6Match[1];
        const isValid = ipv6.split(':').every(seg => seg.length <= 4 && /^[0-9a-fA-F]*$/.test(seg));
        return isValid && port > 0 && port <= 65535;
    }
    // IPv4 with port
    const ipv4Match = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d+)$/);
    if (ipv4Match) {
        const octets = [ipv4Match[1], ipv4Match[2], ipv4Match[3], ipv4Match[4]];
        const validOctets = octets.every(o => {
            const num = parseInt(o, 10);
            return num >= 0 && num <= 255;
        });
        const port = parseInt(ipv4Match[5], 10);
        return validOctets && port > 0 && port <= 65535;
    }
    // Hostname with port
    const hostMatch = addr.match(/^([a-zA-Z0-9][-a-zA-Z0-9.]*):(\d+)$/);
    if (hostMatch) {
        const port = parseInt(hostMatch[2], 10);
        return port > 0 && port <= 65535;
    }
    return false;
}

/**
 * Initialize tunnel management controls.
 *
 * @param {object} opts
 * @param {HTMLElement|null} opts.addTunnelBtn - The "Add Tunnel" button.
 * @param {HTMLElement|null} opts.tunnelsList - The tunnel list container.
 * @param {HTMLElement|null} opts.tunnelsEmpty - The empty state element.
 * @param {any[]} opts.initialTunnels - The initial tunnel list from core config.
 * @param {boolean} [opts.initialKnown=true] - Whether initialTunnels is the list the
 *   core runs; when not, nothing is saved until setTunnels() brings that list.
 * @param {(patch: Record<string, any>, expectProfile?: string|null) => Promise<boolean|'restart'|'partial'|'unconfirmed'>} opts.saveConfigToCore - Callback to save config patch to core;
 *   with `expectProfile`, the backend refuses it once the core runs another profile.
 * @param {(() => Promise<unknown>)|null} [opts.readFromCore] - Reads the core's list again
 *   (and publishes it with setTunnels) when the first read failed, or when
 *   the core runs another profile than the one the list was read from.
 * @param {(() => Promise<string|null>)|null} [opts.readProfile] - The profile the core
 *   runs now ('' for the minimal config, null when unknown).
 * @param {(() => number)|null} [opts.coreGeneration] - Counts core replacements: a list read
 *   from a core that was replaced since is read again before an edit, also
 *   for the same profile (the new core loaded the profile's own list).
 * @param {((profile: string) => Promise<any[]|null>)|null} [opts.readResetBaseline] - Read the reset target's current list before writing it.
 */
export function initTunnelSettings({
    addTunnelBtn,
    tunnelsList,
    tunnelsEmpty,
    initialTunnels,
    initialKnown = true,
    saveConfigToCore,
    readFromCore = null,
    readProfile = null,
    coreGeneration = null,
    readResetBaseline = null,
}) {
    /** @type {any[]} */
    let currentTunnels = initialTunnels;
    /**
     * The list the core runs as far as this page knows: the one read from
     * it, or the last one a save sent that it took (a 'restart' result too:
     * the files hold it and the core runs it after the restart its notice
     * asks for). A save that fails when no newer one was started puts this
     * list back, so a tunnel whose removal never reached the core shows again.
     * @type {any[]}
     */
    let confirmed = initialTunnels.slice();
    /**
     * Whether the core's list was read at all: saving a list built on top of
     * an unread one would drop the tunnels the core runs.
     */
    let known = initialKnown;
    /**
     * The profile the core ran when the list was read ('' for the minimal
     * config); null when not known, and then nothing is checked. A save of
     * this list into another profile would overwrite that profile's tunnels.
     * @type {string|null}
     */
    let listProfile = null;
    /** coreGeneration() when the list was read or last confirmed. */
    let listCore = coreGeneration ? coreGeneration() : 0;
    /** Bumped each time a read list is taken, so a refresh can tell it replaced the list. */
    let listTaken = 0;
    /**
     * The core runs the list shown, but the active profile did not take it
     * (a 'partial' save): it is lost when that profile is loaded again.
     */
    let profileUnsaved = false;
    /** Last list awaiting a confirmed profile save, distinct from the live baseline.
     * @type {any[] | null}
     */
    let pendingIntent = null;
    let pendingUnconfirmed = false;
    /** @type {{profile: string|null, core: number}|null} */
    let pendingTarget = null;
    /** Saves started so far, numbered in start order. */
    let saveSeq = 0;
    /** The newest save the core took: a newer one that failed does not overrule it. */
    let appliedSeq = 0;
    /**
     * The targets and numbers of resets whose own save was started and not yet
     * followed by resetAfterSave, oldest first: resets run (and end) in the
     * order they start, so each takes its own number back.
     * @type {{seq: number, profile: string|null, core: number}[]}
     */
    const resetSeqs = [];
    /** Saves (and resets) not finished yet. */
    let pending = 0;
    /**
     * Tunnel saves and the reset run one at a time, in the order they were
     * started: the backend lock keeps them apart but not in order, so an
     * older list could otherwise land after a newer one.
     * @type {Promise<unknown>}
     */
    let queue = Promise.resolve();

    /**
     * Run `task` after every save started before it.
     * @template T
     * @param {() => Promise<T>} task
     * @returns {Promise<T | false>}
     */
    function enqueue(task) {
        pending += 1;
        const retry = tunnelsList?.querySelector('[data-tunnels-unsaved] button');
        if (retry instanceof HTMLButtonElement) retry.disabled = true;
        // A save that throws took nothing: it reads as a failed one, so the
        // list goes back to what the core runs and no reset number is left.
        const run = queue.then(task).catch((err) => {
            settingsLogger.warn('Tunnel save failed', err);
            return /** @type {const} */ (false);
        }).finally(() => {
            pending -= 1;
            const currentRetry = tunnelsList?.querySelector('[data-tunnels-unsaved] button');
            if (currentRetry instanceof HTMLButtonElement) currentRetry.disabled = pending > 0;
        });
        queue = run.catch(() => {});
        return run;
    }

    /**
     * Whether a save or reset started after the save numbered `seq`.
     * @param {number} seq
     */
    const supersededSince = (seq) => saveSeq !== seq;

    /**
     * Reads the core's list again when it is not known yet (the read when
     * Settings loaded failed), so an edit does not stay blocked until the
     * app restarts; and when the core runs another profile than the one the
     * list was read from (the profile changed while Settings stayed open):
     * an edit of that list would be refused, and each refusal would bring
     * the old profile's list back.
     */
    async function readIfUnknown() {
        if (!readFromCore) return;
        const coreSame = !coreGeneration || coreGeneration() === listCore;
        if (known && listProfile !== null && coreSame) {
            if (!readProfile) return;
            const running = await readProfile().catch(() => null);
            // Unknown, or still the list's profile on the list's core: the
            // list stays. A core that replaced it during the read reloaded
            // the profile, so the list is read again.
            const stillSameCore = !coreGeneration || coreGeneration() === listCore;
            if (stillSameCore && (running === null || running === listProfile)) return;
        }
        // A list known before this read is stale now (another profile or
        // another core runs): if the read does not replace it, it is no
        // longer the list to edit, and editBlocked() says so.
        const staleList = known ? listTaken : -1;
        try {
            await readFromCore();
        } catch {
            // Still unknown: editBlocked() says so.
        }
        if (staleList === listTaken) known = false;
    }

    /**
     * Whether the list cannot be changed now, saying why: its profile is not
     * known (a save of it could land in any profile), or a reset is still
     * running (a list built before it lands after it and brings back the
     * tunnels it removes).
     * @returns {boolean}
     */
    function editBlocked() {
        /** @type {any} */
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')] || {};
        if (!known || listProfile === null) {
            showNotification(t.tunnelsNotLoaded || 'The port forwarding list could not be read from the core. Try again in a moment.', 'error');
            return true;
        }
        if (resetSeqs.length > 0) {
            showNotification(t.tunnelsResetRunning || 'Restoring the defaults is still running. Try again when it is done.', 'warning');
            return true;
        }
        return false;
    }

    /**
     * Save the list as it is now. A partial save keeps the list (the core
     * already runs it) but marks it unsaved, so the list offers a retry. A
     * newer save that failed took nothing, so it does not hide an older
     * partial save.
     * @returns {Promise<boolean|'restart'|'partial'|'unconfirmed'>}
     */
    async function saveTunnels() {
        const seq = ++saveSeq;
        const list = currentTunnels.slice();
        // The profile the list belongs to now: a reset finishing before this
        // save runs files another list under another profile.
        const profile = listProfile;
        // The core the list was read from: a core that replaced it before
        // this save's turn runs its own list, which this one would overwrite.
        const coreAtSnapshot = listCore;
        let coreReplaced = false;
        const ok = await enqueue(async () => {
            if (coreGeneration && coreGeneration() !== coreAtSnapshot) {
                coreReplaced = true;
                return /** @type {const} */ (false);
            }
            const result = await saveConfigToCore({ tunnels: list }, profile);
            // Saves run in start order: the latest one the core took sets the
            // list it runs, while the page still shows that profile's list.
            if (result && result !== 'unconfirmed' && listProfile === profile) confirmed = list;
            return result;
        });
        // Not sent: the page reads the replacement core's list instead.
        // Until that read lands (or when it fails) the newest unsent edit
        // is taken back, so the list does not show a change no core took.
        if (coreReplaced) {
            if (listProfile === profile && !supersededSince(seq)) {
                currentTunnels = confirmed.slice();
            }
            await readIfUnknown();
            return false;
        }
        // Another profile's list replaced this one meanwhile: its baseline,
        // retry and shown list are not this save's to change.
        if (listProfile !== profile) return ok;
        if (ok && seq > appliedSeq) {
            appliedSeq = seq;
            profileUnsaved = ok === 'partial' || ok === 'unconfirmed';
            pendingIntent = profileUnsaved ? list.slice() : null;
            pendingUnconfirmed = ok === 'unconfirmed';
            pendingTarget = profileUnsaved ? { profile, core: coreAtSnapshot } : null;
        }
        if (!ok && !supersededSince(seq)) {
            // A failed later edit cannot replace an earlier pending intent
            // with the older confirmed list that Retry was meant to replace.
            currentTunnels = (pendingIntent ?? confirmed).slice();
        }
        return ok;
    }

    /** @param {object} tunnel */
    function removeTunnel(tunnel) {
        const at = currentTunnels.indexOf(tunnel);
        if (at >= 0) currentTunnels.splice(at, 1);
    }

    /** A row saying the list is not saved to the profile, with a retry button. */
    function renderUnsavedRow() {
        /** @type {any} */
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')] || {};
        const row = document.createElement('div');
        row.className = 'flex items-center justify-between gap-2 rounded-lg p-2 text-xs text-[var(--warning-color,#d97706)]';
        row.dataset.tunnelsUnsaved = '';
        const label = document.createElement('span');
        label.textContent = t.unsavedChanges || 'Unsaved changes';
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'btn-secondary text-xs px-2 py-1';
        retryBtn.textContent = t.retry || 'Retry';
        retryBtn.disabled = pending > 0;
        retryBtn.onclick = async () => {
            if (pending > 0) return;
            // The retry is for the list of the profile shown now: when
            // another profile's list replaces it during the read, that list
            // is not what failed to save, and is not saved in its place.
            const profileAtClick = listProfile;
            await readIfUnknown();
            if (pending > 0 || editBlocked() || listProfile !== profileAtClick || !profileUnsaved) {
                renderTunnels();
                return;
            }
            retryBtn.disabled = true;
            try {
                await saveTunnels();
            } finally {
                retryBtn.disabled = false;
            }
            renderTunnels();
        };
        row.appendChild(label);
        row.appendChild(retryBtn);
        return row;
    }

    function renderTunnels() {
        if (!tunnelsList) return;

        if (!currentTunnels || currentTunnels.length === 0) {
            tunnelsList.replaceChildren();
            if (profileUnsaved) tunnelsList.appendChild(renderUnsavedRow());
            if (tunnelsEmpty) tunnelsList.appendChild(tunnelsEmpty);
            if (tunnelsEmpty) tunnelsEmpty.style.display = 'block';
            return;
        }

        if (tunnelsEmpty) tunnelsEmpty.style.display = 'none';
        tunnelsList.replaceChildren();
        if (profileUnsaved) tunnelsList.appendChild(renderUnsavedRow());

        currentTunnels.forEach((tunnel) => {
            const item = document.createElement('div');
            item.className = 'flex items-center justify-between bg-[var(--zephyr-bg-input)] border border-[var(--zephyr-border-subtle)] rounded-lg p-3 hover:border-[var(--zephyr-border-strong)] transition-[border-color]';

            const info = document.createElement('div');
            info.className = 'flex flex-col gap-1';

            const topRow = document.createElement('div');
            topRow.className = 'flex items-center gap-2';

            const protocolBadge = document.createElement('span');
            protocolBadge.className = 'type-badge text-[var(--text-secondary)]';
            protocolBadge.textContent = (Array.isArray(tunnel.network) ? tunnel.network : [tunnel.network]).map((/** @type {string} */ n) => String(n).toUpperCase()).join(' + ');

            const target = document.createElement('span');
            target.className = 'text-xs font-medium text-[var(--text-primary)]';
            target.textContent = tunnel.target;

            topRow.appendChild(protocolBadge);
            topRow.appendChild(target);

            const listenEl = document.createElement('span');
            listenEl.className = 'text-2xs text-[var(--text-muted)] font-mono';
            /** @type {any} */
            const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
            listenEl.textContent = `${t.listen || 'Listen'}: ${tunnel.address}`;

            info.appendChild(topRow);
            info.appendChild(listenEl);

            const delBtn = document.createElement('button');
            delBtn.className = 'btn-delete-icon';
            delBtn.type = 'button';
            // Tooltip and accessible name carry the same row-specific text,
            // matching the other icon-only row buttons in this app.
            const deleteLabel = `${(/** @type {any} */ (translations)[appStore.get('currentLang')] || {}).delete || 'Delete'} ${tunnel.address}`;
            delBtn.title = deleteLabel;
            delBtn.setAttribute('aria-label', deleteLabel);
            // eslint-disable-next-line no-unsanitized/property -- static SVG constant
            delBtn.innerHTML = SVG_ICONS.trash; // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
            delBtn.onclick = async () => {
                // The deletion belongs to the profile whose list was shown:
                // once another profile's list replaced it, it is dropped (an
                // identical rule there is not the one the user picked).
                const profileAtClick = listProfile;
                const accepted = await showConfirmModal(
                    `${t.delete || 'Delete'} ${tunnel.address}?`,
                    tunnel.target ? `${tunnel.address} → ${tunnel.target}` : tunnel.address,
                    { danger: true, confirmText: t.delete || 'Delete' }
                );
                if (!accepted) return;
                // The core may run another profile by now: its list is read
                // first, and then the deletion is dropped below.
                await readIfUnknown();
                if (editBlocked() || listProfile !== profileAtClick) {
                    renderTunnels();
                    return;
                }
                // The list may have changed while the confirmation waited
                // (another deletion, or setTunnels/resetTunnels replacing
                // the array): find this tunnel again instead of trusting
                // the rendered index. Identity first; a reload replaces
                // the objects, so identity fails even when the same rule
                // is still there — fall back to a value match, but only
                // when exactly one current tunnel matches. Zero or
                // several matches means the rule is gone or ambiguous:
                // leave the list untouched rather than delete the wrong
                // row.
                let currentIndex = currentTunnels.indexOf(tunnel);
                if (currentIndex === -1) {
                    const matches = [];
                    for (let i = 0; i < currentTunnels.length; i += 1) {
                        if (sameTunnel(currentTunnels[i], tunnel)) matches.push(i);
                    }
                    if (matches.length !== 1) return;
                    currentIndex = matches[0];
                }
                currentTunnels.splice(currentIndex, 1);
                renderTunnels();
                // A failed save that was the newest puts back the list the
                // core runs (the deleted row included); a later save
                // decides otherwise.
                await saveTunnels();
                renderTunnels();
            };

            item.appendChild(info);
            item.appendChild(delBtn);
            tunnelsList.appendChild(item);
        });
    }

    addTunnelBtn?.addEventListener('click', async () => {
        /** @type {any} */
        const t = /** @type {any} */ (translations)[appStore.get('currentLang')];
        await readIfUnknown();
        if (editBlocked()) return;
        const cancelText = t.cancel || 'Cancel';
        const confirmText = t.add || 'Add';
        const esc = (/** @type {string} */ v) => escapeHtml(String(v ?? ''));
        const customHtml = `
            <div class="space-y-4">
                <div>
                    <span class="block text-xs font-medium text-[var(--text-muted)] mb-1.5">${esc(t.tunnelProtocol || 'Protocol')}</span>
                    <div id="tunnel-protocol-seg" class="seg-tabs seg-tabs-lg w-full" role="radiogroup" aria-label="${esc(t.tunnelProtocol || 'Protocol')}">
                        <button type="button" role="radio" aria-checked="false" data-network="tcp" class="seg-tab flex-1 justify-center">TCP</button>
                        <button type="button" role="radio" aria-checked="false" data-network="udp" class="seg-tab flex-1 justify-center">UDP</button>
                        <button type="button" role="radio" aria-checked="true" data-network="tcp,udp" class="seg-tab active flex-1 justify-center">TCP + UDP</button>
                    </div>
                </div>
                <div>
                    <label for="tunnel-address-input" class="block text-xs font-medium text-[var(--text-muted)] mb-1.5">${esc(t.tunnelNetwork || 'Local listen address')}</label>
                    <div class="input-paste-wrapper">
                        <input type="text" id="tunnel-address-input" placeholder="127.0.0.1:6553" spellcheck="false" autocomplete="off" aria-describedby="tunnel-address-hint" class="form-control form-control-md form-control-mono">
                        ${renderPasteButtonHtml('tunnel-address-paste-btn', `${t.paste || 'Paste'} (${t.tunnelNetwork || 'Local listen address'})`, false, null)}
                    </div>
                    <div id="tunnel-address-hint" class="text-2xs text-[var(--text-muted)] mt-1.5 ms-1">${esc(t.tunnelAddressHint || 'Connections to this address are forwarded')}</div>
                </div>
                <div>
                    <label for="tunnel-target-input" class="block text-xs font-medium text-[var(--text-muted)] mb-1.5">${esc(t.tunnelTarget || 'Forward to')}</label>
                    <div class="input-paste-wrapper">
                        <input type="text" id="tunnel-target-input" placeholder="8.8.8.8:53" spellcheck="false" autocomplete="off" aria-describedby="tunnel-target-hint" class="form-control form-control-md form-control-mono">
                        ${renderPasteButtonHtml('tunnel-target-paste-btn', `${t.paste || 'Paste'} (${t.tunnelTarget || 'Forward to'})`, false, null)}
                    </div>
                    <div id="tunnel-target-hint" class="text-2xs text-[var(--text-muted)] mt-1.5 ms-1">${esc(t.tunnelTargetHint || 'Reached through the current proxy')}</div>
                </div>
                <div class="flex gap-3 justify-end pt-2">
                    <button type="button" id="tunnel-cancel-btn" class="btn-ghost">${esc(cancelText)}</button>
                    <button type="button" id="tunnel-confirm-btn" class="btn-primary">${esc(confirmText)}</button>
                </div>
            </div>
        `;

        const _contentArea = /** @type {HTMLElement} */ (await showModal(
            t.addPortForwarding || "Add Port Forwarding",
            "", "", true, customHtml,
            (contentArea, closeModal) => {
                /** @type {string} */
                let protocolStrValue = 'tcp,udp';
                const protocolButtons = /** @type {HTMLElement[]} */ (Array.from(contentArea.querySelectorAll('[data-network]')));
                // role is not on the modal sanitiser's allow-list; set it here.
                contentArea.querySelector('#tunnel-protocol-seg')?.setAttribute('role', 'radiogroup');
                /** @param {HTMLElement} b */
                const selectProtocol = (b) => {
                    protocolStrValue = b.dataset.network || 'tcp,udp';
                    for (const x of protocolButtons) {
                        const on = x === b;
                        x.classList.toggle('active', on);
                        x.setAttribute('aria-checked', String(on));
                        // Radio group: one Tab stop, on the checked option.
                        x.tabIndex = on ? 0 : -1;
                    }
                };
                /** @param {KeyboardEvent} e */
                const onProtocolKey = (e) => {
                    // The shared radio-group keys (ui/tablist-keys.js) already moved it.
                    if (e.defaultPrevented) return;
                    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
                    const from = protocolButtons.indexOf(/** @type {HTMLElement} */ (e.currentTarget));
                    if (!step || from < 0) return;
                    e.preventDefault();
                    const next = protocolButtons[(from + step + protocolButtons.length) % protocolButtons.length];
                    selectProtocol(next);
                    next.focus();
                };
                for (const b of protocolButtons) {
                    b.setAttribute('role', 'radio');
                    b.addEventListener('click', () => selectProtocol(b));
                    b.addEventListener('keydown', onProtocolKey);
                }
                const initial = protocolButtons.find((b) => b.classList.contains('active')) || protocolButtons[0];
                if (initial) selectProtocol(initial);
                const addressInput = /** @type {HTMLInputElement} */ (contentArea.querySelector('#tunnel-address-input'));
                const targetInput = /** @type {HTMLInputElement} */ (contentArea.querySelector('#tunnel-target-input'));
                const cancelBtn = contentArea.querySelector('#tunnel-cancel-btn');
                const confirmBtn = /** @type {HTMLButtonElement} */ (contentArea.querySelector('#tunnel-confirm-btn'));

contentArea.querySelector('#tunnel-address-paste-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (addressInput) {
        void pasteWithFeedback(addressInput, showNotification, translations, appStore.get('currentLang') || 'en');
    }
});
contentArea.querySelector('#tunnel-target-paste-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (targetInput) {
        void pasteWithFeedback(targetInput, showNotification, translations, appStore.get('currentLang') || 'en');
    }
});

                cancelBtn?.addEventListener('click', () => closeModal(null));

                confirmBtn?.addEventListener('click', async () => {
                    if (confirmBtn.disabled) return;
                    confirmBtn.disabled = true;

                    const protocolStr = protocolStrValue;
                    const address = addressInput?.value?.trim() || '';
                    const target = targetInput?.value?.trim() || '';

                    if (!protocolStr || !address || !target) {
                        showNotification(t.valueEmpty || 'Value cannot be empty', 'error');
                        confirmBtn.disabled = false;
                        return;
                    }

                    const protocols = protocolStr.split(',').map(s => s.trim().toLowerCase()).filter(s => s);
                    const validProtocols = ['tcp', 'udp'];
                    const invalidProtocols = protocols.filter(p => !validProtocols.includes(p));

                    if (protocols.length === 0 || invalidProtocols.length > 0) {
                        showNotification(t.invalidProtocol || 'Invalid protocol. Use tcp, udp, or both.', 'error');
                        confirmBtn.disabled = false;
                        return;
                    }

                    if (!isValidAddress(address)) {
                        showNotification(t.invalidAddressFormat || 'Invalid listen address format. Use host:port', 'error');
                        confirmBtn.disabled = false;
                        return;
                    }

                    if (!isValidAddress(target)) {
                        showNotification(t.invalidTargetFormat || 'Invalid target address format. Use host:port', 'error');
                        confirmBtn.disabled = false;
                        return;
                    }

                    // The core may run another profile than when the dialog
                    // opened: its list is read first, so the tunnel goes into
                    // the list of the profile it is saved to.
                    await readIfUnknown();
                    if (editBlocked()) {
                        confirmBtn.disabled = false;
                        return;
                    }
                    const network = protocols;
                    const newTunnel = { network, address, target };
                    currentTunnels.push(newTunnel);
                    try {
                        // 'partial' keeps the tunnel (the core runs it); the list
                        // then offers to retry saving it to the profile.
                        // A failed save that was the newest puts back the
                        // list the core runs, without this tunnel.
                        const ok = await saveTunnels();
                        if (!ok) {
                            renderTunnels();
                            confirmBtn.disabled = false;
                            return;
                        }
                        closeModal(null);
                        renderTunnels();
                    } catch (_err) {
                        removeTunnel(newTunnel);
                        confirmBtn.disabled = false;
                        showNotification(t.saveFailed || 'Failed to save configuration', 'error');
                    }
                });
            }
        ));
    });

    // Initial render
    renderTunnels();

    // Row labels (listen line, delete tooltip) are read from the current
    // language at render time: re-render when the language changes, or
    // the rows keep the old language until the next add or delete.
    // I18N_APPLIED fires while the dropdown is still applying
    // translations — the store still holds the old language then — so
    // that render alone never picks up the new labels; the store is
    // updated right after, and LANGUAGE_CHANGED is the event that
    // actually carries the switch.
    Bus.on(Events.I18N_APPLIED, renderTunnels);
    Bus.on(Events.LANGUAGE_CHANGED, renderTunnels);

    return {
        renderTunnels,
        /** Reset tunnels to empty and re-render */
        resetTunnels() {
            currentTunnels = [];
            profileUnsaved = false;
            pendingIntent = null;
            pendingUnconfirmed = false;
            pendingTarget = null;
            appliedSeq = ++saveSeq; // a save still in flight no longer sets the flag
            renderTunnels();
        },
        /**
         * Run the reset's own save after the tunnel saves already started,
         * with saves started meanwhile waiting until it is done: an older
         * list can neither land after the empty one nor change its flag.
         * @template T
         * @param {() => Promise<T>} save
         * @param {string|null} [profile] the profile the save was checked
         *   against ('' for the minimal config, null when not known)
         * @returns {Promise<T | false>}
         */
        saveAfterPending(save, profile = null) {
            const reset = { seq: ++saveSeq, profile, core: listCore };
            resetSeqs.push(reset);
            return enqueue(async () => {
                // A save that throws counts as failed, so the caller always
                // goes on to resetAfterSave, which releases the reset's
                // number: left held, it would block every tunnel edit.
                // The core the empty list is sent to: one that replaced it
                // during the save loaded the profile on its own, so its list
                // is not known from this reset.
                const coreAtSave = coreGeneration ? coreGeneration() : 0;
                reset.core = coreAtSave;
                if (profile !== null && (listProfile !== profile || listCore !== coreAtSave) && readResetBaseline) {
                    const baseline = await readResetBaseline(profile).catch(() => null);
                    if (Array.isArray(baseline) && (!coreGeneration || coreGeneration() === coreAtSave)) {
                        profileUnsaved = false;
                        pendingIntent = null;
                        pendingUnconfirmed = false;
                        pendingTarget = null;
                        confirmed = baseline.slice();
                        listProfile = profile;
                        listCore = coreAtSave;
                        known = true;
                    }
                }
                /** @type {T | false} */
                const result = await save().catch((/** @type {unknown} */ err) => {
                    settingsLogger.warn('Restoring the default port forwards failed:', err);
                    return false;
                });
                // The reset sends an empty list: the core runs none now, and
                // that list is known even when the first read failed. It is
                // the list of the profile the save was checked against; with
                // none known, a save of it could reach any profile, so it is
                // read again first.
                if (result && result !== 'unconfirmed') {
                    confirmed = [];
                    listProfile = profile;
                    listCore = coreAtSave;
                    known = profile !== null && (!coreGeneration || coreGeneration() === coreAtSave);
                    listTaken += 1;
                }
                return result;
            });
        },
        /**
         * After restoring the defaults sent an empty list: empty the list
         * only when the core took it, with the retry row when the active
         * profile did not ('partial'). A failed reset that no newer save
         * follows shows the list the core still runs, which also brings back
         * what a save that failed while the reset waited tried to change.
         * @param {boolean|'restart'|'partial'|'unconfirmed'} result
         * @returns {boolean} whether the list was emptied
         */
        resetAfterSave(result) {
            const reset = resetSeqs.shift() ?? { seq: ++saveSeq, profile: listProfile, core: listCore };
            const { seq } = reset;
            if (!result) {
                if (!supersededSince(seq)) {
                    if (pendingTarget !== null && (pendingTarget.profile !== listProfile
                        || pendingTarget.core !== listCore
                        || (coreGeneration && pendingTarget.core !== coreGeneration()))) {
                        profileUnsaved = false;
                        pendingIntent = null;
                        pendingUnconfirmed = false;
                        pendingTarget = null;
                    }
                    currentTunnels = (pendingIntent ?? confirmed).slice();
                    renderTunnels();
                }
                return false;
            }
            // A newer save already took over the list and its flag.
            if (seq < appliedSeq) return false;
            if (result === 'unconfirmed' && readResetBaseline
                && (listProfile !== reset.profile || listCore !== reset.core
                    || (coreGeneration && coreGeneration() !== reset.core))) {
                // No evidence for this target: do not attach its Retry to the
                // previous profile's list or present that list as reset.
                known = false;
                profileUnsaved = false;
                pendingIntent = null;
                pendingUnconfirmed = false;
                pendingTarget = null;
                renderTunnels();
                return false;
            }
            // The core took the empty list; whether the profile did is the
            // flag until a newer save lands. One still to come decides it
            // then: when it fails, the profile still holds the old list.
            appliedSeq = seq;
            profileUnsaved = result === 'partial' || result === 'unconfirmed';
            pendingIntent = profileUnsaved ? [] : null;
            pendingUnconfirmed = result === 'unconfirmed';
            pendingTarget = profileUnsaved ? { profile: reset.profile, core: reset.core } : null;
            renderTunnels();
            if (supersededSince(seq)) return false;
            currentTunnels = [];
            renderTunnels();
            return true;
        },
        /**
         * Where a read of the core's list starts: pass it back to setTunnels.
         * @returns {number}
         */
        readMark() {
            return pending > 0 ? -1 : saveSeq;
        },
        /**
         * Update tunnels from external source and re-render. A read that
         * started while a save was running, or before one started, may hold
         * the list from before that save: it is ignored.
         * @param {Array<object>} tunnels
         * @param {number} [mark] readMark() taken when the read started
         * @param {string|null} [profile] the profile the core ran when the
         *   list was read ('' for the minimal config): saves of this list are
         *   refused once the core runs another one
         * @returns {boolean} whether the list was taken
         */
        setTunnels(tunnels, mark, profile) {
            if (mark !== undefined && (mark !== saveSeq || pending > 0)) return false;
            // The same list read back from the same profile is still the one
            // the profile did not take; another list, or one of another
            // profile (also an identical one), has nothing left to retry.
            // A replaced core supplies a new baseline even for the same profile.
            const sameProfile = profile != null && profile === listProfile;
            const core = coreGeneration ? coreGeneration() : 0;
            const sameTarget = pendingTarget !== null && profile != null && profile === pendingTarget.profile && core === pendingTarget.core;
            const baselineOwnedByTarget = pendingTarget !== null
                && listProfile === pendingTarget.profile && listCore === pendingTarget.core;
            // A read of the pre-save baseline is expected after an unanswered
            // write. A third list may contain someone else's newer changes:
            // show it and retire Retry rather than overwrite it with our intent.
            const matchesPendingOrBaseline = (baselineOwnedByTarget && stableJson(tunnels) === stableJson(confirmed))
                || stableJson(tunnels) === stableJson(pendingIntent);
            const keepPending = sameTarget && pendingUnconfirmed && pendingIntent !== null && matchesPendingOrBaseline;
            if (!keepPending && (!sameProfile || (pendingTarget !== null && !sameTarget) || stableJson(tunnels) !== stableJson(currentTunnels))) {
                profileUnsaved = false;
                pendingIntent = null;
                pendingUnconfirmed = false;
                pendingTarget = null;
            }
            listProfile = profile ?? null;
            listCore = core;
            currentTunnels = keepPending ? (pendingIntent?.slice() ?? tunnels) : tunnels;
            confirmed = tunnels.slice();
            known = true;
            listTaken += 1;
            renderTunnels();
            return true;
        },
    };
}
