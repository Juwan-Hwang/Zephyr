import { describe, it, expect } from 'vitest';
import { getDelayColorClass, formatFileSize, formatBytes, formatSpeed, formatDuration } from './format.js';

describe('getDelayColorClass', () => {
    it('returns tertiary for null', () => expect(getDelayColorClass(null)).toBe('text-[var(--zephyr-text-tertiary)]'));
    it('returns tertiary for 0', () => expect(getDelayColorClass(0)).toBe('text-[var(--zephyr-text-tertiary)]'));
    it('returns tertiary for 999999+', () => expect(getDelayColorClass(999999)).toBe('text-[var(--zephyr-text-tertiary)]'));
    it('returns emerald for < 200', () => expect(getDelayColorClass(120)).toBe('text-success'));
    it('returns emerald for 199', () => expect(getDelayColorClass(199)).toBe('text-success'));
    it('returns amber for 200', () => expect(getDelayColorClass(200)).toBe('text-warning'));
    it('returns amber for 499', () => expect(getDelayColorClass(499)).toBe('text-warning'));
    it('returns rose for 500', () => expect(getDelayColorClass(500)).toBe('text-danger'));
    it('returns rose for 800', () => expect(getDelayColorClass(800)).toBe('text-danger'));
    it('boundary: 1', () => expect(getDelayColorClass(1)).toBe('text-success'));
});

describe('formatFileSize', () => {
    it('0 bytes', () => expect(formatFileSize(0)).toBe('0 B'));
    it('500 bytes', () => expect(formatFileSize(500)).toBe('500.00 B'));
    it('1024 bytes = 1.00 KB', () => expect(formatFileSize(1024)).toBe('1.00 KB'));
    it('1.46 GB', () => expect(formatFileSize(1565873490)).toBe('1.46 GB'));
    it('1.00 MB', () => expect(formatFileSize(1048576)).toBe('1.00 MB'));
    it('1.00 TB', () => expect(formatFileSize(1099511627776)).toBe('1.00 TB'));
    it('negative produces NaN result', () => expect(formatFileSize(-1)).toBe('NaN undefined'));
});

describe('formatBytes (decimal)', () => {
    it('0 bytes', () => expect(formatBytes(0)).toBe('0 B'));
    it('999 bytes', () => expect(formatBytes(999)).toBe('999.00 B'));
    it('1000 bytes = 1.00 KB', () => expect(formatBytes(1000)).toBe('1.00 KB'));
    it('1.00 MB for 1000000', () => expect(formatBytes(1000000)).toBe('1.00 MB'));
    it('1.02 KB for 1024', () => expect(formatBytes(1024)).toBe('1.02 KB'));
});

describe('formatSpeed', () => {
    it('0 B/s', () => expect(formatSpeed(0)).toBe('0 B/s'));
    it('1.00 KB/s', () => expect(formatSpeed(1000)).toBe('1.00 KB/s'));
    it('1.02 KB/s', () => expect(formatSpeed(1024)).toBe('1.02 KB/s'));
});

describe('formatDuration', () => {
    it('0ms → 0s', () => expect(formatDuration(0)).toBe('0s'));
    it('500ms → 0s', () => expect(formatDuration(500)).toBe('0s'));
    it('65000ms → 1m 5s', () => expect(formatDuration(65000)).toBe('1m 5s'));
    it('3665000ms → 1h 1m 5s', () => expect(formatDuration(3665000)).toBe('1h 1m 5s'));
    it('86400000ms → 1d 0h 0m 0s', () => expect(formatDuration(86400000)).toBe('1d 0h 0m 0s'));
    it('negative → -1s', () => expect(formatDuration(-1)).toBe('-1s'));
    it('60000ms → 1m 0s', () => expect(formatDuration(60000)).toBe('1m 0s'));
    it('3600000ms → 1h 0m 0s', () => expect(formatDuration(3600000)).toBe('1h 0m 0s'));
    it('5000ms → 5s', () => expect(formatDuration(5000)).toBe('5s'));
    it('125000ms → 2m 5s', () => expect(formatDuration(125000)).toBe('2m 5s'));
});
