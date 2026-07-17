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

        const handleMouseMove = /** @param {MouseEvent} e */ (e) => {
            if (frameId) cancelAnimationFrame(frameId);
            frameId = requestAnimationFrame(() => {
                const rect = el.getBoundingClientRect();
                const x = e.clientX - rect.left - rect.width / 2;
                const y = e.clientY - rect.top - rect.height / 2;

                el.style.transition = 'transform .15s ease-out';
                el.style.transform = `perspective(1000px) rotateX(${-y / 40}deg) rotateY(${x / 40}deg) translateY(-3px)`;
            });
        };

        const handleMouseEnter = () => {
            const t = leaveTimeouts.get(el);
            if (t) {
                clearTimeout(t);
                leaveTimeouts.delete(el);
            }
            el.style.willChange = 'transform';
        };

        const handleMouseLeave = () => {
            if (frameId) cancelAnimationFrame(frameId);
            el.style.transition = 'transform .35s cubic-bezier(.22, 1, .36, 1)';
            el.style.transform = '';
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
