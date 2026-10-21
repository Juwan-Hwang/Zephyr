// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';

const getConfig = vi.fn();
vi.mock('../api.js', () => ({
    getConfig,
    patchConfig: vi.fn(async () => {}),
    closeAllConnections: vi.fn(async () => {}),
    invoke: vi.fn(async () => null),
}));
vi.mock('./settings-helpers.js', () => ({
    getSetting: vi.fn(async () => false),
    saveSetting: vi.fn(async () => {}),
    saveSettingChecked: vi.fn(async () => true),
}));
vi.mock('./notifications.js', () => ({ showNotification: vi.fn() }));

describe('DNS rewrite switch at startup', () => {
    it('a failed startup read is retried after a core restart, so the switch is not left disabled', async () => {
        document.body.innerHTML = '<input type="checkbox" id="dns-rewrite-toggle">';
        const toggle = /** @type {HTMLInputElement} */ (document.getElementById('dns-rewrite-toggle'));
        const { initDnsRewriteToggle } = await import('./dns-shared.js');
        const { Bus, Events } = await import('./events.js');
        getConfig.mockRejectedValueOnce(new Error('core not ready'));
        await initDnsRewriteToggle();
        expect(toggle.disabled).toBe(true);

        getConfig.mockResolvedValue({ dns: { enable: true } });
        Bus.emit(Events.CORE_RESTARTED, {});
        await vi.waitFor(() => expect(toggle.disabled).toBe(false));
        expect(toggle.checked).toBe(true);
    });
});
