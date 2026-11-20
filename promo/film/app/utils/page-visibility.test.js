import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** @type {typeof import('./page-visibility.js')} */
let pv;
let visibility;

function setVisibility(state) {
    visibility = state;
    document.dispatchEvent(new Event('visibilitychange'));
}

function addPage(id, hidden = false) {
    const el = document.createElement('section');
    el.dataset.page = id;
    if (hidden) el.classList.add('hidden');
    document.body.appendChild(el);
    return el;
}

/** visibilitychange listeners installed by the module instance under test. */
/** @type {Array<[string, EventListenerOrEventListenerObject, (boolean | AddEventListenerOptions | undefined)]>} */
let installed = [];

beforeEach(async () => {
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    document.body.replaceChildren();
    installed = [];
    const realAdd = document.addEventListener.bind(document);
    vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
        if (type === 'visibilitychange') installed.push([type, listener, options]);
        realAdd(type, listener, options);
    });
    vi.resetModules();
    pv = await import('./page-visibility.js');
});

afterEach(() => {
    // Each test imports a fresh module; detach the previous instance's
    // listener so its callbacks never see a later test's events.
    for (const [type, listener, options] of installed) document.removeEventListener(type, listener, options);
    vi.restoreAllMocks();
});

describe('isPageVisible', () => {
    it('is true for a page without the hidden class', () => {
        addPage('logs');
        expect(pv.isPageVisible('logs')).toBe(true);
    });

    it('is false for a hidden page', () => {
        addPage('logs', true);
        expect(pv.isPageVisible('logs')).toBe(false);
    });

    it('is false for a page that does not exist', () => {
        expect(pv.isPageVisible('nope')).toBe(false);
    });
});

describe('onPageVisible', () => {
    it('runs callbacks when the window becomes visible and the page is shown', () => {
        addPage('logs');
        const cb = vi.fn();
        pv.onPageVisible('logs', cb);
        setVisibility('hidden');
        expect(cb).not.toHaveBeenCalled();
        setVisibility('visible');
        expect(cb).toHaveBeenCalledTimes(1);
    });

    it('skips callbacks for pages that are hidden in the app', () => {
        addPage('logs', true);
        const cb = vi.fn();
        pv.onPageVisible('logs', cb);
        setVisibility('visible');
        expect(cb).not.toHaveBeenCalled();
    });

    it('returns an unsubscribe function', () => {
        addPage('logs');
        const cb = vi.fn();
        const off = pv.onPageVisible('logs', cb);
        off();
        setVisibility('visible');
        expect(cb).not.toHaveBeenCalled();
    });

    it('keeps calling other callbacks when one throws', () => {
        addPage('logs');
        const bad = vi.fn(() => { throw new Error('boom'); });
        const good = vi.fn();
        pv.onPageVisible('logs', bad);
        pv.onPageVisible('logs', good);
        expect(() => setVisibility('visible')).not.toThrow();
        expect(good).toHaveBeenCalledTimes(1);
    });
});

describe('destroyPageVisibility', () => {
    it('clears registered intervals and animation frames', () => {
        const clearSpy = vi.spyOn(globalThis, 'clearInterval');
        const cancelSpy = vi.fn();
        vi.stubGlobal('cancelAnimationFrame', cancelSpy);
        pv.registerPageTimer('logs', 11);
        pv.registerPageTimer('logs', 12);
        pv.registerPageRAF('logs', 21);
        pv.destroyPageVisibility('logs');
        expect(clearSpy).toHaveBeenCalledWith(11);
        expect(clearSpy).toHaveBeenCalledWith(12);
        expect(cancelSpy).toHaveBeenCalledWith(21);
        vi.unstubAllGlobals();
    });

    it('does not clear ids that were unregistered', () => {
        const clearSpy = vi.spyOn(globalThis, 'clearInterval');
        const cancelSpy = vi.fn();
        vi.stubGlobal('cancelAnimationFrame', cancelSpy);
        pv.registerPageTimer('logs', 11);
        pv.registerPageRAF('logs', 21);
        pv.unregisterPageTimer('logs', 11);
        pv.unregisterPageRAF('logs', 21);
        pv.destroyPageVisibility('logs');
        expect(clearSpy).not.toHaveBeenCalledWith(11);
        expect(cancelSpy).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it('drops visibility callbacks for the page', () => {
        addPage('logs');
        const cb = vi.fn();
        pv.onPageVisible('logs', cb);
        pv.destroyPageVisibility('logs');
        setVisibility('visible');
        expect(cb).not.toHaveBeenCalled();
    });

    it('only affects the given page', () => {
        addPage('logs');
        addPage('connections');
        const logsCb = vi.fn();
        const connCb = vi.fn();
        pv.onPageVisible('logs', logsCb);
        pv.onPageVisible('connections', connCb);
        pv.destroyPageVisibility('logs');
        setVisibility('visible');
        expect(logsCb).not.toHaveBeenCalled();
        expect(connCb).toHaveBeenCalledTimes(1);
    });

    it('is a no-op for unknown pages', () => {
        expect(() => pv.destroyPageVisibility('unknown')).not.toThrow();
        expect(() => pv.unregisterPageTimer('unknown', 1)).not.toThrow();
    });

    it('register helpers return the id they were given', () => {
        expect(pv.registerPageTimer('logs', 5)).toBe(5);
        expect(pv.registerPageRAF('logs', 6)).toBe(6);
    });
});
