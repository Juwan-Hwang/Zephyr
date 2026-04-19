// @ts-check
/**
 * Shared DNS logic — single source of truth for DNS configuration,
 * validation, rewrite payload construction, and toggle UI initialization.
 *
 * Consumed by both settings.js and dns.js to eliminate code duplication.
 *
 * @module ui/dns-shared
 */

import { patchConfig, closeAllConnections, getConfig, invoke } from '../api.js';
import { dnsLogger } from '../utils/logger.js';
import { showNotification } from './notifications.js';
import { persistConfigChanges } from './advanced.js';
import { invalidateSettingsCache } from './cache.js';
import { translations, currentLang } from '../i18n.js';
import { COMMANDS } from '@zephyr/shared';

// ---------------------------------------------------------------------------
//  Default DNS configuration
// ---------------------------------------------------------------------------

export const DEFAULT_DNS_CONFIG = {
    nameserver: [
        'https://doh.pub/dns-query',
        'https://dns.alidns.com/dns-query',
    ],
    fallback: [
        'https://dns.cloudflare.com/dns-query',
        'https://dns.google/dns-query',
    ],
};

// ---------------------------------------------------------------------------
//  DNS config helpers
// ---------------------------------------------------------------------------

/**
 * Fetch the current DNS configuration from the backend,
 * falling back to DEFAULT_DNS_CONFIG on failure.
 *
 * @returns {Promise<{ nameserver: string[], fallback: string[] }>}
 */
export async function getDnsConfig() {
    try {
        const settings = await invoke(COMMANDS.GET_SETTINGS);
        return {
            nameserver: settings.dns_nameservers || DEFAULT_DNS_CONFIG.nameserver,
            fallback: settings.dns_fallbacks || DEFAULT_DNS_CONFIG.fallback,
        };
    } catch (e) {
        dnsLogger.warn('Failed to get DNS settings, using defaults', e);
        return DEFAULT_DNS_CONFIG;
    }
}

// ---------------------------------------------------------------------------
//  DNS validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate an IPv6 address string.
 *
 * @param {string} ipv6
 * @returns {boolean}
 */
export function isValidIPv6(ipv6) {
    if (!ipv6.includes(':')) return false;
    if ((ipv6.match(/::/g) || []).length > 1) return false;
    const groups = ipv6.split(':');
    if (groups.length > 8) return false;
    return groups.every(g => g === '' || /^[0-9a-fA-F]{1,4}$/.test(g));
}

/**
 * Validate a DNS server address.
 * Supports DoH (https://), DoT (tls://), IPv4, and IPv6 formats.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isValidDns(url) {
    // DoH (DNS over HTTPS)
    if (url.startsWith('https://')) {
        try {
            const parsed = new URL(url);
            return parsed.hostname.length > 0;
        } catch {
            return false;
        }
    }

    // DoT (DNS over TLS)
    if (url.startsWith('tls://')) {
        const host = url.slice(6);
        if (!host || host.includes(' ')) return false;

        const ipv6WithPortMatch = host.match(/^\[([0-9a-fA-F:]+)\]:(\d+)$/);
        if (ipv6WithPortMatch) {
            const port = parseInt(ipv6WithPortMatch[2], 10);
            return isValidIPv6(ipv6WithPortMatch[1]) && port > 0 && port <= 65535;
        }

        const ipv6BareMatch = host.match(/^\[([0-9a-fA-F:]+)\]$/);
        if (ipv6BareMatch) {
            return isValidIPv6(ipv6BareMatch[1]);
        }

        const portMatch = host.match(/^([^:]+):(\d+)$/);
        if (portMatch) {
            const port = parseInt(portMatch[2], 10);
            return port > 0 && port <= 65535;
        }

        return host.length > 0;
    }

    // IPv4 with optional port
    const ipv4Match = url.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::(\d+))?$/);
    if (ipv4Match) {
        const octets = [ipv4Match[1], ipv4Match[2], ipv4Match[3], ipv4Match[4]];
        const validOctets = octets.every(octet => {
            const num = parseInt(octet, 10);
            return num >= 0 && num <= 255;
        });
        const port = ipv4Match[5];
        const validPort = !port || (parseInt(port, 10) > 0 && parseInt(port, 10) <= 65535);
        return validOctets && validPort;
    }

    // IPv6 with optional port
    const ipv6Match = url.match(/^\[([0-9a-fA-F:]+)\](?::(\d+))?$/);
    if (ipv6Match) {
        const ipv6 = ipv6Match[1];
        const port = ipv6Match[2];
        const validPort = !port || (parseInt(port, 10) > 0 && parseInt(port, 10) <= 65535);
        return isValidIPv6(ipv6) && validPort;
    }

    return false;
}

// ---------------------------------------------------------------------------
//  DNS rewrite payload & apply
// ---------------------------------------------------------------------------

/**
 * Build the DNS rewrite configuration payload.
 *
 * @returns {Promise<Object>}
 */
export async function buildDnsRewritePayload() {
    const dnsConfig = await getDnsConfig();
    return {
        sniffing: true,
        dns: {
            enable: true,
            listen: '0.0.0.0:1053',
            ipv6: false,
            'enhanced-mode': 'fake-ip',
            'fake-ip-range': '198.18.0.1/16',
            'fake-ip-filter': ['*.lan', 'localhost.ptlogin2.qq.com'],
            nameserver: dnsConfig.nameserver,
            fallback: dnsConfig.fallback,
        },
    };
}

/**
 * Apply the DNS rewrite payload to the core and persist changes.
 *
 * @returns {Promise<boolean>}
 */
export async function applyDnsRewrite() {
    try {
        const dnsRewritePayload = await buildDnsRewritePayload();
        await patchConfig(dnsRewritePayload);
        await persistConfigChanges(dnsRewritePayload);
        return true;
    } catch (err) {
        dnsLogger.error('Failed to apply DNS rewrite', err);
        throw err;
    }
}

// ---------------------------------------------------------------------------
//  DNS Rewrite Toggle UI
// ---------------------------------------------------------------------------

/**
 * Initialize the DNS Rewrite toggle, config modal, and save logic.
 */
export async function initDnsRewriteToggle() {
    const toggle = /** @type {HTMLInputElement|null} */ (document.getElementById('dns-rewrite-toggle'));
    const configBtn = document.getElementById('dns-config-btn');
    const modal = document.getElementById('dns-config-modal');
    const cancelBtn = document.getElementById('dns-config-cancel');
    const saveBtn = document.getElementById('dns-config-save');
    const nameserversInput = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('dns-nameservers-input'));
    const fallbacksInput = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('dns-fallbacks-input'));

    if (!toggle) return;

    try {
        /** @type {{dns?: {enable?: boolean}}} */
        const config = await getConfig();
        const isEnabled = config?.dns?.enable === true;
        toggle.checked = isEnabled;
    } catch (e) {
        const savedState = localStorage.getItem('dnsRewrite');
        toggle.checked = savedState === null ? true : savedState === 'true';
    }

    // Load saved DNS config into inputs
    async function loadDnsConfig() {
        const config = await getDnsConfig();
        if (nameserversInput) nameserversInput.value = config.nameserver.join('\n');
        if (fallbacksInput) fallbacksInput.value = config.fallback.join('\n');
    }

    // Open config modal
    if (configBtn) {
        configBtn.addEventListener('click', async () => {
            await loadDnsConfig();
            if (modal) {
                modal.classList.remove('hidden');
                modal.classList.add('flex');
            }
        });
    }

    // Close modal
    function closeModal() {
        if (!modal) return;
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }

    if (cancelBtn) {
        cancelBtn.addEventListener('click', closeModal);
    }

    // Click outside to close
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeModal();
            }
        });
    }

    // Save DNS config
    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            const nameservers = (nameserversInput?.value || '').split('\n').map(/** @param {string} s */ s => s.trim()).filter(/** @param {string} s */ s => s);
            const fallbacks = (fallbacksInput?.value || '').split('\n').map(/** @param {string} s */ s => s.trim()).filter(/** @param {string} s */ s => s);

            if (nameservers.length === 0) {
                showNotification('At least one nameserver is required', 'error');
                return;
            }

            const invalidNameservers = nameservers.filter(/** @param {string} s */ s => !isValidDns(s));
            const invalidFallbacks = fallbacks.filter(/** @param {string} s */ s => !isValidDns(s));

            if (invalidNameservers.length > 0 || invalidFallbacks.length > 0) {
                /** @type {Record<string, string>} */
                const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);
                showNotification(t.invalidDnsFormat || 'Invalid DNS server format. Use https://, tls://, or IP address', 'error');
                return;
            }

            try {
                const settings = await invoke(COMMANDS.GET_SETTINGS);
                settings.dns_nameservers = nameservers;
                settings.dns_fallbacks = fallbacks.length > 0 ? fallbacks : null;
                await invoke(COMMANDS.SAVE_SETTINGS, { settings });
                invalidateSettingsCache();

                closeModal();
                showNotification('DNS configuration saved', 'success');

                if (toggle.checked) {
                    await applyDnsRewrite();
                    await closeAllConnections();
                }
            } catch (err) {
                dnsLogger.error('Failed to save DNS config', err);
                showNotification('Failed to save DNS configuration', 'error');
            }
        });
    }

    toggle.addEventListener('change', async (e) => {
        const target = /** @type {HTMLInputElement} */ (e.target);
        const enabled = target.checked;
        /** @type {Record<string, string>} */
        const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);

        if (enabled) {
            try {
                await applyDnsRewrite();
                await closeAllConnections();
                localStorage.setItem('dnsRewrite', 'true');
                showNotification(t.notifDnsEnabled, 'success');
            } catch (err) {
                showNotification(t.dnsEnableFailed || 'Failed to enable DNS Rewrite', 'error');
                toggle.checked = false;
            }
        } else {
            try {
                const payload = { dns: { enable: false }, sniffing: false };
                await patchConfig(payload);
                await persistConfigChanges(payload);
                await closeAllConnections();
                localStorage.setItem('dnsRewrite', 'false');
                showNotification(t.notifDnsDisabled, 'info');
            } catch (err) {
                dnsLogger.error('Failed to disable DNS rewrite', err);
                showNotification(t.dnsDisableFailed || 'Failed to disable DNS Rewrite', 'error');
                toggle.checked = true;
            }
        }
    });
}
