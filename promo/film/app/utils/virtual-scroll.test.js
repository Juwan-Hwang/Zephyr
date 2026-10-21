import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createVirtualScroll } from './virtual-scroll.js';

/** Controllable requestAnimationFrame queue. */
let rafQueue;
let nextRafId;

function flushRaf() {
    const pending = rafQueue;
    rafQueue = new Map();
    for (const cb of pending.values()) cb(0);
}

/** Captures ResizeObserver instances so tests can trigger them. */
let resizeObservers;

class FakeResizeObserver {
    constructor(cb) {
        this.cb = cb;
        this.observed = [];
        this.disconnected = false;
        resizeObservers.push(this);
    }
    observe(el) { this.observed.push(el); }
    unobserve() {}
    disconnect() { this.disconnected = true; }
    trigger() { this.cb([], this); }
}

/**
 * Build a scroll container fixture.
 * @param {object} [o]
 * @param {number} [o.count=1000]
 * @param {number} [o.viewport=400]
 * @param {number} [o.width=600]
 * @param {number} [o.rowHeight=0] - height reported by rendered rows (0 = unmeasured)
 * @param {object} [o.opts] - extra createVirtualScroll options
 */
function setup({ count = 1000, viewport = 400, width = 600, rowHeight = 0, opts = {} } = {}) {
    const container = document.createElement('div');
    const spacerTop = document.createElement('div');
    const linesContainer = document.createElement('div');
    const spacerBottom = document.createElement('div');
    container.append(spacerTop, linesContainer, spacerBottom);
    document.body.appendChild(container);

    let clientHeight = viewport;
    let clientWidth = width;
    Object.defineProperty(container, 'clientHeight', { configurable: true, get: () => clientHeight });
    Object.defineProperty(container, 'clientWidth', { configurable: true, get: () => clientWidth });

    const state = { count, rowHeight };
    const renderItem = vi.fn((idx, frag) => {
        const el = document.createElement('div');
        el.setAttribute('data-line-idx', String(idx));
        el.textContent = `row ${idx}`;
        const h = state.rowHeight;
        el.getBoundingClientRect = () => /** @type {DOMRect} */ ({
            height: h, width: clientWidth, top: 0, left: 0, right: clientWidth, bottom: h, x: 0, y: 0,
            toJSON() { return {}; },
        });
        frag.appendChild(el);
    });

    const vs = createVirtualScroll({
        container,
        spacerTop,
        spacerBottom,
        linesContainer,
        itemCount: () => state.count,
        renderItem,
        rowHeightEst: 20,
        overscanPx: 100,
        scrollQuantumPx: 200,
        ...opts,
    });

    /** Indices currently mounted, in DOM order. */
    const mounted = () => [...linesContainer.children].map(el => Number(el.getAttribute('data-line-idx')));

    const scrollTo = (top) => {
        container.scrollTop = top;
        container.dispatchEvent(new Event('scroll'));
    };

    return {
        container, spacerTop, spacerBottom, linesContainer, vs, renderItem, state, mounted, scrollTo,
        setViewport: (h) => { clientHeight = h; },
        setWidth: (w) => { clientWidth = w; },
    };
}

beforeEach(() => {
    rafQueue = new Map();
    nextRafId = 1;
    resizeObservers = [];
    vi.stubGlobal('requestAnimationFrame', (cb) => {
        const id = nextRafId++;
        rafQueue.set(id, cb);
        return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id) => { rafQueue.delete(id); });
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    document.body.replaceChildren();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('createVirtualScroll — initial render', () => {
    it('renders only enough rows to cover the viewport plus overscan', () => {
        const { vs, mounted, spacerTop, spacerBottom } = setup();
        vs.invalidate();
        // needed = 400 + 2*100 = 600px at 20px/row → 30 rows
        expect(mounted()).toEqual(Array.from({ length: 30 }, (_, i) => i));
        expect(spacerTop.style.height).toBe('0px');
        // remaining 970 rows estimated at 20px each
        expect(spacerBottom.style.height).toBe(`${970 * 20}px`);
    });

    it('caps the initial window at maxMounted rows', () => {
        const { vs, mounted } = setup({ opts: { maxMounted: 10 } });
        vs.invalidate();
        expect(mounted()).toHaveLength(10);
    });

    it('renders the whole list when it is shorter than the viewport', () => {
        const { vs, mounted, spacerBottom } = setup({ count: 5 });
        vs.invalidate();
        expect(mounted()).toEqual([0, 1, 2, 3, 4]);
        expect(spacerBottom.style.height).toBe('0px');
    });

    it('renders nothing for an empty list', () => {
        const { vs, mounted, renderItem, spacerTop, spacerBottom } = setup({ count: 0 });
        vs.invalidate();
        expect(mounted()).toEqual([]);
        expect(renderItem).not.toHaveBeenCalled();
        expect(spacerTop.style.height).toBe('0px');
        expect(spacerBottom.style.height).toBe('0px');
    });

    it('renders nothing while the container has no height (e.g. hidden page)', () => {
        const { vs, mounted } = setup({ viewport: 0 });
        vs.invalidate();
        expect(mounted()).toEqual([]);
    });

    it('disables native scroll anchoring on the container', () => {
        const { container } = setup();
        expect(container.style.overflowAnchor).toBe('none');
    });
});

describe('createVirtualScroll — scrolling', () => {
    it('moves the render window when scrolled past the quantum threshold', () => {
        const { vs, mounted, scrollTo, spacerTop, spacerBottom } = setup();
        vs.invalidate();
        scrollTo(300);
        // start = row at (300 - 100) / 20 = 10, covering 600px → rows 10..39
        expect(mounted()).toEqual(Array.from({ length: 30 }, (_, i) => i + 10));
        expect(spacerTop.style.height).toBe(`${10 * 20}px`);
        expect(spacerBottom.style.height).toBe(`${(1000 - 40) * 20}px`);
    });

    it('does not re-render for scroll deltas below the quantum threshold', () => {
        const { vs, mounted, renderItem, scrollTo } = setup();
        vs.invalidate();
        renderItem.mockClear();
        scrollTo(150);
        expect(renderItem).not.toHaveBeenCalled();
        expect(mounted()[0]).toBe(0);
    });

    it('keeps mounted rows in ascending DOM order when scrolling down and back up', () => {
        const { vs, mounted, scrollTo } = setup();
        vs.invalidate();
        scrollTo(300);
        scrollTo(600);
        scrollTo(350);
        const rows = mounted();
        expect(rows).toEqual([...rows].sort((a, b) => a - b));
        // contiguous range, no gaps or duplicates
        expect(rows[rows.length - 1] - rows[0] + 1).toBe(rows.length);
        expect(new Set(rows).size).toBe(rows.length);
    });

    it('re-renders already-mounted rows only once (no duplicate renderItem calls)', () => {
        const { vs, renderItem, scrollTo } = setup();
        vs.invalidate();
        renderItem.mockClear();
        scrollTo(300);
        // rows 10..29 stay mounted; only 30..39 are new
        const rendered = renderItem.mock.calls.map(c => c[0]);
        expect(rendered).toEqual(Array.from({ length: 10 }, (_, i) => i + 30));
    });

    it('defers DOM work during high-velocity scrolls and renders once velocity decays', () => {
        vi.useFakeTimers();
        const { vs, mounted, renderItem, scrollTo, spacerTop } = setup();
        vs.invalidate();
        renderItem.mockClear();

        // Jump further than one viewport in a single event (scrollbar drag)
        scrollTo(10000);
        expect(renderItem).not.toHaveBeenCalled();
        expect(mounted()[0]).toBe(0);
        // spacers are still updated to reflect the new position
        expect(parseFloat(spacerTop.style.height)).toBeGreaterThan(0);

        vi.advanceTimersByTime(150);
        expect(renderItem).toHaveBeenCalled();
        const rows = mounted();
        // window now surrounds row 10000/20 = 500
        expect(rows[0]).toBeLessThanOrEqual(495);
        expect(rows[rows.length - 1]).toBeGreaterThanOrEqual(520);
    });

    it('invokes the onScroll callback for user scroll events', () => {
        const onScroll = vi.fn();
        const { vs, scrollTo } = setup({ opts: { onScroll } });
        vs.invalidate();
        scrollTo(50);
        expect(onScroll).toHaveBeenCalledTimes(1);
    });
});

describe('createVirtualScroll — height cache', () => {
    it('uses measured row heights to size the window on the next full render', () => {
        const { vs, mounted } = setup({ rowHeight: 40 });
        vs.invalidate();
        expect(mounted()).toHaveLength(30); // nothing measured yet → 20px estimate

        // A content-change render measures the mounted rows (40px each)
        vs.scheduleRender();
        flushRaf();

        vs.invalidate();
        // 600px coverage / 40px measured rows → 15 rows
        expect(mounted()).toHaveLength(15);
    });

    it('accounts for measured heights in the spacer sizes', () => {
        const { vs, spacerBottom } = setup({ rowHeight: 40 });
        vs.invalidate();
        vs.scheduleRender();
        flushRaf();
        // rows 0..29 measured at 40px and mounted; rows 30..999 are unmeasured and
        // use an estimate between the configured 20px and the 40px running average
        const px = (/** @type {string} */ v) => parseFloat(v);
        expect(px(spacerBottom.style.height)).toBeGreaterThanOrEqual(970 * 20);
        expect(px(spacerBottom.style.height)).toBeLessThanOrEqual(970 * 40);
        const unmeasured = px(spacerBottom.style.height);

        vs.invalidate();
        // after invalidate only rows 0..14 are mounted; rows 15..29 add their
        // measured 40px each on top of the unmeasured rows
        expect(px(spacerBottom.style.height) - unmeasured).toBeGreaterThanOrEqual(15 * 40 - 1);
    });

    it('re-renders correctly after the list shrinks below the cached range', () => {
        const { vs, mounted, state, spacerTop, spacerBottom } = setup({ rowHeight: 40 });
        vs.invalidate();
        vs.scheduleRender();
        flushRaf();

        state.count = 5;
        vs.invalidate();
        expect(mounted()).toEqual([0, 1, 2, 3, 4]);
        expect(spacerTop.style.height).toBe('0px');
        expect(spacerBottom.style.height).toBe('0px');
    });

    it('clears the height cache when the container width changes', () => {
        const { vs, setWidth, state, renderItem, spacerBottom } = setup({ rowHeight: 40 });
        vs.invalidate();
        vs.scheduleRender();
        flushRaf();
        vs.invalidate();
        const withCache = spacerBottom.style.height;
        const rendersBefore = renderItem.mock.calls.length;

        expect(resizeObservers).toHaveLength(1);
        // Rows re-wrap at the new width, so they now measure differently.
        setWidth(300);
        state.rowHeight = 64;
        resizeObservers[0].trigger();
        flushRaf();
        vs.invalidate();
        // Rows were rendered and measured again, and the layout no longer
        // reflects the 40px measurements taken at the old width.
        expect(renderItem.mock.calls.length).toBeGreaterThan(rendersBefore);
        expect(spacerBottom.style.height).not.toBe(withCache);
    });

    it('does not clear the height cache on height-only resizes', () => {
        const { vs, spacerBottom } = setup({ rowHeight: 40 });
        vs.invalidate();
        vs.scheduleRender();
        flushRaf();
        vs.invalidate();
        const withCache = spacerBottom.style.height;

        resizeObservers[0].trigger(); // width unchanged
        flushRaf();
        vs.invalidate();
        expect(spacerBottom.style.height).toBe(withCache);
    });

    it('clearHeightCache forgets measured heights', () => {
        const { vs, spacerBottom } = setup({ rowHeight: 40 });
        vs.invalidate();
        vs.scheduleRender();
        flushRaf();
        vs.invalidate();
        const withCache = spacerBottom.style.height;

        vs.clearHeightCache();
        vs.invalidate();
        // per-row measurements are gone, so the spacer is rebuilt from estimates
        // (which estimate is used after a clear is not asserted here)
        expect(spacerBottom.style.height).not.toBe(withCache);
    });
});

describe('createVirtualScroll — invalidate', () => {
    it('re-renders from scratch with fresh content', () => {
        const { vs, linesContainer, renderItem } = setup({ count: 3 });
        vs.invalidate();
        linesContainer.firstElementChild.textContent = 'stale';
        renderItem.mockClear();
        vs.invalidate();
        expect(renderItem.mock.calls.map(c => c[0])).toEqual([0, 1, 2]);
        expect(linesContainer.firstElementChild.textContent).toBe('row 0');
    });

    it('preserves the user scroll position', () => {
        const { vs, container, scrollTo } = setup();
        vs.invalidate();
        scrollTo(300);
        vs.invalidate();
        expect(container.scrollTop).toBe(300);
    });

    it('calls onAutoScroll exactly once per invalidate', () => {
        const onAutoScroll = vi.fn();
        const { vs } = setup({ opts: { onAutoScroll } });
        vs.invalidate();
        expect(onAutoScroll).toHaveBeenCalledTimes(1);
        vs.invalidate();
        expect(onAutoScroll).toHaveBeenCalledTimes(2);
    });

    it('cancels a pending scheduled render', () => {
        const { vs, renderItem } = setup({ count: 3 });
        vs.scheduleRender();
        expect(rafQueue.size).toBe(1);
        vs.invalidate();
        expect(rafQueue.size).toBe(0);
        expect(renderItem).toHaveBeenCalledTimes(3);
    });
});

describe('createVirtualScroll — scheduleRender', () => {
    it('coalesces multiple calls into a single animation frame', () => {
        const { vs } = setup();
        vs.scheduleRender();
        vs.scheduleRender();
        vs.scheduleRender();
        expect(rafQueue.size).toBe(1);
    });

    it('renders new rows appended to the list and calls onAutoScroll', () => {
        const onAutoScroll = vi.fn();
        const { vs, mounted, state } = setup({ count: 3, opts: { onAutoScroll } });
        vs.invalidate();
        onAutoScroll.mockClear();
        state.count = 5;
        vs.scheduleRender();
        flushRaf();
        expect(mounted()).toEqual([0, 1, 2, 3, 4]);
        expect(onAutoScroll).toHaveBeenCalledTimes(1);
    });
});

describe('createVirtualScroll — destroy', () => {
    it('stops reacting to scroll events', () => {
        const { vs, renderItem, scrollTo, mounted } = setup();
        vs.invalidate();
        vs.destroy();
        renderItem.mockClear();
        scrollTo(300);
        expect(renderItem).not.toHaveBeenCalled();
        expect(mounted()[0]).toBe(0);
    });

    it('disconnects the ResizeObserver', () => {
        const { vs } = setup();
        expect(resizeObservers[0].disconnected).toBe(false);
        vs.destroy();
        expect(resizeObservers[0].disconnected).toBe(true);
    });

    it('cancels a pending animation-frame render', () => {
        const { vs, renderItem } = setup();
        vs.scheduleRender();
        vs.destroy();
        flushRaf();
        expect(renderItem).not.toHaveBeenCalled();
    });

    it('cancels the pending velocity-decay render', () => {
        vi.useFakeTimers();
        const { vs, renderItem, scrollTo } = setup();
        vs.invalidate();
        scrollTo(10000); // high velocity → deferred render scheduled
        renderItem.mockClear();
        vs.destroy();
        vi.advanceTimersByTime(500);
        expect(renderItem).not.toHaveBeenCalled();
    });

    it('is safe to call twice', () => {
        const { vs } = setup();
        vs.destroy();
        expect(() => vs.destroy()).not.toThrow();
    });
});

describe('createVirtualScroll — content-sized container', () => {
    it('invalidate keeps rows mounted when the viewport height comes from the content', () => {
        const f = setup({ count: 6, viewport: 0, rowHeight: 44 });
        // A container without a fixed height (inside a dialog) is as tall as its content.
        Object.defineProperty(f.container, 'clientHeight', {
            configurable: true,
            get: () => (parseFloat(f.spacerTop.style.height) || 0)
                + (parseFloat(f.spacerBottom.style.height) || 0)
                + f.linesContainer.children.length * 44,
        });
        f.vs.invalidate();
        expect(f.mounted()).toEqual([0, 1, 2, 3, 4, 5]);
        f.state.count = 7; // e.g. a rule added at the top
        f.vs.invalidate();
        expect(f.mounted().length).toBe(7);
    });
});
