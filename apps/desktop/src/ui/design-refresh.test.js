// @ts-check
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(SRC, '../../..');
const read = (/** @type {string} */ rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const readRoot = (/** @type {string} */ rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('proxy card meta line', () => {
    it('shows protocol · transport layer (TRANSPORT_MAP), not the proxy.udp capability', () => {
        const src = read('ui/proxies.js');
        expect(src).toMatch(/metaText\.textContent = transport === '-' \? abbr : `\$\{abbr\} · \$\{transport\}`/);
        expect(src).not.toMatch(/`\$\{abbr\} · UDP`/);
        expect(src).toMatch(/'HYSTERIA2': 'QUIC'/);
    });

    it('never guesses TCP for unknown types and has no transport for non-proxy types', () => {
        const src = read('ui/proxies.js');
        expect(src).toMatch(/TRANSPORT_MAP\[upperType\] \|\| '-'/);
        for (const t of ['REJECTDROP', 'DNS', 'SMART']) {
            expect(src).toMatch(new RegExp(`'${t}': '-'`));
        }
        for (const t of ['MIERU', 'MASQUE', 'SUDOKU', 'TRUSTTUNNEL']) {
            expect(src).toMatch(new RegExp(`PROTOCOL_ABBR[\\s\\S]*'${t}':`));
        }
    });
});

describe('motion tokens', () => {
    const vars = () => readRoot('packages/tokens/build/css/variables.css');
    /** @param {string} v */
    const ms = (v) => (v.endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000);
    /** @param {string} name */
    const get = (name) => {
        const m = vars().match(new RegExp(`--zephyr-time-${name}:\\s*([^;]+);`));
        return m ? m[1].trim() : '';
    };

    it('durations are named in ascending order (micro < standard < slow)', () => {
        expect(ms(get('micro'))).toBeLessThan(ms(get('standard')));
        expect(ms(get('standard'))).toBeLessThan(ms(get('slow')));
        expect(vars()).not.toMatch(/--zephyr-time-fast/);
        expect(vars()).not.toMatch(/--zephyr-transition-fast/);
    });

    it('committed token build is in sync with the token sources', () => {
        const prim = JSON.parse(readRoot('packages/tokens/src/primitive.json'));
        for (const [k, v] of Object.entries(prim.time)) {
            expect(get(k), `time.${k}`).toBe(/** @type {{value: string}} */ (v).value);
        }
    });

    // src/tokens-variables.css is a gitignored build:css output; only compare when present.
    it.skipIf(!fs.existsSync(path.join(SRC, 'tokens-variables.css')))('desktop copy of the token build matches packages/tokens', () => {
        expect(read('tokens-variables.css')).toBe(vars());
    });

    it('desktop motion scale reads from the shared tokens, no stale names', () => {
        const css = read('styles.css');
        expect(css).toMatch(/--motion-slow:\s*var\(--zephyr-time-slow\)/);
        const all = [css, read('index.html')].join('\n');
        expect(all).not.toMatch(/--zephyr-time-fast|--zephyr-transition-fast|--zephyr-easing-smooth|--zephyr-easing-ease-in\)/);
    });
});

describe('Windows country-flag font', () => {
    it('ships the woff2 and scopes it to regional indicators / flag tags', () => {
        expect(fs.existsSync(path.join(SRC, 'fonts/TwemojiCountryFlags.woff2'))).toBe(true);
        const css = read('styles.css');
        expect(css).toMatch(/font-family: "Twemoji Country Flags";/);
        expect(css).toMatch(/unicode-range: U\+1F1E6-1F1FF, U\+1F3F4, U\+E0062-E007F;/);
        expect(css).toMatch(/--font-sans: "Twemoji Country Flags",/);
    });

    it('CSP lets the app load its own fonts', () => {
        const conf = JSON.parse(fs.readFileSync(path.join(SRC, '../src-tauri/tauri.conf.json'), 'utf8'));
        const csp = String(conf.app.security.csp);
        // font-src wins when present; default-src only applies without it.
        const src = csp.match(/(?:^|;)\s*font-src\s+([^;]*)/)?.[1] ?? csp.match(/(?:^|;)\s*default-src\s+([^;]*)/)?.[1] ?? '';
        expect(src).toMatch(/(?:^|\s)'self'(?:\s|$)/);
    });

    it('NOTICE credits Twemoji under CC-BY-4.0', () => {
        const notice = readRoot('NOTICE');
        expect(notice).toMatch(/Twemoji/);
        expect(notice).toMatch(/CC-BY[ -]4\.0/);
    });
});
