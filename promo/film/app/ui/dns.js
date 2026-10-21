// @ts-check
/**
 * DNS rewrite logic - manage DNS configuration and anti-leak/Fake-IP settings.
 * Extracted from ui.js for modularity.
 *
 * All shared DNS logic now lives in dns-shared.js.
 * This module re-exports everything for backward compatibility.
 */

export {
    DEFAULT_DNS_CONFIG,
    isValidIPv6,
    isValidDns,
    getDnsConfig,
    buildDnsRewritePayload,
    applyDnsRewrite,
    initDnsRewriteToggle,
} from './dns-shared.js';
