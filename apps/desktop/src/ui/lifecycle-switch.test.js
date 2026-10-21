import { describe, it, expect, vi, beforeEach } from 'vitest';

const api = {
    abortLatencyTests: vi.fn(),
    closeAllConnections: vi.fn(async () => {}),
    restartCore: vi.fn(),
    invoke: vi.fn(),
};
vi.mock('../api.js', () => api);
const notify = vi.fn();
vi.mock('./notifications.js', () => ({ showNotification: notify }));
vi.mock('./prism.js', () => ({ rebuild: vi.fn(async () => {}), overrideApplyAll: vi.fn(async () => []) }));
vi.mock('./proxy-memory.js', () => ({
    restoreProxySelection: vi.fn(async () => {}),
    saveProxySelection: vi.fn(async () => {}),
    waitForMihomoReady: vi.fn(async () => true),
}));
vi.mock('./proxy-groups.js', () => ({ fetchProxyGroups: vi.fn(async () => ({})) }));
vi.mock('./proxies.js', () => ({ startSmartAutoTest: vi.fn(), syncCoreConfig: vi.fn(async () => {}) }));

const { switchToConfig } = await import('./lifecycle.js');
const prism = await import('./prism.js');
const memory = await import('./proxy-memory.js');

describe('switchToConfig', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        api.restartCore.mockResolvedValue({ secret: 's', port: 9090, active_config: 'b.yaml' });
    });

    it('treats a failed save of the active profile as a warning, not a failed switch', async () => {
        api.invoke.mockImplementation(async (cmd) => {
            if (cmd === 'update_last_config') throw new Error('disk full');
            return null;
        });
        const result = await switchToConfig('b.yaml');
        expect(result.actualConfig).toBe('b.yaml');
        expect(notify).toHaveBeenCalledWith(expect.any(String), 'warning');
        // The recovery still runs for the profile the core switched to.
        expect(prism.overrideApplyAll).toHaveBeenCalled();
        expect(memory.restoreProxySelection).toHaveBeenCalledWith('b.yaml');
    });

    it('saves the next selection under the running profile when its save failed', async () => {
        api.invoke.mockImplementation(async (cmd) => {
            if (cmd === 'update_last_config') throw new Error('disk full');
            if (cmd === 'get_settings') return { last_config: 'a.yaml' };
            return null;
        });
        await switchToConfig('b.yaml');
        const { fetchProxyGroups } = await import('./proxy-groups.js');
        fetchProxyGroups.mockResolvedValueOnce({ current: 'HK', uiGroupName: 'Main' });
        api.restartCore.mockResolvedValue({ secret: 's', port: 9090, active_config: 'c.yaml' });
        await switchToConfig('c.yaml');
        expect(memory.saveProxySelection).toHaveBeenCalledWith('b.yaml', { node: 'HK', group: 'Main' });
    });

    it('shows no warning when the save works', async () => {
        api.invoke.mockResolvedValue(null);
        await switchToConfig('b.yaml');
        expect(notify).not.toHaveBeenCalled();
    });
});
