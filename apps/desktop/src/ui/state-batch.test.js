import { describe, it, expect } from 'vitest';
import { createStore } from './state.js';

describe('store batch set', () => {
    it('writes every key of a batch before a watcher runs', () => {
        const store = createStore('test.batch', { a: 0, b: 0 }, { persist: false });
        /** @type {unknown[]} */
        const seen = [];
        store.watchEach('a', () => { seen.push(store.get('b')); });
        store.set({ a: 1, b: 2 });
        expect(seen).toEqual([2]);
    });
});
