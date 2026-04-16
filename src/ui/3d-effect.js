// @ts-check
/**
 * 3D hover effect for cards and navigation items.
 * Uses requestAnimationFrame for smooth rendering — RAF itself provides
 * natural ~60fps throttling, so no additional throttle wrapper is needed.
 * mouseenter fires immediately (no RAF delay) for instant feedback.
 *
 * @module ui/3d-effect
 */

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
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;

                const centerX = rect.width / 2;
                const centerY = rect.height / 2;

                const angleY = (x - centerX) / 40;
                const angleX = (centerY - y) / 40;

                el.style.transform = `perspective(1000px) rotateX(${angleX}deg) rotateY(${angleY}deg) translateY(-4px) scale(1.02)`;
                el.style.zIndex = '10';
            });
        };

        const handleMouseEnter = () => {
            el.style.transition = 'transform 0.15s ease-out';
            el.style.transform = 'translateY(-2px) scale(1.01)';
            el.style.zIndex = '10';
        };

        const handleMouseLeave = () => {
            if (frameId) cancelAnimationFrame(frameId);
            el.style.transition = 'transform 0.3s ease-out';
            el.style.transform = 'translateY(0) scale(1)';
            el.style.zIndex = '1';
            setTimeout(() => {
                el.style.transition = '';
                el.style.transform = '';
            }, 300);
        };

        el.addEventListener('mouseenter', handleMouseEnter);
        el.addEventListener('mousemove', /** @type {EventListener} */ (handleMouseMove));
        el.addEventListener('mouseleave', handleMouseLeave);
    });
}
