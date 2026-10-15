import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockState = vi.hoisted(() => ({ homePageMode: 'minimal' }));

vi.mock('./3d-effect.js', () => ({
    setup3DEffect: vi.fn(),
}));

vi.mock('./state.js', () => ({
    appStore: {
        get: (key) => mockState[key],
    },
}));

const PAGES = ['home', 'console', 'proxies', 'logs', 'connections', 'advanced', 'rule-library'];
const NAV_ITEMS = ['home', 'proxies', 'logs', 'connections', 'rule-library'];

/** Build sidebar + page fixture. `visible` is the page shown initially. */
function buildDom(visible = 'home') {
    const nav = NAV_ITEMS.map(id => {
        const btn = document.createElement('button');
        btn.className = 'nav-btn';
        btn.dataset.nav = id;
        return btn;
    });
    const pages = PAGES.map(id => {
        const section = document.createElement('section');
        section.dataset.page = id;
        if (id !== visible) section.classList.add('hidden');
        return section;
    });
    const glows = ['home', 'proxies'].map(id => {
        const g = document.createElement('div');
        g.id = `glow-${id}`;
        return g;
    });
    document.body.replaceChildren(...nav, ...pages, ...glows);
    const homeBtn = nav[0];
    homeBtn.classList.add('is-active');
}

const navBtn = (id) => /** @type {HTMLElement} */ (document.querySelector(`[data-nav="${id}"]`));
const page = (id) => /** @type {HTMLElement} */ (document.querySelector(`[data-page="${id}"]`));
const visiblePages = () => [...document.querySelectorAll('[data-page]:not(.hidden)')]
    .map(el => /** @type {HTMLElement} */ (el).dataset.page);

/** Callbacks that record their invocation order. */
function makeCallbacks() {
    /** @type {string[]} */
    const calls = [];
    const names = [
        'onProxies', 'onAdvanced', 'onHome', 'onConsole', 'onRuleLibrary', 'onConnections', 'onLogs',
        'onLeaveLogs', 'onLeaveProxies', 'onLeaveConsole',
    ];
    /** @type {Record<string, import('vitest').Mock>} */
    const cbs = {};
    for (const n of names) cbs[n] = vi.fn(() => { calls.push(n); });
    return { cbs, calls };
}

/** @type {typeof import('./navigation.js')} */
let nav;

beforeEach(async () => {
    vi.resetModules();
    mockState.homePageMode = 'minimal';
    buildDom();
    nav = await import('./navigation.js');
});

afterEach(() => {
    vi.useRealTimers();
});

describe('switchPage', () => {
    it('shows only the target page', () => {
        nav.switchPage('proxies');
        expect(visiblePages()).toEqual(['proxies']);
    });

    it('shows only the glow layer belonging to the target page', () => {
        nav.switchPage('proxies');
        expect(document.getElementById('glow-proxies').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('glow-home').classList.contains('hidden')).toBe(true);
    });

    it('hides every glow layer when the page has none', () => {
        nav.switchPage('logs');
        expect(document.querySelectorAll('[id^="glow-"]:not(.hidden)')).toHaveLength(0);
    });
});

describe('navigateTo before initNavigation', () => {
    it('falls back to a plain page switch', () => {
        nav.navigateTo('logs');
        expect(visiblePages()).toEqual(['logs']);
    });
});

describe('initNavigation', () => {
    it('fires the enter callback and switches page on sidebar click', () => {
        const { cbs } = makeCallbacks();
        nav.initNavigation(cbs);
        navBtn('proxies').click();
        expect(cbs.onProxies).toHaveBeenCalledTimes(1);
        expect(visiblePages()).toEqual(['proxies']);
    });

    it('fires the leave callback of the previous page before the enter callback', () => {
        const { cbs, calls } = makeCallbacks();
        nav.initNavigation(cbs);
        nav.navigateTo('logs');
        nav.navigateTo('proxies');
        nav.navigateTo('connections');
        expect(calls).toEqual(['onLogs', 'onLeaveLogs', 'onProxies', 'onLeaveProxies', 'onConnections']);
    });

    it('does not fire a leave callback for pages without one', () => {
        const { cbs, calls } = makeCallbacks();
        nav.initNavigation(cbs);
        nav.navigateTo('connections');
        nav.navigateTo('rule-library');
        expect(calls).toEqual(['onConnections', 'onRuleLibrary']);
    });

    it('is a no-op when navigating to the current page', () => {
        const { cbs, calls } = makeCallbacks();
        nav.initNavigation(cbs);
        nav.navigateTo('logs');
        nav.navigateTo('logs');
        navBtn('logs').click();
        expect(calls).toEqual(['onLogs']);
    });

    it('treats the initially visible page as current', () => {
        const { cbs } = makeCallbacks();
        nav.initNavigation(cbs);
        nav.navigateTo('home');
        expect(cbs.onHome).not.toHaveBeenCalled();
    });

    it('ignores navigation to a page that does not exist', () => {
        const { cbs, calls } = makeCallbacks();
        nav.initNavigation(cbs);
        nav.navigateTo('logs');
        nav.navigateTo('does-not-exist');
        expect(calls).toEqual(['onLogs']);
        expect(visiblePages()).toEqual(['logs']);
        // still on logs: leaving it later fires its leave callback
        nav.navigateTo('home');
        expect(calls).toEqual(['onLogs', 'onLeaveLogs', 'onHome']);
    });

    it('tolerates missing callbacks', () => {
        nav.initNavigation({});
        expect(() => {
            nav.navigateTo('logs');
            nav.navigateTo('proxies');
        }).not.toThrow();
        expect(visiblePages()).toEqual(['proxies']);
    });

    it('marks the target nav item active and clears the previous one', () => {
        nav.initNavigation({});
        navBtn('logs').click();
        expect(navBtn('logs').classList.contains('is-active')).toBe(true);
        expect(navBtn('logs').getAttribute('aria-current')).toBe('page');
        expect(navBtn('home').classList.contains('is-active')).toBe(false);
        expect(navBtn('home').hasAttribute('aria-current')).toBe(false);
    });

    it('animates the previous nav item out and removes the leaving state after 500ms', () => {
        vi.useFakeTimers();
        nav.initNavigation({});
        navBtn('logs').click();
        expect(navBtn('home').classList.contains('is-leaving')).toBe(true);
        vi.advanceTimersByTime(500);
        expect(navBtn('home').classList.contains('is-leaving')).toBe(false);
    });

    it('keeps the current nav item highlighted for pages without a sidebar entry', () => {
        const { cbs } = makeCallbacks();
        nav.initNavigation(cbs);
        navBtn('logs').click();
        nav.navigateTo('advanced');
        expect(cbs.onAdvanced).toHaveBeenCalledTimes(1);
        expect(visiblePages()).toEqual(['advanced']);
        expect(navBtn('logs').classList.contains('is-active')).toBe(true);
    });
});

describe('initNavigation in console home mode', () => {
    beforeEach(() => {
        mockState.homePageMode = 'console';
    });

    it('redirects home to the console page', () => {
        const { cbs } = makeCallbacks();
        nav.initNavigation(cbs);
        nav.navigateTo('logs');
        navBtn('home').click();
        expect(cbs.onConsole).toHaveBeenCalledTimes(1);
        expect(cbs.onHome).not.toHaveBeenCalled();
        expect(visiblePages()).toEqual(['console']);
    });

    it('highlights the home sidebar item for the console page', () => {
        nav.initNavigation({});
        nav.navigateTo('logs');
        nav.navigateTo('home');
        expect(navBtn('home').classList.contains('is-active')).toBe(true);
        expect(navBtn('logs').classList.contains('is-active')).toBe(false);
    });

    it('treats an initially visible home page as the console page', () => {
        const { cbs, calls } = makeCallbacks();
        nav.initNavigation(cbs);
        nav.navigateTo('home'); // already on console → no-op
        nav.navigateTo('proxies');
        expect(calls).toEqual(['onLeaveConsole', 'onProxies']);
    });
});
