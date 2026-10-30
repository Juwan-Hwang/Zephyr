// @ts-check
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const { invokeMock, getConfigMock, showNotificationMock, copyToClipboardMock } = vi.hoisted(() => ({
    invokeMock: vi.fn(),
    getConfigMock: vi.fn(),
    showNotificationMock: vi.fn(),
    copyToClipboardMock: vi.fn(),
}));

/** Queued implementations, consumed in order by the mocks below. */
const invokeImpls = [];
const copyImpls = [];

vi.mock('../api.js', () => ({
    invoke: invokeMock,
    listen: vi.fn(),
    openUrl: vi.fn(),
    restartCore: vi.fn(),
    abortLatencyTests: vi.fn(),
    isAutoStartEnabled: vi.fn(),
    readAutoStartEnabled: vi.fn(),
    enableAutoStart: vi.fn(),
    disableAutoStart: vi.fn(),
    openConfigFolder: vi.fn(),
    openPrismFolder: vi.fn(),
    setSecret: vi.fn(),
    setBaseUrl: vi.fn(),
    getConfig: getConfigMock,
    closeAllConnections: vi.fn(),
    closeConnection: vi.fn(),
    getConnections: vi.fn(),
    getCurrentWindow: vi.fn(),
    getLatencyTestSignal: vi.fn(),
    getProxies: vi.fn(),
    getProxiesMerged: vi.fn(),
    isCoreReachable: vi.fn(),
    patchConfig: vi.fn(),
    readCoreLog: vi.fn(),
    resetLatencyTestController: vi.fn(),
    switchProxy: vi.fn(),
    switchProxyResult: vi.fn(),
    testProxy: vi.fn(),
    getProxyProviders: vi.fn(),
    clearProviderCache: vi.fn(),
    reloadConfig: vi.fn(),
    setCoreReachable: vi.fn(),
    isConnectionRefusedError: vi.fn(),
    SPECIAL_PROXY_NAMES: new Set(),
}));

vi.mock('./tray.js', () => {
    let seq = 0;
    return {
        nextClipboardSeq: () => ++seq,
        noteExternalClipboardWrite: vi.fn(),
        updateTrayMenu: vi.fn(),
        updateTrayStatus: vi.fn(),
        generateProxyEnvVars: () => 'export http_proxy=http://127.0.0.1:7890',
        resolveEnvFormat: (format) => format || 'bash',
        copyToClipboard: copyToClipboardMock,
    };
});

vi.mock('./notifications.js', () => ({
    showNotification: showNotificationMock,
    showConfirmModal: vi.fn(),
    showModal: vi.fn(),
}));

import { initCopyEnvSettings } from './settings.js';

/** @returns {{ promise: Promise<any>, resolve: (value?: any) => void, reject: (err?: any) => void }} */
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** Let every pending microtask (and the chains they queue) drain. */
async function flush() {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
}

/** @returns {HTMLButtonElement} */
function copyBtn() {
    return /** @type {HTMLButtonElement} */ (document.getElementById('copy-env-btn'));
}

/** @returns {string} */
function buttonLabel() {
    return copyBtn().querySelector('span')?.textContent ?? '';
}

describe('copy-env button: a click that fails before queueing', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <button id="copy-env-btn" aria-label="Copy Proxy Env"><span>Copy</span></button>
            <button id="copy-env-format-btn" aria-expanded="false"></button>
            <span id="copy-env-format-label">Bash</span>
            <div id="copy-env-format-menu" class="hidden"><div class="menu-scroll"></div></div>
        `;
        invokeImpls.length = 0;
        copyImpls.length = 0;
        invokeMock.mockClear();
        getConfigMock.mockClear();
        showNotificationMock.mockClear();
        copyToClipboardMock.mockClear();
        invokeMock.mockImplementation((...args) => {
            const impl = invokeImpls.shift();
            return impl ? impl(...args) : Promise.resolve({ copy_env_format: 'bash' });
        });
        getConfigMock.mockResolvedValue({ 'mixed-port': 7890 });
        copyToClipboardMock.mockImplementation((...args) => {
            const impl = copyImpls.shift();
            return impl ? impl(...args) : Promise.resolve(true);
        });
        initCopyEnvSettings();
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.clearAllMocks();
    });

    it('reports a write that lands while the failing click is in flight', async () => {
        // Click A queues its write but it is still in flight; click B
        // starts and waits for settings; A's write lands during B's
        // flight; then B's settings lookup fails. The clipboard holds
        // A's text, so B reports A's success — not its own lookup
        // failure.
        const settingsA = deferred();
        invokeImpls.push(() => settingsA.promise);
        copyBtn().click();
        await flush();
        settingsA.resolve({ copy_env_format: 'bash' });
        const writeA = deferred();
        copyImpls.push(() => writeA.promise);
        await flush();
        expect(copyToClipboardMock).toHaveBeenCalledTimes(1);

        const settingsB = deferred();
        invokeImpls.push(() => settingsB.promise);
        copyBtn().click();
        await flush();

        // A's write lands while B is still awaiting settings.
        writeA.resolve(true);
        await flush();
        expect(buttonLabel()).toBe('Copied');

        settingsB.reject(new Error('settings unavailable'));
        await flush();
        expect(buttonLabel()).toBe('Copied');
        expect(showNotificationMock).not.toHaveBeenCalled();
    });

    it('leaves the button to an in-flight write, which then reports itself', async () => {
        // Click A queues its write but the write is still in flight.
        const settingsA = deferred();
        invokeImpls.push(() => settingsA.promise);
        copyBtn().click();
        await flush();
        settingsA.resolve({ copy_env_format: 'bash' });
        const writeA = deferred();
        copyImpls.push(() => writeA.promise);
        await flush();
        expect(copyToClipboardMock).toHaveBeenCalledTimes(1);

        // Click B fails before queueing while A's write is still in
        // flight: B stays silent and hands the button back to A.
        invokeImpls.push(() => Promise.reject(new Error('settings unavailable')));
        copyBtn().click();
        await flush();
        expect(buttonLabel()).toBe('Copy');
        expect(showNotificationMock).not.toHaveBeenCalled();

        // A's write lands: A owns the button again, so it shows
        // "Copied" instead of staying silent.
        writeA.resolve(true);
        await flush();
        expect(buttonLabel()).toBe('Copied');
        expect(showNotificationMock).not.toHaveBeenCalled();
    });

    it('still reports a lone click that fails before queueing', async () => {
        // No write is queued and none is in flight: there is nothing
        // to hand the button to, so the failure is reported as usual.
        invokeImpls.push(() => Promise.reject(new Error('settings unavailable')));
        copyBtn().click();
        await flush();
        expect(buttonLabel()).toBe('Copy');
        expect(showNotificationMock).toHaveBeenCalledTimes(1);
        expect(String(showNotificationMock.mock.calls[0][0])).toContain('Copy failed');
    });

    it('reports a later click that fails after an earlier copy already settled', async () => {
        // Click A lands fully first. Much later, click B fails before
        // queueing: A's landing is old news, not an overlapping write —
        // B's failure must be reported, not masked as A's success.
        const settingsA = deferred();
        invokeImpls.push(() => settingsA.promise);
        copyBtn().click();
        await flush();
        settingsA.resolve({ copy_env_format: 'bash' });
        const writeA = deferred();
        copyImpls.push(() => writeA.promise);
        await flush();
        writeA.resolve(true);
        await flush();
        expect(buttonLabel()).toBe('Copied');

        invokeImpls.push(() => Promise.reject(new Error('settings unavailable')));
        copyBtn().click();
        await flush();
        expect(buttonLabel()).toBe('Copy');
        expect(showNotificationMock).toHaveBeenCalledTimes(1);
        expect(String(showNotificationMock.mock.calls[0][0])).toContain('Copy failed');
    });

    it('does not let a failed click swallow a still-pending click’s failure', async () => {
        // A queues its write (in flight); X starts and waits for
        // settings; B fails before queueing while A is still in
        // flight, so B stays silent and hands the button to A. A
        // lands; X then queues its write and it fails — X's failure
        // must still be reported, not swallowed because B rewound the
        // click counter.
        const settingsA = deferred();
        invokeImpls.push(() => settingsA.promise);
        copyBtn().click();
        await flush();
        settingsA.resolve({ copy_env_format: 'bash' });
        const writeA = deferred();
        copyImpls.push(() => writeA.promise);
        await flush();
        expect(copyToClipboardMock).toHaveBeenCalledTimes(1);

        const settingsX = deferred();
        invokeImpls.push(() => settingsX.promise);
        copyBtn().click();
        await flush();

        invokeImpls.push(() => Promise.reject(new Error('settings unavailable')));
        copyBtn().click();
        await flush();
        expect(showNotificationMock).not.toHaveBeenCalled();

        writeA.resolve(true);
        await flush();
        expect(buttonLabel()).toBe('Copied');

        settingsX.resolve({ copy_env_format: 'bash' });
        const writeX = deferred();
        copyImpls.push(() => writeX.promise);
        await flush();
        writeX.reject(new Error('clipboard denied'));
        await flush();
        expect(showNotificationMock).toHaveBeenCalledTimes(1);
        expect(String(showNotificationMock.mock.calls[0][0])).toContain('Copy failed');
        expect(buttonLabel()).toBe('Copy');
    });
});
