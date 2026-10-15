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

/** @type {Array<{ up: number, down: number, time: number }>} */
let trafficHistory = [];

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
  trafficHistory = [];
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

  // Filter out any non-numeric entries for safety
  const validData = trafficHistory.filter(
    (d) => !isNaN(d.up) && !isNaN(d.down),
  );
  if (validData.length < 2) return;

  // Dynamic Y-axis scale with a floor of 10 KB/s
  let maxVal = Math.max(...validData.map((d) => Math.max(d.up, d.down)));
  maxVal = Math.max(maxVal, 1024 * 10);

  const getY = (/** @type {number} */ v) => height - ((v / maxVal) * (height - 20)) - 10;

  // Downstream — fixed blue, solid line + gradient fill (primary series)
  drawArea(
    trafficHistory.map((d) => d.down || 0),
    currentColors.download,
    getY,
    { lineWidth: 2, fillAlpha: 0.3 },
  );

  // Upstream — fixed coral, slightly thinner solid line + faint fill
  drawArea(
    trafficHistory.map((d) => d.up || 0),
    currentColors.upload,
    getY,
    { lineWidth: 1.5, fillAlpha: 0.08 },
  );
}

/**
 * Draw a single filled area curve with a gradient fade.
 *
 * @param {number[]} data - Y-values for each data point
 * @param {{ r: number, g: number, b: number }} color - RGB colour for this series
 * @param {(val: number) => number} getY - Maps a data value to a canvas Y coordinate
 * @param {{ lineWidth?: number, fillAlpha?: number }} [style] - Stroke width and top-of-gradient fill opacity
 * @private
 */
function drawArea(data, color, getY, { lineWidth = 2, fillAlpha = 0.3 } = {}) {
  if (!canvas || !ctx) return;

  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const getX = (/** @type {number} */ i) => (i / (MAX_DATA_POINTS - 1)) * width;

  ctx.beginPath();
  traceSmoothCurve(ctx, data.map((v, i) => ({ x: getX(i), y: getY(v) })));

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
  ctx.lineTo(getX(data.length - 1), height);
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
