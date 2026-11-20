// ═══════════════════════════════════════════════════════════════════════════════
//  Type Guards — Runtime type narrowing utilities
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a value is a non-null object.
 */
export declare function isObject(value: unknown): value is Record<string, unknown>;

/**
 * Check if a value is a string.
 */
export declare function isString(value: unknown): value is string;

/**
 * Check if a value is a number (excluding NaN).
 */
export declare function isNumber(value: unknown): value is number;

/**
 * Narrow `unknown` (from catch) to `Error`.
 * Handles both native Error and string/number primitives.
 */
export declare function toError(err: unknown): Error;

/**
 * Assert that a value is truthy, throwing if not.
 * Useful for nullable DOM queries.
 */
export declare function assertDefined<T>(value: T | null | undefined, message?: string): T;
