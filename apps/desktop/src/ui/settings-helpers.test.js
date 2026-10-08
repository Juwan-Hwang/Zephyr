import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api.js', () => ({
    invoke: vi.fn(),
}));

vi.mock('./cache.js', () => ({
    invalidateSettingsCache: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
    settingsLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { invoke } from '../api.js';
import { invalidateSettingsCache } from './cache.js';
import { settingsLogger } from '../utils/logger.js';
import { saveSetting, saveSettings, getSetting } from './settings-helpers.js';

const invokeMock = /** @type {import('vitest').Mock} */ (invoke);

beforeEach(() => {
    vi.clearAllMocks();
    invokeMock.mockResolvedValue(undefined);
});

describe('saveSetting', () => {
    it('sends a single-key patch and invalidates the settings cache', async () => {
        await saveSetting('tun_enabled', true);
        expect(invokeMock).toHaveBeenCalledWith('patch_settings', { patch: { tun_enabled: true } });
        expect(invalidateSettingsCache).toHaveBeenCalledTimes(1);
    });

    it('passes null through to clear a field', async () => {
        await saveSetting('mode', null);
        expect(invokeMock).toHaveBeenCalledWith('patch_settings', { patch: { mode: null } });
    });

    it('writes in call order even when earlier writes are slower', async () => {
        /** @type {string[]} */
        const done = [];
        invokeMock.mockImplementation((_cmd, { patch }) => {
            const key = Object.keys(patch)[0];
            const delay = key === 'first' ? 30 : 0;
            return new Promise(resolve => setTimeout(() => { done.push(key); resolve(undefined); }, delay));
        });
        const a = saveSetting('first', 1);
        const b = saveSetting('second', 2);
        await Promise.all([a, b]);
        expect(done).toEqual(['first', 'second']);
    });

    it('logs failures without rejecting or breaking later writes', async () => {
        invokeMock.mockRejectedValueOnce(new Error('backend down'));
        await expect(saveSetting('theme_mode', 'dark')).resolves.toBeUndefined();
        expect(settingsLogger.warn).toHaveBeenCalledTimes(1);
        expect(invalidateSettingsCache).not.toHaveBeenCalled();

        await saveSetting('theme_mode', 'light');
        expect(invokeMock).toHaveBeenLastCalledWith('patch_settings', { patch: { theme_mode: 'light' } });
        expect(invalidateSettingsCache).toHaveBeenCalledTimes(1);
    });
});

describe('saveSettings', () => {
    it('sends all fields in one atomic patch', async () => {
        await saveSettings({ theme_mode: 'dark', tun_enabled: false });
        expect(invokeMock).toHaveBeenCalledTimes(1);
        expect(invokeMock).toHaveBeenCalledWith('patch_settings', { patch: { theme_mode: 'dark', tun_enabled: false } });
        expect(invalidateSettingsCache).toHaveBeenCalledTimes(1);
    });

    it('shares the write queue with saveSetting', async () => {
        /** @type {string[]} */
        const order = [];
        invokeMock.mockImplementation((_cmd, { patch }) => {
            const keys = Object.keys(patch).join('+');
            const delay = keys === 'a' ? 30 : 0;
            return new Promise(resolve => setTimeout(() => { order.push(keys); resolve(undefined); }, delay));
        });
        await Promise.all([saveSetting('a', 1), saveSettings({ b: 2, c: 3 })]);
        expect(order).toEqual(['a', 'b+c']);
    });

    it('swallows and logs errors', async () => {
        invokeMock.mockRejectedValueOnce(new Error('nope'));
        await expect(saveSettings({ x: 1 })).resolves.toBeUndefined();
        expect(settingsLogger.warn).toHaveBeenCalledTimes(1);
    });
});

describe('getSetting', () => {
    it('returns the stored value', async () => {
        invokeMock.mockResolvedValue({ mode: 'global' });
        await expect(getSetting('mode', 'rule')).resolves.toBe('global');
        expect(invokeMock).toHaveBeenCalledWith('get_settings');
    });

    it('returns the fallback for null or missing fields', async () => {
        invokeMock.mockResolvedValue({ mode: null });
        await expect(getSetting('mode', 'rule')).resolves.toBe('rule');
        await expect(getSetting('missing', 42)).resolves.toBe(42);
    });

    it('keeps falsy-but-set values instead of using the fallback', async () => {
        invokeMock.mockResolvedValue({ tun_enabled: false, port: 0, name: '' });
        await expect(getSetting('tun_enabled', true)).resolves.toBe(false);
        await expect(getSetting('port', 7890)).resolves.toBe(0);
        await expect(getSetting('name', 'x')).resolves.toBe('');
    });

    it('propagates backend errors to the caller', async () => {
        invokeMock.mockRejectedValue(new Error('ipc failed'));
        await expect(getSetting('mode', 'rule')).rejects.toThrow('ipc failed');
    });
});
