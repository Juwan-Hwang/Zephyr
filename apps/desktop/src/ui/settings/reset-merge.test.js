import { describe, it, expect } from 'vitest';
import { withResetChanges } from './reset-merge.js';

describe('withResetChanges', () => {
    it('keeps a value saved meanwhile for a key the reset left alone', () => {
        const before = { theme: 'red', last_proxy_selection: { a: 'HK' } };
        const reset = { theme: 'blue', last_proxy_selection: { a: 'HK' } };
        const stored = { theme: 'red', last_proxy_selection: { a: 'JP' } };
        expect(withResetChanges(stored, before, reset)).toEqual({ theme: 'blue', last_proxy_selection: { a: 'JP' } });
    });

    it('writes forced keys even when the snapshot already held that value', () => {
        const before = { ui_scale: 1 };
        const stored = { ui_scale: 1.25 };
        expect(withResetChanges(stored, before, { ui_scale: 1 }, ['ui_scale'])).toEqual({ ui_scale: 1 });
    });

    it('removes keys the reset deleted, forced or changed', () => {
        const before = { copy_env_format: 'bash', mixed_port: 7890 };
        const reset = { mixed_port: null };
        const stored = { copy_env_format: 'bash', mixed_port: 7890, extra: 1 };
        expect(withResetChanges(stored, before, reset, ['copy_env_format'])).toEqual({ mixed_port: null, extra: 1 });
    });

    it('keeps keys only the stored copy has', () => {
        expect(withResetChanges({ a: 1, b: 2 }, { a: 1 }, { a: 1 })).toEqual({ a: 1, b: 2 });
    });
});
