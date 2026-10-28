// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** @type {Record<string, any>} */
const responses = {};
/** @type {((e: any) => void) | null} */
let progressHandler = null;
const invoke = vi.fn(async (/** @type {string} */ cmd) => {
    const r = responses[cmd];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r() : r;
});
vi.mock('../api.js', () => ({
    invoke: (/** @type {string} */ cmd, /** @type {any} */ args) => invoke(cmd, args),
    listen: vi.fn(async (/** @type {string} */ _name, /** @type {any} */ fn) => { progressHandler = fn; return () => { progressHandler = null; }; }),
    openUrl: vi.fn(async () => {}),
    getCurrentWindow: () => ({ isVisible: async () => (visibleGate ? visibleGate : windowVisible) }),
}));
let windowVisible = true;
/** @type {Promise<boolean> | null} A pending visibility answer, when a test holds it. */
let visibleGate = null;

const showNotification = vi.fn();
vi.mock('./notifications.js', () => ({ showNotification: (/** @type {any[]} */ ...a) => showNotification(...a) }));

const { openUpdateDialog, stageFromStatus, showPendingUpdateNote, releaseNoteHref, _resetUpdateDialogForTests } = await import('./update-dialog.js');
const { appStore } = await import('./state.js');
const { openUrl, listen } = await import('../api.js');

const flush = () => new Promise((r) => setTimeout(r, 0));
const phase = () => document.getElementById('update-dialog')?.dataset.phase;
const click = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id)).click();
const calls = (/** @type {string} */ cmd) => invoke.mock.calls.filter((c) => c[0] === cmd).length;

beforeEach(() => {
    _resetUpdateDialogForTests();
    document.body.innerHTML = '';
    localStorage.clear();
    invoke.mockClear();
    showNotification.mockClear();
    appStore.set('isNetworkUpdating', false);
    windowVisible = true;
    visibleGate = null;
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    Object.assign(responses, {
        get_latest_version: { version: 'v1.19.0', download_url: 'https://x/core.gz' },
        get_latest_client_version: { version: '1.2.0', release_notes: '## Fixes\n- one' },
        get_app_version: '1.2.0',
        get_core_version: 'v1.19.0',
        get_portable_mode: false,
        update_core: { port: 9090, secret: 's' },
        update_client: 'ok',
    });
});

describe('update dialog', () => {
    it('says up to date when nothing is newer', async () => {
        openUpdateDialog();
        expect(phase()).toBe('checking');
        await flush();
        expect(phase()).toBe('latest');
        expect(document.getElementById('upd-close')).not.toBeNull();
    });

    it('never runs two checks at once', async () => {
        /** @type {(v: any) => void} */
        let release = () => {};
        responses.get_latest_version = () => new Promise((r) => { release = r; });
        openUpdateDialog();
        openUpdateDialog();
        click('upd-x');
        openUpdateDialog();
        expect(calls('get_latest_version')).toBe(1);
        release({ version: 'v1.19.0' });
        await flush();
        expect(phase()).toBe('latest');
    });

    it('shows a failed check with a retry instead of "up to date"', async () => {
        responses.get_latest_client_version = new Error('timeout');
        openUpdateDialog();
        await flush();
        expect(phase()).toBe('check-failed');
        expect(document.querySelector('.upd-error')?.textContent).toContain('timeout');
        responses.get_latest_client_version = { version: '1.2.0' };
        click('upd-retry-check');
        await flush();
        expect(phase()).toBe('latest');
    });

    it('installs a core update with progress and refreshes the app', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'https://x/core.gz' };
        /** @type {(v: any) => void} */
        let finish = () => {};
        responses.update_core = () => new Promise((r) => { finish = r; });
        const onCoreUpdated = vi.fn();
        openUpdateDialog({ onCoreUpdated });
        await flush();
        expect(phase()).toBe('available');
        expect(document.querySelector('.upd-new')?.textContent).toBe('v1.20.0');
        click('upd-install');
        await flush();
        expect(phase()).toBe('installing');
        expect(document.getElementById('upd-install')).toBeNull(); // no second download
        openUpdateDialog({ onCoreUpdated }); // reopening only shows the progress
        progressHandler?.({ payload: { component: 'core', progress: 42, status_text: 'Downloading... 42%' } });
        progressHandler?.({ payload: { component: 'client', progress: 90, status_text: 'x' } });
        expect(document.getElementById('upd-pct')?.textContent).toBe('42%');
        responses.get_core_version = 'v1.20.0';
        finish({ port: 1, secret: 'z' });
        await flush(); await flush();
        expect(phase()).toBe('done');
        expect(onCoreUpdated).toHaveBeenCalledWith({ port: 1, secret: 'z' });
        expect(calls('update_core')).toBe(1);
    });

    it('updates the core before the app package when both have updates, and retries only what failed', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        responses.get_latest_client_version = { version: '1.3.0', release_notes: '- new' };
        responses.update_client = new Error('SHA256 verification failed');
        openUpdateDialog();
        await flush();
        expect(document.querySelector('.upd-notes')?.textContent).toContain('new');
        click('upd-install');
        await flush(); await flush(); await flush(); await flush();
        expect(phase()).toBe('install-failed');
        const order = invoke.mock.calls.map((c) => c[0]).filter((c) => c === 'update_core' || c === 'update_client');
        expect(order).toEqual(['update_core', 'update_client']);
        expect(appStore.get('isNetworkUpdating')).toBe(false);
        expect(document.getElementById('update-dialog')?.textContent).toContain('The core is updated, but the app update didn’t finish.');
        responses.update_client = 'ok';
        click('upd-retry-install');
        await flush(); await flush();
        expect(phase()).toBe('done');
        expect(document.getElementById('update-dialog')?.textContent).toContain('The core is updated. Follow the installer');
        expect(calls('update_core')).toBe(1);
        expect(calls('update_client')).toBe(2);
        expect(calls('get_latest_version')).toBe(1);
    });

    it('offers the Lite package when both have updates and passes the choice to the backend', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        responses.get_latest_client_version = { version: '1.3.0', release_notes: '- new' };
        openUpdateDialog();
        await flush();
        expect(phase()).toBe('available');
        expect(document.getElementById('upd-lite')).not.toBeNull();
        click('upd-lite');
        await flush(); await flush(); await flush();
        expect(phase()).toBe('done');
        const order = invoke.mock.calls.map((c) => c[0]).filter((c) => c === 'update_core' || c === 'update_client');
        expect(order).toEqual(['update_core', 'update_client']);
        const clientCalls = invoke.mock.calls.filter((c) => c[0] === 'update_client');
        expect(clientCalls.length).toBe(1);
        expect(clientCalls[0]?.[1]).toEqual({ variant: 'lite' });
    });

    it('passes the Full variant for the recommended dual update', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        responses.get_latest_client_version = { version: '1.3.0' };
        openUpdateDialog();
        await flush();
        click('upd-install');
        await flush(); await flush(); await flush();
        expect(phase()).toBe('done');
        const clientCalls = invoke.mock.calls.filter((c) => c[0] === 'update_client');
        expect(clientCalls.length).toBe(1);
        expect(clientCalls[0]?.[1]).toEqual({ variant: 'full' });
    });

    it('offers no Lite choice for an app-only update and passes no variant', async () => {
        responses.get_latest_client_version = { version: '1.3.0' };
        openUpdateDialog();
        await flush();
        expect(phase()).toBe('available');
        expect(document.getElementById('upd-lite')).toBeNull();
        click('upd-install');
        await flush(); await flush();
        expect(phase()).toBe('done');
        const clientCalls = invoke.mock.calls.filter((c) => c[0] === 'update_client');
        expect(clientCalls.length).toBe(1);
        expect(clientCalls[0]?.[1]).toBeUndefined();
    });

    it('keeps the core refresh warning when only the app installer is retried', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        responses.get_latest_client_version = { version: '1.3.0' };
        responses.update_client = new Error('SHA256 verification failed');
        openUpdateDialog({ onCoreUpdated: () => Promise.reject(new Error('ws down')) });
        await flush();
        click('upd-install');
        await flush(); await flush(); await flush(); await flush();
        expect(phase()).toBe('install-failed');
        expect(document.getElementById('update-dialog')?.textContent).toContain('couldn’t refresh');
        responses.update_client = 'ok';
        click('upd-retry-install');
        await flush(); await flush();
        expect(phase()).toBe('done');
        expect(document.querySelector('.upd-error')?.textContent).toContain('couldn’t refresh');
        expect(calls('update_core')).toBe(1);
    });

    it('names the finished core when the app installer fails with the dialog closed', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        responses.get_latest_client_version = { version: '1.3.0' };
        responses.update_client = new Error('still broken');
        openUpdateDialog();
        await flush();
        click('upd-install');
        click('upd-x');
        await flush(); await flush(); await flush(); await flush();
        expect(showNotification).toHaveBeenLastCalledWith(
            'The core is updated, but the app update didn’t finish. still broken', 'error', 'Update failed');
    });

    it('treats an unreadable portable mode as portable and reports it', async () => {
        responses.get_latest_client_version = { version: '1.3.0' };
        responses.get_portable_mode = new Error('ipc down');
        openUpdateDialog();
        await flush();
        expect(phase()).toBe('available');
        expect(document.getElementById('upd-install')).toBeNull();
        expect(document.getElementById('upd-releases')).not.toBeNull();
        expect(document.querySelector('.upd-error')?.textContent).toContain('ipc down');
    });

    it('keeps the done view but warns when the app could not refresh after a core update', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        openUpdateDialog({ onCoreUpdated: () => Promise.reject(new Error('ws down')) });
        await flush();
        click('upd-install');
        await flush(); await flush(); await flush();
        expect(phase()).toBe('done');
        expect(document.querySelector('.upd-error')?.textContent).toContain('couldn’t refresh');
        expect(document.getElementById('upd-retry-install')).toBeNull();
    });

    it('says saved choices may not be restored when recovery after a core update fails', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        openUpdateDialog({ onCoreUpdated: () => Promise.reject(Object.assign(new Error('override failed'), { recovery: true })) });
        await flush();
        click('upd-install');
        await flush(); await flush(); await flush();
        expect(phase()).toBe('done');
        const warn = document.querySelector('.upd-error')?.textContent || '';
        expect(warn).toContain('couldn’t be restored');
        expect(warn).not.toContain('couldn’t refresh');
    });

    it('warns that closing quits when close-to-tray is off', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        let quits = true;
        responses.update_core = () => new Promise(() => {});
        openUpdateDialog({ closeQuits: () => quits });
        await flush();
        click('upd-install');
        await flush();
        expect(document.querySelector('.upd-hint')?.textContent).toContain('Closing the window quits it');
        quits = false;
        openUpdateDialog({ closeQuits: () => quits });
        expect(document.querySelector('.upd-hint')?.textContent).toContain('won’t stop the update');
    });

    it('notifies how an install ended when the dialog was closed meanwhile', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        /** @type {(v: any) => void} */
        let fail = () => {};
        responses.update_core = () => new Promise((_r, rej) => { fail = rej; });
        openUpdateDialog();
        await flush();
        click('upd-install');
        await flush();
        click('upd-x');
        fail(new Error('disk full'));
        await flush(); await flush();
        expect(showNotification).toHaveBeenCalledWith('disk full', 'error', 'Update failed');
    });

    it('still notifies a failure when the dialog is reopened while the outcome is being reported', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        /** @type {(v: any) => void} */
        let fail = () => {};
        responses.update_core = () => new Promise((_r, rej) => { fail = rej; });
        openUpdateDialog();
        await flush();
        click('upd-install');
        await flush();
        click('upd-x');
        /** @type {(v: boolean) => void} */
        let answer = () => {};
        visibleGate = new Promise((r) => { answer = r; });
        fail(new Error('disk full'));
        await flush();
        // Reopened while the visibility check is pending: a new check replaces the result.
        openUpdateDialog();
        answer(true);
        await flush(); await flush();
        expect(showNotification).toHaveBeenCalledWith('disk full', 'error', 'Update failed');
    });

    it('puts the recovery warning and the partial check into a failed install notification', async () => {
        responses.get_latest_version = new Error('rate limited');
        responses.get_latest_client_version = { version: '1.3.0' };
        responses.update_client = new Error('still broken');
        openUpdateDialog();
        await flush();
        click('upd-install');
        click('upd-x');
        await flush(); await flush(); await flush();
        expect(phase()).toBeUndefined();
        const msg = showNotification.mock.calls.at(-1)?.[0] || '';
        expect(msg).toContain('still broken');
        expect(msg).toContain('rate limited');
    });

    it('keeps the installer step next to a warning in the notification', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        responses.get_latest_client_version = { version: '1.3.0' };
        openUpdateDialog({ onCoreUpdated: () => Promise.reject(new Error('ws down')) });
        await flush();
        click('upd-install');
        click('upd-x');
        await flush(); await flush(); await flush(); await flush();
        const [msg, type] = showNotification.mock.calls.at(-1) || [];
        expect(type).toBe('warning');
        expect(msg).toContain('Follow the installer');
        expect(msg).toContain('couldn’t refresh');
    });

    it('sits under the shared modal and leaves Escape to it while it is open', async () => {
        const shared = document.createElement('div');
        shared.id = 'modal-bg';
        document.body.appendChild(shared);
        openUpdateDialog();
        await flush();
        expect(document.getElementById('update-dialog')?.style.zIndex).toBe('calc(var(--z-modal) - 1)');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(document.getElementById('update-dialog')).not.toBeNull();
        shared.classList.add('hidden');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(document.getElementById('update-dialog')).toBeNull();
    });

    it('sends portable builds to the releases page', async () => {
        responses.get_latest_client_version = { version: '1.3.0' };
        responses.get_portable_mode = true;
        openUpdateDialog();
        await flush();
        expect(document.getElementById('upd-install')).toBeNull();
        expect(document.getElementById('upd-releases')).not.toBeNull();
    });

    it('treats an unreadable installed version as a failed check, not "up to date"', async () => {
        responses.get_core_version = new Error('core binary not found');
        openUpdateDialog();
        await flush();
        expect(phase()).toBe('check-failed');
        expect(document.querySelector('.upd-error')?.textContent).toContain('core binary not found');
        _resetUpdateDialogForTests();
        responses.get_core_version = '';
        openUpdateDialog();
        await flush();
        expect(phase()).toBe('check-failed');
    });

    it('treats non-version core output as an unread version, not an old one', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        responses.get_core_version = 'Mihomo Meta alpha-3f2a1c linux arm64';
        openUpdateDialog();
        await flush();
        expect(phase()).toBe('check-failed');
        expect(document.querySelector('.upd-error')?.textContent).toContain('installed version');
        expect(document.getElementById('upd-install')).toBeNull();
    });

    it.each(['v1.20.0-alpha.', 'v1.20.0-', 'v1.20.0-rc..1'])('treats a malformed core tag as a failed check (%s)', async (tag) => {
        responses.get_latest_version = { version: tag, download_url: 'u' };
        openUpdateDialog();
        await flush();
        expect(phase()).toBe('check-failed');
        expect(document.querySelector('.upd-error')?.textContent).toContain('latest version');
    });

    it('offers a core tag with build metadata after its pre-release, as the updater accepts it', async () => {
        responses.get_latest_version = { version: 'v1.20.0-rc+build', download_url: 'u' };
        openUpdateDialog();
        await flush();
        expect(phase()).toBe('available');
        expect(document.getElementById('upd-install')).not.toBeNull();
    });

    it('treats a published version that is empty or not a version as a failed check', async () => {
        responses.get_latest_version = { version: 'nightly', download_url: 'u' };
        openUpdateDialog();
        await flush();
        expect(phase()).toBe('check-failed');
        expect(document.querySelector('.upd-error')?.textContent).toContain('latest version');
        _resetUpdateDialogForTests();
        responses.get_latest_version = { version: 'v1.19.0', download_url: 'u' };
        responses.get_latest_client_version = { version: '', release_notes: '' };
        openUpdateDialog();
        await flush();
        expect(phase()).toBe('check-failed');
    });

    it('still reports the result when the dialog closes while the progress listener detaches', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        /** @type {() => void} */
        let detach = () => {};
        vi.mocked(listen).mockImplementationOnce(async () => () => new Promise((r) => { detach = () => r(undefined); }));
        openUpdateDialog();
        await flush();
        click('upd-install');
        await flush(); await flush();
        expect(phase()).toBe('installing');
        click('upd-x');
        detach();
        await flush(); await flush();
        expect(showNotification).toHaveBeenCalledWith('The new core is running.', 'success', 'Core updated');
    });

    it('announces each phase once instead of making the whole card a live region', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        responses.update_core = () => new Promise(() => {});
        openUpdateDialog();
        await flush();
        expect(document.querySelector('.upd-card')?.hasAttribute('aria-live')).toBe(false);
        const status = /** @type {HTMLElement} */ (document.getElementById('upd-status'));
        expect(status.getAttribute('aria-live')).toBe('polite');
        expect(status.textContent).toBe('Update available');
        click('upd-install');
        await flush();
        expect(status.textContent).toBe('Updating the core');
        status.textContent = '';
        progressHandler?.({ payload: { component: 'core', progress: 40, status_text: 'downloading' } });
        expect(status.textContent).toBe('');
        expect(document.getElementById('upd-pct')?.textContent).toBe('40%');
    });

    it('announces the app step of a dual update', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        responses.get_latest_client_version = { version: '1.3.0' };
        responses.update_client = () => new Promise(() => {});
        /** @type {(v: any) => void} */
        let coreDone = () => {};
        responses.update_core = () => new Promise((r) => { coreDone = r; });
        openUpdateDialog();
        await flush();
        const status = /** @type {HTMLElement} */ (document.getElementById('upd-status'));
        click('upd-install');
        await flush();
        expect(status.textContent).toBe('Updating the core');
        coreDone({ port: 9090, secret: 's' });
        await flush(); await flush(); await flush();
        expect(status.textContent).not.toBe('Updating the core');
        expect(status.textContent).toBe(document.querySelector('.upd-title')?.textContent);
    });

    it('drops a failed run\'s report when a retry starts while it is still reporting', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        responses.update_core = new Error('disk full');
        openUpdateDialog();
        await flush();
        /** @type {(v: boolean) => void} */
        let answer = () => {};
        visibleGate = new Promise((r) => { answer = r; });
        click('upd-install');
        await flush(); await flush(); await flush();
        expect(phase()).toBe('install-failed');
        // The first run is still asking whether the window is seen; Retry now.
        visibleGate = null;
        responses.update_core = { port: 9090, secret: 's' };
        click('upd-retry-install');
        await flush(); await flush(); await flush();
        expect(phase()).toBe('done');
        answer(false);
        await flush(); await flush(); await flush();
        expect(calls('rate_limited_send_notification')).toBe(0);
        expect(showNotification).not.toHaveBeenCalled();
        expect(calls('end_update_hold')).toBe(1);
    });

    it('ends the core run\'s page hold from an app-only retry that superseded it', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        responses.get_latest_client_version = { version: '1.3.0' };
        responses.update_client = new Error('installer failed');
        openUpdateDialog();
        await flush();
        /** @type {(v: boolean) => void} */
        let answer = () => {};
        visibleGate = new Promise((r) => { answer = r; });
        click('upd-install');
        for (let i = 0; i < 6; i++) await flush();
        expect(phase()).toBe('install-failed');
        // The core run is still reporting; Retry installs only the app.
        visibleGate = null;
        responses.update_client = 'ok';
        click('upd-retry-install');
        for (let i = 0; i < 6; i++) await flush();
        answer(false);
        for (let i = 0; i < 6; i++) await flush();
        expect(calls('update_core')).toBe(1);
        expect(calls('end_update_hold')).toBe(1);
    });

    it('sends an OS notification when the window is hidden to the tray with the dialog open', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        /** @type {(v: any) => void} */
        let fail = () => {};
        responses.update_core = () => new Promise((_r, rej) => { fail = rej; });
        openUpdateDialog();
        await flush();
        click('upd-install');
        await flush();
        windowVisible = false;
        fail(new Error('disk full'));
        await flush(); await flush(); await flush();
        expect(phase()).toBe('install-failed');
        expect(invoke).toHaveBeenCalledWith('rate_limited_send_notification', { title: 'Update failed', body: 'disk full' });
        expect(showNotification).not.toHaveBeenCalled();
    });

    it('falls back to a toast when the OS notification fails', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        responses.rate_limited_send_notification = new Error('denied');
        /** @type {(v: any) => void} */
        let fail = () => {};
        responses.update_core = () => new Promise((_r, rej) => { fail = rej; });
        openUpdateDialog();
        await flush();
        click('upd-install');
        await flush();
        click('upd-x');
        windowVisible = false;
        fail(new Error('disk full'));
        await flush(); await flush(); await flush();
        // A toast in the hidden window would time out unseen: it waits for the window.
        expect(showNotification).not.toHaveBeenCalled();
        window.dispatchEvent(new Event('focus'));
        expect(showNotification).toHaveBeenCalledWith('disk full', 'error', 'Update failed');
        window.dispatchEvent(new Event('focus'));
        expect(showNotification).toHaveBeenCalledTimes(1);
        delete responses.rate_limited_send_notification;
    });

    it('shows no toast on return when the dialog left open shows the outcome', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        responses.rate_limited_send_notification = new Error('denied');
        /** @type {(v: any) => void} */
        let fail = () => {};
        responses.update_core = () => new Promise((_r, rej) => { fail = rej; });
        openUpdateDialog();
        await flush();
        click('upd-install');
        await flush();
        windowVisible = false;
        fail(new Error('disk full'));
        await flush(); await flush(); await flush();
        expect(localStorage.getItem('zephyr.updateNotePending')).not.toBeNull();
        windowVisible = true;
        window.dispatchEvent(new Event('focus'));
        await flush();
        expect(phase()).toBe('install-failed');
        expect(showNotification).not.toHaveBeenCalled();
        expect(localStorage.getItem('zephyr.updateNotePending')).toBeNull();
        delete responses.rate_limited_send_notification;
    });

    it('keeps an unseen result for the page that replaces a destroyed one', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        responses.rate_limited_send_notification = new Error('denied');
        /** @type {(v: any) => void} */
        let fail = () => {};
        responses.update_core = () => new Promise((_r, rej) => { fail = rej; });
        openUpdateDialog();
        await flush();
        click('upd-install');
        await flush();
        windowVisible = false;
        fail(new Error('disk full'));
        await flush(); await flush(); await flush();
        expect(showNotification).not.toHaveBeenCalled();
        // A new page (no focus listener) shows it on load, once.
        windowVisible = true;
        await showPendingUpdateNote();
        expect(showNotification).toHaveBeenCalledWith('disk full', 'error', 'Update failed');
        await showPendingUpdateNote();
        window.dispatchEvent(new Event('focus'));
        await flush();
        expect(showNotification).toHaveBeenCalledTimes(1);
        delete responses.rate_limited_send_notification;
    });

    it('keeps a saved result while a page loads hidden, until the window comes back', async () => {
        localStorage.setItem('zephyr.updateNotePending', JSON.stringify({ msg: 'disk full', type: 'error', title: 'Update failed' }));
        windowVisible = false;
        await showPendingUpdateNote();
        expect(showNotification).not.toHaveBeenCalled();
        expect(localStorage.getItem('zephyr.updateNotePending')).not.toBeNull();
        window.dispatchEvent(new Event('focus'));
        await flush();
        expect(showNotification).toHaveBeenCalledWith('disk full', 'error', 'Update failed');
        expect(localStorage.getItem('zephyr.updateNotePending')).toBeNull();
    });

    it('shows a saved result when focus returns while the visibility check runs', async () => {
        localStorage.setItem('zephyr.updateNotePending', JSON.stringify({ msg: 'disk full', type: 'error', title: 'Update failed' }));
        windowVisible = false;
        const pending = showPendingUpdateNote();
        window.dispatchEvent(new Event('focus'));
        await pending;
        await flush();
        expect(showNotification).toHaveBeenCalledTimes(1);
        expect(showNotification).toHaveBeenCalledWith('disk full', 'error', 'Update failed');
    });

    it.each(['1.20.0', 'v1.20.0+build'])('does not offer a core tag the core updater refuses (%s)', async (tag) => {
        responses.get_latest_version = { version: tag, download_url: 'u' };
        openUpdateDialog();
        await flush(); await flush();
        expect(document.getElementById('upd-install')).toBeNull();
    });

    it('does not offer a published version that is not a version number', async () => {
        responses.get_latest_version = { version: 'v9.0.0 nightly', download_url: 'u' };
        openUpdateDialog();
        await flush(); await flush();
        expect(document.getElementById('upd-install')).toBeNull();
    });

    it('stays quiet when the open dialog is in view', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        openUpdateDialog();
        await flush();
        click('upd-install');
        await flush(); await flush(); await flush();
        expect(phase()).toBe('done');
        expect(showNotification).not.toHaveBeenCalled();
        expect(calls('rate_limited_send_notification')).toBe(0);
    });

    it('still shows a failed source next to an update that was found', async () => {
        responses.get_latest_version = new Error('rate limited');
        responses.get_latest_client_version = { version: '1.3.0' };
        openUpdateDialog();
        await flush();
        expect(phase()).toBe('available');
        expect(document.querySelector('.upd-error')?.textContent).toContain('rate limited');
    });

    it('keeps a failed core check when the app then turns out current', async () => {
        responses.get_latest_version = new Error('rate limited');
        responses.get_latest_client_version = { version: '1.3.0' };
        responses.update_client = 'Already up to date';
        openUpdateDialog();
        await flush();
        click('upd-install');
        await flush(); await flush();
        expect(phase()).toBe('done');
        const text = document.getElementById('update-dialog')?.textContent || '';
        expect(text).toContain('The app is up to date');
        expect(text).not.toContain('You’re up to date');
        expect(text).not.toContain('Zephyr and its core are on the latest versions.');
        expect(document.querySelector('.upd-error')?.textContent).toContain('rate limited');
    });

    it('keeps a failed app check in the result after the core installs', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        responses.get_latest_client_version = new Error('rate limited');
        openUpdateDialog();
        await flush();
        click('upd-install');
        await flush(); await flush(); await flush();
        expect(phase()).toBe('done');
        expect(document.querySelector('.upd-error')?.textContent).toContain('rate limited');
    });

    it('keeps a failed core check in the result and the notification after the app installs', async () => {
        responses.get_latest_version = new Error('rate limited');
        responses.get_latest_client_version = { version: '1.3.0' };
        openUpdateDialog();
        await flush();
        windowVisible = false;
        click('upd-install');
        await flush(); await flush(); await flush();
        expect(phase()).toBe('done');
        expect(document.querySelector('.upd-error')?.textContent).toContain('rate limited');
        const note = invoke.mock.calls.find((c) => c[0] === 'rate_limited_send_notification');
        expect(note?.[1]?.body).toContain('rate limited');
    });

    it('does not read a version with trailing junk as a version', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        responses.get_core_version = '1.19.0junk';
        openUpdateDialog();
        await flush();
        expect(phase()).toBe('check-failed');
        _resetUpdateDialogForTests();
        responses.get_core_version = 'v1.19.0-alpha+build.5';
        openUpdateDialog();
        await flush();
        expect(phase()).toBe('available');
    });

    it('does not offer a core tag the updater would refuse (not three parts)', async () => {
        responses.get_latest_version = { version: 'v1.20', download_url: 'u' };
        openUpdateDialog();
        await flush();
        expect(phase()).toBe('check-failed');
    });

    it('runs a fresh check when a result finished while the dialog was closed', async () => {
        /** @type {(v: any) => void} */
        let release = () => {};
        responses.get_latest_version = () => new Promise((r) => { release = r; });
        openUpdateDialog();
        click('upd-x');
        release({ version: 'v1.19.0' });
        await flush();
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        openUpdateDialog();
        expect(phase()).toBe('checking');
        await flush();
        expect(phase()).toBe('available');
        expect(calls('get_latest_version')).toBe(2);
    });

    it('shows only the new core version once it is installed', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        openUpdateDialog();
        await flush();
        responses.get_core_version = 'v1.20.0';
        click('upd-install');
        await flush(); await flush(); await flush();
        expect(phase()).toBe('done');
        expect(document.querySelector('.upd-arrow')).toBeNull();
        expect(document.querySelector('.upd-rows')?.textContent).toContain('v1.20.0');
    });

    it('holds the network lock during a core update and refuses while another change runs', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        /** @type {(v: any) => void} */
        let finish = () => {};
        responses.update_core = () => new Promise((r) => { finish = r; });
        openUpdateDialog();
        await flush();
        appStore.set('isNetworkUpdating', true);
        click('upd-install');
        await flush();
        expect(phase()).toBe('install-failed');
        expect(calls('update_core')).toBe(0);
        appStore.set('isNetworkUpdating', false);
        click('upd-retry-install');
        await flush();
        expect(phase()).toBe('installing');
        expect(appStore.get('isNetworkUpdating')).toBe(true);
        finish({ port: 1, secret: 'z' });
        await flush(); await flush(); await flush();
        expect(phase()).toBe('done');
        expect(appStore.get('isNetworkUpdating')).toBe(false);
    });

    it('offers the releases page and a core-only update to portable builds with both updates', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        responses.get_latest_client_version = { version: '1.3.0' };
        responses.get_portable_mode = true;
        openUpdateDialog();
        await flush();
        expect(document.getElementById('upd-releases')?.className).toBe('btn-ghost');
        expect(document.getElementById('upd-install')?.textContent).toBe('Update core only');
        click('upd-install');
        await flush(); await flush(); await flush();
        expect(calls('update_core')).toBe(1);
        expect(calls('update_client')).toBe(0);
        // Done with the core: the app update is still a click away.
        expect(phase()).toBe('done');
        expect(document.getElementById('upd-releases')?.className).toBe('btn-primary');
        expect(document.getElementById('upd-close')?.className).toBe('btn-ghost');
    });

    it('opens release-note links in the system browser', async () => {
        responses.get_latest_client_version = { version: '1.3.0', release_notes: '[changelog](https://example.com/c)' };
        openUpdateDialog();
        await flush();
        const link = /** @type {HTMLAnchorElement} */ (document.querySelector('.upd-notes a'));
        const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
        link.dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(true);
        expect(openUrl).toHaveBeenCalledWith('https://example.com/c');
        expect(phase()).toBe('available');
    });

    it('resolves relative release-note links against the releases page and drops the rest', () => {
        expect(releaseNoteHref('https://example.com/c')).toBe('https://example.com/c');
        expect(releaseNoteHref('../compare/v1...v2')).toBe('https://github.com/Juwan-Hwang/Zephyr/compare/v1...v2');
        expect(releaseNoteHref('/Juwan-Hwang/Zephyr/issues')).toBe('https://github.com/Juwan-Hwang/Zephyr/issues');
        expect(releaseNoteHref('#fixes')).toBe('');
        expect(releaseNoteHref('mailto:a@b.c')).toBe('');
        expect(releaseNoteHref('')).toBe('');
    });

    it('keeps a failed check in view when the install is refused for another network change', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        responses.get_latest_client_version = new Error('rate limited');
        openUpdateDialog();
        await flush();
        appStore.set('isNetworkUpdating', true);
        click('upd-install');
        await flush();
        expect(phase()).toBe('install-failed');
        expect(document.getElementById('update-dialog')?.textContent).toContain('rate limited');
    });

    it('does not take a version ending in "-" or "+" as one', async () => {
        responses.get_latest_version = { version: 'v1.20.0-', download_url: 'u' };
        openUpdateDialog();
        await flush();
        expect(phase()).toBe('check-failed');
        _resetUpdateDialogForTests();
        responses.get_latest_version = { version: 'v1.20.0+', download_url: 'u' };
        openUpdateDialog();
        await flush();
        expect(phase()).toBe('check-failed');
    });

    it('shows the toast at once when the user came back while the OS notification failed', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        responses.rate_limited_send_notification = () => { windowVisible = true; throw new Error('denied'); };
        /** @type {(v: any) => void} */
        let fail = () => {};
        responses.update_core = () => new Promise((_r, rej) => { fail = rej; });
        openUpdateDialog();
        await flush();
        click('upd-install');
        await flush();
        click('upd-x');
        windowVisible = false;
        fail(new Error('disk full'));
        await flush(); await flush(); await flush();
        expect(showNotification).toHaveBeenCalledWith('disk full', 'error', 'Update failed');
        expect(localStorage.getItem('zephyr.updateNotePending')).toBeNull();
        delete responses.rate_limited_send_notification;
    });

    it('shows no toast when the user came back to the open dialog while the OS notification failed', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        responses.rate_limited_send_notification = () => { windowVisible = true; throw new Error('denied'); };
        /** @type {(v: any) => void} */
        let fail = () => {};
        responses.update_core = () => new Promise((_r, rej) => { fail = rej; });
        openUpdateDialog();
        await flush();
        click('upd-install');
        await flush();
        windowVisible = false;
        fail(new Error('disk full'));
        await flush(); await flush(); await flush();
        expect(phase()).toBe('install-failed');
        expect(showNotification).not.toHaveBeenCalled();
        expect(localStorage.getItem('zephyr.updateNotePending')).toBeNull();
        delete responses.rate_limited_send_notification;
    });

    it.each([false, true])('shows the toast once when focus returns while the last visibility check runs (window seen: %s)', async (seenAfter) => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        /** @type {(v: boolean) => void} */
        let answer = () => {};
        responses.rate_limited_send_notification = () => {
            visibleGate = new Promise((res) => { answer = res; });
            throw new Error('denied');
        };
        /** @type {(v: any) => void} */
        let fail = () => {};
        responses.update_core = () => new Promise((_r, rej) => { fail = rej; });
        openUpdateDialog();
        await flush();
        click('upd-install');
        await flush();
        click('upd-x');
        windowVisible = false;
        fail(new Error('disk full'));
        await flush(); await flush(); await flush();
        window.dispatchEvent(new Event('focus'));
        answer(seenAfter);
        visibleGate = null;
        await flush(); await flush();
        expect(showNotification).toHaveBeenCalledTimes(1);
        expect(showNotification).toHaveBeenCalledWith('disk full', 'error', 'Update failed');
        expect(localStorage.getItem('zephyr.updateNotePending')).toBeNull();
        delete responses.rate_limited_send_notification;
    });

    it('maps backend stages', () => {
        expect(stageFromStatus('Downloading signature...')).toBe('downloading');
        expect(stageFromStatus('Download complete, extracting core...')).toBe('installing');
        expect(stageFromStatus('Downloading... 10%')).toBe('downloading');
        expect(stageFromStatus('Verifying signature...')).toBe('verifying');
        expect(stageFromStatus('Update complete, restarting core...')).toBe('restarting');
        expect(stageFromStatus('Opening installer...')).toBe('opening');
        expect(stageFromStatus('Writing core files...')).toBe('installing');
        expect(stageFromStatus('Core ready')).toBe('restarting');
    });

    it('does not call a complete check failed when only portable mode is unreadable', async () => {
        responses.get_portable_mode = new Error('ipc down');
        openUpdateDialog();
        await flush();
        expect(phase()).toBe('latest');
    });

    it('keeps the core result and its warning when the app installer ran last', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        responses.get_latest_client_version = { version: '1.3.0' };
        openUpdateDialog({ onCoreUpdated: () => Promise.reject(new Error('ws down')) });
        await flush();
        click('upd-install');
        await flush(); await flush(); await flush(); await flush();
        expect(phase()).toBe('done');
        expect(document.querySelector('.upd-sub')?.textContent).toContain('The core is updated');
        expect(document.querySelector('.upd-error')?.textContent).toContain('couldn’t refresh');
    });

    it('notifies a finished dual update after the dialog was closed', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        responses.get_latest_client_version = { version: '1.3.0' };
        /** @type {(v: any) => void} */
        let finish = () => {};
        responses.update_client = () => new Promise((r) => { finish = r; });
        openUpdateDialog();
        await flush();
        click('upd-install');
        await flush(); await flush(); await flush();
        click('upd-x');
        finish('ok');
        await flush(); await flush();
        expect(showNotification).toHaveBeenCalledWith(expect.stringContaining('The core is updated'), 'success', 'Installer opened');
    });

    it('notifies a finished app update after the dialog was closed', async () => {
        responses.get_latest_client_version = { version: '1.3.0' };
        /** @type {(v: any) => void} */
        let finish = () => {};
        responses.update_client = () => new Promise((r) => { finish = r; });
        openUpdateDialog();
        await flush();
        click('upd-install');
        await flush();
        click('upd-x');
        finish('ok');
        await flush(); await flush();
        expect(showNotification).toHaveBeenCalledWith('Follow the installer to finish the update.', 'success', 'Installer opened');
    });

    it('says the app is current when the backend finds nothing newer at install time', async () => {
        responses.get_latest_client_version = { version: '1.3.0' };
        responses.update_client = 'Already up to date';
        openUpdateDialog();
        await flush();
        click('upd-install');
        await flush(); await flush();
        expect(phase()).toBe('done');
        const text = document.getElementById('update-dialog')?.textContent || '';
        expect(text).toContain('You’re up to date');
        expect(text).not.toContain('Installer opened');
        click('upd-close');
        /** @type {(v: any) => void} */
        let finish = () => {};
        responses.update_client = () => new Promise((r) => { finish = r; });
        openUpdateDialog();
        await flush();
        click('upd-install');
        await flush();
        click('upd-x');
        finish('Already up to date');
        await flush(); await flush();
        expect(showNotification).toHaveBeenLastCalledWith('Zephyr and its core are on the latest versions.', 'success', 'You’re up to date');
    });

    it('still names the core update when the app turns out current after it', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        responses.get_latest_client_version = { version: '1.3.0' };
        responses.update_client = 'Already up to date';
        openUpdateDialog();
        await flush();
        click('upd-install');
        await flush(); await flush(); await flush(); await flush();
        expect(phase()).toBe('done');
        const text = document.getElementById('update-dialog')?.textContent || '';
        expect(text).toContain('Core updated');
        expect(text).not.toContain('Installer opened');
    });

    it('ends the page hold only once recovery and the app installer are done', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        responses.get_latest_client_version = { version: '1.3.0' };
        /** @type {(v: any) => void} */
        let finishClient = () => {};
        responses.update_client = () => new Promise((r) => { finishClient = r; });
        openUpdateDialog();
        await flush();
        click('upd-install');
        for (let i = 0; i < 6; i++) await flush();
        expect(calls('update_client')).toBe(1);
        expect(calls('end_update_hold')).toBe(0);
        finishClient('ok');
        for (let i = 0; i < 6; i++) await flush();
        expect(phase()).toBe('done');
        expect(calls('end_update_hold')).toBe(1);
        const names = invoke.mock.calls.map((c) => c[0]);
        expect(names.indexOf('end_update_hold')).toBeGreaterThan(names.indexOf('update_client'));
        expect(invoke.mock.calls.find((c) => c[0] === 'update_core')?.[1]).toEqual({ url: 'u' });
    });

    it('does not touch the page hold for an app-only update', async () => {
        responses.get_latest_client_version = { version: '1.3.0' };
        openUpdateDialog();
        await flush();
        click('upd-install');
        await flush(); await flush(); await flush();
        expect(phase()).toBe('done');
        expect(calls('end_update_hold')).toBe(0);
    });
});
