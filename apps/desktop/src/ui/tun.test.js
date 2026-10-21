// @ts-check
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mShow = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../api.js', () => ({
    patchConfig: vi.fn().mockResolvedValue(undefined),
    closeAllConnections: vi.fn().mockResolvedValue(true),
    invoke: vi.fn(),
    restartCore: vi.fn().mockResolvedValue({}),
    setSecret: vi.fn(),
    getConfig: vi.fn(),
    getCurrentWindow: vi.fn(() => ({ show: mShow, setFocus: vi.fn().mockResolvedValue(undefined) })),
}));
vi.mock('../websocket.js', () => ({ setWsSecret: vi.fn() }));
vi.mock('./notifications.js', () => ({
    showNotification: vi.fn(),
    showConfirmModal: vi.fn(),
}));
vi.mock('./lifecycle.js', () => ({ postRestartRecovery: vi.fn().mockResolvedValue(undefined) }));

import { invoke, getConfig } from '../api.js';
import { showNotification, showConfirmModal } from './notifications.js';
import { appStore } from './state.js';
import { translations } from '../i18n.js';
import { initTunToggle, mirrorTunToggle } from './tun.js';

const mInvoke = /** @type {import('vitest').Mock} */ (/** @type {unknown} */ (invoke));
const mGetConfig = /** @type {import('vitest').Mock} */ (/** @type {unknown} */ (getConfig));
const mConfirm = /** @type {import('vitest').Mock} */ (/** @type {unknown} */ (showConfirmModal));
const mNotify = /** @type {import('vitest').Mock} */ (/** @type {unknown} */ (showNotification));
const t = /** @type {Record<string, string>} */ (/** @type {unknown} */ (translations.en));

const navDesc = {
    userAgent: Object.getOwnPropertyDescriptor(navigator, 'userAgent'),
    platform: Object.getOwnPropertyDescriptor(navigator, 'platform'),
};

/** @param {string} userAgent @param {string} platform */
function setPlatform(userAgent, platform) {
    Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true });
    Object.defineProperty(navigator, 'platform', { value: platform, configurable: true });
}

/** Resolve once every pending promise and the store's microtask batch have run. */
async function settle() {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

/** @type {(() => void) | null} */
let detach = null;

function mount() {
    document.body.innerHTML = `
        <input type="checkbox" id="tun-proxy-toggle">
        <span id="tun-spinner" class="hidden"></span>
        <p id="tun-status-text"></p>
        <input type="checkbox" id="dz-tun-toggle">`;
    initTunToggle();
    const mirror = /** @type {HTMLInputElement} */ (document.getElementById('dz-tun-toggle'));
    detach = mirrorTunToggle(mirror);
    return {
        home: /** @type {HTMLInputElement} */ (document.getElementById('tun-proxy-toggle')),
        mirror,
    };
}

/** @param {HTMLInputElement} el */
function click(el) {
    el.checked = !el.checked;
    el.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => {
    vi.clearAllMocks();
    appStore.set('isTunEnabled', false);
    appStore.set('isNetworkUpdating', false);
    // The core refuses TUN (no administrator rights): the toggle has to roll back.
    mGetConfig.mockResolvedValue({ tun: { enable: false } });
    mInvoke.mockImplementation(async (/** @type {string} */ cmd) => {
        if (cmd === 'is_process_elevated') return false;
        return null;
    });
});

afterEach(async () => {
    detach?.();
    detach = null;
    await settle();
    for (const [key, desc] of Object.entries(navDesc)) {
        if (desc) Object.defineProperty(navigator, key, desc);
        else delete (/** @type {any} */ (navigator))[key];
    }
});

describe('console TUN switch follows the home toggle', () => {
    it('rolls back after a failed start, although the store never changed', async () => {
        setPlatform('Mozilla/5.0 (X11; FreeBSD amd64)', 'FreeBSD amd64');
        const { home, mirror } = mount();

        click(mirror);
        expect(home.checked).toBe(true);
        await settle();

        expect(appStore.get('isTunEnabled')).toBe(false);
        expect(home.checked).toBe(false);
        expect(mirror.checked).toBe(false);
        expect(mirror.disabled).toBe(false);
        expect(mNotify).toHaveBeenCalledWith(t.tunFailed, 'error');
    });

    it('starts from the stored state before the home checkbox is bound', async () => {
        // The console is built before startup binds the home checkbox, which
        // reads unchecked until then.
        appStore.set('isTunEnabled', true);
        await settle();
        const { home, mirror } = mount();

        expect(home.checked).toBe(false);
        expect(mirror.checked).toBe(true);
    });

    it('stays on when the core accepts TUN', async () => {
        setPlatform('Mozilla/5.0 (X11; FreeBSD amd64)', 'FreeBSD amd64');
        mGetConfig.mockResolvedValue({ tun: { enable: true } });
        const { home, mirror } = mount();

        click(mirror);
        await settle();

        expect(appStore.get('isTunEnabled')).toBe(true);
        expect(home.checked).toBe(true);
        expect(mirror.checked).toBe(true);
    });

    it('cannot start a second switch while one is in flight', async () => {
        setPlatform('Mozilla/5.0 (X11; FreeBSD amd64)', 'FreeBSD amd64');
        const { mirror } = mount();
        appStore.set('isNetworkUpdating', true);
        await settle();
        expect(mirror.disabled).toBe(true);
        appStore.set('isNetworkUpdating', false);
        await settle();
        expect(mirror.disabled).toBe(false);
    });
});

describe('Windows: TUN without administrator rights', () => {
    const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/130.0';

    it('offers to relaunch as administrator and asks the backend to do it', async () => {
        setPlatform(WIN_UA, 'Win32');
        mConfirm.mockResolvedValue(true);
        const { home, mirror } = mount();

        click(home);
        await settle();

        expect(mConfirm).toHaveBeenCalledWith('TUN', t.tunWindowsAdminPrompt);
        // Shown first: a tray-started switch may come from a hidden window.
        expect(mShow).toHaveBeenCalled();
        expect(mShow.mock.invocationCallOrder[0]).toBeLessThan(mConfirm.mock.invocationCallOrder[0]);
        expect(mInvoke).toHaveBeenCalledWith('restart_as_admin_cmd', { enableTun: true });
        expect(home.checked).toBe(false);
        expect(mirror.checked).toBe(false);
        expect(mNotify).not.toHaveBeenCalledWith(t.tunFailed, 'error');
    });

    it('reports the original failure when the prompt is declined', async () => {
        setPlatform(WIN_UA, 'Win32');
        mConfirm.mockResolvedValue(false);
        const { home } = mount();

        click(home);
        await settle();

        expect(mInvoke).not.toHaveBeenCalledWith('restart_as_admin_cmd', expect.anything());
        expect(mNotify).toHaveBeenCalledWith(t.tunFailed, 'error');
        expect(mNotify).not.toHaveBeenCalledWith(t.tunAuthCanceled, expect.anything());
    });

    it('reports a cancelled UAC prompt', async () => {
        setPlatform(WIN_UA, 'Win32');
        mConfirm.mockResolvedValue(true);
        mInvoke.mockImplementation(async (/** @type {string} */ cmd) => {
            if (cmd === 'is_process_elevated') return false;
            // Tauri rejects with the command's error string, not an Error.
            // eslint-disable-next-line no-throw-literal
            if (cmd === 'restart_as_admin_cmd') throw 'canceled';
            return null;
        });
        const { home } = mount();

        click(home);
        await settle();

        expect(mNotify).toHaveBeenCalledWith(t.tunAuthCanceled, 'error');
        expect(home.checked).toBe(false);
    });

    it.each([
        ['not_admin_user', 'tunWindowsNotAdmin', 'error'],
        ['pref_save_failed: disk full', 'tunPrefSaveFailedNotEnabled', 'warning'],
        ['Elevated relaunch failed (error 5)', 'tunWindowsRelaunchFailed', 'error'],
    ])('reports a relaunch refused with %s', async (reason, key, level) => {
        setPlatform(WIN_UA, 'Win32');
        mConfirm.mockResolvedValue(true);
        mInvoke.mockImplementation(async (/** @type {string} */ cmd) => {
            if (cmd === 'is_process_elevated') return false;
            if (cmd === 'restart_as_admin_cmd') throw reason;
            return null;
        });
        const { home } = mount();

        click(home);
        await settle();

        expect(t[key]).toBeTruthy();
        expect(mNotify).toHaveBeenCalledWith(t[key], level);
        expect(home.checked).toBe(false);
        expect(appStore.get('isNetworkUpdating')).toBe(false);
    });

    it('says TUN failed, without the run-as-administrator advice, when already elevated', async () => {
        setPlatform(WIN_UA, 'Win32');
        mInvoke.mockImplementation(async (/** @type {string} */ cmd) => {
            if (cmd === 'is_process_elevated') return true;
            return null;
        });
        const { home } = mount();

        click(home);
        await settle();

        expect(mConfirm).not.toHaveBeenCalled();
        expect(mNotify).toHaveBeenCalledWith(t.tunFailedElevated, 'error');
        expect(mNotify).not.toHaveBeenCalledWith(t.tunFailed, 'error');
    });
});
