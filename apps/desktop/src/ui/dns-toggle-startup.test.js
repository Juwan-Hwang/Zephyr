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

    it.each([false, true])('server edits follow the saved choice and synchronize a successful overlay (enabled=%s)', async (enabled) => {
        vi.resetModules();
        document.body.innerHTML = '<input type="checkbox" id="dns-rewrite-toggle">'
            + '<textarea id="dns-nameservers-input">https://dns.example/dns-query</textarea>'
            + '<textarea id="dns-fallbacks-input"></textarea><button id="dns-config-save"></button>';
        const toggle = /** @type {HTMLInputElement} */ (document.getElementById('dns-rewrite-toggle'));
        const saveButton = /** @type {HTMLButtonElement} */ (document.getElementById('dns-config-save'));
        const listeners = vi.spyOn(saveButton, 'addEventListener');
        const { invoke } = await import('../api.js');
        const { saveSettingsChecked } = await import('./settings-helpers.js');
        const { initDnsRewriteToggle } = await import('./dns-shared.js');
        getConfig.mockReset();
        getConfig.mockResolvedValue({ dns: { enable: true } });
        getSetting.mockImplementation(async () => false);
        vi.mocked(invoke).mockImplementation(async (command) => command === 'get_settings' ? {}
            : command === 'apply_runtime_dns' ? patchConfig() : null);
        try {
            await initDnsRewriteToggle();
            expect(toggle.checked).toBe(false);
            // A stale checkbox neither opts in nor hides a successful retry.
            toggle.checked = !enabled;
            getSetting.mockImplementation(async () => enabled);
            patchConfig.mockClear();
            getSetting.mockClear();
            const onSave = /** @type {() => Promise<void>} */ (/** @type {unknown} */ (listeners.mock.calls.find(([type]) => type === 'click')?.[1]));
            expect(onSave).toBeTypeOf('function');
            await onSave.call(saveButton);
            expect(getSetting).toHaveBeenCalledWith('dns_rewrite_enabled', null);
            expect(saveSettingsChecked).toHaveBeenCalledWith({ dns_nameservers: ['https://dns.example/dns-query'], dns_fallbacks: null });
            expect(patchConfig).toHaveBeenCalledTimes(enabled ? 1 : 0);
            if (enabled) expect(toggle.checked).toBe(true);
        } finally {
            listeners.mockRestore();
            getSetting.mockImplementation(async () => false);
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

    it.each([false, true])('retains unconfirmed intent and rejects disabled changes (enabled=%s)', async (enabled) => {
        vi.resetModules();
        document.body.innerHTML = '<input type="checkbox" id="dns-rewrite-toggle">';
        const toggle = /** @type {HTMLInputElement} */ (document.getElementById('dns-rewrite-toggle'));
        const { initDnsRewriteToggle } = await import('./dns-shared.js');
        const { Bus, Events } = await import('./events.js');
        const { showNotification } = await import('./notifications.js');
        const { invoke } = await import('../api.js');
        getConfig.mockReset();
        getConfig.mockResolvedValue({ dns: { enable: true } });
        getSetting.mockImplementation(async () => !enabled);
        patchConfig.mockReset();
        patchConfig.mockResolvedValue(undefined);
        await initDnsRewriteToggle();
        patchConfig.mockClear();
        vi.mocked(invoke).mockClear();
        patchConfig.mockRejectedValueOnce(new Error('DNS update outcome is unconfirmed; reload or restart the core, then retry'));
        toggle.checked = enabled;
        toggle.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(toggle.indeterminate).toBe(true));
        expect(toggle.disabled).toBe(true);
        expect(showNotification).toHaveBeenCalledWith(expect.stringContaining('reload or restart'), 'warning');
        toggle.dispatchEvent(new Event('change'));
        await Promise.resolve(); await Promise.resolve();
        expect(patchConfig).toHaveBeenCalledOnce();
        /** @type {Promise<unknown>[]} */
        const waits = [];
        Bus.emit(Events.CONFIG_UPDATED, { reloaded: true, waitFor: (done) => waits.push(done) });
        await Promise.all(waits);
        expect(toggle.indeterminate).toBe(false);
        expect(toggle.disabled).toBe(false);
        expect(toggle.checked).toBe(enabled);
        const writes = /** @type {any[]} */ (vi.mocked(invoke).mock.calls.filter(([command]) => command === 'apply_runtime_dns'));
        expect(writes.map(([, args]) => args.enabled)).toEqual(enabled ? [true, true] : [false]);
        // Pending off needs no overlay after reload; pending on needs exactly
        // one new restoration. The disabled synthetic event adds neither.
        expect(patchConfig).toHaveBeenCalledTimes(enabled ? 2 : 1);
        getSetting.mockImplementation(async () => false);
    });

    it('discards an old definite refusal after a newer reload is confirmed', async () => {
        vi.resetModules();
        document.body.innerHTML = '<input type="checkbox" id="dns-rewrite-toggle">';
        const toggle = /** @type {HTMLInputElement} */ (document.getElementById('dns-rewrite-toggle'));
        const { initDnsRewriteToggle } = await import('./dns-shared.js');
        const { Bus, Events } = await import('./events.js');
        const { showNotification } = await import('./notifications.js');
        getConfig.mockReset();
        getConfig.mockResolvedValue({ dns: { enable: true } });
        getSetting.mockImplementation(async () => false);
        patchConfig.mockReset();
        patchConfig.mockResolvedValue(undefined);
        await initDnsRewriteToggle();
        /** @type {(error: Error) => void} */
        let rejectOld = () => {};
        patchConfig.mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }));
        vi.mocked(showNotification).mockClear();
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(patchConfig).toHaveBeenCalledOnce());
        /** @type {Promise<unknown>[]} */
        const waits = [];
        Bus.emit(Events.CONFIG_UPDATED, { reloaded: true, waitFor: (done) => waits.push(done) });
        rejectOld(new Error('Core rejected DNS update with HTTP 400'));
        await Promise.all(waits);
        expect(toggle.indeterminate).toBe(false);
        expect(toggle.disabled).toBe(false);
        expect(toggle.checked).toBe(false);
        expect(showNotification).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'warning');
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(patchConfig).toHaveBeenCalledTimes(2));
    });

    it.each([false, true])('keeps a write crossing reload unknown until a later reload (native unknown=%s)', async (nativeUnknown) => {
        vi.resetModules();
        document.body.innerHTML = '<input type="checkbox" id="dns-rewrite-toggle">';
        const toggle = /** @type {HTMLInputElement} */ (document.getElementById('dns-rewrite-toggle'));
        const { initDnsRewriteToggle, dnsRewriteWanted } = await import('./dns-shared.js');
        const { Bus, Events } = await import('./events.js');
        getConfig.mockReset();
        getConfig.mockResolvedValue({ dns: { enable: true } });
        getSetting.mockImplementation(async () => false);
        patchConfig.mockReset();
        patchConfig.mockResolvedValue(undefined);
        await initDnsRewriteToggle();
        /** @type {() => void} */
        let finishWrite = () => {};
        patchConfig.mockImplementationOnce(() => new Promise((resolve, reject) => {
            finishWrite = () => nativeUnknown
                ? reject(new Error('DNS update outcome is unconfirmed; reload or restart the core, then retry'))
                : resolve(undefined);
        }));
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(patchConfig).toHaveBeenCalledOnce());
        /** @type {Promise<unknown>[]} */
        const waits = [];
        const waitFor = (/** @type {Promise<unknown>} */ done) => { waits.push(done); };
        Bus.emit(Events.CONFIG_UPDATED, { reloaded: true, waitFor });
        finishWrite();
        await Promise.all(waits);
        expect(toggle.indeterminate).toBe(true);
        expect(toggle.disabled).toBe(true);
        expect(await dnsRewriteWanted()).toBe(true);
        expect(patchConfig).toHaveBeenCalledOnce();
        waits.length = 0;
        Bus.emit(Events.CONFIG_UPDATED, { reloaded: true, waitFor });
        await Promise.all(waits);
        expect(toggle.indeterminate).toBe(false);
        expect(toggle.disabled).toBe(false);
        expect(toggle.checked).toBe(true);
        expect(patchConfig).toHaveBeenCalledTimes(2);
    });

    it('closes runtime admission before a server-save continuation resumes after an uncertain reload', async () => {
        vi.resetModules();
        document.body.innerHTML = '<input type="checkbox" id="dns-rewrite-toggle">'
            + '<textarea id="dns-nameservers-input">https://dns.example/dns-query</textarea>'
            + '<textarea id="dns-fallbacks-input"></textarea><button id="dns-config-save"></button>';
        const toggle = /** @type {HTMLInputElement} */ (document.getElementById('dns-rewrite-toggle'));
        const saveButton = /** @type {HTMLButtonElement} */ (document.getElementById('dns-config-save'));
        const listeners = vi.spyOn(saveButton, 'addEventListener');
        const { saveSettingsChecked } = await import('./settings-helpers.js');
        const { initDnsRewriteToggle } = await import('./dns-shared.js');
        const { Bus, Events } = await import('./events.js');
        getConfig.mockReset();
        getConfig.mockResolvedValue({ dns: { enable: true } });
        getSetting.mockImplementation(async () => false);
        patchConfig.mockReset();
        patchConfig.mockResolvedValue(undefined);
        await initDnsRewriteToggle();
        /** @type {() => void} */
        let releaseSave = () => {};
        vi.mocked(saveSettingsChecked).mockClear();
        vi.mocked(saveSettingsChecked).mockImplementationOnce(() => new Promise((resolve) => { releaseSave = () => resolve(true); }));
        getSetting.mockImplementation(async () => true);
        const onSave = /** @type {() => Promise<void>} */ (/** @type {unknown} */ (listeners.mock.calls.find(([type]) => type === 'click')?.[1]));
        const saving = onSave.call(saveButton);
        try {
            await vi.waitFor(() => expect(saveSettingsChecked).toHaveBeenCalledOnce());
            /** @type {Promise<unknown>[]} */
            const waits = [];
            Bus.emit(Events.CONFIG_UPDATED, { reloaded: false, restoreRuntime: true, waitFor: (done) => waits.push(done) });
            expect(toggle.disabled).toBe(true);
            expect(toggle.indeterminate).toBe(true);
            releaseSave();
            await saving;
            await Promise.all(waits);
            expect(patchConfig).not.toHaveBeenCalled();
        } finally {
            releaseSave();
            await saving;
            getSetting.mockImplementation(async () => false);
            listeners.mockRestore();
        }
    });

    it('clears the confirmed overlay indicator when the saved preference cannot be read after reload', async () => {
        vi.resetModules();
        document.body.innerHTML = '<input type="checkbox" id="dns-rewrite-toggle">';
        const toggle = /** @type {HTMLInputElement} */ (document.getElementById('dns-rewrite-toggle'));
        const { initDnsRewriteToggle } = await import('./dns-shared.js');
        const { Bus, Events } = await import('./events.js');
        getConfig.mockReset();
        getConfig.mockResolvedValue({ dns: { enable: true } });
        getSetting.mockImplementation(async () => true);
        patchConfig.mockReset();
        patchConfig.mockResolvedValue(undefined);
        try {
            await initDnsRewriteToggle();
            expect(toggle.checked).toBe(true);
            getSetting.mockRejectedValueOnce(new Error('settings unavailable'));
            const writes = patchConfig.mock.calls.length;
            /** @type {Promise<unknown>[]} */
            const waits = [];
            Bus.emit(Events.CONFIG_UPDATED, { reloaded: true, waitFor: (done) => waits.push(done) });
            expect(toggle.checked).toBe(false);
            await Promise.all(waits);
            expect(toggle.checked).toBe(false);
            expect(toggle.indeterminate).toBe(false);
            expect(patchConfig).toHaveBeenCalledTimes(writes);
        } finally {
            getSetting.mockImplementation(async () => false);
        }
    });

    it('rolls a definite refusal back to the confirmed overlay state rather than the saved on preference', async () => {
        vi.resetModules();
        vi.useFakeTimers();
        document.body.innerHTML = '<input type="checkbox" id="dns-rewrite-toggle">';
        const toggle = /** @type {HTMLInputElement} */ (document.getElementById('dns-rewrite-toggle'));
        const { initDnsRewriteToggle } = await import('./dns-shared.js');
        const { Bus, Events } = await import('./events.js');
        getConfig.mockReset();
        getConfig.mockResolvedValue({ dns: { enable: true } });
        getSetting.mockImplementation(async () => false);
        patchConfig.mockReset();
        patchConfig.mockResolvedValue(undefined);
        try {
            await initDnsRewriteToggle();
            getSetting.mockImplementation(async (key, fallback) => key === 'dns_rewrite_enabled' ? true : fallback);
            patchConfig.mockRejectedValue(new Error('Core rejected DNS update with HTTP 400'));
            /** @type {Promise<unknown>[]} */
            const waits = [];
            Bus.emit(Events.CONFIG_UPDATED, { reloaded: true, waitFor: (done) => waits.push(done) });
            await vi.advanceTimersByTimeAsync(2500);
            await Promise.all(waits);
            expect(toggle.checked).toBe(false);
            toggle.checked = true;
            toggle.dispatchEvent(new Event('change'));
            await vi.advanceTimersByTimeAsync(0);
            expect(toggle.checked).toBe(false);
            expect(toggle.indeterminate).toBe(false);
        } finally {
            getSetting.mockImplementation(async () => false);
            patchConfig.mockReset();
            patchConfig.mockResolvedValue(undefined);
            vi.useRealTimers();
        }
    });

    it('keeps a later disable after a reset in both runtime and preferences', async () => {
        vi.resetModules();
        document.body.innerHTML = '<input type="checkbox" id="dns-rewrite-toggle">';
        const toggle = /** @type {HTMLInputElement} */ (document.getElementById('dns-rewrite-toggle'));
        const { invoke } = await import('../api.js');
        const { saveSettingsChecked } = await import('./settings-helpers.js');
        const { initDnsRewriteToggle, resetDnsDefaults } = await import('./dns-shared.js');
        getConfig.mockReset();
        getConfig.mockResolvedValue({ dns: { enable: true } });
        getSetting.mockImplementation(async () => false);
        await initDnsRewriteToggle();
        /** @type {() => void} */
        let finishReset = () => {};
        const held = new Promise((resolve) => { finishReset = () => resolve(undefined); });
        /** @type {string[]} */
        const order = [];
        vi.mocked(invoke).mockImplementation(async (command, args) => {
            if (command !== 'apply_runtime_dns') return null;
            order.push(args.enabled ? 'enable' : 'disable');
            if (args.enabled) await held;
            return null;
        });
        vi.mocked(saveSettingsChecked).mockImplementation(async () => { order.push('save-reset'); return true; });
        saveSettingChecked.mockImplementation(async (_key, enabled) => { order.push(`save:${enabled}`); return true; });
        const reset = resetDnsDefaults();
        try {
            await vi.waitFor(() => expect(order).toEqual(['enable']));
            toggle.checked = false;
            toggle.dispatchEvent(new Event('change'));
            finishReset();
            await reset;
            await vi.waitFor(() => expect(order).toEqual(['enable', 'save-reset', 'disable', 'save:false']));
            expect(toggle.checked).toBe(false);
            expect(saveSettingsChecked).toHaveBeenCalledWith({ dns_rewrite_enabled: true, dns_nameservers: null, dns_fallbacks: null });
        } finally {
            finishReset();
            await reset;
            vi.mocked(invoke).mockImplementation(async (command) => command === 'apply_runtime_dns' ? patchConfig() : null);
            vi.mocked(saveSettingsChecked).mockImplementation(async () => true);
            saveSettingChecked.mockImplementation(async () => true);
        }
    });

    it.each([true, false])('retains default servers after an unsaved reset when the next choice is %s', async (enabled) => {
        vi.resetModules();
        document.body.innerHTML = '<input type="checkbox" id="dns-rewrite-toggle"><button id="dns-config-btn"></button>'
            + '<textarea id="dns-nameservers-input"></textarea><textarea id="dns-fallbacks-input"></textarea>';
        const { invoke } = await import('../api.js');
        const { saveSettingsChecked } = await import('./settings-helpers.js');
        const { initDnsRewriteToggle, resetDnsDefaults, DEFAULT_DNS_CONFIG } = await import('./dns-shared.js');
        const { Bus, Events } = await import('./events.js');
        getConfig.mockReset();
        getConfig.mockResolvedValue({ dns: { enable: true } });
        getSetting.mockImplementation(async () => false);
        vi.mocked(invoke).mockClear();
        vi.mocked(invoke).mockImplementation(async (command) => command === 'get_settings'
            ? { dns_nameservers: ['https://old.example/dns-query'], dns_fallbacks: ['9.9.9.9'] } : null);
        vi.mocked(saveSettingsChecked).mockClear();
        vi.mocked(saveSettingsChecked).mockRejectedValueOnce(new Error('disk full'));
        try {
            await initDnsRewriteToggle();
            await expect(resetDnsDefaults()).rejects.toThrow('disk full');
            document.getElementById('dns-config-btn')?.click();
            await vi.waitFor(() => expect(/** @type {HTMLTextAreaElement} */ (document.getElementById('dns-nameservers-input')).value).toBe(DEFAULT_DNS_CONFIG.nameserver.join('\n')));
            expect(/** @type {HTMLTextAreaElement} */ (document.getElementById('dns-fallbacks-input')).value).toBe(DEFAULT_DNS_CONFIG.fallback.join('\n'));
            /** @type {Promise<unknown>[]} */
            const waits = [];
            if (enabled) {
                Bus.emit(Events.CONFIG_UPDATED, { reloaded: true, waitFor: (done) => waits.push(done) });
                await Promise.all(waits);
            } else {
                const toggle = /** @type {HTMLInputElement} */ (document.getElementById('dns-rewrite-toggle'));
                toggle.checked = false;
                toggle.dispatchEvent(new Event('change'));
                await vi.waitFor(() => expect(saveSettingsChecked).toHaveBeenCalledTimes(2));
            }
            const writes = /** @type {any[]} */ (vi.mocked(invoke).mock.calls.filter(([command]) => command === 'apply_runtime_dns'));
            expect(writes).toHaveLength(2);
            expect(writes[1][1].enabled).toBe(enabled);
            if (enabled) {
                expect(writes[1][1].dns.nameserver).toEqual(DEFAULT_DNS_CONFIG.nameserver);
                expect(writes[1][1].dns.fallback).toEqual(DEFAULT_DNS_CONFIG.fallback);
                expect(saveSettingsChecked).toHaveBeenLastCalledWith({ dns_rewrite_enabled: true, dns_nameservers: null, dns_fallbacks: null }, expect.any(Function));
            } else {
                expect(saveSettingsChecked).toHaveBeenLastCalledWith({ dns_rewrite_enabled: false, dns_nameservers: null, dns_fallbacks: null });
            }
        } finally {
            vi.mocked(invoke).mockImplementation(async (command) => command === 'apply_runtime_dns' ? patchConfig() : null);
            vi.mocked(saveSettingsChecked).mockImplementation(async () => true);
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
