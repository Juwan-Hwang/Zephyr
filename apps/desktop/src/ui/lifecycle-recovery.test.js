// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';

const prism = { rebuild: vi.fn(), overrideApplyAll: vi.fn() };
const memory = { restoreProxySelectionResult: vi.fn(), waitForMihomoReady: vi.fn() };
const proxies = { startSmartAutoTest: vi.fn(), syncCoreConfig: vi.fn() };

vi.mock('../api.js', () => ({ abortLatencyTests: vi.fn(), closeAllConnections: vi.fn(), restartCore: vi.fn(), invoke: vi.fn() }));
vi.mock('@zephyr/shared', () => ({ COMMANDS: {} }));
vi.mock('./state.js', () => ({ appStore: { getState: vi.fn(() => ({})), setState: vi.fn() } }));
vi.mock('./cache.js', () => ({ invalidateSettingsCache: vi.fn(), invalidateProxiesCache: vi.fn(), invalidateConfigCache: vi.fn() }));
vi.mock('./run-config-cache.js', () => ({ invalidateRunConfigCache: vi.fn() }));
vi.mock('../utils/logger.js', () => ({ apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./notifications.js', () => ({ showNotification: vi.fn() }));
vi.mock('../i18n.js', () => ({ t: (_k, fb) => fb }));
vi.mock('./prism.js', () => prism);
vi.mock('./proxy-memory.js', () => memory);
vi.mock('./proxies.js', () => proxies);
vi.mock('./events.js', () => ({ Bus: { emit: vi.fn() }, Events: { CONFIG_UPDATED: 'config-updated' } }));

const { postRestartRecovery } = await import('./lifecycle.js');

describe('postRestartRecovery result', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        prism.rebuild.mockResolvedValue(undefined);
        prism.overrideApplyAll.mockResolvedValue([{ success: true }]);
        memory.restoreProxySelectionResult.mockResolvedValue('restored');
        memory.waitForMihomoReady.mockResolvedValue(true);
        proxies.syncCoreConfig.mockResolvedValue(undefined);
    });

    it('reports no failures when every step completes', async () => {
        await expect(postRestartRecovery('a.yaml')).resolves.toEqual({ failed: 0 });
    });

    it('counts override scripts that failed to apply', async () => {
        prism.overrideApplyAll.mockResolvedValue([{ success: true }, { success: false }, { success: false }]);
        await expect(postRestartRecovery('a.yaml')).resolves.toEqual({ failed: 2 });
    });

    it('counts failed steps and still runs the rest', async () => {
        prism.rebuild.mockRejectedValue(new Error('patch'));
        memory.restoreProxySelectionResult.mockRejectedValue(new Error('select'));
        await expect(postRestartRecovery('a.yaml')).resolves.toEqual({ failed: 2 });
        expect(proxies.startSmartAutoTest).toHaveBeenCalled();
    });

    it('counts a proxy restore that reported failure, not one with nothing to restore', async () => {
        memory.restoreProxySelectionResult.mockResolvedValue('nothing');
        await expect(postRestartRecovery('a.yaml')).resolves.toEqual({ failed: 0 });
        memory.restoreProxySelectionResult.mockResolvedValue('failed');
        await expect(postRestartRecovery('a.yaml')).resolves.toEqual({ failed: 1 });
    });

    it('counts a Prism rebuild whose reload the core rejected', async () => {
        prism.rebuild.mockResolvedValue({ hot_reload_success: false });
        await expect(postRestartRecovery('a.yaml')).resolves.toEqual({ failed: 1 });
        prism.rebuild.mockResolvedValue({ hot_reload_success: null });
        await expect(postRestartRecovery('a.yaml')).resolves.toEqual({ failed: 0 });
    });

    it('counts a core that did not become ready, and still refreshes', async () => {
        memory.waitForMihomoReady.mockResolvedValue(false);
        await expect(postRestartRecovery('a.yaml')).resolves.toEqual({ failed: 1 });
        expect(proxies.startSmartAutoTest).toHaveBeenCalled();
    });

    it('still announces the reload when syncing the core config fails', async () => {
        const { Bus } = await import('./events.js');
        proxies.syncCoreConfig.mockRejectedValue(new Error('sync'));
        await expect(postRestartRecovery('a.yaml')).resolves.toEqual({ failed: 1 });
        expect(Bus.emit).toHaveBeenCalledWith('config-updated', { reloaded: true });
        expect(proxies.startSmartAutoTest).toHaveBeenCalled();
    });
});
