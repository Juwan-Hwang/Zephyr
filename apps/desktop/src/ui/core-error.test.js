import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = { isSysProxyEnabled: false, noSubscription: false };
vi.mock('../api.js', () => ({ readCoreLog: vi.fn() }));
vi.mock('../i18n.js', () => ({ t: (/** @type {string} */ key) => key }));
vi.mock('./state.js', () => ({ appStore: { get: (/** @type {string} */ key) => /** @type {any} */ (state)[key] } }));

const { showCoreStartError, hideCoreStartError, relocateCoreStartError } = await import('./core-error.js');

describe('core startup banner', () => {
    beforeEach(() => {
        hideCoreStartError();
        state.isSysProxyEnabled = false;
        document.body.innerHTML = '<main id="app-main-container"><section data-page="home"><button id="home-control">Home</button></section><section data-page="console"></section></main><span id="proxy-status-text"></span>';
    });

    it('makes a lazily created console inert while leaving its retry action accessible', async () => {
        const home = /** @type {HTMLElement} */ (document.querySelector('[data-page="home"]'));
        vi.spyOn(home, 'getClientRects').mockReturnValue(/** @type {any} */ ([{}]));
        const retry = showCoreStartError('start failed');
        /** @type {HTMLButtonElement} */ (document.querySelector('.core-error-actions .is-secondary')).click();
        expect(document.getElementById('core-error-state')?.classList.contains('has-log')).toBe(true);
        home.getClientRects = () => /** @type {any} */ ([]);
        const consolePage = /** @type {HTMLElement} */ (document.querySelector('[data-page="console"]'));
        consolePage.innerHTML = '<div class="dz-content"><button id="console-control">Console</button><div id="already-inert" inert></div></div>';
        const content = /** @type {HTMLElement} */ (consolePage.firstElementChild);
        vi.spyOn(content, 'getClientRects').mockReturnValue(/** @type {any} */ ([{}]));
        const retryButton = /** @type {HTMLButtonElement} */ (document.querySelector('.core-error-retry:not(.is-secondary)'));
        retryButton.focus();
        relocateCoreStartError();
        expect(document.activeElement).toBe(retryButton);
        expect(content.firstElementChild).toBe(document.getElementById('core-error-state'));
        expect(content.firstElementChild?.classList.contains('is-banner')).toBe(true);
        expect(document.getElementById('core-error-state')?.classList.contains('has-log')).toBe(true);
        expect(document.getElementById('console-control')?.hasAttribute('inert')).toBe(true);
        expect(document.getElementById('core-error-state')?.closest('[inert]')).toBeNull();
        /** @type {HTMLButtonElement} */ (document.querySelector('.core-error-retry:not(.is-secondary)')).click();
        await retry;
        hideCoreStartError();
        expect(document.getElementById('console-control')?.hasAttribute('inert')).toBe(false);
        expect(document.getElementById('already-inert')?.hasAttribute('inert')).toBe(true);
    });

    it('restores the active system proxy label after retry succeeds', () => {
        state.isSysProxyEnabled = true;
        void showCoreStartError('start failed');
        hideCoreStartError();
        const status = document.getElementById('proxy-status-text');
        expect(status?.textContent).toBe('stateOn');
        expect(status?.dataset.i18n).toBe('stateOn');
    });
});
