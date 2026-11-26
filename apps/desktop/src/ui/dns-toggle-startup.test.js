// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';

const getConfig = vi.fn();
const patchConfig = vi.fn(async () => {});
vi.mock('../api.js', () => ({
    getConfig,
    patchConfig,
    closeAllConnections: vi.fn(async () => {}),
    invoke: vi.fn(async (command) => command === 'apply_runtime_dns' ? patchConfig() : null),
}));
const getSetting = vi.fn(async () => false);
const saveSettingChecked = vi.fn(async () => true);
vi.mock('./settings-helpers.js', () => ({
    getSetting,
    saveSetting: vi.fn(async () => {}),
    saveSettingChecked,
    saveSettingsChecked: vi.fn(async () => true),
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
        expect(toggle.checked).toBe(false);
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

    it.each([false, true])('restores saved DNS even when the profile enables DNS (enabled=%s)', async (enabled) => {
        vi.resetModules();
        vi.useFakeTimers();
        try {
            document.body.innerHTML = '<input type="checkbox" id="dns-rewrite-toggle">';
            const toggle = /** @type {HTMLInputElement} */ (document.getElementById('dns-rewrite-toggle'));
            const { initDnsRewriteToggle } = await import('./dns-shared.js');
            getConfig.mockReset();
            getConfig.mockResolvedValue({ dns: { enable: enabled } });
            getSetting.mockImplementation(async (key, fallback) => (key === 'dns_rewrite_enabled' ? true : fallback));
            patchConfig.mockClear();
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
    it('a startup re-apply that saves the choice forgets the unsaved one', async () => {
        vi.resetModules();
        try {
            document.body.innerHTML = '<input type="checkbox" id="dns-rewrite-toggle">';
            const toggle = /** @type {HTMLInputElement} */ (document.getElementById('dns-rewrite-toggle'));
            const { initDnsRewriteToggle, rememberUnsavedDnsChoice, dnsRewriteWanted } = await import('./dns-shared.js');
            getConfig.mockReset();
            getConfig.mockResolvedValue({ dns: { enable: false } });
            getSetting.mockImplementation(async () => false);
            // An earlier test saved the same value: only this test's save counts.
            saveSettingChecked.mockClear();
            rememberUnsavedDnsChoice(true);
            await initDnsRewriteToggle();
            await vi.waitFor(() => expect(toggle.checked).toBe(true));
            expect(saveSettingChecked).toHaveBeenCalledWith('dns_rewrite_enabled', true);
            // Later the setting is turned off elsewhere: the saved value counts again.
            expect(await dnsRewriteWanted()).toBe(false);
        } finally {
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
    it('when the saved choice cannot be read, the switch keeps its known choice', async () => {
        vi.resetModules();
        vi.useFakeTimers();
        try {
            document.body.innerHTML = '<input type="checkbox" id="dns-rewrite-toggle" checked>';
            const toggle = /** @type {HTMLInputElement} */ (document.getElementById('dns-rewrite-toggle'));
            const { initDnsRewriteToggle } = await import('./dns-shared.js');
            getConfig.mockReset();
            getConfig.mockResolvedValue({ dns: { enable: true } });
            getSetting.mockImplementation(async () => { throw new Error('settings unreadable'); });
            await initDnsRewriteToggle();
            await vi.advanceTimersByTimeAsync(1000 * (1 + 2 + 3 + 4 + 5));
            expect(toggle.disabled).toBe(false);
            expect(toggle.checked).toBe(true);
        } finally {
            getSetting.mockImplementation(async () => false);
            vi.useRealTimers();
        }
    });

    it('keeps a saved-off rewrite off when profile DNS is enabled and servers are edited', async () => {
        vi.resetModules();
        document.body.innerHTML = '<input type="checkbox" id="dns-rewrite-toggle">'
            + '<textarea id="dns-nameservers-input">https://dns.example/dns-query</textarea>'
            + '<textarea id="dns-fallbacks-input"></textarea><button id="dns-config-save"></button>';
        const toggle = /** @type {HTMLInputElement} */ (document.getElementById('dns-rewrite-toggle'));
        const { invoke } = await import('../api.js');
        const { initDnsRewriteToggle } = await import('./dns-shared.js');
        getConfig.mockReset();
        getConfig.mockResolvedValue({ dns: { enable: true } });
        getSetting.mockImplementation(async () => false);
        vi.mocked(invoke).mockImplementation(async (command) => command === 'get_settings' ? {}
            : command === 'apply_runtime_dns' ? patchConfig() : null);
        try {
            await initDnsRewriteToggle();
            expect(toggle.checked).toBe(false);
            // An outdated checkbox must not opt into the overlay on a server edit.
            toggle.checked = true;
            patchConfig.mockClear();
            getSetting.mockClear();
            document.getElementById('dns-config-save')?.click();
            await vi.waitFor(() => expect(getSetting).toHaveBeenCalledWith('dns_rewrite_enabled', null));
            expect(invoke).toHaveBeenCalledWith('save_settings', expect.objectContaining({ settings: expect.objectContaining({ dns_nameservers: ['https://dns.example/dns-query'] }) }));
            expect(patchConfig).not.toHaveBeenCalled();
        } finally {
            vi.mocked(invoke).mockImplementation(async (command) => command === 'apply_runtime_dns' ? patchConfig() : null);
        }
    });

    it('defers DNS restoration after an uncertain reload until a confirmed reload', async () => {
        vi.resetModules();
        document.body.innerHTML = '<input type="checkbox" id="dns-rewrite-toggle">';
        const { initDnsRewriteToggle } = await import('./dns-shared.js');
        const { Bus, Events } = await import('./events.js');
        const { showNotification } = await import('./notifications.js');
        getConfig.mockReset();
        getConfig.mockResolvedValue({ dns: { enable: true } });
        getSetting.mockImplementation(async (key, fallback) => key === 'dns_rewrite_enabled' ? true : fallback);
        try {
            await initDnsRewriteToggle();
            patchConfig.mockClear();
            vi.mocked(showNotification).mockClear();
            /** @type {Promise<unknown>[]} */
            const waits = [];
            const waitFor = (/** @type {Promise<unknown>} */ done) => { waits.push(done); };
            Bus.emit(Events.CONFIG_UPDATED, { reloaded: false, restoreRuntime: true, waitFor });
            await Promise.all(waits);
            expect(patchConfig).not.toHaveBeenCalled();
            expect(showNotification).toHaveBeenCalledWith(expect.any(String), 'warning');
            waits.length = 0;
            Bus.emit(Events.CONFIG_UPDATED, { reloaded: true, waitFor });
            await Promise.all(waits);
            expect(patchConfig).toHaveBeenCalledOnce();
        } finally {
            getSetting.mockImplementation(async () => false);
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
