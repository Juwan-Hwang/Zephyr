// @ts-check
// Test-only helpers for reading the app's own source files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The `src` directory. */
export const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Read a file relative to `src`.
 * @param {string} rel
 * @returns {string}
 */
export const readSrc = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/**
 * Parse index.html without letting happy-dom fetch its stylesheets/scripts:
 * `<script>` and `<link>` are renamed to inert elements before parsing (plain
 * string substitution on our own trusted file, not sanitization).
 * @returns {Document}
 */
export const parseIndex = () => {
    const html = readSrc('index.html')
        .split('<script').join('<template data-inert-script')
        .split('</script>').join('</template>')
        .split('<link').join('<meta data-inert-link');
    return new DOMParser().parseFromString(html, 'text/html');
};
