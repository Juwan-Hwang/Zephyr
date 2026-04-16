// @ts-check
/**
 * Cached Intl constructor instances.
 *
 * Intl constructors (DateTimeFormat, NumberFormat, etc.) are expensive
 * (~0.05-0.1ms each). This module caches instances globally so repeated
 * calls with the same locale + options reuse the same object.
 *
 * @module intl-cache
 */

/** @type {Map<string, Intl.DateTimeFormat>} */
const _dateTimeFormatCache = new Map();

/**
 * Build a cache key from locale and options.
 * @param {string} locale
 * @param {Intl.DateTimeFormatOptions} options
 * @returns {string}
 */
function _dtfKey(locale, options) {
    return `${locale}|${JSON.stringify(options)}`;
}

/**
 * Get a cached Intl.DateTimeFormat instance.
 *
 * @param {string} [locale=navigator.language]
 * @param {Intl.DateTimeFormatOptions} [options]
 * @returns {Intl.DateTimeFormat}
 */
export function getDateTimeFormat(locale, options) {
    locale = locale || (typeof navigator !== 'undefined' ? navigator.language : 'en');
    options = options || {};
    const key = _dtfKey(locale, options);
    let fmt = _dateTimeFormatCache.get(key);
    if (!fmt) {
        fmt = new Intl.DateTimeFormat(locale, options);
        _dateTimeFormatCache.set(key, fmt);
    }
    return fmt;
}
