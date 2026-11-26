import { describe, it, expect } from 'vitest';
import { resetChangesPatch } from './reset-merge.js';

describe('resetChangesPatch', () => {
    it('keeps a value saved meanwhile for a key the reset left alone', () => {
        const before = { theme: 'red', last_proxy_selection: { a: 'HK' } };
        const reset = { theme: 'blue', last_proxy_selection: { a: 'HK' } };
        const stored = { theme: 'red', last_proxy_selection: { a: 'JP' } };
        expect({ ...stored, ...resetChangesPatch(before, reset) }).toEqual({ theme: 'blue', last_proxy_selection: { a: 'JP' } });
    });

    it('writes forced keys even when the snapshot already held that value', () => {
        const before = { ui_scale: 1 };
        const stored = { ui_scale: 1.25 };
        expect({ ...stored, ...resetChangesPatch(before, { ui_scale: 1 }, ['ui_scale']) }).toEqual({ ui_scale: 1 });
    });

    it('clears nullable keys the reset removed, forced or changed', () => {
        const before = { speed_test_url: 'https://test.example/a', mixed_port: 7890 };
        const reset = { mixed_port: null };
        const stored = { speed_test_url: 'https://test.example/a', mixed_port: 7890, extra: 1 };
        expect({ ...stored, ...resetChangesPatch(before, reset, ['speed_test_url']) }).toEqual({ speed_test_url: null, mixed_port: null, extra: 1 });
    });

    it('keeps keys only the stored copy has', () => {
        expect({ a: 1, b: 2, ...resetChangesPatch({ a: 1 }, { a: 1 }) }).toEqual({ a: 1, b: 2 });
    });
});
