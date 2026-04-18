import { describe, it, expect } from 'vitest';
import { buildLatencyPriorityQueue } from './array.js';

describe('buildLatencyPriorityQueue', () => {
    it('empty candidates → empty queue', () => {
        expect(buildLatencyPriorityQueue({}, [])).toEqual([]);
    });
    it('single candidate → single item', () => {
        expect(buildLatencyPriorityQueue({}, ['a'])).toEqual(['a']);
    });
    it('alternates low-high pattern', () => {
        const data = {
            proxies: {
                fast: { history: [{ delay: 100 }] },
                medium: { history: [{ delay: 300 }] },
                slow: { history: [{ delay: 500 }] },
            }
        };
        const result = buildLatencyPriorityQueue(data, ['fast', 'medium', 'slow']);
        expect(result[0]).toBe('fast');
        expect(result[1]).toBe('slow');
        expect(result[2]).toBe('medium');
    });
    it('no history → score 1000000, sorted last', () => {
        const data = { proxies: {} };
        const result = buildLatencyPriorityQueue(data, ['a', 'b']);
        expect(result).toHaveLength(2);
    });
    it('delay 0 → score 1000000', () => {
        const data = { proxies: { a: { history: [{ delay: 0 }] } } };
        const result = buildLatencyPriorityQueue(data, ['a']);
        expect(result).toEqual(['a']);
    });
    it('delay 999999 → score 1000000', () => {
        const data = { proxies: { a: { history: [{ delay: 999999 }] } } };
        const result = buildLatencyPriorityQueue(data, ['a']);
        expect(result).toEqual(['a']);
    });
    it('same delay → original index order', () => {
        const data = {
            proxies: {
                a: { history: [{ delay: 100 }] },
                b: { history: [{ delay: 100 }] },
            }
        };
        const result = buildLatencyPriorityQueue(data, ['a', 'b']);
        expect(result[0]).toBe('a');
        expect(result[1]).toBe('b');
    });
    it('null data → no crash', () => {
        expect(buildLatencyPriorityQueue(null, ['a'])).toEqual(['a']);
    });
    it('undefined data → no crash', () => {
        expect(buildLatencyPriorityQueue(undefined, ['a'])).toEqual(['a']);
    });
});
