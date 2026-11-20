import { describe, it, expect } from 'vitest';
import { isPlainObject, isSafeMergeKey, deepMerge } from './advanced.js';

describe('isPlainObject', () => {
    it('returns true for plain objects', () => {
        expect(isPlainObject({})).toBe(true);
        expect(isPlainObject({ a: 1 })).toBe(true);
        expect(isPlainObject(Object.create(null))).toBe(true);
    });
    it('returns false for null', () => expect(isPlainObject(null)).toBe(false));
    it('returns false for arrays', () => expect(isPlainObject([])).toBe(false));
    it('returns false for primitives', () => {
        expect(isPlainObject(42)).toBe(false);
        expect(isPlainObject('string')).toBe(false);
        expect(isPlainObject(true)).toBe(false);
        expect(isPlainObject(undefined)).toBe(false);
    });
    it('returns false for functions', () => expect(isPlainObject(() => {})).toBe(false));
    it('returns false for class instances', () => {
        class Foo {}
        expect(isPlainObject(new Foo())).toBe(false);
    });
});

describe('isSafeMergeKey', () => {
    it('allows normal keys', () => {
        expect(isSafeMergeKey('name')).toBe(true);
        expect(isSafeMergeKey('port')).toBe(true);
        expect(isSafeMergeKey('__name')).toBe(true);
    });
    it('rejects __proto__', () => expect(isSafeMergeKey('__proto__')).toBe(false));
    it('rejects constructor', () => expect(isSafeMergeKey('constructor')).toBe(false));
    it('rejects prototype', () => expect(isSafeMergeKey('prototype')).toBe(false));
});

describe('deepMerge', () => {
    it('merges flat objects', () => {
        const target = { a: 1 };
        const source = { b: 2 };
        const result = deepMerge(target, source);
        expect(result).toEqual({ a: 1, b: 2 });
    });

    it('source overrides target for same key', () => {
        const target = { a: 1, b: 2 };
        const source = { b: 3, c: 4 };
        const result = deepMerge(target, source);
        expect(result).toEqual({ a: 1, b: 3, c: 4 });
    });

    it('deep merges nested objects', () => {
        const target = { a: { x: 1, y: 2 } };
        const source = { a: { y: 3, z: 4 } };
        const result = deepMerge(target, source);
        expect(result).toEqual({ a: { x: 1, y: 3, z: 4 } });
    });

    it('arrays are replaced not merged', () => {
        const target = { items: [1, 2, 3] };
        const source = { items: [4, 5] };
        const result = deepMerge(target, source);
        expect(result.items).toEqual([4, 5]);
    });

    it('skips __proto__ key', () => {
        const target = {};
        const source = JSON.parse('{"__proto__": {"polluted": true}}');
        const result = deepMerge(target, source);
        expect(result.polluted).toBeUndefined();
    });

    it('skips constructor key', () => {
        const target = {};
        const source = { constructor: { polluted: true } };
        const result = deepMerge(target, source);
        expect(result.polluted).toBeUndefined();
    });

    it('skips prototype key', () => {
        const target = {};
        const source = { prototype: { polluted: true } };
        const result = deepMerge(target, source);
        expect(result.polluted).toBeUndefined();
    });

    it('returns source when target is not plain object', () => {
        const source = { a: 1 };
        expect(deepMerge(null, source)).toEqual({ a: 1 });
        expect(deepMerge([], source)).toEqual({ a: 1 });
        expect(deepMerge(42, source)).toEqual({ a: 1 });
    });

    it('returns source when source is not plain object', () => {
        const target = { a: 1 };
        expect(deepMerge(target, null)).toBe(null);
        expect(deepMerge(target, [1, 2])).toEqual([1, 2]);
    });

    it('handles empty objects', () => {
        expect(deepMerge({}, {})).toEqual({});
        expect(deepMerge({ a: 1 }, {})).toEqual({ a: 1 });
        expect(deepMerge({}, { a: 1 })).toEqual({ a: 1 });
    });

    it('does not modify source object', () => {
        const source = { a: { b: 1 } };
        const sourceCopy = JSON.parse(JSON.stringify(source));
        deepMerge({}, source);
        expect(source).toEqual(sourceCopy);
    });
});
