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
import { invalidateSettingsCache } from './cache.js';
import { translations, currentLang } from '../i18n.js';
import { COMMANDS } from '@zephyr/shared';
import { createFocusTrap } from '../utils/focus-trap.js';
import { Bus, Events } from './events.js';
import { getSetting, saveSetting } from './settings-helpers.js';
import { pasteToElement } from '../utils/clipboard.js';

// ---------------------------------------------------------------------------
//  DNS bootstrap constants
// ---------------------------------------------------------------------------
//
//  These IP addresses MUST be raw IPs (not hostnames).  mihomo uses them as
//  "default-nameserver" to resolve DoH/DoT server domains (e.g. dns.google).
//  Using a hostname here would create a circular dependency: you need DNS to
//  reach the DoH server, but you need the DoH server to resolve its own name.
//
//  All four are well-known public DNS resolvers with decades of stable service.

/** @type {readonly string[]} */
const BOOTSTRAP_DNS_SERVERS = Object.freeze([
    '223.5.5.5',    // NOSONAR — AliDNS (Alibaba), bootstrap resolver must be raw IP
    '119.29.29.29', // NOSONAR — DNSPod (Tencent), bootstrap resolver must be raw IP
    '1.1.1.1',      // NOSONAR — Cloudflare DNS, bootstrap resolver must be raw IP
    '8.8.8.8',      // NOSONAR — Google Public DNS, bootstrap resolver must be raw IP
]);

/**
 * RFC 2544 benchmarking range subnet (198.18.0.0/16) — non-routable on the
 * public internet.  mihomo uses it for fake-ip mode: real queries get
 * synthetic IPs from this range, which are intercepted and resolved
 * internally.
 */
const FAKE_IP_RANGE = '198.18.0.0/16'; // NOSONAR — RFC 2544 benchmark range, non-routable


// ---------------------------------------------------------------------------
//  Helper: DNS rewrite enabled state (default true for new users)
// ---------------------------------------------------------------------------

/**
 * Check if DNS rewrite is saved as enabled in settings.json.
 * Default to true for new users (security feature).
 * @returns {Promise<boolean>}
 */
async function isDnsRewriteSavedEnabled() {
    const saved = await getSetting('dns_rewrite_enabled', null);
    if (saved !== null) {
        return saved;
    }
    // Migrate from legacy localStorage.dnsRewrite
    const legacy = localStorage.getItem('dnsRewrite');
    if (legacy !== null) {
        const enabled = legacy === 'true';
        saveSetting('dns_rewrite_enabled', enabled).catch(() => {});
        localStorage.removeItem('dnsRewrite');
        return enabled;
    }
    return true; // Default
}

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
            'fake-ip-range': FAKE_IP_RANGE,
            // Domains that must resolve to real IPs (not fake-ip).
            // These are services that break or behave incorrectly with fake IPs,
            // such as captive portals, game consoles, and LAN discovery.
            'fake-ip-filter': [
                '*.lan',
                '*.local',
                '*.localhost',
                '*.localdomain',
                'localhost.ptlogin2.qq.com',
                '*.msftncsi.com',
                '*.srv.nintendo.net',
                '*.stun.playstation.net',
                'xbox.*.microsoft.com',
                '*.xboxlive.com',
                '*.stun.steamwire.com',
                'stun.*',
            ],
            // Base DNS servers used to resolve DoH/DoT hostnames themselves.
            // Without this, mihomo cannot resolve the DoH server domain (e.g. dns.google)
            // because it needs DNS to reach the DoH server — a circular dependency.
            'default-nameserver': [...BOOTSTRAP_DNS_SERVERS],
            nameserver: dnsConfig.nameserver,
            fallback: dnsConfig.fallback,
        },
    };
}

/**
 * Apply the DNS rewrite payload to the core via API only.
 * Does NOT persist to the original profile file — DNS rewrite is a runtime
 * overlay that must not corrupt subscription-specific DNS configurations.
 *
 * @returns {Promise<boolean>}
 */
export async function applyDnsRewrite() {
    try {
        const dnsRewritePayload = await buildDnsRewritePayload();
        await patchConfig(dnsRewritePayload);
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
        const savedEnabled = await isDnsRewriteSavedEnabled();

        // If user previously enabled DNS rewrite but core restarted without it,
        // re-apply automatically.
        if (savedEnabled && !isEnabled) {
            try {
                await applyDnsRewrite();
                toggle.checked = true;
                // Persist the decision so CORE_RESTARTED handler won't hit null
                await saveSetting('dns_rewrite_enabled', true);
            } catch {
                // Core may not be ready yet; sync toggle with runtime state
                toggle.checked = false;
            }
        } else {
            toggle.checked = isEnabled;
        }
    } catch {
        toggle.checked = false;
        toggle.disabled = true;
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
                // Animate in
                requestAnimationFrame(() => {
                    const inner = modal.querySelector('.glass-card');
                    if (inner instanceof HTMLElement) {
                        inner.style.transform = 'scale(0.96)';
                        inner.style.opacity = '0';
                        requestAnimationFrame(() => {
                            inner.style.transition = 'all 0.25s cubic-bezier(0.16, 1, 0.3, 1)';
                            inner.style.transform = 'scale(1)';
                            inner.style.opacity = '1';
                        });
                    }
                });
                createFocusTrap(modal, { onEscape: closeModal });
            }
        });
    }

    // Close modal
    function closeModal() {
        if (!modal) return;
        const inner = modal.querySelector('.glass-card');
        if (inner instanceof HTMLElement) {
            inner.style.transition = 'all 0.15s ease-in';
            inner.style.transform = 'scale(0.96)';
            inner.style.opacity = '0';
            setTimeout(() => {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }, 150);
        } else {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }
    }

    if (cancelBtn) {
        cancelBtn.addEventListener('click', closeModal);
    }

document.getElementById('dns-nameservers-paste-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (nameserversInput) pasteToElement(nameserversInput, true, () => showNotification(translations[currentLang]?.pasteFailed || translations.en.pasteFailed, 'warning'));
});

document.getElementById('dns-fallbacks-paste-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (fallbacksInput) pasteToElement(fallbacksInput, true, () => showNotification(translations[currentLang]?.pasteFailed || translations.en.pasteFailed, 'warning'));
});

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
                await saveSetting('dns_rewrite_enabled', true);
                showNotification(t.notifDnsEnabled, 'success');
            } catch {
                showNotification(t.dnsEnableFailed || 'Failed to enable DNS Rewrite', 'error');
                toggle.checked = false;
            }
        } else {
            try {
                const payload = { dns: { enable: false }, sniffing: false };
                await patchConfig(payload);
                await closeAllConnections();
                await saveSetting('dns_rewrite_enabled', false);
                showNotification(t.notifDnsDisabled, 'info');
            } catch (err) {
                dnsLogger.error('Failed to disable DNS rewrite', err);
                showNotification(t.dnsDisableFailed || 'Failed to disable DNS Rewrite', 'error');
                toggle.checked = true;
            }
        }
    });

    // Re-apply DNS rewrite after core restart (e.g. config switch, TUN toggle)
    Bus.on(Events.CORE_RESTARTED, async () => {
        if (!(await isDnsRewriteSavedEnabled())) return;

        for (let i = 0; i < 5; i++) {
            try {
                await applyDnsRewrite();
                if (toggle) toggle.checked = true;
                // Persist the decision so future checks won't hit null
                await saveSetting('dns_rewrite_enabled', true);
                return;
            } catch {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        if (toggle) toggle.checked = false;
    });
}
