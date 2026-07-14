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
    if (p === 'DIRECT') return 'text-success';
    if (p === 'REJECT') return 'text-danger';
    return 'text-accent';
}
