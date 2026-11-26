import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMANDS } from '@zephyr/shared';

const mocks = vi.hoisted(() => ({
    invoke: vi.fn(),
    clearProviderCache: vi.fn(),
    invalidateProxiesCache: vi.fn(),
    invalidateConfigCache: vi.fn(),
    invalidateRunConfigCache: vi.fn(),
    emit: vi.fn(),
}));
vi.mock('../api.js', () => ({ invoke: mocks.invoke, clearProviderCache: mocks.clearProviderCache }));
vi.mock('./cache.js', () => ({ invalidateProxiesCache: mocks.invalidateProxiesCache, invalidateConfigCache: mocks.invalidateConfigCache }));
vi.mock('./run-config-cache.js', () => ({ invalidateRunConfigCache: mocks.invalidateRunConfigCache }));
vi.mock('./events.js', () => ({ Bus: { emit: mocks.emit }, Events: { CONFIG_UPDATED: 'config-updated' } }));
vi.mock('../i18n.js', () => ({ t: (key) => key }));

import { apply, rebuildWithOverrides, overrideSetContent, overrideRefreshRemote } from './prism.js';

describe('restoring settings after a config reload', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        Object.values(mocks).forEach((mock) => mock.mockReset());
    });
    afterEach(() => vi.useRealTimers());

    it('waits for registered restores and clears every config cache', async () => {
        mocks.invoke.mockResolvedValue({ status: { hot_reload_success: true } });
        let restore;
        mocks.emit.mockImplementation((_event, data) => data.waitFor(new Promise((resolve) => { restore = resolve; })));
        const pending = apply();
        let settled = false;
        void pending.then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
        expect(mocks.clearProviderCache).toHaveBeenCalledOnce();
        expect(mocks.invalidateProxiesCache).toHaveBeenCalledOnce();
        expect(mocks.invalidateConfigCache).toHaveBeenCalledOnce();
        expect(mocks.invalidateRunConfigCache).toHaveBeenCalledOnce();
        expect(mocks.emit).toHaveBeenCalledWith('config-updated', expect.objectContaining({ reloaded: true }));
        restore(true);
        await expect(pending).resolves.toEqual({ status: { hot_reload_success: true } });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('reports an apply as not fully running when a restore never replies', async () => {
        mocks.invoke.mockResolvedValue({ status: { hot_reload_success: true }, trace: [] });
        mocks.emit.mockImplementation((_event, data) => data.waitFor(new Promise(() => {})));
        const pending = apply();
        await vi.advanceTimersByTimeAsync(30_000);
        await expect(pending).resolves.toMatchObject({ hot_reload_success: false, status: { hot_reload_success: false }, core_reload_confirmed: true, runtime_restore_success: false });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('reports a rebuild as not fully running when a restore fails', async () => {
        mocks.invoke.mockImplementation(async (command) => command === COMMANDS.PRISM.REBUILD
            ? { hot_reload_success: true }
            : [{ success: true }]);
        mocks.emit.mockImplementation((_event, data) => data.waitFor(Promise.reject(new Error('restore failed'))));
        await expect(rebuildWithOverrides()).resolves.toMatchObject({ hot_reload_success: false, core_reload_confirmed: true, runtime_restore_success: false });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not announce a reload the core rejected', async () => {
        mocks.invoke.mockResolvedValue({ status: { hot_reload_success: false } });
        await expect(apply()).resolves.toEqual({ status: { hot_reload_success: false } });
        expect(mocks.emit).not.toHaveBeenCalled();
    });

    it('builds rules and overrides in one command and only restores accepted reloads', async () => {
        mocks.invoke.mockResolvedValue({ hot_reload_success: false });
        await expect(rebuildWithOverrides()).resolves.toMatchObject({ hot_reload_success: false });
        expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(COMMANDS.PRISM.REBUILD, { options: null, withOverrides: true });
        expect(mocks.emit).not.toHaveBeenCalled();
    });

    it('restores runtime settings after an uncertain reload without reporting acceptance', async () => {
        mocks.invoke.mockResolvedValue({ hot_reload_success: false, hot_reload_uncertain: true });
        mocks.emit.mockImplementation((_event, data) => data.waitFor(Promise.resolve(true)));
        await expect(rebuildWithOverrides()).resolves.toMatchObject({ hot_reload_success: false, hot_reload_uncertain: true });
        expect(mocks.emit).toHaveBeenCalledWith('config-updated', expect.objectContaining({ reloaded: false, restoreRuntime: true }));
    });

    it.each([
        { status: { hot_reload_success: false }, hot_reload_uncertain: true },
        { status: { hot_reload_success: false, hot_reload_uncertain: true } },
    ])('waits for plain apply uncertainty recovery while preserving its failed result: %j', async (result) => {
        mocks.invoke.mockResolvedValue(result);
        let finish;
        mocks.emit.mockImplementation((_event, data) => data.waitFor(new Promise((resolve) => { finish = resolve; })));
        const pending = apply();
        let settled = false;
        void pending.then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
        expect(mocks.emit).toHaveBeenCalledWith('config-updated', expect.objectContaining({ reloaded: false, restoreRuntime: true }));
        finish(true);
        await expect(pending).resolves.toEqual(result);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('also restores runtime settings for an uncertain single override while preserving its failed result', async () => {
        const result = { success: false, configModified: true, reloaded: false, reloadUncertain: true };
        mocks.invoke.mockResolvedValue(result);
        await expect(overrideSetContent('script', 'content')).resolves.toEqual(result);
        expect(mocks.emit).toHaveBeenCalledWith('config-updated', expect.objectContaining({ reloaded: false, restoreRuntime: true }));
    });

    it('invalidates node diagnostics after a live single override or remote refresh', async () => {
        const result = { success: true, configModified: true };
        mocks.invoke.mockResolvedValue(result);
        await expect(overrideSetContent('script', 'function main(config) { return config; }')).resolves.toEqual(result);
        await expect(overrideRefreshRemote('script')).resolves.toEqual(result);
        expect(mocks.emit).toHaveBeenCalledTimes(2);
        expect(mocks.clearProviderCache).toHaveBeenCalledTimes(2);
    });

    it.each([
        { dryRun: true, saveOnly: false, success: true, configModified: true },
        { dryRun: false, saveOnly: true, success: true, configModified: true },
        { dryRun: false, saveOnly: false, success: false, configModified: true },
        { dryRun: false, saveOnly: false, success: true, configModified: false },
    ])('does not restore when the command did not reload: %j', async ({ dryRun, saveOnly, success, configModified }) => {
        const result = { success, configModified };
        mocks.invoke.mockResolvedValue(result);
        await expect(overrideSetContent('script', 'content', dryRun, saveOnly)).resolves.toEqual(result);
        expect(mocks.emit).not.toHaveBeenCalled();
    });

    it('reports a single override as incomplete if running settings cannot be restored', async () => {
        mocks.invoke.mockResolvedValue({ success: true, configModified: true });
        mocks.emit.mockImplementation((_event, data) => data.waitFor(Promise.resolve(false)));
        await expect(overrideSetContent('script', 'content')).resolves.toMatchObject({
            success: false, configModified: true, error: 'requireRestart',
        });
    });

    it('does not restore running settings for an override saved with the core stopped', async () => {
        const result = { success: true, configModified: true, reloaded: false };
        mocks.invoke.mockResolvedValue(result);
        await expect(overrideSetContent('script', 'content')).resolves.toEqual(result);
        expect(mocks.emit).not.toHaveBeenCalled();
    });
});
