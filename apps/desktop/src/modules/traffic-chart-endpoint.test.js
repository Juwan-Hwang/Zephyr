// @ts-check
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Recording 2D context: captures path commands so tests can check where the
 * curve and the fill actually end.
 */
function createRecordingContext() {
    /** @type {Array<[string, ...number[]]>} */
    const ops = [];
    const ctx = {
        ops,
        clearRect: vi.fn(),
        setTransform: vi.fn(),
        scale: vi.fn(),
        beginPath: () => ops.push(['beginPath']),
        moveTo: (/** @type {number} */ x, /** @type {number} */ y) => ops.push(['moveTo', x, y]),
        lineTo: (/** @type {number} */ x, /** @type {number} */ y) => ops.push(['lineTo', x, y]),
        quadraticCurveTo: (/** @type {number} */ cx, /** @type {number} */ cy, /** @type {number} */ x, /** @type {number} */ y) => ops.push(['quadraticCurveTo', cx, cy, x, y]),
        closePath: () => ops.push(['closePath']),
        stroke: () => ops.push(['stroke']),
        fill: () => ops.push(['fill']),
        createLinearGradient: () => ({ addColorStop: vi.fn() }),
        strokeStyle: '',
        fillStyle: /** @type {any} */ (''),
        lineWidth: 1,
        lineCap: '',
        lineJoin: '',
    };
    return ctx;
}

describe('traceSmoothCurve()', () => {
    it('ends exactly on the newest point', async () => {
        const { traceSmoothCurve } = await import('./traffic-chart.js');
        const ctx = createRecordingContext();
        const pts = [{ x: 0, y: 50 }, { x: 10, y: 20 }, { x: 20, y: 80 }, { x: 30, y: 5 }];
        traceSmoothCurve(ctx, pts);
        const last = ctx.ops[ctx.ops.length - 1];
        expect(last).toEqual(['lineTo', 30, 5]);
        expect(ctx.ops[0]).toEqual(['moveTo', 0, 50]);
    });

    it('joins the final segment tangentially (collinear with the last control point)', async () => {
        const { traceSmoothCurve } = await import('./traffic-chart.js');
        const ctx = createRecordingContext();
        const pts = [{ x: 0, y: 0 }, { x: 10, y: 40 }, { x: 20, y: 10 }];
        traceSmoothCurve(ctx, pts);
        const lastQuad = /** @type {number[]} */ (ctx.ops.filter(o => o[0] === 'quadraticCurveTo').pop()).slice(1);
        const [cx, cy, ex, ey] = lastQuad;
        // End tangent of the last quad points from its control (prev sample)
        // toward its end (midpoint); the closing line continues to the last
        // sample along the same direction.
        const cross = ((ex - cx) * (10 - ey)) - ((ey - cy) * (20 - ex));
        expect(Math.abs(cross)).toBeLessThan(1e-9);
    });

    it('handles 0 and 1 points without throwing', async () => {
        const { traceSmoothCurve } = await import('./traffic-chart.js');
        const ctx = createRecordingContext();
        traceSmoothCurve(ctx, []);
        expect(ctx.ops).toEqual([]);
        traceSmoothCurve(ctx, [{ x: 1, y: 2 }]);
        expect(ctx.ops).toEqual([['moveTo', 1, 2]]);
    });
});

describe('traffic chart rendering', () => {
    /** @type {ReturnType<typeof createRecordingContext>} */
    let ctx;
    /** @type {Map<number, FrameRequestCallback>} */
    let frames;
    let nextFrameId = 0;
    /** @type {ReturnType<typeof vi.fn>} */
    let rafSpy;
    let hidden = false;
    /** @type {typeof import('./traffic-chart.js') | null} */
    let loaded = null;

    async function load() {
        loaded = await import('./traffic-chart.js');
        return loaded;
    }

    const WIDTH = 590;
    const HEIGHT = 200;

    function flushFrames() {
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach(cb => cb(performance.now()));
    }

    beforeEach(() => {
        vi.resetModules();
        hidden = false;
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
        frames = new Map();
        rafSpy = vi.fn((/** @type {FrameRequestCallback} */ cb) => { frames.set(++nextFrameId, cb); return nextFrameId; });
        vi.stubGlobal('requestAnimationFrame', rafSpy);
        vi.stubGlobal('cancelAnimationFrame', vi.fn((/** @type {number} */ id) => { frames.delete(id); }));
        vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });

        document.body.innerHTML = '<div><canvas id="trafficChart"></canvas></div>';
        const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('trafficChart'));
        Object.defineProperty(canvas, 'clientWidth', { configurable: true, get: () => WIDTH });
        Object.defineProperty(canvas, 'clientHeight', { configurable: true, get: () => HEIGHT });
        ctx = createRecordingContext();
        canvas.getContext = /** @type {any} */ (() => ctx);
    });

    afterEach(() => {
        // Each test imports a fresh module instance; detach its document
        // listener so it cannot react to later tests' visibility events.
        loaded?.cleanupChart();
        loaded = null;
        vi.unstubAllGlobals();
        // @ts-ignore - remove the instance override, fall back to the prototype getter
        delete document.hidden;
        document.body.innerHTML = '';
    });

    /** @param {number} down */
    const sample = (down) => ({ up: '0 B/s', down: `${down} B/s`, raw: { up: 0, down } });

    it('draws the downstream curve all the way to the newest sample and closes the fill below it', async () => {
        const chart = await load();
        chart.initChart();
        const values = [20000, 40000, 10000, 60000, 30000];
        values.forEach(v => chart.updateTrafficData(sample(v)));
        ctx.ops.length = 0;
        // Let any colour transition finish, then render a clean frame.
        await new Promise(r => setTimeout(r, 450));
        flushFrames();
        ctx.ops.length = 0;
        chart.updateTrafficData(sample(30000));
        flushFrames();

        // First series drawn is downstream; slice its ops up to the first fill.
        const firstFill = ctx.ops.findIndex(o => o[0] === 'fill');
        const series = ctx.ops.slice(0, firstFill + 1);
        const strokeIdx = series.findIndex(o => o[0] === 'stroke');
        const beforeStroke = series[strokeIdx - 1];

        const n = 6; // five samples + one more
        const lastX = ((n - 1) / 59) * WIDTH;
        const maxVal = 60000;
        const lastY = HEIGHT - ((30000 / maxVal) * (HEIGHT - 20)) - 10;

        expect(beforeStroke[0]).toBe('lineTo');
        expect(beforeStroke[1]).toBeCloseTo(lastX, 6);
        expect(beforeStroke[2]).toBeCloseTo(lastY, 6);

        // Fill: straight down from the newest point, then back along the baseline.
        const afterStroke = series.slice(strokeIdx + 1);
        expect(afterStroke[0][0]).toBe('lineTo');
        expect(afterStroke[0][1]).toBeCloseTo(lastX, 6);
        expect(afterStroke[0][2]).toBe(HEIGHT);
        expect(afterStroke[1]).toEqual(['lineTo', 0, HEIGHT]);
        expect(afterStroke[2]).toEqual(['closePath']);
    });

    it('does not request animation frames for the theme transition while the document is hidden', async () => {
        const chart = await load();
        chart.initChart();
        flushFrames();

        hidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
        rafSpy.mockClear();

        chart.updateChartTheme();
        chart.updateTrafficData(sample(1000));
        chart.updateTrafficData(sample(2000));
        expect(rafSpy).not.toHaveBeenCalled();

        hidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
        expect(rafSpy).toHaveBeenCalledTimes(1);
    });

    it('cancels a queued transition frame when the document becomes hidden', async () => {
        const chart = await load();
        chart.initChart();
        flushFrames();
        chart.updateChartTheme();
        expect(rafSpy).toHaveBeenCalled();

        hidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
        expect(cancelAnimationFrame).toHaveBeenCalled();
        expect(frames.size).toBe(0);

        hidden = false;
        rafSpy.mockClear();
        document.dispatchEvent(new Event('visibilitychange'));
        expect(rafSpy).toHaveBeenCalledTimes(1);
    });
});
