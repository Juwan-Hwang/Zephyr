// @ts-check
/**
 * Map the User-Agent string the backend last accepted back to the
 * fake-client triple the settings UI edits.
 *
 * The backend stores a single UA string (`subscription_user_agent`), while
 * the UI edits a triple (enabled / preset-or-custom / custom text). When a
 * sync is rejected before any sync has succeeded this session there is no
 * in-memory snapshot to roll back to, so the accepted value is read back
 * from the backend and converted here: a preset UA maps back to its preset,
 * anything else is a custom text value. A null/empty backend value means
 * the backend holds nothing, and there is nothing to restore.
 *
 * @module ui/settings/ua-triple
 */

/**
 * @param {unknown} backendUA
 * @returns {{ enabled: string, type: string, custom: string|null }|null}
 */
export function uaTripleFromBackendUA(backendUA) {
    if (typeof backendUA !== 'string' || !backendUA.trim()) return null;
    const trimmed = backendUA.trim();
    const isPreset = /^(clash-verge|mihomo-party|Flclash)\//.test(trimmed);
    return {
        enabled: 'true',
        type: isPreset ? trimmed : 'custom',
        custom: isPreset ? null : trimmed,
    };
}
