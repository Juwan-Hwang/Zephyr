// @ts-check
/**
 * Settings section index: a thin rail of short marks in the page's right gutter,
 * one per section, so it covers none of the rows. The mark of the section in view
 * is longer and accent-coloured (scroll-spy). Hovering or focusing the rail shows
 * the section names beside it; clicking one jumps there.
 *
 * Also a search box at the right of the page title: typing keeps only the rows whose
 * name or description matches (a matching section title keeps its whole section).
 *
 * @module ui/settings-nav
 */

import { Bus, Events } from './events.js';
import { t } from '../i18n.js';

const NAV_ID = 'settings-section-nav';

/**
 * Vertical position of `el` inside the scrolling `page`, in scrollTop units.
 * @param {HTMLElement} page
 * @param {HTMLElement} el
 */
function topInPage(page, el) {
    // The body is scaled (--ui-scale): rects are in screen pixels, scrollTop is not.
    const rect = page.getBoundingClientRect();
    const scale = page.offsetHeight > 0 ? rect.height / page.offsetHeight : 1;
    return page.scrollTop + (el.getBoundingClientRect().top - rect.top) / (scale || 1);
}

export function initSettingsNav() {
    const page = /** @type {HTMLElement|null} */ (document.querySelector('[data-page="settings"]'));
    if (!page || document.getElementById(NAV_ID)) return;
    const sections = /** @type {HTMLElement[]} */ (Array.from(page.querySelectorAll(':scope > div > section')));
    if (sections.length < 2) return;

    const nav = document.createElement('nav');
    nav.id = NAV_ID;
    nav.className = 'settings-rail';
    nav.setAttribute('aria-label', page.querySelector(':scope > h2')?.textContent || 'Settings');

    /** @type {HTMLButtonElement[]} */
    const buttons = [];
    sections.forEach((section, i) => {
        const heading = section.querySelector('.settings-section-title');
        if (!heading) return;
        if (!section.id) section.id = `settings-sec-${i}`;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'settings-rail-item';
        btn.dataset.target = section.id;
        const label = document.createElement('span');
        label.className = 'settings-rail-label';
        label.textContent = heading.textContent || '';
        const mark = document.createElement('span');
        mark.className = 'settings-rail-mark';
        mark.setAttribute('aria-hidden', 'true');
        btn.append(label, mark);
        btn.addEventListener('click', () => {
            const top = topInPage(page, section) - 24;
            page.scrollTo({ top: Math.max(0, top), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
            setActive(section.id);
        });
        buttons.push(btn);
        nav.appendChild(btn);
    });
    page.appendChild(nav);
    initSettingsSearch(page, sections, buttons);

    /** @param {string} id */
    function setActive(id) {
        for (const b of buttons) {
            const on = b.dataset.target === id;
            b.classList.toggle('active', on);
            if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
        }
    }

    let ticking = false;
    const onScroll = () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
            ticking = false;
            // Search hides sections: only the ones still shown can be current.
            const shown = sections.filter((s) => s.getClientRects().length > 0);
            if (shown.length === 0) return;
            const line = page.scrollTop + page.clientHeight * 0.3;
            let current = shown[0];
            for (const s of shown) if (topInPage(page, s) <= line) current = s;
            if (page.scrollTop + page.clientHeight >= page.scrollHeight - 4) current = shown.at(-1) ?? current;
            setActive(current.id);
        });
    };
    page.addEventListener('scroll', onScroll, { passive: true });
    setActive(sections[0].id);

    Bus.on(Events.I18N_APPLIED, () => {
        buttons.forEach((b) => {
            const h = document.getElementById(b.dataset.target || '')?.querySelector('.settings-section-title');
            const l = b.querySelector('.settings-rail-label');
            if (h && l) l.textContent = h.textContent || '';
        });
    });
}


/** @param {string} s */
const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * @param {HTMLElement} page
 * @param {HTMLElement[]} sections
 * @param {HTMLButtonElement[]} railButtons
 */
function initSettingsSearch(page, sections, railButtons) {
    const title = /** @type {HTMLElement|null} */ (page.querySelector(':scope > h2'));
    if (!title) return;
    const row = document.createElement('div');
    row.className = 'settings-title-row';
    title.replaceWith(row);
    title.classList.remove('mb-6');
    const box = document.createElement('label');
    box.className = 'settings-search';
    box.innerHTML = '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>'; // nosemgrep: js-innerhtml-assignment — static markup
    const input = document.createElement('input');
    input.type = 'search';
    input.id = 'settings-search';
    input.autocomplete = 'off';
    input.spellcheck = false;
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'settings-search-clear hidden';
    clear.setAttribute('aria-label', t('clearSearch'));
    clear.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>'; // nosemgrep: js-innerhtml-assignment — static markup
    box.append(input, clear);
    row.append(title, box);

    const empty = document.createElement('p');
    empty.className = 'settings-search-empty hidden';
    empty.setAttribute('role', 'status');
    sections[0].parentElement?.before(empty);

    const applyLabels = () => {
        input.placeholder = t('searchSettings');
        input.setAttribute('aria-label', t('searchSettings'));
        clear.setAttribute('aria-label', t('clearSearch'));
    };
    applyLabels();
    Bus.on(Events.I18N_APPLIED, () => { applyLabels(); run(); });

    /** Rows of a card: its direct children except dividers. @param {Element} card */
    const rowsOf = (card) => /** @type {HTMLElement[]} */ (Array.from(card.children).filter((c) => !c.classList.contains('h-px')));

    function run() {
        const q = norm(input.value);
        clear.classList.toggle('hidden', !q);
        page.classList.toggle('is-searching', !!q);
        let anyShown = false;
        for (const section of sections) {
            const head = norm(`${section.querySelector('.settings-section-title')?.textContent || ''} ${section.querySelector('.settings-section-desc')?.textContent || ''}`);
            const whole = !q || head.includes(q);
            let shownInSection = 0;
            for (const card of section.querySelectorAll(':scope > .glass-card')) {
                for (const r of rowsOf(card)) {
                    const hit = whole || norm(r.textContent || '').includes(q);
                    r.classList.toggle('search-miss', !hit);
                    if (hit) shownInSection++;
                }
            }
            const show = whole || shownInSection > 0;
            section.classList.toggle('search-miss', !show);
            if (show) anyShown = true;
            const railBtn = railButtons.find((b) => b.dataset.target === section.id);
            railBtn?.classList.toggle('search-miss', !show);
        }
        empty.classList.toggle('hidden', !q || anyShown);
        // A function replacement: `$&` and friends in the query stay literal.
        if (q && !anyShown) empty.textContent = t('settingsSearchEmpty').replace('@@query@@', () => input.value.trim());
        if (q) page.scrollTop = 0;
        // Already at the top fires no scroll event: re-pick the rail mark among the sections still shown.
        page.dispatchEvent(new Event('scroll'));
    }
    input.addEventListener('input', run);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && input.value) { e.stopPropagation(); input.value = ''; run(); }
    });
    clear.addEventListener('click', () => { input.value = ''; run(); input.focus(); });
}
