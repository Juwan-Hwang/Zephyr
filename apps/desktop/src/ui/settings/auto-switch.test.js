import { describe, it, expect, vi } from 'vitest';
import {
    applyFailover, applySmart, applyAutoTest, readSmartEnabled, readSmartState, readAutoTestEnabled,
    shownFailover, smartEnabledOf, queueSmartConfigWrite, syncSmartShown,
    smartFormErrors,
} from './auto-switch.js';

function memStorage(init = {}) {
    const m = new Map(Object.entries(init));
    return /** @type {Storage} */ (/** @type {unknown} */ ({
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => { m.set(k, String(v)); },
        removeItem: (k) => { m.delete(k); },
        _m: m,
    }));
}

function deps(over = {}) {
    const root = document.createElement('div');
    const store = new Map();
    return {
        getSmartConfig: vi.fn(async () => ({ enabled: false, latency_weight: 0.5 })),
        saveSmartConfig: vi.fn(async () => {}),
        saveSetting: vi.fn(async () => {}),
        setStore: vi.fn((k, v) => { store.set(k, v); }),
        getStore: vi.fn((k) => store.get(k)),
        startAutoTest: vi.fn(),
        stopAutoTest: vi.fn(),
        onChanged: vi.fn(),
        storage: memStorage(),
        root,
        _store: store,
        ...over,
    };
}

describe('switches are independent', () => {
    it('turns failover on in the store only once it is saved', async () => {
        /** @type {(v?: any) => void} */
        let release = () => {};
        const d = deps({ saveSetting: vi.fn(() => new Promise((r) => { release = r; })) });
        d._store.set('failoverEnabled', false);
        const p = applyFailover(true, d);
        await new Promise((r) => setTimeout(r, 0));
        expect(d._store.get('failoverEnabled')).toBe(false);
        release();
        await p;
        expect(d._store.get('failoverEnabled')).toBe(true);
    });
    it('failover writes only the failover setting', async () => {
        const d = deps({ storage: memStorage({ smartEnabled: 'true', smartAutoTest: 'true' }) });
        await applyFailover(true, d);
        expect(d.saveSetting).toHaveBeenCalledWith('failover_enabled', true);
        expect(d._store.get('failoverEnabled')).toBe(true);
        expect(d.saveSmartConfig).not.toHaveBeenCalled();
        expect(d.startAutoTest).not.toHaveBeenCalled();
        expect(d.stopAutoTest).not.toHaveBeenCalled();
        expect(d.storage.getItem('smartEnabled')).toBe('true');
        expect(d.storage.getItem('smartAutoTest')).toBe('true');

        await applyFailover(false, d);
        expect(d.saveSetting).toHaveBeenLastCalledWith('failover_enabled', false);
        expect(d.saveSmartConfig).not.toHaveBeenCalled();
        expect(d.storage.getItem('smartAutoTest')).toBe('true');
    });

    it('scoring writes only the smart engine (and keeps the rest of its config)', async () => {
        const d = deps();
        await applySmart(true, d);
        expect(d.saveSmartConfig).toHaveBeenCalledWith({ enabled: true, latency_weight: 0.5 });
        expect(d.storage.getItem('smartEnabled')).toBe('true');
        expect(d.root.style.getPropertyValue('--smart-enabled')).toBe('1');
        expect(d.saveSetting).not.toHaveBeenCalled();
        expect(d.setStore).not.toHaveBeenCalled();
        // Turning scoring on does not start scheduled tests by itself.
        expect(d.startAutoTest).not.toHaveBeenCalled();
        expect(d.onChanged).toHaveBeenCalled();
    });

    it('scoring on starts scheduled tests that were left on without a timer', async () => {
        const d = deps({ storage: memStorage({ smartEnabled: 'false', smartAutoTest: 'true' }) });
        await applySmart(true, d);
        expect(d.startAutoTest).toHaveBeenCalledTimes(1);
        // Already on: the running scheduler is left alone.
        const on = deps({ getSmartConfig: vi.fn(async () => ({ enabled: true })), storage: memStorage({ smartEnabled: 'true', smartAutoTest: 'true' }) });
        on.root.style.setProperty('--smart-enabled', '1');
        await applySmart(true, on);
        expect(on.startAutoTest).not.toHaveBeenCalled();
    });

    it('scoring on starts scheduled tests when it only showed off (the engine had it on)', async () => {
        // Startup couldn't read the engine: scoring showed off and no timer started.
        const d = deps({ getSmartConfig: vi.fn(async () => ({ enabled: true })), storage: memStorage({ smartEnabled: 'false', smartAutoTest: 'true' }) });
        d.root.style.setProperty('--smart-enabled', '0');
        await applySmart(true, d);
        expect(d.startAutoTest).toHaveBeenCalledTimes(1);
    });

    it('scoring off stops scheduled tests, which only feed the scores', async () => {
        const d = deps({ storage: memStorage({ smartEnabled: 'true', smartAutoTest: 'true' }) });
        await applySmart(false, d);
        expect(d.saveSmartConfig).toHaveBeenCalledWith({ enabled: false, latency_weight: 0.5 });
        expect(d.storage.getItem('smartAutoTest')).toBe('false');
        expect(d.stopAutoTest).toHaveBeenCalled();
        expect(d.root.style.getPropertyValue('--smart-enabled')).toBe('0');
        expect(d.saveSetting).not.toHaveBeenCalled();
    });

    it('scheduled tests start and stop on their own', async () => {
        const d = deps();
        d.root.style.setProperty('--smart-enabled', '1');
        await applyAutoTest(true, d);
        expect(d.storage.getItem('smartAutoTest')).toBe('true');
        expect(d.startAutoTest).toHaveBeenCalledTimes(1);
        await applyAutoTest(false, d);
        expect(d.storage.getItem('smartAutoTest')).toBe('false');
        expect(d.stopAutoTest).toHaveBeenCalledTimes(1);
        expect(d.saveSmartConfig).not.toHaveBeenCalled();
        expect(d.saveSetting).not.toHaveBeenCalled();
    });

    it('keeps a scheduled-test choice made before scoring was read', async () => {
        const d = deps();
        await applyAutoTest(true, d);
        expect(d.storage.getItem('smartAutoTest')).toBe('true');
        d.root.style.setProperty('--smart-enabled', '0');
        await applyAutoTest(true, d);
        expect(d.storage.getItem('smartAutoTest')).toBe('false');
    });
});

describe('failures go back', () => {
    it('a failed failover save puts the store back and rejects', async () => {
        const d = deps({ saveSetting: vi.fn(async () => { throw new Error('settings down'); }) });
        d._store.set('failoverEnabled', false);
        await expect(applyFailover(true, d)).rejects.toThrow('settings down');
        expect(d._store.get('failoverEnabled')).toBe(false);
    });

    it('a failed scoring save puts scoring back and rejects', async () => {
        const d = deps({
            saveSmartConfig: vi.fn(async () => { throw new Error('engine down'); }),
            storage: memStorage({ smartEnabled: 'false' }),
        });
        d.root.style.setProperty('--smart-enabled', '0');
        await expect(applySmart(true, d)).rejects.toThrow('engine down');
        expect(d.storage.getItem('smartEnabled')).toBe('false');
        expect(d.root.style.getPropertyValue('--smart-enabled')).toBe('0');
    });

    it('a failed "scoring off" also restarts the scheduled tests it stopped', async () => {
        const d = deps({
            getSmartConfig: vi.fn(async () => ({ enabled: true })),
            saveSmartConfig: vi.fn(async () => { throw new Error('engine down'); }),
            storage: memStorage({ smartEnabled: 'true', smartAutoTest: 'true' }),
        });
        await expect(applySmart(false, d)).rejects.toThrow('engine down');
        expect(d.storage.getItem('smartEnabled')).toBe('true');
        expect(d.storage.getItem('smartAutoTest')).toBe('true');
        expect(d.stopAutoTest).toHaveBeenCalledTimes(1);
        expect(d.startAutoTest).toHaveBeenCalledTimes(1);
        expect(d.root.style.getPropertyValue('--smart-enabled')).toBe('1');
    });

    it('a failed "scoring off" restores what the engine config said, not a stale fallback', async () => {
        // The switch showed on from the engine config; localStorage had no value.
        const d = deps({
            getSmartConfig: vi.fn(async () => ({ enabled: true })),
            saveSmartConfig: vi.fn(async () => { throw new Error('engine down'); }),
            storage: memStorage({ smartAutoTest: 'true' }),
        });
        d.root.style.setProperty('--smart-enabled', '1');
        await expect(applySmart(false, d)).rejects.toThrow('engine down');
        expect(d.root.style.getPropertyValue('--smart-enabled')).toBe('1');
        // The fallback now follows the engine, for a later read that fails.
        expect(d.storage.getItem('smartEnabled')).toBe('true');
        expect(d.storage.getItem('smartAutoTest')).toBe('true');
        expect(d.startAutoTest).toHaveBeenCalledTimes(1);
    });

    it('a failed "scoring off" with an unreadable engine puts back what was shown', async () => {
        // Shown on from the engine at startup; localStorage never said so.
        const d = deps({
            getSmartConfig: vi.fn(async () => { throw new Error('engine down'); }),
            storage: memStorage({ smartAutoTest: 'true' }),
        });
        d.root.style.setProperty('--smart-enabled', '1');
        await expect(applySmart(false, d)).rejects.toThrow('engine down');
        expect(d.root.style.getPropertyValue('--smart-enabled')).toBe('1');
        expect(d.storage.getItem('smartEnabled')).toBeNull();
        expect(d.storage.getItem('smartAutoTest')).toBe('true');
        expect(d.startAutoTest).toHaveBeenCalledTimes(1);
        expect(d.saveSmartConfig).not.toHaveBeenCalled();
    });

    it('a failed "scoring on" leaves scoring off when the engine config said off', async () => {
        const d = deps({
            getSmartConfig: vi.fn(async () => ({ enabled: false })),
            saveSmartConfig: vi.fn(async () => { throw new Error('engine down'); }),
            storage: memStorage({ smartEnabled: 'true' }),
        });
        await expect(applySmart(true, d)).rejects.toThrow('engine down');
        expect(d.root.style.getPropertyValue('--smart-enabled')).toBe('0');
        // The stale fallback is corrected to what the engine said.
        expect(d.storage.getItem('smartEnabled')).toBe('false');
    });

    it('scheduled tests queued behind a failed "scoring on" stay off', async () => {
        const d = deps({
            saveSmartConfig: vi.fn(async () => { throw new Error('engine down'); }),
            storage: memStorage({ smartEnabled: 'false' }),
        });
        d.root.style.setProperty('--smart-enabled', '0');
        const smart = applySmart(true, d);
        const test = applyAutoTest(true, d);
        await expect(smart).rejects.toThrow('engine down');
        await test;
        expect(d.storage.getItem('smartAutoTest')).toBe('false');
        expect(d.startAutoTest).not.toHaveBeenCalled();
        expect(d.stopAutoTest).toHaveBeenCalled();
    });

    it('an unreadable smart config is reported instead of saving a guessed one', async () => {
        const d = deps({ getSmartConfig: vi.fn(async () => { throw new Error('no engine'); }) });
        await expect(applySmart(true, d)).rejects.toThrow('no engine');
        expect(d.saveSmartConfig).not.toHaveBeenCalled();
        expect(d.storage.getItem('smartEnabled')).toBeNull();
    });
});

describe('failover policy', () => {
    it('turning failover on turns a disabled policy back on, keeping its other values', async () => {
        const setFailoverPolicy = vi.fn(async () => {});
        const d = deps({
            getFailoverPolicy: vi.fn(async () => ({ enabled: false, threshold: 5, cooldownSecs: 120, fallbackGroup: '' })),
            setFailoverPolicy,
        });
        await applyFailover(true, d);
        expect(setFailoverPolicy).toHaveBeenCalledWith({ enabled: true, threshold: 5, cooldownSecs: 120, fallbackGroup: undefined });
    });

    it('leaves the policy alone when it is already on, or when switching off', async () => {
        const setFailoverPolicy = vi.fn(async () => {});
        const getFailoverPolicy = vi.fn(async () => ({ enabled: true, threshold: 3, cooldownSecs: 60, fallbackGroup: 'Auto' }));
        await applyFailover(true, deps({ getFailoverPolicy, setFailoverPolicy }));
        const offPolicy = vi.fn(async () => ({ enabled: false, threshold: 3, cooldownSecs: 60 }));
        await applyFailover(false, deps({ getFailoverPolicy: offPolicy, setFailoverPolicy }));
        expect(setFailoverPolicy).not.toHaveBeenCalled();
        expect(offPolicy).not.toHaveBeenCalled();
    });

    it('a policy that cannot be turned on undoes the setting and rejects', async () => {
        const d = deps({
            getFailoverPolicy: vi.fn(async () => ({ enabled: false, threshold: 3, cooldownSecs: 60 })),
            setFailoverPolicy: vi.fn(async () => { throw new Error('policy down'); }),
        });
        d._store.set('failoverEnabled', false);
        await expect(applyFailover(true, d)).rejects.toThrow('policy down');
        expect(d._store.get('failoverEnabled')).toBe(false);
        expect(d.saveSetting.mock.calls).toEqual([['failover_enabled', true], ['failover_enabled', false]]);
    });

    it('keeps the store matching the saved setting when undoing it fails too', async () => {
        const onRollbackFailed = vi.fn();
        const d = deps({
            getFailoverPolicy: vi.fn(async () => ({ enabled: false, threshold: 3, cooldownSecs: 60 })),
            setFailoverPolicy: vi.fn(async () => { throw new Error('policy down'); }),
            saveSetting: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('disk')),
            onRollbackFailed,
        });
        d._store.set('failoverEnabled', false);
        await expect(applyFailover(true, d)).rejects.toThrow('policy down');
        expect(d._store.get('failoverEnabled')).toBe(true);
        expect(onRollbackFailed).toHaveBeenCalledOnce();
        expect(shownFailover(true, { enabled: false })).toBe(false);
    });

    it('a policy that cannot be read undoes the setting and rejects', async () => {
        const setFailoverPolicy = vi.fn(async () => {});
        const d = deps({ getFailoverPolicy: vi.fn(async () => { throw new Error('prism down'); }), setFailoverPolicy });
        d._store.set('failoverEnabled', false);
        await expect(applyFailover(true, d)).rejects.toThrow('prism down');
        expect(d._store.get('failoverEnabled')).toBe(false);
        expect(d.saveSetting.mock.calls).toEqual([['failover_enabled', true], ['failover_enabled', false]]);
        expect(setFailoverPolicy).not.toHaveBeenCalled();
    });

    it('a failed setting save never touches the policy', async () => {
        const setFailoverPolicy = vi.fn(async () => {});
        const getFailoverPolicy = vi.fn(async () => ({ enabled: false, threshold: 3, cooldownSecs: 60 }));
        const d = deps({ saveSetting: vi.fn(async () => { throw new Error('settings down'); }), getFailoverPolicy, setFailoverPolicy });
        await expect(applyFailover(true, d)).rejects.toThrow('settings down');
        expect(getFailoverPolicy).not.toHaveBeenCalled();
        expect(setFailoverPolicy).not.toHaveBeenCalled();
    });

    it('shows off while the policy is off, otherwise follows the setting', () => {
        expect(shownFailover(true, { enabled: false })).toBe(false);
        expect(shownFailover(true, { enabled: true })).toBe(true);
        expect(shownFailover(true, null)).toBe(true);
        expect(shownFailover(false, { enabled: true })).toBe(false);
        expect(shownFailover(false, null)).toBe(false);
    });
});

describe('reading state', () => {
    it('prefers the smart engine config over localStorage', async () => {
        const storage = memStorage({ smartEnabled: 'false' });
        expect(await readSmartEnabled({ getSmartConfig: async () => ({ enabled: true }), storage })).toBe(true);
    });
    it('falls back to localStorage when the engine is unavailable or has no enabled line', async () => {
        const storage = memStorage({ smartEnabled: 'true' });
        expect(await readSmartEnabled({ getSmartConfig: async () => { throw new Error('x'); }, storage })).toBe(true);
        expect(await readSmartEnabled({ getSmartConfig: async () => ({}), storage })).toBe(true);
        expect(smartEnabledOf({ enabled: false }, storage)).toBe(false);
    });
    it('says whether scoring was read from the engine or guessed', async () => {
        const storage = memStorage({ smartEnabled: 'false' });
        expect(await readSmartState({ getSmartConfig: async () => { throw new Error('x'); }, storage })).toEqual({ enabled: false, known: false });
        expect(await readSmartState({ getSmartConfig: async () => ({}), storage })).toEqual({ enabled: false, known: false });
        expect(await readSmartState({ getSmartConfig: async () => ({ enabled: true }), storage })).toEqual({ enabled: true, known: true });
    });
    it('answers a later failed read with what the engine said at startup', async () => {
        const storage = memStorage({ smartEnabled: 'false' });
        await readSmartState({ getSmartConfig: async () => ({ enabled: true }), storage });
        expect(storage.getItem('smartEnabled')).toBe('true');
        const root = document.createElement('div');
        const r = await syncSmartShown({
            getSmartConfig: async () => { throw new Error('down'); },
            startAutoTest: () => {}, stopAutoTest: () => {}, storage, root,
        });
        expect(r.on).toBe(true);
    });
    it('reads scheduled tests from localStorage', () => {
        expect(readAutoTestEnabled(memStorage({ smartAutoTest: 'true' }))).toBe(true);
        expect(readAutoTestEnabled(memStorage())).toBe(false);
    });
});

describe('one queue', () => {
    it('applies changes in the order they were made, even when an earlier one is slow', async () => {
        /** @type {string[]} */
        const order = [];
        let release = () => {};
        const slow = new Promise((r) => { release = () => r(undefined); });
        const d = deps({
            saveSmartConfig: vi.fn(async (cfg) => { if (cfg.enabled) await slow; order.push(`smart:${cfg.enabled}`); }),
            saveSetting: vi.fn(async (_k, v) => { order.push(`failover:${v}`); }),
        });
        const a = applySmart(true, d);
        const b = applyFailover(true, d);
        const c = applySmart(false, d);
        const other = queueSmartConfigWrite(async () => { order.push('dialog'); });
        // Let the first save start and park on `slow` before releasing it.
        await new Promise((r) => setTimeout(r, 0));
        expect(order).toEqual([]);
        expect(d.saveSetting).not.toHaveBeenCalled();
        release();
        await Promise.all([a, b, c, other]);
        expect(order).toEqual(['smart:true', 'failover:true', 'smart:false', 'dialog']);
        expect(d.storage.getItem('smartEnabled')).toBe('false');
    });

    it('a failed change does not block the next one', async () => {
        const d = deps({ saveSetting: vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue(undefined) });
        await expect(applyFailover(true, d)).rejects.toThrow('x');
        await applyFailover(true, d);
        expect(d._store.get('failoverEnabled')).toBe(true);
    });
});

describe('syncing scoring from the engine', () => {
    const opts = (/** @type {any} */ over = {}) => ({
        getSmartConfig: vi.fn(async () => ({ enabled: true })),
        startAutoTest: vi.fn(),
        stopAutoTest: vi.fn(),
        storage: memStorage(),
        root: document.createElement('div'),
        ...over,
    });

    it('keeps what the engine said when the fallback cache cannot be written', async () => {
        const storage = memStorage({ smartEnabled: 'false' });
        storage.setItem = () => { throw new Error('QuotaExceededError'); };
        const o = opts({ storage });
        const r = await syncSmartShown(o);
        expect(r).toEqual({ on: true, changed: true, fromEngine: true });
        expect(o.root.style.getPropertyValue('--smart-enabled')).toBe('1');
    });

    it('a later failed read keeps the engine value, not the stale cache it could not write', async () => {
        const storage = memStorage({ smartEnabled: 'false' });
        storage.setItem = () => { throw new Error('QuotaExceededError'); };
        const o = opts({ storage });
        await syncSmartShown(o);
        o.getSmartConfig = vi.fn(async () => { throw new Error('down'); });
        const r = await syncSmartShown(o);
        expect(r).toEqual({ on: true, changed: false, fromEngine: false });
        expect(o.root.style.getPropertyValue('--smart-enabled')).toBe('1');
    });

    it('a failed read after scoring was turned on keeps it on', async () => {
        const storage = memStorage({ smartEnabled: 'false' });
        const root = document.createElement('div');
        const o = opts({ storage, root, getSmartConfig: vi.fn(async () => ({ enabled: false })) });
        await syncSmartShown(o);
        // Storage that can't be written keeps the old fallback.
        storage.setItem = () => { throw new Error('QuotaExceededError'); };
        await applySmart(true, deps({ storage, root, getSmartConfig: vi.fn(async () => ({ enabled: false })) }));
        o.getSmartConfig = vi.fn(async () => { throw new Error('down'); });
        const r = await syncSmartShown(o);
        expect(r.on).toBe(true);
        expect(root.style.getPropertyValue('--smart-enabled')).toBe('1');
    });

    it('turns scheduled tests off when the engine turned scoring off', async () => {
        const o = opts({ getSmartConfig: vi.fn(async () => ({ enabled: false })), storage: memStorage({ smartEnabled: 'true', smartAutoTest: 'true' }) });
        o.root.style.setProperty('--smart-enabled', '1');
        const r = await syncSmartShown(o);
        expect(r).toEqual({ on: false, changed: true, fromEngine: true });
        expect(o.stopAutoTest).toHaveBeenCalledTimes(1);
        expect(o.storage.getItem('smartAutoTest')).toBe('false');
        expect(o.storage.getItem('smartEnabled')).toBe('false');
    });

    it('leaves scheduled tests alone when "off" is only a guess from a failed read', async () => {
        const o = opts({ getSmartConfig: vi.fn(async () => { throw new Error('down'); }), storage: memStorage({ smartEnabled: 'false', smartAutoTest: 'true' }) });
        o.root.style.setProperty('--smart-enabled', '1');
        const r = await syncSmartShown(o);
        expect(r).toEqual({ on: false, changed: true, fromEngine: false });
        expect(o.stopAutoTest).not.toHaveBeenCalled();
        expect(o.storage.getItem('smartAutoTest')).toBe('true');
    });

    it('starts scheduled tests left on when scoring comes on', async () => {
        const o = opts({ storage: memStorage({ smartAutoTest: 'true' }) });
        o.root.style.setProperty('--smart-enabled', '0');
        expect((await syncSmartShown(o)).changed).toBe(true);
        expect(o.startAutoTest).toHaveBeenCalledTimes(1);
        // No change: nothing starts or stops.
        expect((await syncSmartShown(o)).changed).toBe(false);
        expect(o.startAutoTest).toHaveBeenCalledTimes(1);
    });

    it('turns scheduled tests off when the engine confirms the "off" a failed read had guessed', async () => {
        const o = opts({ getSmartConfig: vi.fn(async () => ({ enabled: false })), storage: memStorage({ smartEnabled: 'false', smartAutoTest: 'true' }) });
        o.root.style.setProperty('--smart-enabled', '0');
        const r = await syncSmartShown(o);
        expect(r).toEqual({ on: false, changed: false, fromEngine: true });
        expect(o.stopAutoTest).toHaveBeenCalledTimes(1);
        expect(o.storage.getItem('smartAutoTest')).toBe('false');
        // Already off: nothing more to stop.
        await syncSmartShown(o);
        expect(o.stopAutoTest).toHaveBeenCalledTimes(1);
    });
});

describe('storage that cannot be written', () => {
    it('still saves scoring to the engine', async () => {
        const d = deps();
        d.storage.setItem = () => { throw new Error('QuotaExceededError'); };
        d.root.style.setProperty('--smart-enabled', '0');
        await applySmart(true, d);
        expect(d.saveSmartConfig).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
        expect(d.root.style.getPropertyValue('--smart-enabled')).toBe('1');
    });

    it('still stops scheduled tests and rolls back a failed save', async () => {
        const d = deps({ getSmartConfig: vi.fn(async () => ({ enabled: true })), saveSmartConfig: vi.fn(async () => { throw new Error('io'); }) });
        d.storage.setItem = () => { throw new Error('QuotaExceededError'); };
        d.root.style.setProperty('--smart-enabled', '1');
        await expect(applySmart(false, d)).rejects.toThrow('io');
        expect(d.stopAutoTest).toHaveBeenCalled();
        expect(d.root.style.getPropertyValue('--smart-enabled')).toBe('1');
    });
});

describe('scheduled tests when storage refuses the preference', () => {
    it('keep the switched value in memory, so the scheduler still runs', async () => {
        const d = deps({ storage: memStorage({ smartEnabled: 'true', smartAutoTest: 'false' }) });
        d.storage.setItem = () => { throw new Error('QuotaExceededError'); };
        d.root.style.setProperty('--smart-enabled', '1');
        await applyAutoTest(true, d);
        expect(d.startAutoTest).toHaveBeenCalled();
        expect(readAutoTestEnabled(d.storage)).toBe(true);
        await applyAutoTest(false, d);
        expect(readAutoTestEnabled(d.storage)).toBe(false);
    });
});

describe('a failed "scoring on" whose rollback shows scoring on', () => {
    it('starts scheduled tests that were left without a timer', async () => {
        // Startup could not read scoring (shown off); the engine has it on, the save fails.
        const d = deps({
            storage: memStorage({ smartAutoTest: 'true' }),
            getSmartConfig: vi.fn(async () => ({ enabled: true })),
            saveSmartConfig: vi.fn(async () => { throw new Error('io'); }),
        });
        d.root.style.setProperty('--smart-enabled', '0');
        await expect(applySmart(true, d)).rejects.toThrow('io');
        expect(d.root.style.getPropertyValue('--smart-enabled')).toBe('1');
        expect(d.startAutoTest).toHaveBeenCalled();
    });

    it('leaves them alone when the rollback shows scoring off', async () => {
        const d = deps({
            storage: memStorage({ smartAutoTest: 'true' }),
            saveSmartConfig: vi.fn(async () => { throw new Error('io'); }),
        });
        d.root.style.setProperty('--smart-enabled', '0');
        await expect(applySmart(true, d)).rejects.toThrow('io');
        expect(d.startAutoTest).not.toHaveBeenCalled();
    });
});

describe('failed scoring-off save with the engine unread', () => {
    it('keeps scheduled tests on without starting them while scoring shows off', async () => {
        const d = deps({
            getSmartConfig: vi.fn(async () => { throw new Error('down'); }),
            storage: memStorage({ smartEnabled: 'false', smartAutoTest: 'true' }),
        });
        d.root.style.setProperty('--smart-enabled', '0');
        await expect(applySmart(false, d)).rejects.toThrow('down');
        expect(d.storage.getItem('smartAutoTest')).toBe('true');
        expect(d.startAutoTest).not.toHaveBeenCalled();
        expect(d.root.style.getPropertyValue('--smart-enabled')).toBe('0');
    });
});

describe('smartFormErrors', () => {
    const ok = { latency_p90: 0.4, success_rate: 0.4, stability: 0.2, half_life_hours: 1, base_interval_secs: 300 };
    it('accepts the defaults', () => {
        expect(smartFormErrors(ok)).toEqual([]);
    });
    it('rejects weights that do not sum to 1, negative weights and non-positive times', () => {
        expect(smartFormErrors({ ...ok, stability: 0.5 }).join()).toContain('sum');
        expect(smartFormErrors({ ...ok, latency_p90: -0.1, success_rate: 0.9 }).join()).toContain('>= 0');
        expect(smartFormErrors({ ...ok, half_life_hours: 0 }).join()).toContain('half-life');
        expect(smartFormErrors({ ...ok, base_interval_secs: 0 }).join()).toContain('base interval');
    });
});
