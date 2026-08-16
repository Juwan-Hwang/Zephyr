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
import { pasteToElement } from '../../utils/clipboard.js';
import { translations } from '../../i18n.js';
import { escapeAttr } from '../../utils/sanitize.js';

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
 * @param {(patch: Record<string, any>) => Promise<boolean>} opts.saveConfigToCore - Callback to save config patch to core.
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

        currentTunnels.forEach((tunnel, index) => {
            const item = document.createElement('div');
            item.className = 'flex items-center justify-between bg-[var(--zephyr-bg-input)] border border-[var(--zephyr-border-subtle)] rounded-lg p-3 hover:border-[var(--zephyr-border-strong)] transition-[border-color]';

            const info = document.createElement('div');
            info.className = 'flex flex-col gap-1';

            const topRow = document.createElement('div');
            topRow.className = 'flex items-center gap-2';

            const protocolBadge = document.createElement('span');
            protocolBadge.className = 'type-badge text-[var(--text-secondary)]';
            protocolBadge.textContent = tunnel.network.join(', ');

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
            // eslint-disable-next-line no-unsanitized/property -- static SVG constant
            delBtn.innerHTML = SVG_ICONS.trash; // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
            delBtn.onclick = async () => {
                const deleted = currentTunnels[index];
                currentTunnels.splice(index, 1);
                const ok = await saveConfigToCore({ tunnels: currentTunnels });
                if (!ok) { currentTunnels.splice(index, 0, deleted); return; }
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
        const confirmText = t.confirm || 'Confirm';
        const customHtml = `
            <div class="space-y-4">
                <div>
                    <label class="block text-2xs text-[var(--text-muted)] uppercase tracking-wider mb-1.5">${t.tunnelProtocol || 'Protocol'}</label>
                    <input type="text" id="tunnel-protocol-input" placeholder="tcp, udp, or tcp,udp" value="tcp,udp" class="form-control form-control-md form-control-mono">
                </div>
                <div>
                    <label class="block text-2xs text-[var(--text-muted)] uppercase tracking-wider mb-1.5">${t.tunnelNetwork || 'Listen Network'}</label>
                    <div class="input-paste-wrapper">
                        <input type="text" id="tunnel-address-input" placeholder="e.g., 127.0.0.1:6553" class="form-control form-control-md form-control-mono">
                        <button type="button" id="tunnel-address-paste-btn" class="btn-input-paste" title="${escapeAttr(t.paste || 'Paste')}" aria-label="${escapeAttr(t.paste || 'Paste')}" data-i18n-title="paste" data-i18n-aria-label="paste">${SVG_ICONS.clipboard}</button>
                    </div>
                </div>
                <div>
                    <label class="block text-2xs text-[var(--text-muted)] uppercase tracking-wider mb-1.5">${t.tunnelTarget || 'Target Address'}</label>
                    <div class="input-paste-wrapper">
                        <input type="text" id="tunnel-target-input" placeholder="e.g., 8.8.8.8:53" class="form-control form-control-md form-control-mono">
                        <button type="button" id="tunnel-target-paste-btn" class="btn-input-paste" title="${escapeAttr(t.paste || 'Paste')}" aria-label="${escapeAttr(t.paste || 'Paste')}" data-i18n-title="paste" data-i18n-aria-label="paste">${SVG_ICONS.clipboard}</button>
                    </div>
                </div>
                <div class="flex gap-3 justify-end pt-2">
                    <button id="tunnel-cancel-btn" class="btn-ghost">${cancelText}</button>
                    <button id="tunnel-confirm-btn" class="btn-primary">${confirmText}</button>
                </div>
            </div>
        `;

        const _contentArea = /** @type {HTMLElement} */ (await showModal(
            t.addPortForwarding || "Add Port Forwarding",
            "", "", true, customHtml,
            (contentArea, closeModal) => {
                const protocolInput = /** @type {HTMLInputElement} */ (contentArea.querySelector('#tunnel-protocol-input'));
                const addressInput = /** @type {HTMLInputElement} */ (contentArea.querySelector('#tunnel-address-input'));
                const targetInput = /** @type {HTMLInputElement} */ (contentArea.querySelector('#tunnel-target-input'));
                const cancelBtn = contentArea.querySelector('#tunnel-cancel-btn');
                const confirmBtn = /** @type {HTMLButtonElement} */ (contentArea.querySelector('#tunnel-confirm-btn'));

                contentArea.querySelector('#tunnel-address-paste-btn')?.addEventListener('click', (e) => {
                    e.preventDefault();
                    if (addressInput) pasteToElement(addressInput);
                });
                contentArea.querySelector('#tunnel-target-paste-btn')?.addEventListener('click', (e) => {
                    e.preventDefault();
                    if (targetInput) pasteToElement(targetInput);
                });

                cancelBtn?.addEventListener('click', () => closeModal(null));

                confirmBtn?.addEventListener('click', async () => {
                    if (confirmBtn.disabled) return;
                    confirmBtn.disabled = true;

                    const protocolStr = protocolInput?.value?.trim() || '';
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
