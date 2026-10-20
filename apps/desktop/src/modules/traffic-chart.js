// @ts-check
/**
 * @module traffic-chart
 *
 * Real-time traffic visualization with smooth area charts.
 * Completely independent — no external dependencies from ui.js.
 *
 * Features:
 *  - Theme-aware colours via CSS custom properties ({@link getThemeColors})
 *  - Smooth colour transitions when the theme changes
 *  - All rendering driven through {@link requestAnimationFrame}
 */

import { getThemeColors, hexToRgb } from '../utils/color.js';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Maximum number of data points kept in the rolling window. */
const MAX_DATA_POINTS = 60;

/** Duration (ms) over which colour transitions are interpolated. */
const COLOR_LERP_DURATION = 400;

/* ------------------------------------------------------------------ */
/*  Mutable chart state                                                */
/* ------------------------------------------------------------------ */

/**
 * A full window of zero samples: the chart starts as a flat baseline across the
 * whole card and new data scrolls in from the right, instead of a sliver on the edge.
 * @returns {Array<{ up: number, down: number, time: number }>}
 */
function zeroHistory() {
  const now = Date.now();
  return Array.from({ length: MAX_DATA_POINTS }, (_, i) => ({ up: 0, down: 0, time: now - (MAX_DATA_POINTS - i) * 1000 }));
}

/** @type {Array<{ up: number, down: number, time: number }>} */
let trafficHistory = zeroHistory();

/** @type {HTMLCanvasElement | null} */
let canvas = null;

/** @type {CanvasRenderingContext2D | null} */
let ctx = null;

/* ---- resize bookkeeping ---- */
/** @type {((this: Window, ev: UIEvent) => any) | null} */
let _chartResizeHandler = null;
/** @type {ResizeObserver | null} */
let _chartResizeObserver = null;
/** @type {number | null} */
let _chartFrameId = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let _chartResizeDebounce = null;

/** @type {MutationObserver | null} Re-reads the traffic colours when light/dark mode toggles. */
let _chartThemeObserver = null;

/* ---- visibility state ---- */

/** @type {boolean} Whether the document is currently visible. */
let _isVisible = !document.hidden;

/**
 * Reusable points buffer for chart rendering to eliminate per-frame allocations.
 * @type {Array<{ x: number, y: number }>}
 */
const _pointsBuffer = [];

/** @type {boolean} Whether data was received while hidden (needs re-render on visible). */
let _pendingRender = false;

function _onVisibilityChange() {
  const wasHidden = !_isVisible;
  _isVisible = !document.hidden;
  // Going hidden: drop any queued frame (including a colour-transition
  // chain) and replay it once the document is visible again.
  if (!wasHidden && !_isVisible && _chartFrameId !== null) {
    cancelAnimationFrame(_chartFrameId);
    _chartFrameId = null;
    _pendingRender = true;
  }
  // When becoming visible again, render any data that accumulated while hidden
  if (wasHidden && _isVisible && _pendingRender) {
    _pendingRender = false;
    scheduleRender();
  }
}

/**
 * Start listening for document visibility changes.
 * Called automatically by initChart().
 * @private
 */
function _initVisibilityListener() {
  _isVisible = !document.hidden;
  _pendingRender = false;
  document.addEventListener('visibilitychange', _onVisibilityChange);
}

/**
 * Remove the visibility listener. Called by cleanupChart().
 * @private
 */
function _destroyVisibilityListener() {
  document.removeEventListener('visibilitychange', _onVisibilityChange);
}

/* ---- colour state ---- */

/**
 * Current (possibly mid-transition) chart colours.
 * Each property stores `{ r, g, b }` for fast interpolation.
 * @type {{ download: { r: number, g: number, b: number }, upload: { r: number, g: number, b: number } }}
 */
const currentColors = {
  download: { r: 10, g: 132, b: 255 },
  upload: { r: 255, g: 107, b: 107 },
};

/**
 * Target colours (what we are transitioning *towards*).
 * @type {{ download: { r: number, g: number, b: number }, upload: { r: number, g: number, b: number } }}
 */
let targetColors = {
  download: { r: 10, g: 132, b: 255 },
  upload: { r: 255, g: 107, b: 107 },
};

/** @type {number} Timestamp when the last colour transition started. */
let colorTransitionStart = 0;

/** Snapshot of colours at the moment the transition began. */
let colorTransitionFrom = {
  download: { r: 10, g: 132, b: 255 },
  upload: { r: 255, g: 107, b: 107 },
};

/** @type {boolean} Whether a colour transition is currently in progress. */
let isColorTransitioning = false;

/* ------------------------------------------------------------------ */
/*  Colour helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Linearly interpolate between two RGB triplets.
 *
 * @param {{ r: number, g: number, b: number }} a
 * @param {{ r: number, g: number, b: number }} b
 * @param {number} t - Progress in [0, 1]
 * @returns {{ r: number, g: number, b: number }}
 */
function lerpColor(a, b, t) {
  return {
    r: Math.round(a.r + ((b.r - a.r) * t)),
    g: Math.round(a.g + ((b.g - a.g) * t)),
    b: Math.round(a.b + ((b.b - a.b) * t)),
  };
}

/**
 * Convert an `{ r, g, b }` object to an `rgba(…)` string.
 *
 * @param {{ r: number, g: number, b: number }} c
 * @param {number} [alpha=1]
 * @returns {string}
 */
function rgba(c, alpha = 1) {
  return `rgba(${c.r},${c.g},${c.b},${alpha})`;
}

/**
 * Kick off a smooth colour transition towards the given target colours.
 *
 * @param {{ download: { r: number, g: number, b: number }, upload: { r: number, g: number, b: number } }} target
 */
function beginColorTransition(target) {
  colorTransitionFrom = {
    download: { ...currentColors.download },
    upload: { ...currentColors.upload },
  };
  targetColors = target;
  colorTransitionStart = performance.now();
  isColorTransitioning = true;
}

/**
 * Advance the colour transition.  Call once per animation frame while
 * `isColorTransitioning` is true.
 */
function tickColorTransition() {
  if (!isColorTransitioning) return;

  const elapsed = performance.now() - colorTransitionStart;
  const t = Math.min(1, elapsed / COLOR_LERP_DURATION);

  currentColors.download = lerpColor(colorTransitionFrom.download, targetColors.download, t);
  currentColors.upload = lerpColor(colorTransitionFrom.upload, targetColors.upload, t);

  if (t >= 1) isColorTransitioning = false;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Initialise the traffic chart.  Binds to the `#trafficChart` canvas,
 * sets up resize observers, and performs the first render.
 */
export function initChart() {
  canvas = /** @type {HTMLCanvasElement | null} */ (document.getElementById('trafficChart'));
  if (!canvas) return;
  ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Start listening for visibility changes (pause rendering when hidden)
  // before the first render is scheduled, so it sees the current state.
  _initVisibilityListener();

  // Immediately adopt the current theme colours
  updateChartTheme();

  // Download/upload colours differ between light and dark mode; re-read them
  // whenever <html>'s class list (which carries `dark`) changes.
  if (_chartThemeObserver) _chartThemeObserver.disconnect();
  if (typeof MutationObserver !== 'undefined') {
    _chartThemeObserver = new MutationObserver(() => updateChartTheme());
    _chartThemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  }

  // Clean up any pre-existing listeners
  if (_chartResizeHandler) {
    window.removeEventListener('resize', _chartResizeHandler);
  }
  if (_chartResizeObserver) {
    _chartResizeObserver.disconnect();
  }

  /**
   * Schedule a debounced canvas resize + redraw.
   * @private
   */
  const resize = () => {
    if (_chartResizeDebounce) clearTimeout(_chartResizeDebounce);

    _chartResizeDebounce = setTimeout(() => {
      if (!canvas || !ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      scheduleRender();
    }, 100);
  };

  _chartResizeHandler = resize;
  window.addEventListener('resize', resize);

  _chartResizeObserver = new ResizeObserver(resize);
  _chartResizeObserver.observe(canvas.parentElement || canvas);

  resize();
}

/**
 * Release all chart resources — call when unmounting or switching pages.
 */
export function cleanupChart() {
  _destroyVisibilityListener();

  if (_chartFrameId !== null) {
    cancelAnimationFrame(_chartFrameId);
    _chartFrameId = null;
  }

  if (_chartResizeDebounce) {
    clearTimeout(_chartResizeDebounce);
    _chartResizeDebounce = null;
  }

  if (_chartResizeHandler) {
    window.removeEventListener('resize', _chartResizeHandler);
    _chartResizeHandler = null;
  }

  if (_chartResizeObserver) {
    _chartResizeObserver.disconnect();
    _chartResizeObserver = null;
  }

  if (_chartThemeObserver) {
    _chartThemeObserver.disconnect();
    _chartThemeObserver = null;
  }

  canvas = null;
  ctx = null;
}

/**
 * Push a new traffic data point into the rolling window and schedule a
 * render via `requestAnimationFrame`.
 *
 * @param {Object} data - Traffic data object
 * @param {string} data.up - Upload speed formatted string (e.g. "10 KB/s")
 * @param {string} data.down - Download speed formatted string
 * @param {Object} data.raw - Raw numeric values
 * @param {number} data.raw.up - Upload speed in bytes/s
 * @param {number} data.raw.down - Download speed in bytes/s
 */
export function updateTrafficData(data) {
  trafficHistory.push({
    up: data.raw.up,
    down: data.raw.down,
    time: Date.now(),
  });

  if (trafficHistory.length > MAX_DATA_POINTS) {
    trafficHistory.shift();
  }

  // Skip rendering when the document is hidden; mark for deferred render
  if (!_isVisible) {
    _pendingRender = true;
  } else {
    scheduleRender();
  }

  // Update the numeric speed display in the DOM
  const upValEl = document.getElementById('speed-up-val');
  const upUnitEl = document.getElementById('speed-up-unit');
  const downValEl = document.getElementById('speed-down-val');
  const downUnitEl = document.getElementById('speed-down-unit');

  if (upValEl && upUnitEl) {
    const parts = data.up.split(' ');
    upValEl.textContent = parts[0] || '0';
    upUnitEl.textContent = parts[1] || 'KB/s';
  }
  if (downValEl && downUnitEl) {
    const parts = data.down.split(' ');
    downValEl.textContent = parts[0] || '0';
    downUnitEl.textContent = parts[1] || 'KB/s';
  }
}

/**
 * Clear all stored traffic history and redraw the empty chart.
 */
export function clearTrafficHistory() {
  trafficHistory = zeroHistory();
  scheduleRender();
}

/**
 * Re-read theme colours from CSS custom properties and begin a smooth
 * transition.  Call this when the user switches between light / dark
 * themes, or at any time the CSS variables change.
 */
export function updateChartTheme() {
  const { download, upload } = getThemeColors();

  const downloadRgb = hexToRgb(download) || { r: 10, g: 132, b: 255 };
  const uploadRgb = hexToRgb(upload) || { r: 255, g: 107, b: 107 };

  beginColorTransition({ download: downloadRgb, upload: uploadRgb });

  // Ensure a render is scheduled so the transition is visible
  scheduleRender();
}

/* ------------------------------------------------------------------ */
/*  Rendering pipeline                                                 */
/* ------------------------------------------------------------------ */

/**
 * Schedule a render on the next animation frame.  If a frame is already
 * pending the request is coalesced.
 *
 * @private
 */
function scheduleRender() {
  // Never request frames while the document is hidden — this also pauses
  // the theme colour transition, which would otherwise keep re-queuing
  // rAF callbacks. The visibility listener replays the render on return.
  if (!_isVisible) {
    _pendingRender = true;
    return;
  }
  if (_chartFrameId !== null) cancelAnimationFrame(_chartFrameId);
  _chartFrameId = requestAnimationFrame(() => {
    _chartFrameId = null;
    renderChart();
  });
}

/**
 * Core render routine.  Advances colour transitions, clears the canvas,
 * and draws both area curves.
 *
 * @private
 */
function renderChart() {
  if (!canvas || !ctx) return;

  // Advance colour lerp
  tickColorTransition();

  const width = canvas.clientWidth;
  const height = canvas.clientHeight;

  // If a transition is still in flight, schedule another frame — unless the
  // canvas is not laid out (e.g. its page is display:none). The resize
  // observer re-schedules a render as soon as it gets a size again.
  if (isColorTransitioning && width > 0 && height > 0) {
    scheduleRender();
  }

  ctx.clearRect(0, 0, width, height);

  if (trafficHistory.length < 2) return;

  // Single-pass computation of Y-axis scale (min 10 KB/s floor) and validity check.
  // Avoids per-frame array allocations (`trafficHistory.filter(...)` and `.map(...)`).
  // Samples are coerced with Number() and must be finite: numeric strings count
  // (the legacy isNaN check accepted them), while NaN and ±Infinity are excluded
  // here and normalised to 0 when drawn, so one bad sample cannot poison the scale.
  let maxVal = 1024 * 10;
  let validCount = 0;
  for (const d of trafficHistory) {
    const up = Number(d.up);
    const down = Number(d.down);
    if (Number.isFinite(up) && Number.isFinite(down)) {
      validCount++;
      if (up > maxVal) maxVal = up;
      if (down > maxVal) maxVal = down;
    }
  }
  if (validCount < 2) return;

  const getY = (/** @type {number} */ v) => height - ((v / maxVal) * (height - 20)) - 10;

  // Downstream — fixed blue, solid line + gradient fill (primary series)
  drawArea(
    trafficHistory,
    'down',
    currentColors.download,
    getY,
    { lineWidth: 2, fillAlpha: 0.3 },
  );

  // Upstream — fixed coral, slightly thinner solid line + faint fill
  drawArea(
    trafficHistory,
    'up',
    currentColors.upload,
    getY,
    { lineWidth: 1.5, fillAlpha: 0.08 },
  );
}

/**
 * Draw a single filled area curve with a gradient fade.
 *
 * Optimised to reuse `_pointsBuffer` in-place without allocating temporary arrays or point objects per frame.
 *
 * @param {Array<{ up: number, down: number, time: number }>} history - Traffic history samples
 * @param {'down' | 'up'} key - Which speed property to render ('down' or 'up')
 * @param {{ r: number, g: number, b: number }} color - RGB colour for this series
 * @param {(val: number) => number} getY - Maps a data value to a canvas Y coordinate
 * @param {{ lineWidth?: number, fillAlpha?: number }} [style] - Stroke width and top-of-gradient fill opacity
 * @private
 */
function drawArea(history, key, color, getY, { lineWidth = 2, fillAlpha = 0.3 } = {}) {
  if (!canvas || !ctx) return;

  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const len = history.length;
  // Anchor the newest sample to the right edge so a short history still reads as a
  // live tail instead of a sliver hugging the left edge (the home hero is full width).
  const offset = Math.max(0, MAX_DATA_POINTS - len);
  const getX = (/** @type {number} */ i) => ((i + offset) / (MAX_DATA_POINTS - 1)) * width;

  // Populate reusable _pointsBuffer in-place to avoid per-render array and object allocations
  while (_pointsBuffer.length < len) {
    _pointsBuffer.push({ x: 0, y: 0 });
  }
  _pointsBuffer.length = len;

  for (let i = 0; i < len; i++) {
    const pt = _pointsBuffer[i];
    pt.x = getX(i);
    // Same coercion rule as the scale pass in renderChart(): finite numbers
    // (including numeric strings) draw at face value, anything else becomes 0.
    const v = Number(history[i][key]);
    pt.y = getY(Number.isFinite(v) ? v : 0);
  }

  ctx.beginPath();
  traceSmoothCurve(ctx, _pointsBuffer);

  // Stroke
  ctx.strokeStyle = rgba(color, 0.8);
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Gradient fill
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, rgba(color, fillAlpha));
  gradient.addColorStop(1, rgba(color, 0));

  // Close the fill straight down from the newest point (where the curve now
  // ends) and back along the baseline.
  ctx.lineTo(getX(len - 1), height);
  ctx.lineTo(getX(0), height);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();
}

/**
 * Trace a smooth curve through `points` onto the current path.
 *
 * Uses the midpoint quadratic-Bézier technique (each sample is a control
 * point, each curve segment ends halfway to the next sample) and then
 * finishes with a straight segment into the final sample. That last segment
 * is collinear with the end tangent of the preceding Bézier, so the join is
 * smooth, and the curve now actually reaches the newest data point instead
 * of stopping at the midpoint of the last interval.
 *
 * @param {Pick<CanvasRenderingContext2D, 'moveTo' | 'lineTo' | 'quadraticCurveTo'>} target
 * @param {Array<{ x: number, y: number }>} points
 */
export function traceSmoothCurve(target, points) {
  if (points.length === 0) return;
  target.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    target.quadraticCurveTo(prev.x, prev.y, (prev.x + cur.x) / 2, (prev.y + cur.y) / 2);
  }
  if (points.length > 1) {
    const last = points[points.length - 1];
    target.lineTo(last.x, last.y);
  }
}
