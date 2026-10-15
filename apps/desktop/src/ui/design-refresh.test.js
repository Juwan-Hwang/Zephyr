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
