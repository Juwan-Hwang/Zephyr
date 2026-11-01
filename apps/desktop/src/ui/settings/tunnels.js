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
import { showModal, showNotification } from '../notifications.js';
import { SVG_ICONS } from '../icons.js';
import { pasteWithFeedback, renderPasteButtonHtml } from '../../utils/clipboard.js';
import { translations } from '../../i18n.js';
import { escapeHtml } from '../../utils/sanitize.js';

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
 * @param {(patch: Record<string, any>) => Promise<boolean|'restart'|'partial'>} opts.saveConfigToCore - Callback to save config patch to core.
 */
export function initTunnelSettings({
    addTunnelBtn,
    tunnelsList,
    tunnelsEmpty,
    initialTunnels,
    initialKnown = true,
    saveConfigToCore,
}) {
    /** @type {any[]} */
    let currentTunnels = initialTunnels;
    /**
     * The list the core runs as far as this page knows: the one read from
     * it, or the last one a save sent that it took. A save that fails when
     * no newer one was started puts this list back, so a tunnel whose
     * removal never reached the core shows again.
     * @type {any[]}
     */
    let confirmed = initialTunnels.slice();
    /**
     * Whether the core's list was read at all: saving a list built on top of
     * an unread one would drop the tunnels the core runs.
     */
    let known = initialKnown;
    /**
     * The core runs the list shown, but the active profile did not take it
     * (a 'partial' save): it is lost when that profile is loaded again.
     */
    let profileUnsaved = false;
    /** Saves started so far, numbered in start order. */
    let saveSeq = 0;
    /** The newest save the core took: a newer one that failed does not overrule it. */
    let appliedSeq = 0;
    /** The number saveAfterPending gave the reset's save, until resetAfterSave. */
    let resetSeq = 0;
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
     * @returns {Promise<T>}
     */
    function enqueue(task) {
        pending += 1;
        const run = queue.then(task).finally(() => { pending -= 1; });
        queue = run.catch(() => {});
        return run;
    }

    /**
     * Whether a save or reset started after the save numbered `seq`.
     * @param {number} seq
     */
    const supersededSince = (seq) => saveSeq !== seq;

    /**
     * Save the list as it is now. A partial save keeps the list (the core
     * already runs it) but marks it unsaved, so the list offers a retry. A
     * newer save that failed took nothing, so it does not hide an older
     * partial save.
     * @returns {Promise<boolean|'restart'|'partial'>}
     */
    async function saveTunnels() {
        const seq = ++saveSeq;
        const list = currentTunnels.slice();
        const ok = await enqueue(async () => {
            const result = await saveConfigToCore({ tunnels: list });
            // Saves run in start order: the latest one the core took sets the list it runs.
            if (result) confirmed = list;
            return result;
        });
        if (ok && seq > appliedSeq) {
            appliedSeq = seq;
            profileUnsaved = ok === 'partial';
        }
        if (!ok && !supersededSince(seq)) {
            // The newest save failed: show what the core runs, which also
            // brings back what an earlier failed save tried to change.
            currentTunnels = confirmed.slice();
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
        retryBtn.onclick = async () => {
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
            delBtn.setAttribute('aria-label', `${(/** @type {any} */ (translations)[appStore.get('currentLang')] || {}).delete || 'Delete'} ${tunnel.address}`);
            // eslint-disable-next-line no-unsanitized/property -- static SVG constant
            delBtn.innerHTML = SVG_ICONS.trash; // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
            delBtn.onclick = async () => {
                // Found by the tunnel itself: an earlier delete may have
                // moved it since this row was drawn.
                const at = currentTunnels.indexOf(tunnel);
                if (at < 0) return;
                currentTunnels.splice(at, 1);
                renderTunnels();
                // A failed save that was the newest puts back the list the
                // core runs; a later save decides otherwise.
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
        if (!known) {
            showNotification(t.tunnelsNotLoaded || 'The port forwarding list could not be read from the core. Reopen Settings to try again.', 'error');
            return;
        }
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

    return {
        renderTunnels,
        /** Reset tunnels to empty and re-render */
        resetTunnels() {
            currentTunnels = [];
            profileUnsaved = false;
            appliedSeq = ++saveSeq; // a save still in flight no longer sets the flag
            renderTunnels();
        },
        /**
         * Run the reset's own save after the tunnel saves already started,
         * with saves started meanwhile waiting until it is done: an older
         * list can neither land after the empty one nor change its flag.
         * @template T
         * @param {() => Promise<T>} save
         * @returns {Promise<T>}
         */
        saveAfterPending(save) {
            resetSeq = ++saveSeq;
            return enqueue(async () => {
                const result = await save();
                // The reset sends an empty list: the core runs none now.
                if (result) confirmed = [];
                return result;
            });
        },
        /**
         * After restoring the defaults sent an empty list: empty the list
         * only when the core took it (a failed save leaves the list the core
         * still runs), with the retry row when the active profile did not
         * ('partial').
         * @param {boolean|'restart'|'partial'} result
         * @returns {boolean} whether the list was emptied
         */
        resetAfterSave(result) {
            const seq = resetSeq || ++saveSeq;
            resetSeq = 0;
            if (!result) return false;
            // Older saves finished before the reset's own; a save started
            // after it is still to come and decides the list and its flag.
            if (seq < appliedSeq || supersededSince(seq)) return false;
            appliedSeq = seq;
            currentTunnels = [];
            profileUnsaved = result === 'partial';
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
         * @returns {boolean} whether the list was taken
         */
        setTunnels(tunnels, mark) {
            if (mark !== undefined && (mark !== saveSeq || pending > 0)) return false;
            // The same list read back from the core is still the one the
            // profile did not take; a different one (another profile now
            // runs) has nothing left to retry.
            if (JSON.stringify(tunnels) !== JSON.stringify(currentTunnels)) profileUnsaved = false;
            currentTunnels = tunnels;
            confirmed = tunnels.slice();
            known = true;
            renderTunnels();
            return true;
        },
    };
}
