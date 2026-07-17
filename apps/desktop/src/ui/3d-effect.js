// @ts-check
/**
 * 3D hover effect for cards and navigation items.
 * Uses requestAnimationFrame for smooth rendering — RAF itself provides
 * natural ~60fps throttling, so no additional throttle wrapper is needed.
 * mouseenter fires immediately (no RAF delay) for instant feedback.
 *
 * @module ui/3d-effect
 */

/** Store leave-timeout IDs without polluting DOM element types. */
const leaveTimeouts = new WeakMap();

/**
 * Apply a 3D perspective hover effect to one or more elements.
 * Each element gets its own RAF-based update loop.
 *
 * @param {HTMLElement|NodeList|HTMLElement[]} input - Element(s) to apply the effect to
 */
export function setup3DEffect(input) {
    const elements = (input instanceof NodeList || Array.isArray(input)) ? input : [input];

    elements.forEach(el => {
        if (!el || !(el instanceof HTMLElement)) return;

        /** @type {number|null} */
        let frameId = null;
        /** Cached on mouseenter to avoid layout thrashing in RAF. */
        /** @type {DOMRect | null} */
        let cachedRect = null;

        const handleMouseMove = /** @param {MouseEvent} e */ (e) => {
            // Synchronous guard — skip if no cached rect (before mouseenter).
            if (!cachedRect) return;
            // Disable transition during active movement for snappy cursor tracking.
            el.style.transition = 'none';
            // Capture mouse coords synchronously — accessing `e` inside RAF
            // can yield stale values in some environments.
            const clientX = e.clientX;
            const clientY = e.clientY;
            if (frameId) cancelAnimationFrame(frameId);
            frameId = requestAnimationFrame(() => {
                frameId = null;
                if (!cachedRect) return;
                const x = clientX - cachedRect.left - cachedRect.width / 2;
                const y = clientY - cachedRect.top - cachedRect.height / 2;

                el.style.transform = `perspective(1000px) rotateX(${-y / 40}deg) rotateY(${x / 40}deg) translateY(-3px)`;
            });
        };

        const handleMouseEnter = () => {
            const t = leaveTimeouts.get(el);
            if (t) {
                clearTimeout(t);
                leaveTimeouts.delete(el);
            }
            // Cache rect once on enter — calling getBoundingClientRect()
            // inside RAF would force synchronous reflow every frame.
            cachedRect = el.getBoundingClientRect();
            el.style.willChange = 'transform';
            el.style.transition = 'transform .15s ease-out';
        };

        const handleMouseLeave = () => {
            if (frameId) cancelAnimationFrame(frameId);
            el.style.transition = 'transform .35s cubic-bezier(.22, 1, .36, 1)';
            el.style.transform = '';
            cachedRect = null;
            const prev = leaveTimeouts.get(el);
            if (prev) clearTimeout(prev);
            const t = setTimeout(() => {
                el.style.transition = '';
                el.style.willChange = '';
                leaveTimeouts.delete(el);
            }, 350);
            leaveTimeouts.set(el, t);
        };

        el.addEventListener('mouseenter', handleMouseEnter);
        el.addEventListener('mousemove', /** @type {EventListener} */ (handleMouseMove));
        el.addEventListener('mouseleave', handleMouseLeave);
    });
}
