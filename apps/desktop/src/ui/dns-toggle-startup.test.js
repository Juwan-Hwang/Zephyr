// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';

const getConfig = vi.fn();
const patchConfig = vi.fn(async () => {});
vi.mock('../api.js', () => ({
    getConfig,
    patchConfig,
    closeAllConnections: vi.fn(async () => {}),
    invoke: vi.fn(async () => null),
}));
const getSetting = vi.fn(async () => false);
const saveSettingChecked = vi.fn(async () => true);
vi.mock('./settings-helpers.js', () => ({
    getSetting,
    saveSetting: vi.fn(async () => {}),
    saveSettingChecked,
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

    it('a failed startup read is retried on its own when no restart comes', async () => {
        vi.resetModules();
        vi.useFakeTimers();
        try {
            document.body.innerHTML = '<input type="checkbox" id="dns-rewrite-toggle">';
            const toggle = /** @type {HTMLInputElement} */ (document.getElementById('dns-rewrite-toggle'));
            const { initDnsRewriteToggle } = await import('./dns-shared.js');
            getConfig.mockReset();
            getConfig.mockRejectedValueOnce(new Error('core busy'));
            getConfig.mockRejectedValueOnce(new Error('core busy'));
            getConfig.mockResolvedValue({ dns: { enable: false } });
            await initDnsRewriteToggle();
            expect(toggle.disabled).toBe(true);
            await vi.advanceTimersByTimeAsync(1000);
            expect(toggle.disabled).toBe(true);
            await vi.advanceTimersByTimeAsync(2000);
            expect(toggle.disabled).toBe(false);
            expect(toggle.checked).toBe(false);
            expect(getConfig).toHaveBeenCalledTimes(3);
        } finally {
            vi.useRealTimers();
        }
    });

    it('a failed startup re-apply of the saved rewrite is retried, then saved through the checked write', async () => {
        vi.resetModules();
        vi.useFakeTimers();
        try {
            document.body.innerHTML = '<input type="checkbox" id="dns-rewrite-toggle">';
            const toggle = /** @type {HTMLInputElement} */ (document.getElementById('dns-rewrite-toggle'));
            const { initDnsRewriteToggle } = await import('./dns-shared.js');
            getConfig.mockReset();
            getConfig.mockResolvedValue({ dns: { enable: false } });
            getSetting.mockImplementation(async (key, fallback) => (key === 'dns_rewrite_enabled' ? true : fallback));
            patchConfig.mockRejectedValueOnce(new Error('core not ready'));
            await initDnsRewriteToggle();
            expect(toggle.checked).toBe(false);
            expect(toggle.disabled).toBe(true);
            await vi.advanceTimersByTimeAsync(1000);
            expect(toggle.disabled).toBe(false);
            expect(toggle.checked).toBe(true);
            expect(patchConfig).toHaveBeenCalledTimes(2);
            expect(saveSettingChecked).toHaveBeenCalledWith('dns_rewrite_enabled', true);
        } finally {
            vi.useRealTimers();
            getSetting.mockImplementation(async () => false);
        }
    });
    it('a startup retry follows an unsaved "off" kept after a failed Restore Defaults save', async () => {
        vi.resetModules();
        vi.useFakeTimers();
        try {
            document.body.innerHTML = '<input type="checkbox" id="dns-rewrite-toggle">';
            const toggle = /** @type {HTMLInputElement} */ (document.getElementById('dns-rewrite-toggle'));
            const { initDnsRewriteToggle, rememberUnsavedDnsChoice } = await import('./dns-shared.js');
            getConfig.mockReset();
            patchConfig.mockClear();
            getConfig.mockRejectedValueOnce(new Error('core busy'));
            getConfig.mockResolvedValue({ dns: { enable: false } });
            getSetting.mockImplementation(async (key, fallback) => (key === 'dns_rewrite_enabled' ? true : fallback));
            await initDnsRewriteToggle();
            expect(toggle.disabled).toBe(true);
            // The reset turned the rewrite off but could not save it.
            rememberUnsavedDnsChoice(false);
            await vi.advanceTimersByTimeAsync(1000);
            expect(toggle.disabled).toBe(false);
            expect(toggle.checked).toBe(false);
            expect(patchConfig).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
            getSetting.mockImplementation(async () => false);
        }
    });
    it('when every startup read fails, the switch is enabled once the retries are used up', async () => {
        vi.resetModules();
        vi.useFakeTimers();
        try {
            document.body.innerHTML = '<input type="checkbox" id="dns-rewrite-toggle">';
            const toggle = /** @type {HTMLInputElement} */ (document.getElementById('dns-rewrite-toggle'));
            const { initDnsRewriteToggle } = await import('./dns-shared.js');
            getConfig.mockReset();
            getConfig.mockRejectedValue(new Error('core down'));
            await initDnsRewriteToggle();
            expect(toggle.disabled).toBe(true);
            await vi.advanceTimersByTimeAsync(1000 * (1 + 2 + 3 + 4 + 5));
            expect(getConfig).toHaveBeenCalledTimes(6);
            expect(toggle.disabled).toBe(false);
            expect(toggle.checked).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
    it('the DNS config button works while the startup read is still waiting on the core', async () => {
        vi.resetModules();
        document.body.innerHTML = '<input type="checkbox" id="dns-rewrite-toggle">'
            + '<button id="dns-config-btn"></button>'
            + '<div id="dns-config-modal" class="hidden"><div class="glass-card">'
            + '<textarea id="dns-nameservers-input"></textarea><textarea id="dns-fallbacks-input"></textarea>'
            + '<button id="dns-config-cancel"></button><button id="dns-config-save"></button></div></div>';
        const toggle = /** @type {HTMLInputElement} */ (document.getElementById('dns-rewrite-toggle'));
        const { initDnsRewriteToggle } = await import('./dns-shared.js');
        getConfig.mockReset();
        getConfig.mockImplementation(() => new Promise(() => {}));
        void initDnsRewriteToggle();
        await vi.waitFor(() => expect(getConfig).toHaveBeenCalled());
        expect(toggle.disabled).toBe(true);
        document.getElementById('dns-config-btn')?.click();
        const modal = /** @type {HTMLElement} */ (document.getElementById('dns-config-modal'));
        await vi.waitFor(() => expect(modal.classList.contains('hidden')).toBe(false));
        expect(toggle.disabled).toBe(true);
        getConfig.mockReset();
    });
});
