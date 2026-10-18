// @ts-check
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./navigation.js', () => ({ navigateTo: vi.fn() }));

const { initNoSubscriptionState, syncNoSubscriptionState } = await import('./no-subscription.js');
const { navigateTo } = await import('./navigation.js');
const { appStore } = await import('./state.js');

/** appStore notifies subscribers in a microtask. */
const flush = () => new Promise((r) => queueMicrotask(() => r(undefined)));

function mountHosts() {
    document.body.innerHTML = `
        <div id="home-hero"><div class="home-hero-body"></div></div>
        <input type="checkbox" id="sys-proxy-toggle">
        <div data-page="console">
            <div id="dz-traffic-card" class="dz-traffic-card"><canvas></canvas></div>
            <input type="checkbox" id="dz-sys-toggle">
        </div>`;
}

describe('no-subscription empty state', () => {
    beforeEach(async () => {
        vi.mocked(navigateTo).mockClear();
        appStore.set('noSubscription', false);
        await flush();
        mountHosts();
        initNoSubscriptionState();
    });

    it('shows the title and Add button in the hero and the console traffic card', async () => {
        appStore.set('noSubscription', true);
        await flush();
        for (const [host, box] of [['home-hero', 'home-empty-state'], ['dz-traffic-card', 'console-empty-state']]) {
            expect(document.getElementById(host)?.classList.contains('is-empty')).toBe(true);
            const el = document.getElementById(box);
            expect(el?.parentElement?.id).toBe(host);
            expect(el?.querySelector('h3')?.textContent).toBeTruthy();
            expect(el?.querySelector('button.home-empty-btn')).not.toBeNull();
        }
        appStore.set('noSubscription', false);
        await flush();
        expect(document.getElementById('console-empty-state')).toBeNull();
        expect(document.getElementById('dz-traffic-card')?.classList.contains('is-empty')).toBe(false);
    });

    it('renders into a console card injected later', () => {
        appStore.set('noSubscription', true);
        const card = document.getElementById('dz-traffic-card');
        card?.replaceChildren();
        card?.classList.remove('is-empty');
        syncNoSubscriptionState();
        expect(card?.querySelector('#console-empty-state')).not.toBeNull();
    });

    it('either system-proxy switch opens Add subscription instead of turning on', () => {
        appStore.set('noSubscription', true);
        for (const id of ['sys-proxy-toggle', 'dz-sys-toggle']) {
            const toggle = /** @type {HTMLInputElement} */ (document.getElementById(id));
            const onChange = vi.fn();
            toggle.addEventListener('change', onChange);
            toggle.click();
            expect(toggle.checked).toBe(false);
            expect(onChange).not.toHaveBeenCalled();
        }
        expect(navigateTo).toHaveBeenCalledTimes(2);
        expect(navigateTo).toHaveBeenCalledWith('subscriptions');
    });

    it('leaves the switches alone once a subscription exists', () => {
        const toggle = /** @type {HTMLInputElement} */ (document.getElementById('dz-sys-toggle'));
        toggle.click();
        expect(toggle.checked).toBe(true);
        expect(navigateTo).not.toHaveBeenCalled();
    });
});
