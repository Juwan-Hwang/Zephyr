// @ts-check
/**
 * Fullscreen editor copy button: the native write path and its textarea
 * fallback. The native `writeText` call used to be evaluated synchronously
 * as an argument, so without the Clipboard API it threw before the promise
 * chain — and the fallback that claims to cover that environment never ran.
 * And a failed `execCommand` fallback used to stay silent: no "Copied", no
 * error, the button simply did nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./prism.js', () => ({
    overrideList: vi.fn(),
    overrideCreate: vi.fn(),
    overrideUpdate: vi.fn(),
    overrideDelete: vi.fn(),
    overrideGetContent: vi.fn(),
    overrideSetContent: vi.fn(),
    overrideReorder: vi.fn(),
    overrideToggle: vi.fn(),
    overrideTest: vi.fn(),
    overrideRefreshRemote: vi.fn(),
    overrideApplyAll: vi.fn(),
    overrideExport: vi.fn(),
    overrideImport: vi.fn(),
}));
vi.mock('../utils/logger.js', () => ({
    rulesLogger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock('./icons.js', () => ({ SVG_ICONS: {} }));
vi.mock('./proxies.js', () => ({
    stopSmartAutoTest: vi.fn(),
    startSmartAutoTest: vi.fn(),
    refreshProxies: vi.fn(),
}));
vi.mock('../i18n.js', () => ({
    t: (key) =>
        ({ overrideCopied: 'Copied', overrideCopy: 'Copy', copyFailed: 'Copy failed' })[key] ?? key,
    currentLang: 'en',
}));
vi.mock('./notifications.js', () => ({
    showNotification: vi.fn(),
    showModal: vi.fn(),
    showConfirmModal: vi.fn(),
}));
vi.mock('../utils/focus-trap.js', () => ({ createFocusTrap: vi.fn() }));
vi.mock('./link-dialog.js', () => ({ showLinkDialog: vi.fn() }));
vi.mock('./editor/prism-editor.js', () => ({
    createEditor: vi.fn(),
    getEditorContent: vi.fn(),
}));
vi.mock('./events.js', () => ({
    Bus: { on: vi.fn(), emit: vi.fn() },
    Events: { I18N_APPLIED: 'i18n-applied' },
}));

let clipboardSeq = 0;
vi.mock('./tray.js', () => ({
    // The race helper itself is covered by tray-clipboard.test.js; here
    // the write settles at once, so passing it through is enough.
    withClipboardTimeout: (promise) => promise,
    nextClipboardSeq: () => ++clipboardSeq,
    noteExternalClipboardWrite: vi.fn().mockReturnValue(true),
    getLatestLandedSeq: vi.fn().mockReturnValue(0),
}));

import { showNotification } from './notifications.js';
import { copyFullscreenOutput } from './plugins.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setClipboard(value) {
    Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
}

describe('copyFullscreenOutput', () => {
    beforeEach(() => {
        clipboardSeq = 0;
        vi.clearAllMocks();
        document.body.innerHTML = `
            <div id="fullscreen-editor-output">hello</div>
            <button id="fullscreen-editor-copy-output-btn">Copy</button>
        `;
        document.execCommand = vi.fn().mockReturnValue(true);
    });

    afterEach(() => {
        setClipboard(undefined);
    });

    it('falls back to the textarea when there is no Clipboard API', async () => {
        setClipboard(undefined);
        copyFullscreenOutput();
        await flush();
        await flush();
        expect(document.execCommand).toHaveBeenCalledWith('copy');
        expect(document.getElementById('fullscreen-editor-copy-output-btn').textContent).toBe(
            'Copied',
        );
        expect(showNotification).not.toHaveBeenCalled();
    });

    it('reports the failure when the textarea fallback cannot copy', async () => {
        setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
        document.execCommand = vi.fn().mockReturnValue(false);
        copyFullscreenOutput();
        await flush();
        await flush();
        expect(showNotification).toHaveBeenCalledWith('Copy failed', 'error');
        expect(document.getElementById('fullscreen-editor-copy-output-btn').textContent).toBe(
            'Copy',
        );
    });
});
