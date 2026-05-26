// @ts-check
/**
 * Virtual Scroll Engine — Production-grade, jump-free virtual scrolling.
 *
 * Architecture:
 *   - Offsets use heightCache (real) + frozenEst (fallback).
 *   - heightCache populated at unmount (sync) + each render (sync measure).
 *   - avgMeasuredHeight updated AFTER render, not during — prevents cascade.
 *   - scrollTop anchor correction when spacerTop changes — prevents visual jump.
 *   - DOM insertion order preserved (insertBefore, not appendChild).
 *   - Slide cap: symmetric 4-direction limit, prevents window collapse.
 *   - High-velocity fast path (updateSpacers only, skip DOM ops).
 *   - Offsets array reused across renders (version-gated).
 *
 * @module utils/virtual-scroll
 */

/**
 * @typedef {Object} VirtualScrollOptions
 * @property {HTMLElement} container
 * @property {HTMLElement} spacerTop
 * @property {HTMLElement} spacerBottom
 * @property {HTMLElement} linesContainer
 * @property {() => number} itemCount
 * @property {(idx: number, fragment: DocumentFragment) => void} renderItem
 * @property {string} [dataAttr='data-line-idx']
 * @property {number} [rowHeightEst=48]
 * @property {number} [overscanPx=800]
 * @property {number} [maxMounted=300]
 * @property {number} [scrollQuantumPx=200]
 * @property {number} [slideStep=25]
 * @property {() => void} [onAutoScroll]
 * @property {() => void} [onScroll]
 */

/**
 * @typedef {Object} VirtualScrollHandle
 * @property {() => void} invalidate
 * @property {() => void} scheduleRender
 * @property {() => void} destroy
 * @property {() => void} clearHeightCache
 */

export function createVirtualScroll(/** @type {VirtualScrollOptions} */ opts) {
    const {
        container, spacerTop, spacerBottom, linesContainer,
        itemCount, renderItem,
        dataAttr = 'data-line-idx',
        rowHeightEst = 48, overscanPx = 800, maxMounted = 300,
        scrollQuantumPx = 200, slideStep = 25,
        onAutoScroll, onScroll: onScrollCallback,
    } = opts;

    // ── State ──────────────────────────────────────────────────────────────

    /** @type {Map<number, number>} Real measured heights */
    const heightCache = new Map();
    /** Last scrollTop at render time (for quantum gate) */
    let lastRenderedScrollTop = -1;
    /** Currently mounted item indices */
    /** @type {Set<number>} */
    const mountedSet = new Set();
    /** @type {number|null} */
    let renderRAF = null;
    let lastContainerWidth = container.clientWidth;

    // Previous render range for slide cap
    let prevStart = 0;
    let prevEnd = 0;

    // Scroll-event velocity tracking
    let lastScrollEventTop = 0;
    let scrollEventVelocity = 0;
    /** Guard: suppress scroll events triggered by our own anchor correction. */
    let suppressScroll = false;

    /** When true, skip onAutoScroll callback after render (used by invalidate). */
    let skipAutoScroll = false;

    /**
     * When true, the next render() should apply anchor correction.
     * Only set by scheduleRender() (content-change path).
     * Scroll-driven renders and invalidate must NOT anchor-correct.
     */
    let anchorCorrectionPending = false;

    // ── Height estimation (frozen during render) ───────────────────────────

    /** Running average of measured heights */
    let avgMeasuredHeight = rowHeightEst;

    /** @returns {number} */
    function effectiveEst() {
        return avgMeasuredHeight;
    }

    /** Recompute average — call AFTER render, not during. */
    function updateAvgHeight() {
        if (heightCache.size === 0) return;
        let sum = 0;
        for (const h of heightCache.values()) sum += h;
        avgMeasuredHeight = sum / heightCache.size;
    }

    // ── Offsets (reusable, version-gated) ─────────────────────────────────

    /** @type {Float64Array} */
    let offsetsArr = new Float64Array(0);
    let offsetsVersion = -1;
    let offsetsN = -1;

    function ensureOffsets() {
        const n = itemCount();
        if (n === offsetsN && offsetsVersion === heightCache.size) return;
        offsetsN = n;
        offsetsVersion = heightCache.size;
        if (offsetsArr.length < n + 1) offsetsArr = new Float64Array(n + 1);
        const est = effectiveEst();
        offsetsArr[0] = 0;
        for (let i = 0; i < n; i++) {
            offsetsArr[i + 1] = offsetsArr[i] + (heightCache.get(i) ?? est);
        }
    }

    /** @param {number} target @returns {number} */
    function bisectStart(target) {
        const n = offsetsArr.length - 1;
        if (n === 0) return 0;
        let lo = 0, hi = n;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (offsetsArr[mid + 1] <= target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    // ── Range computation ─────────────────────────────────────────────────

    /** @returns {[number, number]} */
    function computeRange() {
        const scrollTop = container.scrollTop;
        const viewportH = container.clientHeight;
        const n = itemCount();
        if (n === 0 || viewportH === 0) return [0, 0];

        const est = effectiveEst();

        // Cold start: render from beginning
        if (lastRenderedScrollTop < 0) {
            const needed = viewportH + 2 * overscanPx;
            let coverage = 0, end = 0;
            const maxEnd = Math.min(n, maxMounted);
            while (end < maxEnd && coverage < needed) {
                coverage += heightCache.get(end) ?? est;
                end++;
            }
            return [0, end];
        }

        const needed = viewportH + 2 * overscanPx;
        let start = Math.max(0, bisectStart(scrollTop - overscanPx));

        // Walk forward using coverage
        const maxEnd = Math.min(n, start + maxMounted);
        let coverage = 0, end = start;
        while (end < maxEnd && coverage < needed) {
            coverage += heightCache.get(end) ?? est;
            end++;
        }

        // Walk backward for top coverage
        const minStart = Math.max(0, end - maxMounted);
        coverage = 0;
        for (let i = start; i < end; i++) coverage += heightCache.get(i) ?? est;
        while (start > minStart && coverage < needed) {
            start--;
            coverage += heightCache.get(start) ?? est;
        }

        // Slide cap: symmetric 4-direction limit.
        // Prevents window collapse (one side advancing while the other is capped).
        // Only activates when ranges overlap (continuous scroll) and velocity is high.
        const rangesOverlap = start < prevEnd && end > prevStart;
        if (rangesOverlap && scrollEventVelocity > viewportH * 2) {
            const dynamicStep = Math.min(maxMounted, Math.max(slideStep, Math.floor(scrollEventVelocity / est)));
            // Limit all four directions to keep window size stable
            if (start < prevStart - dynamicStep) start = prevStart - dynamicStep;
            if (start > prevStart + dynamicStep) start = prevStart + dynamicStep;
            if (end < prevEnd - dynamicStep) end = prevEnd - dynamicStep;
            if (end > prevEnd + dynamicStep) end = prevEnd + dynamicStep;
            // Safety: ensure start <= end
            if (start > end) {
                const mid = (start + end) >> 1;
                start = Math.max(0, mid - (slideStep >> 1));
                end = Math.min(n, start + slideStep);
            }
        }

        return [Math.max(0, start), Math.min(n, end)];
    }

    // ── Rendering ──────────────────────────────────────────────────────────

    /** Fast path: only update spacers, no DOM mount/unmount. */
    function updateSpacers() {
        const savedST = container.scrollTop;
        ensureOffsets();
        const [newStart, newEnd] = computeRange();
        const n = itemCount();
        const updatedTotal = offsetsArr[n];
        spacerTop.style.height = newStart > 0 ? `${offsetsArr[newStart]}px` : '0';
        spacerBottom.style.height = `${Math.max(0, updatedTotal - offsetsArr[newEnd])}px`;
        // Restore scrollTop exactly — prevents content shift from spacer changes.
        container.scrollTop = savedST;
        // Intentionally NOT updating prevStart/prevEnd/lastRenderedScrollTop.
        // Preserving old prev values prevents slide cap from constraining the
        // next full render's range, and stale lastRenderedScrollTop ensures
        // the quantum gate triggers immediately when velocity drops.
    }

    function render() {
        // 1st call: needed for computeRange → bisectStart → offsets lookup.
        ensureOffsets();
        const [newStart, newEnd] = computeRange();

        const n = itemCount();

        // Save scrollTop BEFORE any DOM changes.
        const savedScrollTop = container.scrollTop;

        // Capture old spacerTop height for anchor correction
        const oldSpacerTopH = parseFloat(spacerTop.style.height) || 0;

        // Determine mount/unmount sets
        /** @type {Set<number>} */
        const toMount = new Set();
        for (let i = newStart; i < newEnd; i++) toMount.add(i);
        /** @type {Set<number>} */
        const toUnmount = new Set(mountedSet);
        for (const idx of toMount) toUnmount.delete(idx);

        // Step 1: Unmount — capture real heights synchronously
        for (const idx of toUnmount) {
            const el = linesContainer.querySelector(`[${dataAttr}="${idx}"]`);
            if (el) {
                const h = el.getBoundingClientRect().height;
                if (h > 0) heightCache.set(idx, h);
                el.remove();
            }
            mountedSet.delete(idx);
        }

        // Step 2: Measure ALL currently-mounted items (including those staying).
        for (const idx of mountedSet) {
            if (heightCache.has(idx)) continue;
            const el = linesContainer.querySelector(`[${dataAttr}="${idx}"]`);
            if (el) {
                const h = el.getBoundingClientRect().height;
                if (h > 0) heightCache.set(idx, h);
            }
        }

        // Step 3: Rebuild offsets with all known real heights.
        ensureOffsets();
        const updatedTotal = offsetsArr[n];

        // Step 4: Set spacers
        // Save scrollTop before setting spacers — browser may silently clamp
        // scrollTop if it exceeds the new scrollHeight after spacer changes.
        const scrollTopBeforeSpacer = container.scrollTop;
        const newSpacerTopH = newStart > 0 ? offsetsArr[newStart] : 0;
        spacerTop.style.height = `${newSpacerTopH}px`;
        spacerBottom.style.height = `${Math.max(0, updatedTotal - offsetsArr[newEnd])}px`;

        // If browser auto-adjusted scrollTop after spacer change, restore it.
        // Only restore when user is not actively scrolling (low velocity).
        if (Math.abs(container.scrollTop - scrollTopBeforeSpacer) > 0.5 && scrollEventVelocity < 10) {
            console.log(`[vs] render: browser clamped scrollTop ${scrollTopBeforeSpacer} → ${container.scrollTop}, restoring`);
            suppressScroll = true;
            container.scrollTop = scrollTopBeforeSpacer;
            suppressScroll = false;
        }

        // Step 5: Anchor correction — ONLY when explicitly requested via scheduleRender().
        // Scroll-driven renders and invalidate must NOT anchor-correct.
        if (anchorCorrectionPending) {
            anchorCorrectionPending = false;
            const spacerDelta = newSpacerTopH - oldSpacerTopH;
            const targetScrollTop = savedScrollTop + spacerDelta;
            if (Math.abs(targetScrollTop - container.scrollTop) > 0.5) {
                suppressScroll = true;
                container.scrollTop = targetScrollTop;
                suppressScroll = false;
            }
        }
        lastRenderedScrollTop = container.scrollTop;

        // Step 6: Mount new items in correct DOM order.
        // Filter to only truly new items for branch detection.
        const toMountSorted = /** @type {number[]} */ ([...toMount].filter(idx => !mountedSet.has(idx)).sort((a, b) => a - b));
        if (toMountSorted.length > 0) {
            const firstExisting = linesContainer.firstElementChild;
            const firstExistingIdx = firstExisting
                ? parseInt(/** @type {string} */ (firstExisting.getAttribute(dataAttr)), 10)
                : Infinity;
            const lastExisting = linesContainer.lastElementChild;
            const lastExistingIdx = lastExisting
                ? parseInt(/** @type {string} */ (lastExisting.getAttribute(dataAttr)), 10)
                : -1;

            // All new items go before existing items (scrolling up)
            if (toMountSorted[toMountSorted.length - 1] < firstExistingIdx) {
                const frag = document.createDocumentFragment();
                for (const idx of toMountSorted) {
                    renderItem(idx, frag);
                    mountedSet.add(idx);
                }
                linesContainer.insertBefore(frag, firstExisting);
            }
            // All new items go after existing items (scrolling down)
            else if (toMountSorted[0] > lastExistingIdx) {
                const frag = document.createDocumentFragment();
                for (const idx of toMountSorted) {
                    renderItem(idx, frag);
                    mountedSet.add(idx);
                }
                linesContainer.appendChild(frag);
            }
            // Mixed: batch split
            else {
                const beforeFrag = document.createDocumentFragment();
                const afterFrag = document.createDocumentFragment();
                for (const idx of toMountSorted) {
                    if (idx < firstExistingIdx) {
                        renderItem(idx, beforeFrag);
                    } else {
                        renderItem(idx, afterFrag);
                    }
                    mountedSet.add(idx);
                }
                if (beforeFrag.childElementCount > 0) {
                    linesContainer.insertBefore(beforeFrag, firstExisting);
                }
                if (afterFrag.childElementCount > 0) {
                    linesContainer.appendChild(afterFrag);
                }
            }
        }

        // Update avg AFTER render — prevents cascade during next render
        updateAvgHeight();

        prevStart = newStart;
        prevEnd = newEnd;

        if (onAutoScroll && !skipAutoScroll) onAutoScroll();
    }

    function scheduleRender() {
        anchorCorrectionPending = true;
        if (renderRAF !== null) return;
        renderRAF = requestAnimationFrame(() => { renderRAF = null; render(); });
    }

    // ── Scroll Handler ─────────────────────────────────────────────────────

    function onScroll() {
        if (suppressScroll) return;
        if (onScrollCallback) onScrollCallback();

        // Track scroll-event velocity
        const st = container.scrollTop;
        scrollEventVelocity = Math.abs(st - lastScrollEventTop);
        lastScrollEventTop = st;

        const viewportH = container.clientHeight;

        // High velocity (drag scrollbar): only update spacers, skip DOM ops.
        if (scrollEventVelocity > viewportH) {
            needsRenderAfterVelocity = true;
            updateSpacers();
            resetVelocityDecay();
            return;
        }

        // Normal speed: full synchronous render when quantum threshold reached.
        if (Math.abs(st - lastRenderedScrollTop) >= scrollQuantumPx) {
            if (renderRAF !== null) {
                cancelAnimationFrame(renderRAF);
                renderRAF = null;
            }
            render();
        }
    }

    // Velocity decay timer
    let velocityDecayTimer = 0;
    let needsRenderAfterVelocity = false;
    function resetVelocityDecay() {
        clearTimeout(velocityDecayTimer);
        velocityDecayTimer = /** @type {number} */ (setTimeout(() => {
            scrollEventVelocity = 0;
            // Only force render if we skipped DOM updates during high velocity.
            if (needsRenderAfterVelocity) {
                needsRenderAfterVelocity = false;
                render();
            }
        }, 100));
    }

    const onScrollWithDecay = () => {
        onScroll();
        resetVelocityDecay();
    };

    // ── ResizeObserver ────────────────────────────────────────────────────

    /** @type {ResizeObserver|null} */
    let resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => {
            const newWidth = container.clientWidth;
            if (lastContainerWidth > 0 && newWidth !== lastContainerWidth) {
                // Width change affects line wrapping → heights are non-linear.
                // Clear cache and re-measure instead of ratio scaling.
                clearHeightCache();
            }
            lastContainerWidth = newWidth;
            scheduleRender();
        });
        resizeObserver.observe(container);
    }

    // Disable browser scroll anchoring — we handle scrollTop ourselves.
    container.style.overflowAnchor = 'none';

    container.addEventListener('scroll', onScrollWithDecay, { passive: true });

    // ── Public API ─────────────────────────────────────────────────────────

    function invalidate() {
        const n = itemCount();
        for (const key of heightCache.keys()) { if (key >= n) heightCache.delete(key); }
        mountedSet.clear();

        const savedScrollTop = container.scrollTop;

        linesContainer.innerHTML = '';
        spacerTop.style.height = '0';
        spacerBottom.style.height = '0';

        lastRenderedScrollTop = -1;
        prevStart = 0;
        prevEnd = 0;
        scrollEventVelocity = 0;
        lastScrollEventTop = 0;

        if (renderRAF !== null) {
            cancelAnimationFrame(renderRAF);
            renderRAF = null;
        }

        // Render synchronously (not via RAF) because invalidate is called rapidly
        // (every ~1s by fetchLogs). Using RAF causes each invalidate to cancel the
        // previous one's RAF, so the callback never executes.
        skipAutoScroll = true;
        anchorCorrectionPending = false;
        suppressScroll = true; // prevent onScroll from setting _autoScroll=false
        try {
            render();
        } finally {
            suppressScroll = false;
            skipAutoScroll = false;
        }

        // Restore scroll position if user had scrolled
        if (savedScrollTop > 0 && container.scrollTop !== savedScrollTop) {
            container.scrollTop = savedScrollTop;
            lastRenderedScrollTop = savedScrollTop;
        }

        // Trigger onAutoScroll after render (for initial load, scrolls to bottom)
        if (onAutoScroll) onAutoScroll();
    }

    function destroy() {
        container.removeEventListener('scroll', onScrollWithDecay);
        clearTimeout(velocityDecayTimer);
        if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
        if (renderRAF !== null) { cancelAnimationFrame(renderRAF); renderRAF = null; }
    }

    function clearHeightCache() { heightCache.clear(); }

    return { invalidate, scheduleRender, destroy, clearHeightCache };
}
