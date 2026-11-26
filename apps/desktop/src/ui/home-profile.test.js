import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./cache.js', () => ({
    getConfigsCached: vi.fn(async () => [
        { name: 'config.yaml', is_active: true, sub_info: `upload=0; download=${5 * 1073741824}; total=${50 * 1073741824}` },
        { name: 'work.yml' },
    ]),
    getSettingsCached: vi.fn(async () => ({ last_config: 'config.yaml' })),
    invalidateConfigsCache: vi.fn(),
}));
vi.mock('../i18n.js', () => ({ t: (/** @type {string} */ k) => k }));
vi.mock('./tray.js', () => ({ switchProfile: vi.fn(async () => {}) }));
vi.mock('./running-profile.js', () => ({ readRunningProfile: vi.fn(async () => 'config.yaml') }));
vi.mock('./network-change.js', () => ({ networkChangesBegun: vi.fn(() => 0) }));
const store = { noSubscription: false, isNetworkUpdating: false };
vi.mock('./state.js', () => ({ appStore: { get: (/** @type {string} */ k) => /** @type {any} */ (store)[k] } }));

const { initHomeProfile: mountHomeProfile, profileLabel } = await import('./home-profile.js');
const { getSettingsCached, getConfigsCached } = await import('./cache.js');
const { Bus, Events } = await import('./events.js');
const { readRunningProfile } = await import('./running-profile.js');
const { networkChangesBegun } = await import('./network-change.js');

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

/** @type {Set<() => void>} */
const cleanups = new Set();
/** @param {Parameters<typeof mountHomeProfile>[0]} [options] */
function initHomeProfile(options) {
    const dispose = mountHomeProfile(options);
    const stop = () => {
        if (!cleanups.delete(stop)) return;
        dispose();
    };
    cleanups.add(stop);
    return stop;
}

describe('home profile menu', () => {
    beforeEach(() => { document.body.innerHTML = '<div id="home-profile"></div>'; });
    afterEach(() => { for (const stop of cleanups) stop(); });

    it('drops the file extension', () => {
        expect(profileLabel('a.yaml')).toBe('a');
        expect(profileLabel('b.YML')).toBe('b');
        expect(profileLabel('c')).toBe('c');
    });

    it('shows the current profile and switches to another', async () => {
        const switchTo = vi.fn(async () => {});
        const stop = initHomeProfile({ switchTo });
        await flush();
        const btn = /** @type {HTMLButtonElement} */ (document.getElementById('home-profile-btn'));
        expect(btn.textContent).toContain('config');
        btn.click();
        await flush();
        const items = document.querySelectorAll('[role="menuitemradio"]');
        expect(items).toHaveLength(2);
        expect(items[0].getAttribute('aria-checked')).toBe('true');
        // Usage under each name; none reported reads as such.
        expect(items[0].querySelector('.home-profile-usage')?.textContent).toBe('5 GB / 50 GB');
        expect(items[1].querySelector('.home-profile-usage')?.textContent).toBe('homeProfileNoUsage');
        expect(btn.getAttribute('aria-expanded')).toBe('true');
        /** @type {HTMLElement} */ (items[1]).click();
        await flush();
        expect(switchTo).toHaveBeenCalledWith('work.yml');
        expect(document.querySelector('[role="menu"]')).toBeNull();
        stop();
    });

    it('switches to the active profile again only while the minimal config runs instead', async () => {
        const switchTo = vi.fn(async () => {});
        const stop = initHomeProfile({ switchTo });
        await flush();
        const btn = /** @type {HTMLButtonElement} */ (document.getElementById('home-profile-btn'));
        const pickActive = async () => {
            btn.click();
            await flush();
            /** @type {HTMLElement} */ (document.querySelectorAll('[role="menuitemradio"]')[0]).click();
            await flush();
        };
        await pickActive();
        expect(switchTo).not.toHaveBeenCalled();
        store.noSubscription = true;
        try {
            await pickActive();
            expect(switchTo).toHaveBeenCalledWith('config.yaml');
        } finally {
            store.noSubscription = false;
            stop();
        }
    });

    it('closes on Escape without switching', async () => {
        const switchTo = vi.fn(async () => {});
        const stop = initHomeProfile({ switchTo });
        await flush();
        const btn = /** @type {HTMLButtonElement} */ (document.getElementById('home-profile-btn'));
        btn.click();
        await flush();
        expect(document.querySelector('[role="menu"]')).not.toBeNull();
        expect(btn.getAttribute('aria-expanded')).toBe('true');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(document.querySelector('[role="menu"]')).toBeNull();
        expect(switchTo).not.toHaveBeenCalled();
        stop();
    });

    it('can open again before a cancelled settings read finishes', async () => {
        const stop = initHomeProfile();
        await flush();
        const btn = /** @type {HTMLButtonElement} */ (document.getElementById('home-profile-btn'));
        /** @type {(settings: any) => void} */
        let release = () => {};
        vi.mocked(getSettingsCached).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
        btn.click();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        btn.click();
        await flush();
        expect(btn.getAttribute('aria-expanded')).toBe('true');
        release({ last_config: 'obsolete.yaml' });
        await flush();
        expect(btn.textContent).toContain('config');
        expect(btn.getAttribute('aria-expanded')).toBe('true');
        stop();
    });

    it('a second click cancels a menu still waiting for settings', async () => {
        const stop = initHomeProfile();
        await flush();
        const btn = /** @type {HTMLButtonElement} */ (document.getElementById('home-profile-btn'));
        /** @type {(settings: any) => void} */
        let release = () => {};
        vi.mocked(getSettingsCached).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
        btn.click();
        btn.click();
        release({ last_config: 'config.yaml' });
        await flush();
        expect(document.querySelector('[role="menu"]')).toBeNull();
        btn.click();
        await flush();
        expect(btn.getAttribute('aria-expanded')).toBe('true');
        stop();
    });

    it('does not label an unconfirmed profile when the post-switch read fails', async () => {
        const stop = initHomeProfile({ switchTo: async () => {} });
        await flush();
        const btn = /** @type {HTMLButtonElement} */ (document.getElementById('home-profile-btn'));
        btn.click();
        await flush();
        vi.mocked(getSettingsCached).mockRejectedValueOnce(new Error('settings unavailable'));
        /** @type {HTMLElement} */ (document.querySelectorAll('[role="menuitemradio"]')[1]).click();
        await flush();
        expect(btn.textContent).toContain('homeProfile');
        expect(btn.textContent).not.toContain('work');
        stop();
    });

    it('closes stale checked menu items when a refresh cannot read the current profile', async () => {
        const stop = initHomeProfile();
        await flush();
        const btn = /** @type {HTMLButtonElement} */ (document.getElementById('home-profile-btn'));
        btn.click();
        await flush();
        expect(document.querySelector('[role="menu"]')).not.toBeNull();
        vi.mocked(getSettingsCached).mockRejectedValueOnce(new Error('settings unavailable'));
        Bus.emit(Events.CONFIG_UPDATED);
        await flush();
        expect(document.querySelector('[role="menu"]')).toBeNull();
        expect(document.activeElement).toBe(btn);
        expect(btn.textContent).toContain('homeProfile');
        stop();
    });

    it('closes an open menu when its profile choices change without changing the current profile', async () => {
        const stop = initHomeProfile();
        await flush();
        const btn = /** @type {HTMLButtonElement} */ (document.getElementById('home-profile-btn'));
        btn.click();
        await flush();
        vi.mocked(getConfigsCached).mockResolvedValueOnce([{ name: 'config.yaml', is_active: true }, { name: 'new.yaml' }]);
        Bus.emit(Events.CONFIG_UPDATED);
        await flush();
        expect(document.querySelector('[role="menu"]')).toBeNull();
        expect(document.activeElement).toBe(btn);
        expect(btn.textContent).toContain('config');
        stop();
    });

    it('drops an old catalog when a newer refresh overtakes a failed settings read', async () => {
        const stop = initHomeProfile();
        await flush();
        const btn = /** @type {HTMLButtonElement} */ (document.getElementById('home-profile-btn'));
        /** @type {(value: any[]) => void} */
        let finishOld = () => {};
        /** @type {Promise<any[]>} */
        const oldCatalog = new Promise((resolve) => { finishOld = resolve; });
        vi.mocked(getSettingsCached).mockRejectedValueOnce(new Error('settings unavailable'));
        vi.mocked(getConfigsCached).mockReturnValueOnce(oldCatalog).mockReturnValueOnce(oldCatalog);
        btn.click();
        await flush();
        vi.mocked(getConfigsCached).mockResolvedValueOnce([{ name: 'config.yaml', is_active: true }, { name: 'new.yaml' }]);
        Bus.emit(Events.CONFIG_UPDATED);
        await flush();
        finishOld([{ name: 'removed.yaml' }]);
        await flush();
        expect(document.querySelector('[role="menu"]')).toBeNull();
        expect(btn.textContent).toContain('config');
        stop();
    });

    it('uses the live running profile when a menu checkmark is stale', async () => {
        const switchTo = vi.fn(async () => {});
        const stop = initHomeProfile({ switchTo });
        await flush();
        /** @type {HTMLElement} */ (document.getElementById('home-profile-btn')).click();
        await flush();
        vi.mocked(readRunningProfile).mockResolvedValueOnce('work.yml');
        /** @type {HTMLElement} */ (document.querySelector('[role="menuitemradio"][aria-checked="true"]')).click();
        await flush();
        expect(switchTo).toHaveBeenCalledWith('config.yaml');
        stop();
    });

    it('does not queue a profile click made during an existing network change', async () => {
        const switchTo = vi.fn(async () => {});
        const stop = initHomeProfile({ switchTo });
        await flush();
        /** @type {HTMLElement} */ (document.getElementById('home-profile-btn')).click();
        await flush();
        store.isNetworkUpdating = true;
        try {
            /** @type {HTMLElement} */ (document.querySelectorAll('[role="menuitemradio"]')[1]).click();
            store.isNetworkUpdating = false;
            await flush();
            expect(switchTo).not.toHaveBeenCalled();
        } finally {
            store.isNetworkUpdating = false;
            stop();
        }
    });

    it('does not switch a profile deleted while the runtime read waits', async () => {
        const switchTo = vi.fn(async () => {});
        const stop = initHomeProfile({ switchTo });
        await flush();
        const btn = /** @type {HTMLElement} */ (document.getElementById('home-profile-btn'));
        btn.click();
        await flush();
        /** @type {(value: string) => void} */
        let finishRead = () => {};
        vi.mocked(readRunningProfile).mockReturnValueOnce(new Promise((resolve) => { finishRead = resolve; }));
        /** @type {HTMLElement} */ (document.querySelectorAll('[role="menuitemradio"]')[1]).click();
        vi.mocked(getConfigsCached).mockResolvedValueOnce([{ name: 'config.yaml', is_active: true }]);
        finishRead('config.yaml');
        await flush();
        expect(switchTo).not.toHaveBeenCalled();
        stop();
    });

    it('does not apply an older profile selection after a newer click', async () => {
        const switchTo = vi.fn(async () => {});
        const stop = initHomeProfile({ switchTo });
        await flush();
        const btn = /** @type {HTMLElement} */ (document.getElementById('home-profile-btn'));
        btn.click();
        await flush();
        /** @type {(value: string) => void} */
        let oldRead = () => {};
        vi.mocked(readRunningProfile).mockReturnValueOnce(new Promise((resolve) => { oldRead = resolve; }));
        /** @type {HTMLElement} */ (document.querySelectorAll('[role="menuitemradio"]')[1]).click();
        btn.click();
        await flush();
        /** @type {HTMLElement} */ (document.querySelectorAll('[role="menuitemradio"]')[0]).click();
        await flush();
        oldRead('config.yaml');
        await flush();
        expect(switchTo).not.toHaveBeenCalled();
        stop();
    });

    it('dismisses the menu when another field receives focus and leaves its arrow keys alone', async () => {
        const input = document.createElement('input');
        document.body.append(input);
        const stop = initHomeProfile();
        await flush();
        /** @type {HTMLElement} */ (document.getElementById('home-profile-btn')).click();
        await flush();
        input.focus();
        expect(document.querySelector('[role="menu"]')).toBeNull();
        const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
        input.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        expect(document.activeElement).toBe(input);
        stop();
    });

    it('does not dispatch a home selection after a newer tray network change', async () => {
        const switchTo = vi.fn(async () => {});
        const stop = initHomeProfile({ switchTo });
        await flush();
        /** @type {HTMLElement} */ (document.getElementById('home-profile-btn')).click();
        await flush();
        /** @type {(value: string) => void} */
        let finish = () => {};
        vi.mocked(readRunningProfile).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
        /** @type {HTMLElement} */ (document.querySelectorAll('[role="menuitemradio"]')[1]).click();
        vi.mocked(networkChangesBegun).mockReturnValue(1);
        finish('config.yaml');
        await flush();
        expect(switchTo).not.toHaveBeenCalled();
        vi.mocked(networkChangesBegun).mockReturnValue(0);
        stop();
    });
});
