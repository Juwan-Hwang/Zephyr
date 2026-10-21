import { describe, it, expect, vi } from 'vitest';
import {
    applyFailover, applySmart, applyAutoTest, readSmartEnabled, readAutoTestEnabled,
    shownFailover, smartEnabledOf, queueSmartConfigWrite,
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
        expect(d.storage.getItem('smartEnabled')).toBeNull();
        expect(d.storage.getItem('smartAutoTest')).toBe('true');
        expect(d.startAutoTest).toHaveBeenCalledTimes(1);
    });

    it('a failed "scoring on" leaves scoring off when the engine config said off', async () => {
        const d = deps({
            getSmartConfig: vi.fn(async () => ({ enabled: false })),
            saveSmartConfig: vi.fn(async () => { throw new Error('engine down'); }),
            storage: memStorage({ smartEnabled: 'true' }),
        });
        await expect(applySmart(true, d)).rejects.toThrow('engine down');
        expect(d.root.style.getPropertyValue('--smart-enabled')).toBe('0');
        expect(d.storage.getItem('smartEnabled')).toBe('true');
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
