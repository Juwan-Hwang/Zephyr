// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';

const win = { show: vi.fn().mockResolvedValue(undefined), setFocus: vi.fn().mockResolvedValue(undefined) };
const api = { listen: vi.fn(), invoke: vi.fn(), getCurrentWindow: vi.fn(() => win) };
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
        api.getCurrentWindow.mockImplementation(() => win);
        win.show.mockResolvedValue(undefined);
        win.setFocus.mockResolvedValue(undefined);
        notifications.showConfirmModal.mockResolvedValue(false);
    });

    it('asks for links that arrived before the listener, after registering it', async () => {
        api.invoke.mockResolvedValueOnce([link]).mockResolvedValue([]);
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

    it('shows the window before asking about a held link', async () => {
        api.invoke.mockResolvedValueOnce([link]).mockResolvedValue([]);
        await initDeepLink();
        await vi.waitFor(() => expect(notifications.showConfirmModal).toHaveBeenCalledTimes(1));
        expect(win.show).toHaveBeenCalledTimes(1);
        expect(win.show.mock.invocationCallOrder[0]).toBeLessThan(notifications.showConfirmModal.mock.invocationCallOrder[0]);
    });

    it('leaves the window alone when nothing was held', async () => {
        api.invoke.mockResolvedValue([]);
        await initDeepLink();
        await new Promise((r) => setTimeout(r, 0));
        expect(win.show).not.toHaveBeenCalled();
    });

    it('takes the waiting links when the backend says one arrived', async () => {
        api.invoke.mockResolvedValueOnce([]).mockResolvedValueOnce([link]).mockResolvedValue([]);
        await initDeepLink();
        const onEvent = api.listen.mock.calls[0][1];
        onEvent({ payload: null });
        await vi.waitFor(() => expect(notifications.showConfirmModal).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(3));
    });

    it('handles a link that arrives during an open prompt after it, in order', async () => {
        const later = { ...link, name: 'Later' };
        let answer;
        notifications.showConfirmModal.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
        api.invoke.mockResolvedValueOnce([link]).mockResolvedValueOnce([]).mockResolvedValueOnce([later]).mockResolvedValue([]);
        await initDeepLink();
        await vi.waitFor(() => expect(notifications.showConfirmModal).toHaveBeenCalledTimes(1));
        api.listen.mock.calls[0][1]({ payload: null });
        await new Promise((r) => setTimeout(r, 0));
        expect(notifications.showConfirmModal).toHaveBeenCalledTimes(1);
        answer(false);
        await vi.waitFor(() => expect(notifications.showConfirmModal).toHaveBeenCalledTimes(2));
        expect(notifications.showConfirmModal.mock.calls[1][1]).toContain('Later');
    });

    it('leaves later links with the backend while a prompt is open', async () => {
        const later = { ...link, name: 'Later' };
        const queue = [link, later];
        api.invoke.mockImplementation(async () => (queue.length ? [queue.shift()] : []));
        let answer;
        notifications.showConfirmModal.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
        await initDeepLink();
        await vi.waitFor(() => expect(notifications.showConfirmModal).toHaveBeenCalledTimes(1));
        expect(queue).toEqual([later]);
        answer(false);
        await vi.waitFor(() => expect(notifications.showConfirmModal).toHaveBeenCalledTimes(2));
        expect(queue).toEqual([]);
    });

    it('still handles the next link when one fails', async () => {
        const later = { ...link, name: 'Later' };
        api.invoke.mockResolvedValueOnce([link]).mockResolvedValueOnce([later]).mockResolvedValue([]);
        notifications.showConfirmModal.mockRejectedValueOnce(new Error('modal gone'));
        await initDeepLink();
        await vi.waitFor(() => expect(notifications.showConfirmModal).toHaveBeenCalledTimes(2));
        expect(notifications.showConfirmModal.mock.calls[1][1]).toContain('Later');
        expect(win.show).toHaveBeenCalledTimes(1);
    });
});
