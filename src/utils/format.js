// @ts-check
/**
 * Unified formatting utilities for file-size, date, speed, and numbers.
 *
 * @module format
 */

import { getDateTimeFormat } from './intl-cache.js';

/**
 * Get a Tailwind CSS text-color class based on latency value.
 *
 * @param {number|null} delay - Latency in ms, or null/0/999999+ for unknown
 * @returns {string} Tailwind text color class name
 *
 * @example
 * getDelayColorClass(120);  // 'text-emerald-400'
 * getDelayColorClass(350);  // 'text-amber-400'
 * getDelayColorClass(800);  // 'text-rose-400'
 * getDelayColorClass(null); // 'text-zinc-600'
 */
export function getDelayColorClass(delay) {
    if (delay === null || delay === 0 || delay >= 999999) return 'text-zinc-600';
    if (delay < 200) return 'text-emerald-400';
    if (delay < 500) return 'text-amber-400';
    return 'text-rose-400';
}

/**
 * Format file size for subscription usage display (binary, base-1024).
 *
 * @param {number} bytes - Number of bytes
 * @returns {string} Formatted file size, e.g. "1.46 GB"
 *
 * @example
 * formatFileSize(1565873490); // "1.46 GB"
 * formatFileSize(0);          // "0 B"
 */
export function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';

    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ── Network-traffic helpers (decimal, base-1000) ──────────────────────

const _NET_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/**
 * Format a byte count using decimal (base-1000) units.
 *
 * Unlike {@link formatFileSize} which uses binary (base-1024) units,
 * this follows the SI / network-traffic convention where 1 KB = 1000 B.
 *
 * @param {number} bytes - Number of bytes
 * @returns {string} Formatted value, e.g. "1.02 KB"
 *
 * @example
 * formatBytes(0);       // "0 B"
 * formatBytes(1024);    // "1.02 KB"
 * formatBytes(1048576); // "1.00 MB"
 */
export function formatBytes(bytes) {
    if (bytes === 0) return '0 B';

    const i = Math.min(
        Math.floor(Math.log(bytes) / Math.log(1000)),
        _NET_UNITS.length - 1,
    );

    return parseFloat((bytes / Math.pow(1000, i)).toFixed(2)) + ' ' + _NET_UNITS[i];
}

/**
 * Format a transfer speed in bytes-per-second.
 *
 * @param {number} bytesPerSecond - Speed in bytes/s
 * @returns {string} Formatted speed, e.g. "1.02 KB/s"
 *
 * @example
 * formatSpeed(0);    // "0 B/s"
 * formatSpeed(1024); // "1.02 KB/s"
 */
export function formatSpeed(bytesPerSecond) {
    return formatBytes(bytesPerSecond) + '/s';
}

// ── Time helpers ───────────────────────────────────────────────────────

const _MS_PER_MINUTE = 60_000;
const _MS_PER_HOUR   = 3_600_000;
const _MS_PER_DAY    = 86_400_000;

/**
 * Format a time interval in milliseconds to a compact human-readable string.
 *
 * Components are included only when non-zero, except that the smallest
 * displayed unit is always shown (even if zero) to indicate precision.
 *
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Formatted duration, e.g. "1h 1m 5s"
 *
 * @example
 * formatDuration(0);        // "0s"
 * formatDuration(65000);    // "1m 5s"
 * formatDuration(3665000);  // "1h 1m 5s"
 * formatDuration(86400000); // "1d 0h 0m"
 */
export function formatDuration(ms) {
    const days    = Math.floor(ms / _MS_PER_DAY);
    const hours   = Math.floor((ms % _MS_PER_DAY) / _MS_PER_HOUR);
    const minutes = Math.floor((ms % _MS_PER_HOUR) / _MS_PER_MINUTE);

    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}s`;
}

// ── Date helpers ───────────────────────────────────────────────────────

/** @type {Intl.DateTimeFormatOptions} */
const _DEFAULT_DATE_OPTIONS = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
};

/**
 * Format a timestamp into a locale-aware date/time string.
 *
 * Uses a cached {@link Intl.DateTimeFormat} from {@link module:intl-cache}
 * so repeated calls with the same locale are essentially free.
 *
 * @param {number} timestamp - Unix epoch timestamp in milliseconds
 * @param {string} [locale] - BCP 47 locale tag (defaults to navigator.language)
 * @returns {string} Formatted date string
 *
 * @example
 * formatDate(Date.now());                  // "Apr 16, 2026, 10:30 AM"
 * formatDate(Date.now(), 'zh-CN');        // "2026年4月16日 上午10:30"
 */
export function formatDate(timestamp, locale) {
    const fmt = getDateTimeFormat(locale, _DEFAULT_DATE_OPTIONS);
    return fmt.format(timestamp);
}
