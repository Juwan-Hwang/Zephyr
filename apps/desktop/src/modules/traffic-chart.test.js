import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Controllable requestAnimationFrame queue. */
let rafQueue;
let nextRafId;
function flushRaf() {
    // A render may schedule another frame (colour transition); run one round only.
    const pending = rafQueue;
    rafQueue = new Map();
    for (const cb of pending.values()) cb(0);
}

let now;

class FakeResizeObserver {
    constructor(cb) { this.cb = cb; this.disconnected = false; observers.push(this); }
    observe() {}
    unobserve() {}
    disconnect() { this.disconnected = true; }
}
let observers;

/** Minimal 2D context that records the drawing operations we care about. */
function createFakeContext() {
    const ctx = {
        ops: /** @type {Array<{op: string, args: any[]}>} */ ([]),
        strokes: /** @type {string[]} */ ([]),
        strokeStyle: '',
        fillStyle: /** @type {any} */ (''),
        lineWidth: 1,
        lineCap: 'butt',
        lineJoin: 'miter',
        clearRect: vi.fn((...args) => ctx.ops.push({ op: 'clearRect', args })),
        beginPath: vi.fn(() => ctx.ops.push({ op: 'beginPath', args: [] })),
        moveTo: vi.fn((...args) => ctx.ops.push({ op: 'moveTo', args })),
        lineTo: vi.fn((...args) => ctx.ops.push({ op: 'lineTo', args })),
        quadraticCurveTo: vi.fn((...args) => ctx.ops.push({ op: 'quadraticCurveTo', args })),
        closePath: vi.fn(),
        stroke: vi.fn(() => { ctx.strokes.push(ctx.strokeStyle); }),
        fill: vi.fn(),
        setTransform: vi.fn(),
        scale: vi.fn(),
        createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    };
    return ctx;
}

/** @type {ReturnType<typeof createFakeContext>} */
let ctx;
/** @type {HTMLCanvasElement} */
let canvas;
/** @type {typeof import('./traffic-chart.js')} */
let chart;

const WIDTH = 590; // 59 gaps → 10px per data point
const HEIGHT = 120;

function buildDom() {
    const wrapper = document.createElement('div');
    canvas = document.createElement('canvas');
    canvas.id = 'trafficChart';
    Object.defineProperty(canvas, 'clientWidth', { configurable: true, value: WIDTH });
    Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: HEIGHT });
    ctx = createFakeContext();
    canvas.getContext = /** @type {any} */ (() => ctx);
    wrapper.appendChild(canvas);

    const speed = ['speed-up-val', 'speed-up-unit', 'speed-down-val', 'speed-down-unit'].map(id => {
        const span = document.createElement('span');
        span.id = id;
        return span;
    });
    document.body.replaceChildren(wrapper, ...speed);
}

/** @param {number} up @param {number} down */
function sample(up, down, upText = '1 KB/s', downText = '2 KB/s') {
    return { up: upText, down: downText, raw: { up, down } };
}

const curvePoints = () => ctx.ops.filter(o => o.op === 'quadraticCurveTo');
const moveTos = () => ctx.ops.filter(o => o.op === 'moveTo');

let hidden;

beforeEach(async () => {
    rafQueue = new Map();
    nextRafId = 1;
    observers = [];
    now = 1000;
    hidden = false;
    vi.stubGlobal('requestAnimationFrame', (cb) => {
        const id = nextRafId++;
        rafQueue.set(id, cb);
        return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id) => { rafQueue.delete(id); });
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    document.documentElement.style.removeProperty('--accent-primary');
    document.documentElement.style.removeProperty('--color-secondary');

    buildDom();
    vi.resetModules();
    chart = await import('./traffic-chart.js');
});

afterEach(() => {
    chart.cleanupChart();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('updateTrafficData — speed readout', () => {
    it('splits formatted speeds into value and unit', () => {
        chart.updateTrafficData(sample(1, 2, '12.5 MB/s', '3 KB/s'));
        expect(document.getElementById('speed-up-val').textContent).toBe('12.5');
        expect(document.getElementById('speed-up-unit').textContent).toBe('MB/s');
        expect(document.getElementById('speed-down-val').textContent).toBe('3');
        expect(document.getElementById('speed-down-unit').textContent).toBe('KB/s');
    });

    it('falls back to sensible defaults for malformed strings', () => {
        chart.updateTrafficData(sample(0, 0, '', '7'));
        expect(document.getElementById('speed-up-val').textContent).toBe('0');
        expect(document.getElementById('speed-up-unit').textContent).toBe('KB/s');
        expect(document.getElementById('speed-down-val').textContent).toBe('7');
        expect(document.getElementById('speed-down-unit').textContent).toBe('KB/s');
    });

    it('works without the readout elements and without a canvas', () => {
        document.body.replaceChildren();
        expect(() => {
            chart.updateTrafficData(sample(1, 1));
            flushRaf();
        }).not.toThrow();
    });
});

describe('chart rendering', () => {
    beforeEach(() => {
        chart.initChart();
        flushRaf();
        ctx.ops.length = 0;
        ctx.strokes.length = 0;
    });

    it('draws nothing until at least two samples exist', () => {
        chart.updateTrafficData(sample(100, 100));
        flushRaf();
        expect(ctx.clearRect).toHaveBeenCalled();
        expect(ctx.stroke).not.toHaveBeenCalled();
    });

    it('draws download and upload series once two samples exist', () => {
        chart.updateTrafficData(sample(100, 100));
        chart.updateTrafficData(sample(200, 200));
        flushRaf();
        expect(ctx.stroke).toHaveBeenCalledTimes(2);
        expect(moveTos()).toHaveLength(2);
    });

    it('coalesces several updates into one frame', () => {
        for (let i = 0; i < 5; i++) chart.updateTrafficData(sample(i, i));
        expect(rafQueue.size).toBe(1);
    });

    it('keeps a rolling window of 60 samples', () => {
        for (let i = 0; i < 75; i++) chart.updateTrafficData(sample(i, i));
        flushRaf();
        // each series draws (points - 1) curve segments
        expect(curvePoints()).toHaveLength(2 * 59);
    });

    it('scales the Y axis with a 10 KB/s floor for small values', () => {
        chart.updateTrafficData(sample(0, 1024));
        chart.updateTrafficData(sample(0, 0));
        flushRaf();
        // download series starts at 1024 B/s → 10% of the 10 KB/s floor
        // y = h - (v / max) * (h - 20) - 10 = 120 - 0.1 * 100 - 10 = 100
        const [downStart, upStart] = moveTos();
        expect(downStart.args).toEqual([0, 100]);
        // zero sits on the baseline (10px padding)
        expect(upStart.args).toEqual([0, 110]);
    });

    it('scales the Y axis to the peak value when above the floor', () => {
        chart.updateTrafficData(sample(50000, 100000));
        chart.updateTrafficData(sample(0, 0));
        flushRaf();
        const [downStart, upStart] = moveTos();
        expect(downStart.args).toEqual([0, 10]); // peak touches the top padding
        expect(upStart.args).toEqual([0, 60]); // half the peak → middle
    });

    it('treats NaN samples as zero instead of breaking the chart', () => {
        chart.updateTrafficData(sample(NaN, NaN));
        chart.updateTrafficData(sample(2048, 2048));
        chart.updateTrafficData(sample(4096, 4096));
        flushRaf();
        expect(ctx.stroke).toHaveBeenCalledTimes(2);
        for (const { args } of ctx.ops.filter(o => o.op !== 'clearRect' && o.op !== 'beginPath')) {
            for (const v of args) expect(Number.isFinite(v)).toBe(true);
        }
    });

    it('clearTrafficHistory empties the chart', () => {
        chart.updateTrafficData(sample(1, 1));
        chart.updateTrafficData(sample(2, 2));
        flushRaf();
        ctx.stroke.mockClear();
        chart.clearTrafficHistory();
        flushRaf();
        expect(ctx.clearRect).toHaveBeenCalled();
        expect(ctx.stroke).not.toHaveBeenCalled();
    });
});

describe('visibility handling', () => {
    beforeEach(() => {
        chart.initChart();
        now += 400; // finish the initial colour transition so no frames are pending
        flushRaf();
        expect(rafQueue.size).toBe(0);
    });

    it('does not schedule renders while the document is hidden', () => {
        hidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
        chart.updateTrafficData(sample(1, 1));
        chart.updateTrafficData(sample(2, 2));
        expect(rafQueue.size).toBe(0);
    });

    it('renders accumulated data once the document becomes visible again', () => {
        hidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
        chart.updateTrafficData(sample(1, 1));
        chart.updateTrafficData(sample(2, 2));

        hidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
        expect(rafQueue.size).toBe(1);
        ctx.stroke.mockClear();
        flushRaf();
        expect(ctx.stroke).toHaveBeenCalledTimes(2);
    });

    it('does not re-render on becoming visible if nothing arrived while hidden', () => {
        hidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
        hidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
        expect(rafQueue.size).toBe(0);
    });
});

describe('theme colours', () => {
    it('transitions smoothly to new theme colours over 400ms', () => {
        chart.initChart();
        // let the initial transition finish
        now += 400;
        flushRaf();
        chart.updateTrafficData(sample(1, 1));
        chart.updateTrafficData(sample(2, 2));
        flushRaf();
        const [initialDown, initialUp] = ctx.strokes.slice(-2);
        // defaults from getThemeColors(): #8b5cf6 / #3b82f6
        expect(initialDown).toBe('rgba(139,92,246,0.8)');
        expect(initialUp).toBe('rgba(59,130,246,0.8)');

        document.documentElement.style.setProperty('--accent-primary', '#ff0000');
        document.documentElement.style.setProperty('--color-secondary', '#00ff00');
        chart.updateChartTheme();

        now += 200; // halfway
        flushRaf();
        const [midDown, midUp] = ctx.strokes.slice(-2);
        expect(midDown).toBe(`rgba(${Math.round(139 + (255 - 139) / 2)},${Math.round(92 / 2)},${Math.round(246 / 2)},0.8)`);
        expect(midUp).toBe(`rgba(${Math.round(59 / 2)},${Math.round(130 + (255 - 130) / 2)},${Math.round(246 / 2)},0.8)`);
        // transition still in flight → another frame queued
        expect(rafQueue.size).toBe(1);

        now += 300; // past the end
        flushRaf();
        const [endDown, endUp] = ctx.strokes.slice(-2);
        expect(endDown).toBe('rgba(255,0,0,0.8)');
        expect(endUp).toBe('rgba(0,255,0,0.8)');
        // transition complete → no more frames
        expect(rafQueue.size).toBe(0);
    });

    it('falls back to default colours when the CSS variables are not hex', () => {
        document.documentElement.style.setProperty('--accent-primary', 'rebeccapurple');
        chart.initChart();
        now += 400;
        flushRaf();
        chart.updateTrafficData(sample(1, 1));
        chart.updateTrafficData(sample(2, 2));
        flushRaf();
        expect(ctx.strokes.slice(-2)[0]).toBe('rgba(139,92,246,0.8)');
    });
});

describe('lifecycle', () => {
    it('initChart is a no-op without a #trafficChart canvas', () => {
        document.body.replaceChildren();
        expect(() => chart.initChart()).not.toThrow();
        expect(observers).toHaveLength(0);
    });

    it('cleanupChart cancels pending frames and disconnects observers', () => {
        chart.initChart();
        chart.updateTrafficData(sample(1, 1));
        chart.updateTrafficData(sample(2, 2));
        expect(rafQueue.size).toBe(1);
        chart.cleanupChart();
        expect(rafQueue.size).toBe(0);
        expect(observers[0].disconnected).toBe(true);
    });

    it('stops drawing after cleanupChart', () => {
        chart.initChart();
        flushRaf();
        chart.cleanupChart();
        ctx.ops.length = 0;
        chart.updateTrafficData(sample(1, 1));
        chart.updateTrafficData(sample(2, 2));
        flushRaf();
        expect(ctx.ops).toHaveLength(0);
    });

    it('stops listening for visibility changes after cleanupChart', () => {
        chart.initChart();
        hidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
        chart.updateTrafficData(sample(1, 1));
        chart.cleanupChart();
        hidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
        expect(rafQueue.size).toBe(0);
    });

    it('resizes the canvas backing store for the device pixel ratio', () => {
        vi.useFakeTimers();
        vi.stubGlobal('devicePixelRatio', 2);
        canvas.getBoundingClientRect = () => /** @type {DOMRect} */ ({
            width: 300, height: 100, top: 0, left: 0, right: 300, bottom: 100, x: 0, y: 0, toJSON() { return {}; },
        });
        chart.initChart();
        vi.advanceTimersByTime(100);
        expect(canvas.width).toBe(600);
        expect(canvas.height).toBe(200);
        expect(ctx.scale).toHaveBeenCalledWith(2, 2);
    });
});
