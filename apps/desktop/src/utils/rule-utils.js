// @ts-check
/**
 * Shared rule-related utility functions.
 *
 * @module utils/rule-utils
 */

/**
 * Get Tailwind color class for a rule policy.
 * @param {string} policy
 * @returns {string}
 */
export function getPolicyColor(policy) {
    const p = (policy || '').toUpperCase();
    if (p === 'DIRECT') return 'text-green-400';
    if (p === 'REJECT') return 'text-rose-500';
    return 'text-accent';
}
