// @ts-check
// ═══════════════════════════════════════════════════════════════════════════════
//  Type Guards — Runtime type narrowing utilities
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a value is a non-null object.
 * @param {*} value
 * @returns {value is Record<string, unknown>}
 */
export function isObject(value) {
    return value !== null && typeof value === 'object';
}

/**
 * Check if a value is a string.
 * @param {*} value
 * @returns {value is string}
 */
export function isString(value) {
    return typeof value === 'string';
}

/**
 * Check if a value is a finite number (excluding NaN/Infinity).
 * @param {*} value
 * @returns {value is number}
 */
export function isNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Narrow `unknown` (from catch blocks) to `Error`.
 * Handles native Error, strings, numbers, and objects with message property.
 * @param {unknown} err
 * @returns {Error}
 */
export function toError(err) {
    if (err instanceof Error) return err;
    if (typeof err === 'string') return new Error(err);
    if (typeof err === 'number') return new Error(`Error code: ${err}`);
    if (isObject(err) && typeof err.message === 'string') {
        return new Error(err.message);
    }
    return new Error(String(err));
}

/**
 * Assert that a value is defined (non-null, non-undefined).
 * Throws an Error with the provided message if not.
 * @template T
 * @param {T | null | undefined} value
 * @param {string} [message]
 * @returns {T}
 * @throws {Error}
 */
export function assertDefined(value, message) {
    if (value == null) {
        throw new Error(message || 'Expected value to be defined, but received null/undefined');
    }
    return value;
}
