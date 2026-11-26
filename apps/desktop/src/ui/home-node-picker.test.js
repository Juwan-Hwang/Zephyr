import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The list only needs the node list; everything else is a no-op.
vi.mock('../api.js', () => ({
    getProxies: vi.fn(),
    getProxiesMerged: vi.fn(async (data) => data),
    // Runs the click's `prepare` in its turn, as the real queue does, and
    // drops the switch unsent as busy when canSend says no.
    switchProxyResult: vi.fn(async (_group, _name, options) => {
        const prepared = await options?.prepare?.();
        if (options?.canSend && !options.canSend()) return { ok: false, reason: 'busy', prepared, seq: 1 };
        options?.beforeSend?.();
        return { ok: true, reason: null, prepared, seq: 1 };
    }),
    isLatestSwitch: vi.fn(() => true),
    coreReplacements: vi.fn(() => 0),
    SWITCH_BUSY: 'busy',
    abortLatencyTests: vi.fn(),
    closeAllConnections: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../utils/logger.js', () => ({
    homeNodePickerLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../i18n.js', () => ({ t: (/** @type {string} */ k) => k }));
vi.mock('./proxy-groups.js', () => ({ fetchProxyGroups: vi.fn() }));
vi.mock('./proxies.js', () => ({
    sortProxiesByLatency: vi.fn(),
    syncCoreConfig: vi.fn().mockResolvedValue(undefined),
    renderProxies: vi.fn(),
    notifySwitchFailed: vi.fn(),
    resolveLeafNode: vi.fn((/** @type {string} */ n, /** @type {any} */ map) => {
        let cur = n; const seen = new Set();
        while (map?.[cur]?.now && map[map[cur].now] && !seen.has(cur)) { seen.add(cur); cur = map[cur].now; }
        return cur;
    }),
}));
vi.mock('./state.js', () => ({ appStore: { get: vi.fn(() => null) } }));
vi.mock('./cache.js', () => ({
    invalidateProxiesCache: vi.fn(),
    getSettingsCached: vi.fn().mockResolvedValue({}),
}));
vi.mock('./proxy-memory.js', () => ({ saveProxySelection: vi.fn() }));
vi.mock('./running-profile.js', () => ({ readRunningProfile: vi.fn().mockResolvedValue('config.yaml') }));
vi.mock('./notifications.js', () => ({ showNotification: vi.fn() }));
vi.mock('./home-stats.js', () => ({ splitFlag: (/** @type {string} */ n) => ({ flag: '', label: n }) }));

const GROUPS = {
    uiGroupName: 'Proxy',
    mainGroup: 'Proxy',
    current: 'HK 02',
    proxies: ['HK 01', 'HK 02', 'JP 01'],
    data: { proxies: {
        'HK 01': { history: [{ delay: 120 }] },
        'HK 02': { history: [{ delay: 80 }] },
        'JP 01': { history: [] },
    } },
};

function mountDom() {
    document.body.innerHTML = `
      <div data-page="home">
        <div id="home-node-current">
          <button type="button" id="home-node-trigger" aria-expanded="false"><span id="current-node-name">HK 02</span></button>
          <div id="home-node-picker" class="dz-hidden"><div id="home-node-list"></div></div>
        </div>
        <div id="elsewhere">speed</div>
      </div>
      <div data-page="proxies" class="hidden"></div>`;
    return {
        page: /** @type {HTMLElement} */ (document.querySelector('[data-page="home"]')),
        trigger: /** @type {HTMLElement} */ (document.getElementById('home-node-trigger')),
        dropdown: /** @type {HTMLElement} */ (document.getElementById('home-node-picker')),
        list: /** @type {HTMLElement} */ (document.getElementById('home-node-list')),
        elsewhere: /** @type {HTMLElement} */ (document.getElementById('elsewhere')),
    };
}

/** @param {HTMLElement} dropdown */
const isShown = (dropdown) => !dropdown.classList.contains('dz-hidden');

/** Resolve-on-demand stand-in for the /proxies round trip. */
function deferred() {
    /** @type {(v: any) => void} */
    let resolve = () => {};
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}

/** @type {typeof import('./home-node-picker.js')} */
let picker;
/** @type {import('vitest').Mock} */
let fetchProxyGroups;
/** @type {ReturnType<typeof mountDom>} */
let dom;

beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    dom = mountDom();
    picker = await import('./home-node-picker.js');
    fetchProxyGroups = /** @type {any} */ ((await import('./proxy-groups.js')).fetchProxyGroups);
    fetchProxyGroups.mockReset();
    fetchProxyGroups.mockResolvedValue(GROUPS);
    picker.initHomeNodePicker();
});

afterEach(() => {
    picker.closePicker();
    vi.useRealTimers();
    document.body.innerHTML = '';
});

/** Click the node bar and let the node list arrive. */
async function clickOpen() {
    if (picker.isNodePickerOpen()) picker.closePicker();
    dom.trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    await vi.advanceTimersByTimeAsync(0);
}

/** @param {string} name */
const row = (name) => /** @type {HTMLElement} */ (dom.list.querySelector(`[data-node="${name}"]`));

describe('home node list', () => {
    it('opens on click with one row per node, the current one marked, and closes on a second click', async () => {
        await clickOpen();
        expect(isShown(dom.dropdown)).toBe(true);
        expect(dom.trigger.getAttribute('aria-expanded')).toBe('true');
        expect(dom.list.getAttribute('role')).toBe('listbox');
        const options = dom.list.querySelectorAll('[role="option"]');
        expect(options).toHaveLength(3);
        expect(row('HK 02').getAttribute('aria-selected')).toBe('true');
        expect(row('HK 01').getAttribute('aria-selected')).toBe('false');
        expect(row('HK 01').textContent).toContain('120 ms');
        // No measurement: no figure.
        expect(row('JP 01').textContent).not.toContain('ms');

        dom.trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
        expect(isShown(dom.dropdown)).toBe(false);
        expect(picker.isNodePickerOpen()).toBe(false);
        expect(dom.trigger.getAttribute('aria-expanded')).toBe('false');
    });

    it('stays closed when it was closed while the node list was still loading', async () => {
        const slow = deferred();
        fetchProxyGroups.mockReturnValueOnce(slow.promise);
        dom.trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        slow.resolve(GROUPS);
        await vi.advanceTimersByTimeAsync(0);
        expect(isShown(dom.dropdown)).toBe(false);
        expect(picker.isNodePickerOpen()).toBe(false);

        // ...and the next click still opens it.
        await clickOpen();
        expect(isShown(dom.dropdown)).toBe(true);
    });

    it('discards provider data when the selected group is cleared while it loads', async () => {
        const state = await import('./state.js');
        const api = await import('../api.js');
        const slow = deferred();
        /** @type {any} */ (state.appStore.get).mockImplementation((/** @type {string} */ key) => key === 'uiGroupName' ? 'Proxy' : null);
        vi.mocked(api.getProxiesMerged).mockReturnValueOnce(slow.promise);
        try {
            dom.trigger.click();
            await vi.advanceTimersByTimeAsync(0);
            vi.mocked(state.appStore.get).mockImplementation(() => null);
            slow.resolve(GROUPS.data);
            await vi.advanceTimersByTimeAsync(0);
            expect(isShown(dom.dropdown)).toBe(false);
            expect(picker.isNodePickerOpen()).toBe(false);
            expect(dom.list.querySelector('[data-node]')).toBeNull();
        } finally {
            vi.mocked(state.appStore.get).mockImplementation(() => null);
        }
    });

    it('releases the open state when there is nothing to show, so the next click can open', async () => {
        fetchProxyGroups.mockResolvedValueOnce(null);
        await clickOpen();
        expect(picker.isNodePickerOpen()).toBe(false);
        await clickOpen();
        expect(isShown(dom.dropdown)).toBe(true);
    });

    it('closePicker restores the closed look even when the flag was already cleared', async () => {
        await clickOpen();
        picker.closePicker();
        dom.dropdown.classList.remove('dz-hidden');
        picker.closePicker();
        expect(isShown(dom.dropdown)).toBe(false);
    });

    it('closes on a click outside, but not on a click inside the list', async () => {
        await clickOpen();
        dom.list.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(isShown(dom.dropdown)).toBe(true);
        dom.elsewhere.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(isShown(dom.dropdown)).toBe(false);
    });

    it('closes on window blur, on the app being hidden, and on Escape', async () => {
        await clickOpen();
        window.dispatchEvent(new Event('blur'));
        expect(isShown(dom.dropdown)).toBe(false);

        await clickOpen();
        expect(isShown(dom.dropdown)).toBe(true);
        const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
        vis.mockRestore();
        expect(isShown(dom.dropdown)).toBe(false);

        await clickOpen();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(isShown(dom.dropdown)).toBe(false);
    });

    it('closes when navigation hides the home page', async () => {
        await clickOpen();
        dom.page.classList.add('hidden');
        await vi.advanceTimersByTimeAsync(0); // MutationObserver delivery
        expect(isShown(dom.dropdown)).toBe(false);
        expect(picker.isNodePickerOpen()).toBe(false);
    });

    it('picking the current node only closes the list', async () => {
        const api = await import('../api.js');
        await clickOpen();
        /** @type {any} */ (api.switchProxyResult).mockClear();
        /** @type {any} */ (api.closeAllConnections).mockClear();
        /** @type {any} */ (api.abortLatencyTests).mockClear();
        /** @type {any} */ (api.switchProxyResult).mockResolvedValueOnce({ ok: true, unchanged: true });
        row('HK 02').click();
        await vi.advanceTimersByTimeAsync(0);
        expect(isShown(dom.dropdown)).toBe(false);
        expect(api.switchProxyResult).toHaveBeenCalledWith('Proxy', 'HK 02', expect.objectContaining({ skipIfCurrent: true }));
        expect(api.closeAllConnections).not.toHaveBeenCalled();
        expect(api.abortLatencyTests).not.toHaveBeenCalled();
    });

    it('picking a node closes the list and switches through the API', async () => {
        const api = await import('../api.js');
        await clickOpen();
        const jp = /** @type {HTMLElement} */ (dom.list.querySelector('[data-node="JP 01"]'));
        jp.click();
        expect(isShown(dom.dropdown)).toBe(false);
        await vi.advanceTimersByTimeAsync(0);
        expect(api.switchProxyResult).toHaveBeenCalledWith('Proxy', 'JP 01', expect.anything());
    });

    it('sorts provider members by their merged latency', async () => {
        const api = await import('../api.js');
        /** @type {any} */ (api.getProxiesMerged).mockResolvedValueOnce({ proxies: {
            ...GROUPS.data.proxies,
            'JP 01': { history: [{ delay: 12 }] },
        } });
        await clickOpen();
        expect(dom.list.firstElementChild?.getAttribute('data-node')).toBe('JP 01');
        expect(row('JP 01').textContent).toContain('12 ms');
    });

    it('refuses a stale row after the selected group changes', async () => {
        const state = await import('./state.js');
        const api = await import('../api.js');
        await clickOpen();
        /** @type {any} */ (state.appStore.get).mockImplementation((/** @type {string} */ key) => key === 'uiGroupName' ? 'Other' : null);
        /** @type {any} */ (api.abortLatencyTests).mockClear();
        try {
            row('JP 01').click();
            await vi.advanceTimersByTimeAsync(0);
            expect(api.abortLatencyTests).not.toHaveBeenCalled();
            expect(document.getElementById('current-node-name')?.textContent).toBe('HK 02');
        } finally {
            /** @type {any} */ (state.appStore.get).mockImplementation(() => null);
        }
    });

    it('refuses a row when its selected group has been cleared', async () => {
        const state = await import('./state.js');
        const api = await import('../api.js');
        /** @type {any} */ (state.appStore.get).mockImplementation((/** @type {string} */ key) => key === 'uiGroupName' ? 'Proxy' : null);
        try {
            await clickOpen();
            vi.mocked(state.appStore.get).mockImplementation(() => null);
            vi.mocked(api.abortLatencyTests).mockClear();
            row('JP 01').click();
            await vi.advanceTimersByTimeAsync(0);
            expect(api.abortLatencyTests).not.toHaveBeenCalled();
            expect(document.getElementById('current-node-name')?.textContent).toBe('HK 02');
        } finally {
            vi.mocked(state.appStore.get).mockImplementation(() => null);
        }
    });

    it('restores the old node name and reports an error when the switch fails or throws', async () => {
        const api = await import('../api.js');
        const proxies = await import('./proxies.js');
        const rejected = new Error('busy');
        for (const fail of [() => Promise.resolve({ ok: false, reason: rejected }), () => Promise.reject(new Error('boom'))]) {
            /** @type {any} */ (api.switchProxyResult).mockImplementationOnce(fail);
            await clickOpen();
            const jp = /** @type {HTMLElement} */ (dom.list.querySelector('[data-node="JP 01"]'));
            jp.click();
            await vi.advanceTimersByTimeAsync(0);
            expect(document.getElementById('current-node-name')?.textContent).toBe('HK 02');
        }
        // Same titled toast as the proxies page; a thrown error carries its reason.
        expect(proxies.notifySwitchFailed).toHaveBeenCalledTimes(2);
        expect(proxies.notifySwitchFailed).toHaveBeenNthCalledWith(1, rejected, false, expect.any(Function));
        expect(/** @type {any} */ (proxies.notifySwitchFailed).mock.calls[1][0]).toBeInstanceOf(Error);
    });

    it('saves an older accepted switch when the newer click fails, and reports only the newer one', async () => {
        const api = await import('../api.js');
        const proxies = await import('./proxies.js');
        const memory = await import('./proxy-memory.js');
        const running = await import('./running-profile.js');
        /** @type {any} */ (running.readRunningProfile).mockResolvedValue('sub');
        /** @type {(v: any) => void} */
        let resolveA = () => {};
        /** @type {(e: any) => void} */
        let rejectB = () => {};
        /** @type {any} */ (api.switchProxyResult)
            .mockImplementationOnce(() => new Promise((r) => { resolveA = r; }))
            .mockImplementationOnce(() => new Promise((_, j) => { rejectB = j; }));
        /** @param {string} name */
        const pick = async (name) => {
            await clickOpen();
            /** @type {HTMLElement} */ (dom.list.querySelector(`[data-node="${name}"]`)).click();
            await vi.advanceTimersByTimeAsync(0);
        };
        await pick('JP 01');
        await pick('HK 01');
        const boom = new Error('boom');
        rejectB(boom);
        await vi.advanceTimersByTimeAsync(0);
        const syncsBeforeA = /** @type {any} */ (proxies.syncCoreConfig).mock.calls.length;
        resolveA({ ok: true, reason: null, prepared: 'sub' });
        await vi.advanceTimersByTimeAsync(3000);
        // The failed newer click's resync may have read the core before A landed: A redraws.
        expect(/** @type {any} */ (proxies.syncCoreConfig).mock.calls.length).toBeGreaterThan(syncsBeforeA);
        expect(memory.saveProxySelection).toHaveBeenCalledTimes(1);
        expect(memory.saveProxySelection).toHaveBeenCalledWith('sub', { node: 'JP 01', group: 'Proxy' });
        expect(proxies.notifySwitchFailed).toHaveBeenCalledTimes(1);
        expect(proxies.notifySwitchFailed).toHaveBeenCalledWith(boom, false, expect.any(Function));
    });

    it('a network change that began after the click drops the switch unsent and leaves the list idle', async () => {
        const api = await import('../api.js');
        const state = await import('./state.js');
        const memory = await import('./proxy-memory.js');
        const notes = await import('./notifications.js');
        await clickOpen();
        /** @type {any} */ (api.switchProxyResult).mockClear();
        const realQueue = /** @type {any} */ (api.switchProxyResult).getMockImplementation();
        // The change begins once the click is queued, before its turn.
        /** @type {any} */ (api.switchProxyResult).mockImplementationOnce((/** @type {any[]} */ ...args) => {
            /** @type {any} */ (state.appStore.get).mockImplementation((/** @type {string} */ k) => (k === 'isNetworkUpdating' ? true : null));
            return realQueue(...args);
        });
        try {
            /** @type {HTMLElement} */ (dom.list.querySelector('[data-node="JP 01"]')).click();
            await vi.advanceTimersByTimeAsync(3000);
            expect(api.switchProxyResult).toHaveBeenCalledTimes(1);
            expect(memory.saveProxySelection).not.toHaveBeenCalled();
            expect(notes.showNotification).toHaveBeenCalledWith('consoleSubUpdateBusy', 'info');
            // The label is back on the node the core runs, not "switching".
            expect(document.getElementById('current-node-name')?.textContent).toBe('HK 02');
        } finally {
            /** @type {any} */ (state.appStore.get).mockImplementation(() => null);
        }
    });

    it('re-reads an older ambiguous switch after a later group switch was refused', async () => {
        const api = await import('../api.js');
        const proxies = await import('./proxies.js');
        const first = deferred();
        const second = deferred();
        /** @type {any} */ (api.switchProxyResult)
            .mockReturnValueOnce(first.promise)
            .mockReturnValueOnce(second.promise);
        await clickOpen();
        row('JP 01').click();
        fetchProxyGroups.mockResolvedValue({ ...GROUPS, mainGroup: 'Other', uiGroupName: 'Other' });
        await clickOpen();
        row('HK 01').click();
        second.resolve({ ok: false, reason: new Error('refused'), maybeApplied: false });
        await vi.advanceTimersByTimeAsync(0);
        const reads = /** @type {any} */ (proxies.syncCoreConfig).mock.calls.length;
        const notices = /** @type {any} */ (proxies.notifySwitchFailed).mock.calls.length;
        first.resolve({ ok: false, reason: new Error('no response'), maybeApplied: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(/** @type {any} */ (proxies.syncCoreConfig).mock.calls.length).toBeGreaterThan(reads);
        expect(/** @type {any} */ (proxies.notifySwitchFailed).mock.calls.length).toBe(notices);
    });

    it('does not save its node when the core took a newer switch than its own', async () => {
        const api = await import('../api.js');
        const memory = await import('./proxy-memory.js');
        const running = await import('./running-profile.js');
        /** @type {any} */ (running.readRunningProfile).mockResolvedValue('sub');
        // A node card's switch, taken by the core after this one, is the latest.
        /** @type {any} */ (api.isLatestSwitch).mockReturnValue(false);
        try {
            await clickOpen();
            /** @type {HTMLElement} */ (dom.list.querySelector('[data-node="JP 01"]')).click();
            await vi.advanceTimersByTimeAsync(3000);
            expect(api.switchProxyResult).toHaveBeenCalledWith('Proxy', 'JP 01', expect.anything());
            // Asked about its own switch, by the number the queue gave it.
            expect(api.isLatestSwitch).toHaveBeenCalledWith('Proxy', 1);
            expect(memory.saveProxySelection).not.toHaveBeenCalled();
        } finally {
            /** @type {any} */ (api.isLatestSwitch).mockReturnValue(true);
        }
    });

    it('is keyboard operable: Enter opens on the current node, arrows move, Enter picks, Escape returns focus', async () => {
        const api = await import('../api.js');
        dom.trigger.focus();
        dom.trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
        await vi.advanceTimersByTimeAsync(0);
        expect(isShown(dom.dropdown)).toBe(true);
        expect(document.activeElement).toBe(row('HK 02'));
        // Fastest first by the figure each row shows; the unmeasured one last.
        expect(Array.from(dom.list.querySelectorAll('[data-node]'), (r) => /** @type {HTMLElement} */ (r).dataset.node)).toEqual(['HK 02', 'HK 01', 'JP 01']);

        dom.list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        expect(document.activeElement).toBe(row('HK 01'));
        dom.list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
        expect(document.activeElement).toBe(row('HK 02'));

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(isShown(dom.dropdown)).toBe(false);
        expect(document.activeElement).toBe(dom.trigger);

        // An arrow key on the bar opens it too; Enter picks the focused row.
        dom.trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
        await vi.advanceTimersByTimeAsync(0);
        expect(isShown(dom.dropdown)).toBe(true);
        dom.list.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
        dom.list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await vi.advanceTimersByTimeAsync(0);
        expect(isShown(dom.dropdown)).toBe(false);
        expect(api.switchProxyResult).toHaveBeenCalledWith('Proxy', 'JP 01', expect.anything());
    });

    it('moves keyboard focus to the loading hint when the group has no nodes yet', async () => {
        fetchProxyGroups.mockResolvedValue({ ...GROUPS, proxies: [], providerLoading: true });
        dom.trigger.focus();
        dom.trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
        await vi.advanceTimersByTimeAsync(0);
        expect(isShown(dom.dropdown)).toBe(true);
        expect(document.activeElement?.textContent).toBe('loadingNodes');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(isShown(dom.dropdown)).toBe(false);
        expect(document.activeElement).toBe(dom.trigger);
    });

    it('shows an empty group immediately without polling when no provider is loading', async () => {
        fetchProxyGroups.mockResolvedValue({ ...GROUPS, proxies: [], providerLoading: false });
        await clickOpen();
        expect(dom.list.querySelector('[data-picker-hint]')?.textContent).toBe('noNodesYet');
        await vi.advanceTimersByTimeAsync(8000);
        expect(fetchProxyGroups).toHaveBeenCalledTimes(1);
    });

    it('keeps loading while the provider has not delivered its nodes (DIRECT alone)', async () => {
        fetchProxyGroups.mockResolvedValue({ ...GROUPS, proxies: ['DIRECT'], providerLoading: true });
        dom.trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(0);
        expect(isShown(dom.dropdown)).toBe(true);
        expect(dom.list.querySelector('[data-picker-hint]')?.textContent).toBe('loadingNodes');
        fetchProxyGroups.mockResolvedValue(GROUPS);
        await vi.advanceTimersByTimeAsync(1600);
        expect(dom.list.querySelector('[data-picker-hint]')).toBeNull();
        expect(dom.list.querySelectorAll('[data-node]').length).toBe(GROUPS.proxies.length);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    it('keeps initial members when every provider retry fails', async () => {
        fetchProxyGroups.mockResolvedValueOnce({ ...GROUPS, proxies: ['DIRECT'], providerLoading: true });
        await clickOpen();
        fetchProxyGroups.mockRejectedValue(new Error('provider unavailable'));
        await vi.advanceTimersByTimeAsync(1600);
        expect(dom.list.querySelector('[data-picker-hint]')?.textContent).toBe('loadingNodes');
        expect(fetchProxyGroups).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(6400);
        expect(fetchProxyGroups).toHaveBeenCalledTimes(6);
        expect(row('DIRECT')).not.toBeNull();
        expect(dom.list.querySelector('[data-picker-hint]')).toBeNull();
    });

    it.each(['restart', 'restore'])('closes old rows on a restart or runtime restoration: %s', async (kind) => {
        const { Bus, Events } = await import('./events.js');
        await clickOpen();
        Bus.emit(kind === 'restart' ? Events.CORE_RESTARTED : Events.CONFIG_UPDATED, { reloaded: false, restoreRuntime: true });
        expect(isShown(dom.dropdown)).toBe(false);
        expect(picker.isNodePickerOpen()).toBe(false);
    });

    it('switchNodeFromHome switches the selected group with the same bookkeeping', async () => {
        const api = await import('../api.js');
        const state = await import('./state.js');
        /** @type {any} */ (state.appStore.get).mockImplementation((/** @type {string} */ k) => (k === 'uiGroupName' ? 'Proxy' : null));
        try {
            picker.switchNodeFromHome('JP 01');
            await vi.advanceTimersByTimeAsync(0);
            expect(api.switchProxyResult).toHaveBeenCalledWith('Proxy', 'JP 01', expect.anything());
        } finally {
            /** @type {any} */ (state.appStore.get).mockImplementation(() => null);
        }
    });
});
