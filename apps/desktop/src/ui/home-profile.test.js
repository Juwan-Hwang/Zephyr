import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const { initHomeProfile, profileLabel } = await import('./home-profile.js');

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('home profile menu', () => {
    beforeEach(() => { document.body.innerHTML = '<div id="home-profile"></div>'; });

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
});
