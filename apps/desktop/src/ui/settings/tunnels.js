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
 * @param {(patch: Record<string, any>) => Promise<boolean|'restart'>} opts.saveConfigToCore - Callback to save config patch to core.
 */
export function initTunnelSettings({
    addTunnelBtn,
    tunnelsList,
    tunnelsEmpty,
    initialTunnels,
    saveConfigToCore,
}) {
    /** @type {any[]} */
    let currentTunnels = initialTunnels;

    function renderTunnels() {
        if (!tunnelsList) return;

        if (!currentTunnels || currentTunnels.length === 0) {
            tunnelsList.replaceChildren();
            if (tunnelsEmpty) tunnelsList.appendChild(tunnelsEmpty);
            if (tunnelsEmpty) tunnelsEmpty.style.display = 'block';
            return;
        }

        if (tunnelsEmpty) tunnelsEmpty.style.display = 'none';
        tunnelsList.replaceChildren();

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
                const confirmed = await showConfirmModal(
                    `${t.delete || 'Delete'} ${tunnel.address}?`,
                    tunnel.target ? `${tunnel.address} → ${tunnel.target}` : tunnel.address,
                    { danger: true, confirmText: t.delete || 'Delete' }
                );
                if (!confirmed) return;
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
                const deleted = currentTunnels[currentIndex];
                // Remember which list this deletion came from:
                // setTunnels/resetTunnels replace the array wholesale,
                // so a restore after a failed save must only touch
                // this list. And remember the neighbours: another
                // deletion can shift this same array while the save is
                // in flight, so the captured index may no longer be the
                // deleted row's place — the restore goes back before the
                // next row (or after the previous one) to keep the order.
                const listAtDelete = currentTunnels;
                const nextTunnel = currentTunnels[currentIndex + 1] ?? null;
                const prevTunnel = currentTunnels[currentIndex - 1] ?? null;
                currentTunnels.splice(currentIndex, 1);
                const ok = await saveConfigToCore({ tunnels: currentTunnels });
                if (!ok) {
                    // Only restore into the list this deletion came from:
                    // if the array was replaced while the save was in
                    // flight, that list is authoritative — splicing the
                    // deleted tunnel back into it at the old index would
                    // corrupt it.
                    if (currentTunnels === listAtDelete) {
                        const nextIndex = nextTunnel ? currentTunnels.indexOf(nextTunnel) : -1;
                        if (nextIndex !== -1) currentTunnels.splice(nextIndex, 0, deleted);
                        else {
                            const prevIndex = prevTunnel ? currentTunnels.indexOf(prevTunnel) : -1;
                            if (prevIndex !== -1) currentTunnels.splice(prevIndex + 1, 0, deleted);
                            else currentTunnels.splice(Math.min(currentIndex, currentTunnels.length), 0, deleted);
                        }
                    }
                    // The list changed under the save: re-render, or a
                    // language apply that ran while the save was pending
                    // leaves the restored row missing onscreen.
                    renderTunnels();
                    return;
                }
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
                        const ok = await saveConfigToCore({ tunnels: currentTunnels });
                        if (!ok) { currentTunnels.pop(); confirmBtn.disabled = false; return; }
                        closeModal(null);
                        renderTunnels();
                    } catch (_err) {
                        currentTunnels.pop();
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
            renderTunnels();
        },
        /** Update tunnels from external source and re-render */
        setTunnels(/** @type {Array<object>} */ tunnels) {
            currentTunnels = tunnels;
            renderTunnels();
        },
    };
}
