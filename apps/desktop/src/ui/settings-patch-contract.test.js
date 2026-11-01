// The settings page saves its own switches as a patch (not a full settings
// snapshot read first, which would put back a value another write changed in
// between). patch_settings applies only the fields it lists and drops the
// rest, so every field the page sends must be one of them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const settingsSource = fs.readFileSync(path.join(here, 'settings.js'), 'utf8');
const libSource = fs.readFileSync(path.resolve(here, '../../src-tauri/src/lib.rs'), 'utf8');

/** The body of `async function saveNow()` in settings.js. */
function saveNowBody() {
    const start = settingsSource.indexOf('async function saveNow()');
    expect(start).toBeGreaterThan(-1);
    const end = settingsSource.indexOf('\n    }\n', start);
    return settingsSource.slice(start, end);
}

describe('settings page save', () => {
    it('sends a patch, not a full snapshot', () => {
        const body = saveNowBody();
        expect(body).toContain('COMMANDS.PATCH_SETTINGS');
        expect(body).not.toContain('COMMANDS.SAVE_SETTINGS');
        expect(body).not.toContain('COMMANDS.GET_SETTINGS');
    });

    it('sends only fields patch_settings applies', () => {
        const sent = [...saveNowBody().matchAll(/patch\.([a-z_]+)\s*=/g)].map((m) => m[1]);
        expect(sent.length).toBeGreaterThan(5);
        const patchable = new Set([...libSource.matchAll(/patch_field!\((\w+)\)/g)].map((m) => m[1]));
        expect(sent.filter((field) => !patchable.has(field))).toEqual([]);
        // Apply & Restart passes the stored arguments to the restart.
        expect(sent).toContain('custom_args');
    });
});
