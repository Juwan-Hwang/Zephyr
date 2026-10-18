import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The wheel only needs the node list; everything else is a no-op.
vi.mock('../api.js', () => ({
    getProxies: vi.fn(),
    switchProxyResult: vi.fn().mockResolvedValue({ ok: true, reason: null }),
    abortLatencyTests: vi.fn(),
    closeAllConnections: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../utils/logger.js', () => ({
    nodeWheelLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../i18n.js', () => ({ t: (/** @type {string} */ k) => k }));
vi.mock('./proxy-groups.js', () => ({ fetchProxyGroups: vi.fn() }));
vi.mock('./proxies.js', () => ({
    sortProxiesByLatency: vi.fn(),
    syncCoreConfig: vi.fn().mockResolvedValue(undefined),
    renderProxies: vi.fn(),
    notifySwitchFailed: vi.fn(),
    resolveLeafNode: vi.fn((/** @type {string} */ n, /** @type {any} */ map) => {
        let cur = n; const seen = new Set();
        while (map?.[cur]?.now && map[map[cur].now] && !seen.has(cur)) { seen.add(cur); cur = map[cur].now; }
        return cur;
    }),
}));
vi.mock('./state.js', () => ({ appStore: { get: vi.fn(() => null) } }));
vi.mock('./cache.js', () => ({
    invalidateProxiesCache: vi.fn(),
    getSettingsCached: vi.fn().mockResolvedValue({}),
}));
vi.mock('./proxy-memory.js', () => ({ saveProxySelection: vi.fn() }));
vi.mock('./notifications.js', () => ({ showNotification: vi.fn() }));

const GROUPS = {
    uiGroupName: 'Proxy',
    mainGroup: 'Proxy',
    current: 'HK 02',
    proxies: ['HK 01', 'HK 02', 'JP 01'],
    data: { proxies: { 'HK 01': { udp: true }, 'HK 02': { udp: true }, 'JP 01': { udp: false } } },
};

function mountDom() {
    document.body.innerHTML = `
      <div data-page="home">
        <section id="home-hero">
          <div id="node-wheel-container">
            <button type="button" id="node-wheel-trigger" aria-expanded="false"><span id="current-node-name">HK 02</span></button>
            <div id="node-wheel-dropdown" class="opacity-0 pointer-events-none">
              <div id="node-wheel-scroll"><div id="node-wheel-list"></div></div>
            </div>
          </div>
          <div id="elsewhere">speed</div>
        </section>
      </div>
      <div data-page="proxies" class="hidden"></div>`;
    return {
        page: /** @type {HTMLElement} */ (document.querySelector('[data-page="home"]')),
        container: /** @type {HTMLElement} */ (document.getElementById('node-wheel-container')),
        trigger: /** @type {HTMLElement} */ (document.getElementById('node-wheel-trigger')),
        dropdown: /** @type {HTMLElement} */ (document.getElementById('node-wheel-dropdown')),
        list: /** @type {HTMLElement} */ (document.getElementById('node-wheel-list')),
        elsewhere: /** @type {HTMLElement} */ (document.getElementById('elsewhere')),
    };
}

/** @param {HTMLElement} el @param {number} [x] @param {number} [y] */
const enter = (el, x = 10, y = 10) => el.dispatchEvent(new PointerEvent('pointerenter', { clientX: x, clientY: y }));
/** @param {HTMLElement} from @param {Element | null} to */
const leave = (from, to) => from.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: to }));
/** @param {EventTarget} target @param {number} [x] @param {number} [y] */
const move = (target, x = 10, y = 10) => target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y }));
/** @param {HTMLElement} dropdown */
const isShown = (dropdown) => !dropdown.classList.contains('opacity-0');

/** Resolve-on-demand stand-in for the /proxies round trip. */
function deferred() {
    /** @type {(v: any) => void} */
    let resolve = () => {};
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}

/** @type {typeof import('./node-wheel.js')} */
let wheel;
/** @type {import('vitest').Mock} */
let fetchProxyGroups;
/** @type {ReturnType<typeof mountDom>} */
let dom;

beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    /** @type {any} */ (window)._wheelListenerAdded = false;
    /** @type {any} */ (window)._wheelPointerTracked = false;
    dom = mountDom();
    wheel = await import('./node-wheel.js');
    fetchProxyGroups = /** @type {any} */ ((await import('./proxy-groups.js')).fetchProxyGroups);
    fetchProxyGroups.mockReset();
    fetchProxyGroups.mockResolvedValue(GROUPS);
    wheel.initNodeWheel();
});

afterEach(() => {
    wheel.closeWheel();
    vi.useRealTimers();
    document.body.innerHTML = '';
});

/** Hover the pill long enough to open it and let the node list arrive. */
async function hoverOpen() {
    enter(dom.trigger);
    await vi.advanceTimersByTimeAsync(wheel.WHEEL_HOVER_OPEN_DELAY);
    await vi.advanceTimersByTimeAsync(0);
}

describe('node quick-switch wheel', () => {
    it('opens after the hover delay and collapses when the pointer leaves the pill', async () => {
        await hoverOpen();
        expect(isShown(dom.dropdown)).toBe(true);
        expect(dom.trigger.getAttribute('aria-expanded')).toBe('true');
        expect(dom.list.querySelectorAll('[role="option"]')).toHaveLength(3);

        leave(dom.dropdown, dom.elsewhere);
        expect(isShown(dom.dropdown)).toBe(false);
        expect(wheel.isNodeWheelOpen()).toBe(false);
        expect(dom.trigger.getAttribute('aria-expanded')).toBe('false');
    });

    it('does not open when the pointer leaves before the hover delay, and keeps one timer', async () => {
        enter(dom.trigger);
        enter(dom.trigger); // repeated enter must not stack a second open timer
        await vi.advanceTimersByTimeAsync(wheel.WHEEL_HOVER_OPEN_DELAY - 50);
        leave(dom.trigger, dom.elsewhere);
        await vi.advanceTimersByTimeAsync(1000);
        expect(fetchProxyGroups).not.toHaveBeenCalled();
        expect(isShown(dom.dropdown)).toBe(false);
    });

    it('stays closed when the pointer leaves while the node list is still loading (the stuck-open race)', async () => {
        const slow = deferred();
        fetchProxyGroups.mockReturnValueOnce(slow.promise);
        enter(dom.trigger);
        await vi.advanceTimersByTimeAsync(wheel.WHEEL_HOVER_OPEN_DELAY);
        expect(fetchProxyGroups).toHaveBeenCalledTimes(1);

        leave(dom.trigger, dom.elsewhere); // pointer gone before /proxies answered
        slow.resolve(GROUPS);
        await vi.advanceTimersByTimeAsync(0);

        expect(isShown(dom.dropdown)).toBe(false);
        expect(wheel.isNodeWheelOpen()).toBe(false);
        expect(dom.trigger.style.pointerEvents).not.toBe('none');

        // ...and the next normal hover still opens and closes it.
        await hoverOpen();
        expect(isShown(dom.dropdown)).toBe(true);
        leave(dom.dropdown, dom.elsewhere);
        expect(isShown(dom.dropdown)).toBe(false);
    });

    it('a click on the pill while a hover-started open is loading does not cancel it', async () => {
        const slow = deferred();
        fetchProxyGroups.mockReturnValueOnce(slow.promise);
        enter(dom.trigger);
        await vi.advanceTimersByTimeAsync(wheel.WHEEL_HOVER_OPEN_DELAY);
        dom.trigger.click();
        slow.resolve(GROUPS);
        await vi.advanceTimersByTimeAsync(0);
        expect(isShown(dom.dropdown)).toBe(true);
        expect(wheel.isNodeWheelOpen()).toBe(true);
    });

    it('releases the open state when there is nothing to show, so the next hover can open', async () => {
        fetchProxyGroups.mockResolvedValueOnce(null);
        await hoverOpen();
        expect(wheel.isNodeWheelOpen()).toBe(false);
        leave(dom.trigger, dom.elsewhere);
        await hoverOpen();
        expect(isShown(dom.dropdown)).toBe(true);
    });

    it('closeWheel restores the closed look even when the flag was already cleared', async () => {
        await hoverOpen();
        wheel.closeWheel();
        // Simulate a stale, visible dropdown left behind by some other path.
        dom.dropdown.classList.remove('opacity-0', 'pointer-events-none');
        dom.trigger.style.opacity = '0';
        wheel.closeWheel();
        expect(isShown(dom.dropdown)).toBe(false);
        expect(dom.trigger.style.opacity).toBe('1');
    });

    it('moving into the dropdown keeps it open; sliding off into the positioning strip closes it', async () => {
        await hoverOpen();
        const option = /** @type {HTMLElement} */ (dom.list.querySelector('[role="option"]'));
        leave(dom.trigger, option);
        expect(isShown(dom.dropdown)).toBe(true);
        leave(option, dom.container);
        expect(isShown(dom.dropdown)).toBe(false);
    });

    it('closes when the pointer leaves the window (relatedTarget null)', async () => {
        await hoverOpen();
        leave(dom.dropdown, null);
        expect(isShown(dom.dropdown)).toBe(false);
    });

    it('closes on a pointermove outside the wheel even if no leave event arrived', async () => {
        await hoverOpen();
        move(dom.dropdown);
        expect(isShown(dom.dropdown)).toBe(true);
        move(dom.elsewhere, 400, 300);
        expect(isShown(dom.dropdown)).toBe(false);
    });

    it('closes on window blur, on the app being hidden, and on Escape', async () => {
        await hoverOpen();
        window.dispatchEvent(new Event('blur'));
        expect(isShown(dom.dropdown)).toBe(false);

        move(dom.trigger, 20, 20); // pointer moves again → hover may reopen
        await hoverOpen();
        expect(isShown(dom.dropdown)).toBe(true);
        const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
        vis.mockRestore();
        expect(isShown(dom.dropdown)).toBe(false);

        move(dom.trigger, 30, 30);
        await hoverOpen();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(isShown(dom.dropdown)).toBe(false);
    });

    it('closes when navigation hides the home page', async () => {
        await hoverOpen();
        dom.page.classList.add('hidden');
        await vi.advanceTimersByTimeAsync(0); // MutationObserver delivery
        expect(isShown(dom.dropdown)).toBe(false);
        expect(wheel.isNodeWheelOpen()).toBe(false);
    });

    it('does not pop open again under a pointer that has not moved after a forced close', async () => {
        move(dom.trigger, 50, 12);
        await hoverOpen();
        window.dispatchEvent(new Event('blur'));
        // The pill reappears under the same pointer; the browser reports a fresh enter.
        enter(dom.trigger, 50, 12);
        await vi.advanceTimersByTimeAsync(wheel.WHEEL_HOVER_OPEN_DELAY + 50);
        expect(isShown(dom.dropdown)).toBe(false);
        // A real movement over the pill opens it as usual.
        move(dom.trigger, 56, 14);
        await vi.advanceTimersByTimeAsync(wheel.WHEEL_HOVER_OPEN_DELAY);
        await vi.advanceTimersByTimeAsync(0);
        expect(isShown(dom.dropdown)).toBe(true);
    });

    it('picking a node collapses the wheel and switches through the API', async () => {
        const api = await import('../api.js');
        await hoverOpen();
        const jp = /** @type {HTMLElement} */ (Array.from(dom.list.querySelectorAll('[role="option"]'))
            .find((o) => o.textContent === 'JP 01'));
        jp.click();
        expect(isShown(dom.dropdown)).toBe(false);
        await vi.advanceTimersByTimeAsync(0);
        expect(api.switchProxyResult).toHaveBeenCalledWith('Proxy', 'JP 01');
    });

    it('restores the old node name and reports an error when the switch fails or throws', async () => {
        const api = await import('../api.js');
        const proxies = await import('./proxies.js');
        const rejected = new Error('busy');
        for (const fail of [() => Promise.resolve({ ok: false, reason: rejected }), () => Promise.reject(new Error('boom'))]) {
            /** @type {any} */ (api.switchProxyResult).mockImplementationOnce(fail);
            await hoverOpen();
            const jp = /** @type {HTMLElement} */ (Array.from(dom.list.querySelectorAll('[role="option"]'))
                .find((o) => o.textContent === 'JP 01'));
            jp.click();
            await vi.advanceTimersByTimeAsync(0);
            expect(document.getElementById('current-node-name')?.textContent).toBe('HK 02');
        }
        // Same titled toast as the proxies page; a thrown error carries its reason.
        expect(proxies.notifySwitchFailed).toHaveBeenCalledTimes(2);
        expect(proxies.notifySwitchFailed).toHaveBeenNthCalledWith(1, rejected);
        expect(/** @type {any} */ (proxies.notifySwitchFailed).mock.calls[1][0]).toBeInstanceOf(Error);
    });

    it('is keyboard operable: Enter opens on the current node, arrows move, Escape returns focus', async () => {
        dom.trigger.focus();
        dom.trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
        await vi.advanceTimersByTimeAsync(0);
        expect(isShown(dom.dropdown)).toBe(true);
        expect(document.activeElement?.textContent).toBe('HK 02');

        dom.list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        expect(document.activeElement?.textContent).toBe('JP 01');
        dom.list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
        expect(document.activeElement?.textContent).toBe('HK 01');

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(isShown(dom.dropdown)).toBe(false);
        expect(document.activeElement).toBe(dom.trigger);
    });

    it('moves keyboard focus to the loading hint when the group has no nodes yet', async () => {
        fetchProxyGroups.mockResolvedValue({ ...GROUPS, proxies: [] });
        dom.trigger.focus();
        dom.trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
        await vi.advanceTimersByTimeAsync(0);
        expect(isShown(dom.dropdown)).toBe(true);
        expect(document.activeElement?.textContent).toBe('loadingNodes');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(isShown(dom.dropdown)).toBe(false);
        expect(document.activeElement).toBe(dom.trigger);
    });
});
