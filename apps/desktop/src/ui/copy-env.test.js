// @ts-check
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const { invokeMock, getConfigMock, showNotificationMock, copyToClipboardMock, trayState } = vi.hoisted(() => ({
    invokeMock: vi.fn(),
    getConfigMock: vi.fn(),
    showNotificationMock: vi.fn(),
    copyToClipboardMock: vi.fn(),
    /** The sequence the mock tray reports as landed. */
    trayState: { landedSeq: 0 },
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
        getLatestLandedSeq: () => trayState.landedSeq,
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
import { nextClipboardSeq } from './tray.js';

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
    if (vi.isFakeTimers()) {
        for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(0);
        return;
    }
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

/**
 * Click Copy with a deferred settings read; resolve the read and
 * queue a deferred write. Returns the write deferred, so the test
 * can land or fail it on its own schedule.
 */
async function queueFirstCopy() {
    const settings = deferred();
    invokeImpls.push(() => settings.promise);
    copyBtn().click();
    await flush();
    settings.resolve({ copy_env_format: 'bash' });
    const write = deferred();
    copyImpls.push(() => write.promise);
    await flush();
    return write;
}

/** Click Copy with a settings read that rejects, so the click fails before queueing. */
async function clickThatFailsBeforeQueueing() {
    invokeImpls.push(() => Promise.reject(new Error('settings unavailable')));
    copyBtn().click();
    await flush();
}

/** The button is idle and exactly one "Copy failed" notification was shown. */
function expectCopyFailed() {
    expect(buttonLabel()).toBe('Copy');
    expect(showNotificationMock).toHaveBeenCalledTimes(1);
    expect(String(showNotificationMock.mock.calls[0][0])).toContain('Copy failed');
}

/** Point the mock tray's landing at the first queued write (A). */
function landFirstWrite() {
    trayState.landedSeq = copyToClipboardMock.mock.calls[0][1];
}

/**
 * Click A (queues its write), start click B (waits for settings),
 * land A's write while B is in flight. Returns B's settings
 * deferred, so the test can fail it on its own schedule — with or
 * without an external copy landing in between.
 */
async function landFirstCopyWhileSecondClickWaits() {
    const writeA = await queueFirstCopy();
    expect(copyToClipboardMock).toHaveBeenCalledTimes(1);

    const settingsB = deferred();
    invokeImpls.push(() => settingsB.promise);
    copyBtn().click();
    await flush();

    // A's write lands while B is still awaiting settings.
    writeA.resolve(true);
    await flush();
    expect(buttonLabel()).toBe('Copied');
    return settingsB;
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
        trayState.landedSeq = 0;
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
        const settingsB = await landFirstCopyWhileSecondClickWaits();
        // The landing is still A's: no external copy replaced it.
        landFirstWrite();

        settingsB.reject(new Error('settings unavailable'));
        await flush();
        expect(buttonLabel()).toBe('Copied');
        expect(showNotificationMock).not.toHaveBeenCalled();
    });

    it('reports the failure when an external copy replaced the landed write', async () => {
        // Click A queues its write but it is still in flight; click B
        // starts and waits for settings; A's write lands during B's
        // flight — but an external copy C lands after A, so the
        // clipboard no longer holds A's text. B's lookup then fails:
        // the failure must be reported, not masked as A's success.
        const settingsB = await landFirstCopyWhileSecondClickWaits();

        // An external copy takes its own sequence and lands after A.
        trayState.landedSeq = nextClipboardSeq();

        settingsB.reject(new Error('settings unavailable'));
        await flush();
        expectCopyFailed();
    });

    it('leaves the button to an in-flight write, which then reports itself', async () => {
        // Click A queues its write but the write is still in flight.
        const writeA = await queueFirstCopy();
        expect(copyToClipboardMock).toHaveBeenCalledTimes(1);

        // Click B fails before queueing while A's write is still in
        // flight: B stays silent and hands the button back to A.
        await clickThatFailsBeforeQueueing();
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
        await clickThatFailsBeforeQueueing();
        expectCopyFailed();
    });

    it('reports a later click that fails after an earlier copy already settled', async () => {
        // Click A lands fully first. Much later, click B fails before
        // queueing: A's landing is old news, not an overlapping write —
        // B's failure must be reported, not masked as A's success.
        const writeA = await queueFirstCopy();
        writeA.resolve(true);
        await flush();
        expect(buttonLabel()).toBe('Copied');

        await clickThatFailsBeforeQueueing();
        expectCopyFailed();
    });

    it('does not let a failed click swallow a still-pending click’s failure', async () => {
        // A queues its write (in flight); X starts and waits for
        // settings; B fails before queueing while A is still in
        // flight, so B stays silent and hands the button to A. A
        // lands; X then queues its write and it fails — X's failure
        // must still be reported, not swallowed because B rewound the
        // click counter.
        const writeA = await queueFirstCopy();
        expect(copyToClipboardMock).toHaveBeenCalledTimes(1);

        const settingsX = deferred();
        invokeImpls.push(() => settingsX.promise);
        copyBtn().click();
        await flush();

        await clickThatFailsBeforeQueueing();
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
        expectCopyFailed();
    });

    it('gives a re-shown feedback its full window instead of stacking timers', async () => {
        // A lands while B awaits settings, so A shows "Copied"; B
        // then fails before queueing and the handoff shows it again
        // for the same landed copy. The second show must replace the
        // first timer — not stack a second one that would cut the
        // window short.
        vi.useFakeTimers();
        try {
            const settingsB = await landFirstCopyWhileSecondClickWaits();
            // The landing is still A's: no external copy replaced it.
            landFirstWrite();

            settingsB.reject(new Error('settings unavailable'));
            await flush();
            expect(buttonLabel()).toBe('Copied');
            expect(vi.getTimerCount()).toBe(1);

            await vi.advanceTimersByTimeAsync(1500);
            expect(buttonLabel()).toBe('Copy');
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('restores the button when a later queued write stays silent', async () => {
        // A lands while C awaits settings, so A shows "Copied"; C
        // then queues, but its write is superseded and stays silent.
        // A's timer must still restore the button — the newer queued
        // write must not leave it stuck on "Copied" indefinitely.
        vi.useFakeTimers();
        try {
            const writeA = await queueFirstCopy();
            expect(copyToClipboardMock).toHaveBeenCalledTimes(1);

            const settingsC = deferred();
            invokeImpls.push(() => settingsC.promise);
            copyBtn().click();
            await flush();

            writeA.resolve(true);
            await flush();
            expect(buttonLabel()).toBe('Copied');

            settingsC.resolve({ copy_env_format: 'bash' });
            copyImpls.push(() => Promise.resolve(false));
            await flush();
            expect(showNotificationMock).not.toHaveBeenCalled();
            expect(buttonLabel()).toBe('Copied');

            await vi.advanceTimersByTimeAsync(1500);
            expect(buttonLabel()).toBe('Copy');
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });
});
