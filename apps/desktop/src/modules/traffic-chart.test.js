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
    observe() { /* TODO document why this method 'observe' is empty */ }
    unobserve() { /* TODO document why this method 'unobserve' is empty */ }
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
/** The straight segment into the newest sample (fill-closing lineTos run along y = HEIGHT). */
const curveEnds = () => ctx.ops.filter(o => o.op === 'lineTo' && o.args[1] !== HEIGHT);

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
    document.documentElement.style.removeProperty('--zephyr-color-download');
    document.documentElement.style.removeProperty('--zephyr-color-upload');

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

    it('starts as a flat baseline across the whole width before real data arrives', () => {
        chart.updateTrafficData(sample(0, 0));
        flushRaf();
        const [downStart, upStart] = moveTos();
        // The window is pre-filled with zeros, so both series start at the left edge on the baseline.
        expect(downStart.args).toEqual([0, 110]);
        expect(upStart.args).toEqual([0, 110]);
        expect(curvePoints()).toHaveLength(2 * 59);
    });

    it('draws download and upload series', () => {
        chart.updateTrafficData(sample(100, 100));
        chart.updateTrafficData(sample(200, 200));
        flushRaf();
        expect(moveTos()).toHaveLength(2);
        expect(ctx.fill).toHaveBeenCalled();
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
        flushRaf();
        // newest download sample 1024 B/s → 10% of the 10 KB/s floor
        // y = h - (v / max) * (h - 20) - 10 = 120 - 0.1 * 100 - 10 = 100, on the right edge
        const [downEnd, upEnd] = curveEnds();
        expect(downEnd.args).toEqual([WIDTH, 100]);
        // zero sits on the baseline (10px padding)
        expect(upEnd.args).toEqual([WIDTH, 110]);
    });

    it('scales the Y axis to the peak value when above the floor', () => {
        chart.updateTrafficData(sample(50000, 100000));
        flushRaf();
        const [downEnd, upEnd] = curveEnds();
        expect(downEnd.args).toEqual([WIDTH, 10]); // peak touches the top padding
        expect(upEnd.args).toEqual([WIDTH, 60]); // half the peak → middle
    });

    it('scales to a finite series even when the other series in the sample is NaN', () => {
        chart.updateTrafficData(sample(NaN, 100000));
        flushRaf();
        const [downEnd, upEnd] = curveEnds();
        // download is finite, so it sets the scale and its peak touches the top padding,
        // even though the same sample's upload value is NaN
        expect(downEnd.args).toEqual([WIDTH, 10]);
        // upload NaN is normalised to zero → baseline
        expect(upEnd.args).toEqual([WIDTH, 110]);
    });

    it('treats NaN samples as zero instead of breaking the chart', () => {
        chart.updateTrafficData(sample(NaN, NaN));
        chart.updateTrafficData(sample(2048, 2048));
        chart.updateTrafficData(sample(4096, 4096));
        flushRaf();
        expect(moveTos()).toHaveLength(2);
        for (const { args } of ctx.ops.filter(o => o.op !== 'clearRect' && o.op !== 'beginPath')) {
            for (const v of args) expect(Number.isFinite(v)).toBe(true);
        }
    });

    it('clearTrafficHistory resets the chart to a flat baseline', () => {
        chart.updateTrafficData(sample(50000, 100000));
        flushRaf();
        ctx.ops.length = 0;
        chart.clearTrafficHistory();
        flushRaf();
        expect(ctx.clearRect).toHaveBeenCalled();
        expect(curveEnds()).toHaveLength(2);
        for (const end of curveEnds()) expect(end.args[1]).toBe(110);
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
        // defaults from getThemeColors(): download #0A84FF / upload #FF6B6B
        expect(initialDown).toBe('rgba(10,132,255,0.8)');
        expect(initialUp).toBe('rgba(255,107,107,0.8)');

        document.documentElement.style.setProperty('--zephyr-color-download', '#ff0000');
        document.documentElement.style.setProperty('--zephyr-color-upload', '#00ff00');
        chart.updateChartTheme();

        now += 200; // halfway
        flushRaf();
        const [midDown, midUp] = ctx.strokes.slice(-2);
        expect(midDown).toBe(`rgba(${Math.round(10 + (255 - 10) / 2)},${Math.round(132 / 2)},${Math.round(255 / 2)},0.8)`);
        expect(midUp).toBe(`rgba(${Math.round(255 / 2)},${Math.round(107 + (255 - 107) / 2)},${Math.round(107 / 2)},0.8)`);
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
        document.documentElement.style.setProperty('--zephyr-color-download', 'rgb(1, 2, 3)');
        chart.initChart();
        now += 400;
        flushRaf();
        chart.updateTrafficData(sample(1, 1));
        chart.updateTrafficData(sample(2, 2));
        flushRaf();
        expect(ctx.strokes.slice(-2)[0]).toBe('rgba(10,132,255,0.8)');
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