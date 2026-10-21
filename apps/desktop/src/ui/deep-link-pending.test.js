// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';

const api = { listen: vi.fn(), invoke: vi.fn() };
const notifications = { showNotification: vi.fn(), showConfirmModal: vi.fn() };

vi.mock('../api.js', () => api);
vi.mock('./notifications.js', () => notifications);
vi.mock('../i18n.js', () => ({ translations: { en: {} } }));
vi.mock('@zephyr/shared', () => ({ COMMANDS: { TAKE_PENDING_DEEP_LINKS: 'take_pending_deep_links', DOWNLOAD_SUB: 'download_sub' } }));
vi.mock('../utils/logger.js', () => ({ apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./state.js', () => ({ appStore: { get: vi.fn(), set: vi.fn() } }));
vi.mock('./lifecycle.js', () => ({ switchToConfig: vi.fn() }));
vi.mock('./cache.js', () => ({ invalidateConfigsCache: vi.fn() }));
vi.mock('./settings/sub-download-gate.js', () => ({ subDownloadSlot: vi.fn() }));

const { initDeepLink } = await import('./deep-link.js');

const link = { action: 'install-config', url: 'https://example.com/sub', name: 'Early' };

describe('initDeepLink', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        api.listen.mockResolvedValue(() => {});
        notifications.showConfirmModal.mockResolvedValue(false);
    });

    it('asks for links that arrived before the listener, after registering it', async () => {
        api.invoke.mockResolvedValue([link]);
        await initDeepLink();
        await vi.waitFor(() => expect(notifications.showConfirmModal).toHaveBeenCalledTimes(1));
        expect(api.listen.mock.invocationCallOrder[0]).toBeLessThan(api.invoke.mock.invocationCallOrder[0]);
        expect(api.invoke).toHaveBeenCalledWith('take_pending_deep_links');
        expect(notifications.showConfirmModal.mock.calls[0][1]).toContain('https://example.com/sub');
    });

    it('still listens when the held links cannot be read', async () => {
        api.invoke.mockRejectedValue(new Error('no such command'));
        const unlisten = await initDeepLink();
        expect(typeof unlisten).toBe('function');
        await Promise.resolve();
        expect(notifications.showConfirmModal).not.toHaveBeenCalled();
    });
});
