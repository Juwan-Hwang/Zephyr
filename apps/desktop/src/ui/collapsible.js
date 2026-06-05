// @ts-check
/**
 * Reusable collapsible panel component.
 * Uses CSS grid-template-rows animation for smooth open/close.
 * Eliminates code duplication between renderConfigSection and renderArraySection.
 */

/**
 * Create a collapsible panel.
 * @param {HTMLElement} container - Parent element to append the collapsible to
 * @param {Object} opts
 * @param {string} [opts.title=''] - Panel title text
 * @param {string} [opts.icon] - Optional SVG icon HTML
 * @param {boolean} [opts.defaultOpen=false] - Start expanded
 * @param {string} [opts.headerClass] - Additional CSS classes for the header
 * @param {string} [opts.contentClass] - Additional CSS classes for the content area
 * @param {string} [opts.cardClass] - Additional CSS classes for the outer card
 * @param {string} [opts.badgeText] - Optional badge text (e.g. item count)
 * @param {string} [opts.subLabel] - Optional sub-label text (e.g. full key path)
 * @returns {{ content: HTMLElement, toggle: Function, header: HTMLElement, card: HTMLElement }}
 */
export function createCollapsible(container, {
    title = '',
    icon = '',
    defaultOpen = false,
    headerClass = '',
    contentClass = 'border-t border-[var(--zephyr-border-subtle)] space-y-1 p-3',
    cardClass = 'glass-card overflow-hidden',
    badgeText = '',
    subLabel = '',
} = {}) {
    const card = document.createElement('div');
    card.className = cardClass;

    // Header
    const header = document.createElement('div');
    header.className = `flex items-center justify-between p-4 cursor-pointer hover:bg-[var(--zephyr-bg-subtle)] active:bg-[var(--zephyr-bg-muted)] transition-all duration-200 select-none ${headerClass}`;

    const leftPart = document.createElement('div');
    leftPart.className = 'flex items-center gap-2.5';

    // Collapse arrow
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrow.setAttribute('class', 'w-3 h-3 text-[var(--text-muted)] transition-transform ease-[cubic-bezier(0.25,1,0.5,1)] collapse-arrow');
    arrow.setAttribute('viewBox', '0 0 24 24');
    arrow.setAttribute('fill', 'none');
    arrow.setAttribute('stroke', 'currentColor');
    arrow.setAttribute('stroke-width', '2.5');
    arrow.setAttribute('stroke-linecap', 'round');
    arrow.setAttribute('stroke-linejoin', 'round');
    const arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arrowPath.setAttribute('d', 'm6 9 6 6 6-6');
    arrow.appendChild(arrowPath);
    leftPart.appendChild(arrow);

    if (icon) {
        const iconWrapper = document.createElement('span');
        // eslint-disable-next-line no-unsanitized/property -- caller-validated: icon param is always static SVG
        iconWrapper.innerHTML = icon;
        if (iconWrapper.firstElementChild) {
            leftPart.appendChild(iconWrapper.firstElementChild);
        }
    }

    const titleSpan = document.createElement('span');
    titleSpan.className = 'text-xs font-semibold text-[var(--text-primary)] tracking-wide';
    titleSpan.textContent = title;
    leftPart.appendChild(titleSpan);

    if (badgeText) {
        const badge = document.createElement('span');
        badge.className = 'text-2xs text-[var(--text-tertiary)] font-mono';
        badge.textContent = badgeText;
        leftPart.appendChild(badge);
    }

    header.appendChild(leftPart);

    if (subLabel) {
        const sub = document.createElement('span');
        sub.className = 'text-2xs text-[var(--text-tertiary)] font-mono opacity-60';
        sub.textContent = subLabel;
        header.appendChild(sub);
    }

    // Content wrapper for smooth animation
    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'collapse-content-wrapper';
    contentWrapper.style.cssText = `
        display: grid;
        grid-template-rows: 0fr;
        transition: grid-template-rows 0.35s cubic-bezier(0.25, 1, 0.5, 1);
    `;

    const contentInner = document.createElement('div');
    contentInner.className = 'overflow-hidden';
    contentInner.style.cssText = 'min-height: 0;';

    const content = document.createElement('div');
    content.className = contentClass;
    content.style.cssText = `
        transform: translateY(-8px);
        opacity: 0;
        transition: transform 0.3s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.25s ease;
    `;

    contentInner.appendChild(content);
    contentWrapper.appendChild(contentInner);

    // Collapse state
    let isCollapsed = !defaultOpen;

    const updateCollapse = () => {
        if (isCollapsed) {
            contentWrapper.style.gridTemplateRows = '0fr';
            content.style.transform = 'translateY(-8px)';
            content.style.opacity = '0';
            arrow.style.transform = 'rotate(-90deg)';
        } else {
            contentWrapper.style.gridTemplateRows = '1fr';
            content.style.transform = 'translateY(0)';
            content.style.opacity = '1';
            arrow.style.transform = 'rotate(0deg)';
        }
    };

    // Set initial state without animation
    if (isCollapsed) {
        arrow.style.transform = 'rotate(-90deg)';
        contentWrapper.style.gridTemplateRows = '0fr';
    } else {
        contentWrapper.style.gridTemplateRows = '1fr';
        content.style.transform = 'translateY(0)';
        content.style.opacity = '1';
    }

    const toggle = () => {
        isCollapsed = !isCollapsed;
        updateCollapse();
    };

    header.onclick = toggle;

    card.appendChild(header);
    card.appendChild(contentWrapper);
    container.appendChild(card);

    return { content, toggle, header, card };
}
