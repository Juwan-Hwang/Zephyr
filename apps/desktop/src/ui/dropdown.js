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
 * @returns {{ setValue: Function, getValue: Function, syncUI: Function }|undefined}
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

    const arrow = trigger.querySelector('.dropdown-arrow');
    let isPortalActive = false;

    // Position the menu relative to the trigger (used when portaled to body)
    const positionMenu = () => {
        const rect = trigger.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.left = `${rect.left}px`;
        menu.style.top = `${rect.bottom + 6}px`;
        menu.style.width = `${rect.width}px`;
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
    }, { passive: false });

    const closeMenu = () => {
        menu.classList.add('hidden');
        if (arrow) arrow.classList.remove('rotate-180');
        trigger.classList.remove('border-accent/50');
        // Return from portal
        if (isPortalActive) {
            isPortalActive = false;
            menu.style.position = '';
            menu.style.left = '';
            menu.style.top = '';
            menu.style.width = '';
            menu.style.zIndex = '';
            wrap.appendChild(menu);
        }
    };

    const openMenu = () => {
        menu.classList.remove('hidden');
        if (arrow) arrow.classList.add('rotate-180');
        trigger.classList.add('border-accent/50');
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

    // Hover highlight
    menu.querySelectorAll(`[${optionAttr}]`).forEach(item => {
        item.addEventListener('mouseenter', () => {
            menu.querySelectorAll(`[${optionAttr}]`).forEach(i => i.classList.remove('active'));
            item.classList.add('active');
        });
    });
    menu.addEventListener('mouseleave', syncUI);

    // Toggle
    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.contains('hidden') ? openMenu() : closeMenu();
    });

    // Option click
    menu.querySelectorAll(`[${optionAttr}]`).forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            const val = item.getAttribute(optionAttr);
            if (!val || val === select.value) { closeMenu(); return; }
            select.value = val;
            syncUI();
            closeMenu();
            if (onChange) onChange(val, select);
        });
    });

    // Close on outside click / Escape
    document.addEventListener('click', (e) => {
        if (!(e.target instanceof Element)) return;
        if (!e.target.closest(`#${wrapId}`) && !e.target.closest(`#${menuId}`)) closeMenu();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeMenu();
    });

    // Reposition on window resize/scroll while open
    window.addEventListener('resize', () => { if (!menu.classList.contains('hidden')) positionMenu(); });
    window.addEventListener('scroll', () => { if (!menu.classList.contains('hidden')) positionMenu(); }, { capture: true, passive: true });

    // Initial sync
    syncUI();

    return {
        setValue: (/** @type {string} */ val) => { select.value = val; syncUI(); },
        getValue: () => select.value,
        syncUI,
    };
}
