// @ts-check
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../api.js', () => ({
    invoke: vi.fn().mockResolvedValue({}),
}));

import { translations, setLanguage } from '../i18n.js';
import { renderTunStatus } from './tun-status.js';
import { initNavTooltips, getNavLabel, NAV_TOOLTIP_HOVER_DELAY } from './nav-tooltip.js';
import { Bus, Events } from './events.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (/** @type {string} */ rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/**
 * Parse index.html without letting happy-dom fetch its stylesheets/scripts:
 * `<script>` and `<link>` are renamed to inert elements before parsing (plain
 * string substitution on our own trusted file, not sanitization).
 */
const parseIndex = () => {
    const html = read('index.html')
        .split('<script').join('<template data-inert-script')
        .split('</script>').join('</template>')
        .split('<link').join('<meta data-inert-link');
    return new DOMParser().parseFromString(html, 'text/html');
};

// ─────────────────────────────────────────────────────────────────────────────
//  1. TUN status labels
// ─────────────────────────────────────────────────────────────────────────────

describe('TUN status labels', () => {
    const all = /** @type {Record<string, Record<string, unknown>>} */ (/** @type {unknown} */ (translations));

    it('every locale has dedicated, non-empty tunActive / tunInactive strings', () => {
        for (const [lang, dict] of Object.entries(all)) {
            expect(typeof dict.tunActive, `${lang}.tunActive`).toBe('string');
            expect(typeof dict.tunInactive, `${lang}.tunInactive`).toBe('string');
            expect(String(dict.tunActive).length, `${lang}.tunActive`).toBeGreaterThan(0);
            expect(dict.tunActive, `${lang}`).not.toBe(dict.tunInactive);
            // Must not reuse the system-proxy wording.
            expect(dict.tunActive, `${lang}`).not.toBe(dict.proxyActive);
            expect(dict.tunInactive, `${lang}`).not.toBe(dict.proxyInactive);
        }
    });

    afterEach(() => setLanguage('en'));

    it('renderTunStatus() writes the localized text, data-i18n key and colour classes', () => {
        setLanguage('zh');
        const el = document.createElement('p');
        el.className = 'text-2xs text-[var(--text-muted)]';

        renderTunStatus(el, true);
        expect(el.textContent).toBe('TUN 已启用');
        expect(el.dataset.i18n).toBe('tunActive');
        expect(el.classList.contains('text-accent')).toBe(true);
        expect(el.classList.contains('text-[var(--text-muted)]')).toBe(false);

        renderTunStatus(el, false);
        expect(el.textContent).toBe('TUN 已关闭');
        expect(el.dataset.i18n).toBe('tunInactive');
        expect(el.classList.contains('text-accent')).toBe(false);
        expect(el.classList.contains('text-[var(--text-muted)]')).toBe(true);
    });

    it('keeps the current state when the language changes (data-i18n is updated)', () => {
        setLanguage('en');
        document.body.innerHTML = '<p id="tun-status-text" data-i18n="tunInactive">TUN disabled</p>';
        const el = /** @type {HTMLElement} */ (document.getElementById('tun-status-text'));
        renderTunStatus(el, true);
        setLanguage('ja');
        expect(el.textContent).toBe(all.ja.tunActive);
        document.body.innerHTML = '';
    });

    it('is a no-op for a missing element', () => {
        expect(() => renderTunStatus(null, true)).not.toThrow();
    });

    it('the configuring state keeps data-i18n in step for a mid-toggle language switch', () => {
        expect(read('ui/tun.js')).toContain("statusText.dataset.i18n = 'configuringTun';");
        for (const lang of Object.keys(all)) {
            expect(typeof all[lang].configuringTun).toBe('string');
        }
    });

    it('TUN code paths no longer borrow the system-proxy strings', () => {
        const tun = read('ui/tun.js');
        expect(tun).not.toMatch(/t\.proxyActive/);
        expect(tun).not.toMatch(/t\.virtualAdapter/);
        const proxies = read('ui/proxies.js');
        expect(proxies).not.toMatch(/tunEnable \? t\.proxyActive/);
        expect(proxies).toMatch(/renderTunStatus\(/);
    });

    it('TUN card places its status line directly under the title, like the system proxy card', () => {
        const doc = parseIndex();
        const status = /** @type {HTMLElement} */ (doc.getElementById('tun-status-text'));
        expect(status).toBeTruthy();
        expect(status.dataset.i18n).toBe('tunInactive');
        const title = /** @type {HTMLElement} */ (doc.querySelector('[data-i18n="tunMode"]'));
        // Title and status share the same text column.
        const column = title.parentElement;
        expect(column?.contains(status)).toBe(true);
        expect(title.nextElementSibling?.contains(status)).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
//  2 + 3. Speed units and tabular numerals
// ─────────────────────────────────────────────────────────────────────────────

describe('speed units and numerals', () => {
    const css = read('styles.css');
    /** Body of the first rule whose selector starts a line and is exactly `selector`. */
    const rule = (/** @type {string} */ selector) => {
        for (let at = css.indexOf(selector); at >= 0; at = css.indexOf(selector, at + 1)) {
            if (at > 0 && css[at - 1] !== '\n') continue;
            const rest = css.slice(at + selector.length);
            const open = rest.length - rest.trimStart().length;
            if (rest[open] !== '{') continue;
            const close = rest.indexOf('}', open);
            return close < 0 ? '' : rest.slice(open + 1, close);
        }
        return '';
    };

    it('KPI unit span is not uppercased (KB/s stays KB/s)', () => {
        const body = rule('.dz-kpi-value span');
        expect(body).toBeTruthy();
        expect(body).not.toMatch(/text-transform\s*:\s*uppercase/);
    });

    it('KPI labels keep their uppercase styling', () => {
        expect(rule('.dz-kpi-label')).toMatch(/text-transform\s*:\s*uppercase/);
    });

    it('home speed unit spans are not uppercased', () => {
        const doc = parseIndex();
        for (const id of ['speed-down-unit', 'speed-up-unit']) {
            const el = doc.getElementById(id);
            expect(el, id).toBeTruthy();
            expect(el?.classList.contains('uppercase'), id).toBe(false);
        }
    });

    it('dynamic numeric readouts use tabular numerals', () => {
        for (const sel of ['.dz-kpi-value b', '.dz-kpi-foot', '.dz-header .dz-sub', '.dz-sub-used span', '.dz-latency-num', '.dz-chart-meta b', '.dz-conn-speed']) {
            expect(rule(sel), sel).toMatch(/font-variant-numeric\s*:\s*tabular-nums/);
        }
        const doc = parseIndex();
        for (const id of ['speed-down-val', 'speed-up-val']) {
            expect(doc.getElementById(id)?.classList.contains('tabular-nums'), id).toBe(true);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
//  4. Sidebar tooltips
// ─────────────────────────────────────────────────────────────────────────────

describe('sidebar nav tooltips', () => {
    /** @type {() => void} */
    let cleanup = () => {};

    beforeEach(() => {
        vi.useFakeTimers();
        document.documentElement.setAttribute('dir', 'ltr');
        document.body.innerHTML = `
            <nav id="sidebar-nav">
                <button type="button" data-nav="home" class="nav-btn" aria-label="Home" data-i18n-aria-label="home"><svg class="icon"></svg><span class="sr-only" data-i18n="home">首页</span></button>
                <button type="button" data-nav="logs" class="nav-btn" aria-label="Logs" data-i18n-aria-label="logs"><svg class="icon"></svg><span class="sr-only" data-i18n="logs">日志</span></button>
            </nav>`;
        cleanup = initNavTooltips(document.getElementById('sidebar-nav'));
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        document.body.innerHTML = '';
        document.documentElement.removeAttribute('dir');
    });

    const tip = () => /** @type {HTMLElement} */ (document.getElementById('nav-tooltip'));
    const btn = (/** @type {string} */ nav) => /** @type {HTMLElement} */ (document.querySelector(`[data-nav="${nav}"]`));
    const over = (/** @type {Element} */ el, /** @type {Element | null} */ related = null) =>
        el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, relatedTarget: related }));
    const out = (/** @type {Element} */ el, /** @type {Element | null} */ related = null) =>
        el.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: related }));

    it('creates one aria-hidden tooltip node on <body>', () => {
        expect(document.querySelectorAll('#nav-tooltip').length).toBe(1);
        expect(tip().getAttribute('aria-hidden')).toBe('true');
        expect(tip().parentElement).toBe(document.body);
    });

    it('reads the localized label from the sr-only span', () => {
        expect(getNavLabel(btn('home'))).toBe('首页');
        const bare = document.createElement('button');
        bare.setAttribute('aria-label', 'Settings');
        expect(getNavLabel(bare)).toBe('Settings');
    });

    it('shows after the hover intent delay and hides on leave', () => {
        over(btn('home'));
        expect(tip().classList.contains('is-visible')).toBe(false);
        vi.advanceTimersByTime(NAV_TOOLTIP_HOVER_DELAY);
        expect(tip().classList.contains('is-visible')).toBe(true);
        expect(tip().textContent).toBe('首页');
        expect(tip().dataset.side).toBe('end');

        out(btn('home'), document.body);
        expect(tip().classList.contains('is-visible')).toBe(false);
    });

    it('follows immediately when moving to another nav button', () => {
        over(btn('home'));
        vi.advanceTimersByTime(NAV_TOOLTIP_HOVER_DELAY);
        out(btn('home'), btn('logs'));
        over(btn('logs'), btn('home'));
        expect(tip().classList.contains('is-visible')).toBe(true);
        expect(tip().textContent).toBe('日志');
    });

    it('cancels a pending show when the pointer leaves first', () => {
        over(btn('home'));
        out(btn('home'), document.body);
        vi.advanceTimersByTime(NAV_TOOLTIP_HOVER_DELAY * 2);
        expect(tip().classList.contains('is-visible')).toBe(false);
    });

    it('shows on keyboard focus (focus-visible) and hides on blur / Escape', () => {
        const home = btn('home');
        const spy = vi.spyOn(home, 'matches').mockImplementation((sel) => sel === ':focus-visible');
        home.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        expect(tip().classList.contains('is-visible')).toBe(true);

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(tip().classList.contains('is-visible')).toBe(false);

        home.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        home.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }));
        expect(tip().classList.contains('is-visible')).toBe(false);
        spy.mockRestore();
    });

    it('hands the label back to the keyboard-focused button when the pointer leaves', () => {
        const home = btn('home');
        vi.spyOn(home, 'matches').mockImplementation((sel) => sel === ':focus-visible');
        home.focus();
        home.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        expect(tip().textContent).toBe('首页');

        over(btn('logs'), home);
        expect(tip().textContent).toBe('日志');
        out(btn('logs'), document.body);
        expect(tip().classList.contains('is-visible')).toBe(true);
        expect(tip().textContent).toBe('首页');
    });

    it('keeps the hovered label when keyboard focus leaves the sidebar', () => {
        const logs = btn('logs');
        vi.spyOn(logs, 'matches').mockImplementation((sel) => sel === ':focus-visible');
        logs.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        over(btn('home'), logs);
        expect(tip().textContent).toBe('首页');

        logs.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }));
        expect(tip().classList.contains('is-visible')).toBe(true);
        expect(tip().textContent).toBe('首页');
    });

    it('does not break when :focus-visible is unsupported (older WebKit)', () => {
        const home = btn('home');
        vi.spyOn(home, 'matches').mockImplementation(() => { throw new SyntaxError('unsupported selector'); });
        home.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        home.focus();
        over(home);
        vi.advanceTimersByTime(NAV_TOOLTIP_HOVER_DELAY);
        expect(() => out(home, document.body)).not.toThrow();
        expect(tip().classList.contains('is-visible')).toBe(false);
    });

    it('still shows on keyboard focus when :focus-visible is unsupported', () => {
        const home = btn('home');
        vi.spyOn(home, 'matches').mockImplementation(() => { throw new SyntaxError('unsupported selector'); });
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
        home.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        expect(tip().classList.contains('is-visible')).toBe(true);
        expect(tip().textContent).toBe('首页');
    });

    it('hides when the sidebar scrolls', () => {
        over(btn('home'));
        vi.advanceTimersByTime(NAV_TOOLTIP_HOVER_DELAY);
        expect(tip().classList.contains('is-visible')).toBe(true);
        btn('home').parentElement?.dispatchEvent(new Event('scroll'));
        expect(tip().classList.contains('is-visible')).toBe(false);
    });

    it('does not show for mouse focus (not focus-visible)', () => {
        const home = btn('home');
        vi.spyOn(home, 'matches').mockReturnValue(false);
        home.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        expect(tip().classList.contains('is-visible')).toBe(false);
    });

    it('hides on pointerdown (click)', () => {
        over(btn('home'));
        vi.advanceTimersByTime(NAV_TOOLTIP_HOVER_DELAY);
        btn('home').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        expect(tip().classList.contains('is-visible')).toBe(false);
    });

    it('stays hidden after a click while the pointer moves within the same button', () => {
        const home = btn('home');
        over(home);
        vi.advanceTimersByTime(NAV_TOOLTIP_HOVER_DELAY);
        home.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        over(/** @type {Element} */ (home.querySelector('svg')), home);
        vi.advanceTimersByTime(NAV_TOOLTIP_HOVER_DELAY * 2);
        expect(tip().classList.contains('is-visible')).toBe(false);

        // Leaving the button lifts the suppression for the next hover.
        out(home, document.body);
        over(home);
        vi.advanceTimersByTime(NAV_TOOLTIP_HOVER_DELAY);
        expect(tip().classList.contains('is-visible')).toBe(true);
    });

    it('stays hidden after Escape while the pointer moves within the same button', () => {
        const home = btn('home');
        over(home);
        vi.advanceTimersByTime(NAV_TOOLTIP_HOVER_DELAY);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        over(/** @type {Element} */ (home.querySelector('.sr-only')), home);
        vi.advanceTimersByTime(NAV_TOOLTIP_HOVER_DELAY * 2);
        expect(tip().classList.contains('is-visible')).toBe(false);
    });

    it('a visible label follows a language change', () => {
        const home = btn('home');
        over(home);
        vi.advanceTimersByTime(NAV_TOOLTIP_HOVER_DELAY);
        /** @type {HTMLElement} */ (home.querySelector('.sr-only')).textContent = 'Home';
        document.documentElement.setAttribute('dir', 'rtl');
        Bus.emit(Events.I18N_APPLIED);
        expect(tip().textContent).toBe('Home');
        expect(tip().dataset.side).toBe('start');
        cleanup();
        cleanup = () => {};
        expect(() => Bus.emit(Events.I18N_APPLIED)).not.toThrow();
    });

    it('Escape cancels a hover that is still waiting out its delay', () => {
        const home = btn('home');
        over(home);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        vi.advanceTimersByTime(NAV_TOOLTIP_HOVER_DELAY * 2);
        expect(tip().classList.contains('is-visible')).toBe(false);
        over(/** @type {Element} */ (home.querySelector('svg')), home);
        vi.advanceTimersByTime(NAV_TOOLTIP_HOVER_DELAY * 2);
        expect(tip().classList.contains('is-visible')).toBe(false);
    });

    it('a dismissed label stays hidden when focus then leaves the sidebar', () => {
        const home = btn('home');
        over(home);
        vi.advanceTimersByTime(NAV_TOOLTIP_HOVER_DELAY);
        home.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        home.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }));
        expect(tip().classList.contains('is-visible')).toBe(false);
    });

    it('compensates for the body UI scale when positioning', () => {
        const home = btn('home');
        vi.spyOn(home, 'getBoundingClientRect').mockReturnValue(
            /** @type {DOMRect} */ ({ top: 100, left: 0, right: 60, bottom: 140, width: 60, height: 40, x: 0, y: 100, toJSON() {} }));
        document.documentElement.style.setProperty('--ui-scale', '2');
        over(home);
        vi.advanceTimersByTime(NAV_TOOLTIP_HOVER_DELAY);
        expect(tip().style.top).toBe('60px');
        expect(tip().style.left).toBe('40px');
        document.documentElement.style.removeProperty('--ui-scale');
    });

    it('hides when a focused button is activated from the keyboard', () => {
        const home = btn('home');
        vi.spyOn(home, 'matches').mockImplementation((sel) => sel === ':focus-visible');
        home.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        expect(tip().classList.contains('is-visible')).toBe(true);
        home.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
        expect(tip().classList.contains('is-visible')).toBe(false);
    });

    it('cancels a pending hover when the window loses focus', () => {
        over(btn('home'));
        window.dispatchEvent(new Event('blur'));
        vi.advanceTimersByTime(NAV_TOOLTIP_HOVER_DELAY * 2);
        expect(tip().classList.contains('is-visible')).toBe(false);
    });

    it('flips to the start side in RTL layouts', () => {
        document.documentElement.setAttribute('dir', 'rtl');
        over(btn('home'));
        vi.advanceTimersByTime(NAV_TOOLTIP_HOVER_DELAY);
        expect(tip().dataset.side).toBe('start');
    });

    it('cleanup removes the tooltip node', () => {
        cleanup();
        expect(document.getElementById('nav-tooltip')).toBeNull();
        cleanup = () => {};
    });

    it('index.html nav buttons drop the native title and carry localized aria-labels', () => {
        const doc = parseIndex();
        const buttons = [...doc.querySelectorAll('#sidebar-nav .nav-btn')];
        expect(buttons.length).toBeGreaterThan(0);
        for (const b of buttons) {
            const nav = b.getAttribute('data-nav');
            expect(b.hasAttribute('title'), `${nav} title`).toBe(false);
            expect(b.getAttribute('aria-label'), `${nav} aria-label`).toBeTruthy();
            const key = b.getAttribute('data-i18n-aria-label');
            expect(key, `${nav} data-i18n-aria-label`).toBeTruthy();
            expect(b.querySelector('.sr-only')?.getAttribute('data-i18n')).toBe(key);
        }
    });

    it('tooltip styles respect reduced motion', () => {
        const css = read('styles.css');
        expect(css).toMatch(/\.nav-tooltip\s*\{/);
        expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.nav-tooltip\s*\{\s*transition:\s*none/);
    });
});
