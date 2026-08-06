// @ts-check
/**
 * Custom dropdown component that mirrors a hidden native <select>.
 * Supports portal positioning, wheel event passthrough, and keyboard navigation.
 */

/**
 * Initialize a custom dropdown.
 * @param {Object} opts
 * @param {string} opts.wrapId - Wrapper div id
 * @param {string} opts.triggerId - Button trigger id
 * @param {string} opts.menuId - Dropdown menu div id
 * @param {string} opts.labelId - Label span id inside trigger
 * @param {string} opts.selectId - Hidden native select id
 * @param {Function} [opts.onChange] - Callback when selection changes
 * @param {string} [opts.optionAttr='data-value'] - Attribute to match options
 * @returns {{ setValue: Function, getValue: Function, syncUI: Function, dispose: Function }|undefined}
 */
export function initCustomDropdown({ wrapId, triggerId, menuId, labelId, selectId, onChange, optionAttr = 'data-value' }) {
    const wrap = document.getElementById(wrapId);
    const trigger = document.getElementById(triggerId);
    const menu = document.getElementById(menuId);
    const label = document.getElementById(labelId);
    const select = /** @type {HTMLSelectElement|null} */ (document.getElementById(selectId));
    if (!wrap || !trigger || !menu || !label || !select) return;

    // Prevent duplicate initialization
    if (wrap.dataset.dropdownInit) return;
    wrap.dataset.dropdownInit = '1';

    // AbortController for clean removal of all event listeners
    const ac = new AbortController();
    const { signal } = ac;

    const arrow = trigger.querySelector('.dropdown-arrow');
    let isPortalActive = false;

    // Position the menu relative to the trigger (used when portaled to body)
    const positionMenu = () => {
        const rect = trigger.getBoundingClientRect();
        // body has transform: scale(var(--ui-scale)), which makes fixed positioning
        // relative to the body instead of the viewport. getBoundingClientRect returns
        // visual (scaled) coordinates, but fixed left/top inside a transformed container
        // are in the container's coordinate space. Divide by ui-scale to compensate.
        const uiScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
        menu.style.position = 'fixed';
        menu.style.left = `${rect.left / uiScale}px`;
        menu.style.top = `${(rect.bottom + 6) / uiScale}px`;
        menu.style.width = `${rect.width / uiScale}px`;
        menu.style.zIndex = '99999';
    };

    // Wheel scroll: JS passthrough with smooth scrolling
    menu.addEventListener('wheel', (e) => {
        e.preventDefault();
        const delta = e.deltaY;
        document.querySelectorAll('.overflow-y-auto, .custom-scrollbar').forEach(el => {
            if (el.scrollHeight > el.clientHeight) {
                el.scrollBy({ top: delta, behavior: 'smooth' });
            }
        });
    }, { passive: false, signal });

    const closeMenu = () => {
        menu.classList.add('hidden');
        if (arrow) arrow.classList.remove('rotate-180');
        trigger.classList.remove('border-[var(--zephyr-border-strong)]');
        // Return from portal
        if (isPortalActive) {
            isPortalActive = false;
            menu.style.position = '';
            menu.style.left = '';
            menu.style.insetInlineStart = '';
            menu.style.top = '';
            menu.style.width = '';
            menu.style.zIndex = '';
            wrap.appendChild(menu);
        }
    };

    const openMenu = () => {
        menu.classList.remove('hidden');
        if (arrow) arrow.classList.add('rotate-180');
        trigger.classList.add('border-[var(--zephyr-border-strong)]');
        // Portal to body to escape any parent stacking context
        if (!isPortalActive) {
            isPortalActive = true;
            positionMenu();
            document.body.appendChild(menu);
        } else {
            positionMenu();
        }
    };

    const syncUI = () => {
        const opt = select.querySelector(`option[value="${select.value}"]`);
        if (label && opt) {
            const activeBtn = menu.querySelector(`[${optionAttr}="${select.value}"]`);
            label.textContent = activeBtn?.getAttribute('data-label') || opt.textContent || select.value;
        }
        menu.querySelectorAll(`[${optionAttr}]`).forEach(item => {
            item.classList.toggle('active', item.getAttribute(optionAttr) === select.value);
        });
    };

    // Hover highlight — skip disabled items
    menu.querySelectorAll(`[${optionAttr}]`).forEach(item => {
        item.addEventListener('mouseenter', () => {
            menu.querySelectorAll(`[${optionAttr}]`).forEach(i => i.classList.remove('active'));
            if (item.matches(':disabled, [disabled], [aria-disabled="true"]')) return;
            item.classList.add('active');
        }, { signal });
    });
    menu.addEventListener('mouseleave', syncUI, { signal });

    // Toggle — guard against disabled trigger (non-native elements don't block clicks)
    trigger.addEventListener('click', (e) => {
        if (trigger.matches(':disabled, [disabled], [aria-disabled="true"]')) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        e.stopPropagation();
        menu.classList.contains('hidden') ? openMenu() : closeMenu();
    }, { signal });

    // Option click — guard against disabled items (non-native elements
    // don't block click events natively even with aria-disabled="true")
    menu.querySelectorAll(`[${optionAttr}]`).forEach(item => {
        item.addEventListener('click', (e) => {
            if (item.matches(':disabled, [disabled], [aria-disabled="true"]')) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            e.stopPropagation();
            const val = item.getAttribute(optionAttr);
            if (val === null || val === select.value) { closeMenu(); return; }
            select.value = val;
            syncUI();
            closeMenu();
            if (onChange) onChange(val, select);
        }, { signal });
    });

    // Close on outside click / Escape
    /** @param {MouseEvent} e */
    const onDocClick = (e) => {
        if (!(e.target instanceof Element)) return;
        if (!e.target.closest(`#${wrapId}`) && !e.target.closest(`#${menuId}`)) closeMenu();
    };
    /** @param {KeyboardEvent} e */
    const onDocKeydown = (e) => {
        if (e.key === 'Escape') closeMenu();
    };

    // Reposition on window resize/scroll while open
    const onWinResize = () => { if (!menu.classList.contains('hidden')) positionMenu(); };
    const onWinScroll = () => { if (!menu.classList.contains('hidden')) positionMenu(); };

    document.addEventListener('click', onDocClick, { signal });
    document.addEventListener('keydown', onDocKeydown, { signal });
    window.addEventListener('resize', onWinResize, { signal });
    window.addEventListener('scroll', onWinScroll, { capture: true, passive: true, signal });

    // Initial sync
    syncUI();

    return {
        setValue: (/** @type {string} */ val) => { select.value = val; syncUI(); },
        getValue: () => select.value,
        syncUI,
        dispose: () => {
            // Abort all listeners (document, window, trigger, menu, options)
            ac.abort();
            closeMenu();
            delete wrap.dataset.dropdownInit;
        },
    };
}
