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
    getCurrentWindow: () => ({ isVisible: async () => windowVisible }),
}));
let windowVisible = true;

const showNotification = vi.fn();
vi.mock('./notifications.js', () => ({ showNotification: (/** @type {any[]} */ ...a) => showNotification(...a) }));

const { openUpdateDialog, stageFromStatus, _resetUpdateDialogForTests } = await import('./update-dialog.js');
const { appStore } = await import('./state.js');
const { openUrl, listen } = await import('../api.js');

const flush = () => new Promise((r) => setTimeout(r, 0));
const phase = () => document.getElementById('update-dialog')?.dataset.phase;
const click = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id)).click();
const calls = (/** @type {string} */ cmd) => invoke.mock.calls.filter((c) => c[0] === cmd).length;

beforeEach(() => {
    _resetUpdateDialogForTests();
    document.body.innerHTML = '';
    invoke.mockClear();
    showNotification.mockClear();
    appStore.set('isNetworkUpdating', false);
    windowVisible = true;
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
        windowVisible = false;
        fail(new Error('disk full'));
        await flush(); await flush(); await flush();
        expect(showNotification).toHaveBeenCalledWith('disk full', 'error', 'Update failed');
        delete responses.rate_limited_send_notification;
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

    it('maps backend stages', () => {
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

    it('asks the backend to keep the page alive only while the app installer still follows', async () => {
        responses.get_latest_version = { version: 'v1.20.0', download_url: 'u' };
        responses.get_latest_client_version = { version: '1.3.0' };
        openUpdateDialog();
        await flush();
        click('upd-install');
        await flush(); await flush(); await flush(); await flush();
        expect(invoke.mock.calls.find((c) => c[0] === 'update_core')?.[1]).toEqual({ url: 'u', thenClient: true });
        _resetUpdateDialogForTests();
        invoke.mockClear();
        responses.get_latest_client_version = { version: '1.2.0' };
        openUpdateDialog();
        await flush();
        click('upd-install');
        await flush(); await flush();
        expect(invoke.mock.calls.find((c) => c[0] === 'update_core')?.[1]).toEqual({ url: 'u', thenClient: false });
    });
});
