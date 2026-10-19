import { describe, it, expect, vi } from 'vitest';
import { deriveAutoSwitch, autoSwitchTargets, readAutoSwitchState, applyAutoSwitch, restoreAutoSwitch, shownAutoSwitch } from './auto-switch.js';

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
    return {
        getSmartConfig: vi.fn(async () => ({ enabled: false, latency_weight: 0.5 })),
        saveSmartConfig: vi.fn(async () => {}),
        saveSetting: vi.fn(async () => {}),
        setStore: vi.fn(),
        startAutoTest: vi.fn(),
        stopAutoTest: vi.fn(),
        onChanged: vi.fn(),
        storage: memStorage(),
        root,
        ...over,
    };
}

describe('auto-switch: legacy combinations', () => {
    it('reads on when failover was on', () => {
        expect(deriveAutoSwitch({ failover: true, smart: false, autoTest: false })).toBe(true);
    });
    it('reads on when scheduled tests ran with scoring', () => {
        expect(deriveAutoSwitch({ failover: false, smart: true, autoTest: true })).toBe(true);
    });
    it('reads off for scoring alone or nothing', () => {
        expect(deriveAutoSwitch({ failover: false, smart: true, autoTest: false })).toBe(false);
        expect(deriveAutoSwitch({ failover: false, smart: false, autoTest: true })).toBe(false);
        expect(deriveAutoSwitch({ failover: false, smart: false, autoTest: false })).toBe(false);
    });
    it('writes all three keys the same way', () => {
        expect(autoSwitchTargets(true)).toEqual({ failover: true, smart: true, autoTest: true });
        expect(autoSwitchTargets(false)).toEqual({ failover: false, smart: false, autoTest: false });
    });
});

describe('auto-switch: readAutoSwitchState', () => {
    it('prefers the smart engine config over localStorage', async () => {
        const storage = memStorage({ smartEnabled: 'false', smartAutoTest: 'true' });
        const s = await readAutoSwitchState({ failoverEnabled: false, getSmartConfig: async () => ({ enabled: true }), storage });
        expect(s).toEqual({ failover: false, smart: true, autoTest: true });
    });
    it('falls back to localStorage when the engine is unavailable', async () => {
        const storage = memStorage({ smartEnabled: 'true' });
        const s = await readAutoSwitchState({ failoverEnabled: true, getSmartConfig: async () => { throw new Error('x'); }, storage });
        expect(s).toEqual({ failover: true, smart: true, autoTest: false, smartUnknown: true });
    });
});

describe('auto-switch: applyAutoSwitch', () => {
    it('turns failover, scoring and scheduled tests on together', async () => {
        const d = deps();
        await applyAutoSwitch(true, d);
        expect(d.saveSmartConfig).toHaveBeenCalledWith({ enabled: true, latency_weight: 0.5 });
        expect(d.saveSetting).toHaveBeenCalledWith('failover_enabled', true);
        expect(d.setStore).toHaveBeenCalledWith('failoverEnabled', true);
        expect(d.storage.getItem('smartEnabled')).toBe('true');
        expect(d.storage.getItem('smartAutoTest')).toBe('true');
        expect(d.root.style.getPropertyValue('--smart-enabled')).toBe('1');
        expect(d.startAutoTest).toHaveBeenCalled();
        expect(d.stopAutoTest).not.toHaveBeenCalled();
        expect(d.onChanged).toHaveBeenCalled();
    });

    it('turns all three off together', async () => {
        const d = deps();
        await applyAutoSwitch(false, d);
        expect(d.saveSetting).toHaveBeenCalledWith('failover_enabled', false);
        expect(d.storage.getItem('smartAutoTest')).toBe('false');
        expect(d.root.style.getPropertyValue('--smart-enabled')).toBe('0');
        expect(d.stopAutoTest).toHaveBeenCalled();
    });

    it('turns a disabled failover policy back on, keeping its other values', async () => {
        const setFailoverPolicy = vi.fn(async () => {});
        const d = deps({
            getFailoverPolicy: vi.fn(async () => ({ enabled: false, threshold: 5, cooldownSecs: 120, fallbackGroup: '' })),
            setFailoverPolicy,
        });
        await applyAutoSwitch(true, d);
        expect(setFailoverPolicy).toHaveBeenCalledWith({ enabled: true, threshold: 5, cooldownSecs: 120, fallbackGroup: undefined });
    });

    it('leaves the failover policy alone when it is already on, or when switching off', async () => {
        const setFailoverPolicy = vi.fn(async () => {});
        const getFailoverPolicy = vi.fn(async () => ({ enabled: true, threshold: 3, cooldownSecs: 60, fallbackGroup: 'Auto' }));
        await applyAutoSwitch(true, deps({ getFailoverPolicy, setFailoverPolicy }));
        const offPolicy = vi.fn(async () => ({ enabled: false, threshold: 3, cooldownSecs: 60 }));
        await applyAutoSwitch(false, deps({ getFailoverPolicy: offPolicy, setFailoverPolicy }));
        expect(setFailoverPolicy).not.toHaveBeenCalled();
        expect(offPolicy).not.toHaveBeenCalled();
    });

    it('reports a failover policy that could not be turned on, after writing the rest', async () => {
        const d = deps({
            getFailoverPolicy: vi.fn(async () => ({ enabled: false, threshold: 3, cooldownSecs: 60 })),
            setFailoverPolicy: vi.fn(async () => { throw new Error('policy down'); }),
        });
        await expect(applyAutoSwitch(true, d)).rejects.toThrow('policy down');
        expect(d.storage.getItem('smartAutoTest')).toBe('true');
        expect(d.startAutoTest).toHaveBeenCalled();
    });

    it('turns the failover policy back off when the change it was part of failed', async () => {
        const setFailoverPolicy = vi.fn(async () => {});
        const d = deps({
            saveSetting: vi.fn(async () => { throw new Error('settings down'); }),
            getFailoverPolicy: vi.fn(async () => ({ enabled: false, threshold: 5, cooldownSecs: 120, fallbackGroup: 'Auto' })),
            setFailoverPolicy,
        });
        await expect(applyAutoSwitch(true, d)).rejects.toThrow('settings down');
        expect(setFailoverPolicy.mock.calls).toEqual([
            [{ enabled: true, threshold: 5, cooldownSecs: 120, fallbackGroup: 'Auto' }],
            [{ enabled: false, threshold: 5, cooldownSecs: 120, fallbackGroup: 'Auto' }],
        ]);
    });

    it('does not touch the policy on failure when it was already on', async () => {
        const setFailoverPolicy = vi.fn(async () => {});
        const d = deps({
            saveSetting: vi.fn(async () => { throw new Error('settings down'); }),
            getFailoverPolicy: vi.fn(async () => ({ enabled: true, threshold: 3, cooldownSecs: 60 })),
            setFailoverPolicy,
        });
        await expect(applyAutoSwitch(true, d)).rejects.toThrow('settings down');
        expect(setFailoverPolicy).not.toHaveBeenCalled();
    });

    it('still writes the other keys when the smart engine fails, then reports it', async () => {
        const d = deps({ saveSmartConfig: vi.fn(async () => { throw new Error('engine down'); }) });
        await expect(applyAutoSwitch(true, d)).rejects.toThrow('engine down');
        expect(d.saveSetting).toHaveBeenCalledWith('failover_enabled', true);
        expect(d.storage.getItem('smartAutoTest')).toBe('true');
    });
});

describe('auto-switch: shownAutoSwitch', () => {
    it('shows off while the failover policy is off, even with the keys on', () => {
        expect(shownAutoSwitch(true, { enabled: false })).toBe(false);
    });
    it('follows the keys when the policy is on or unknown', () => {
        expect(shownAutoSwitch(true, { enabled: true })).toBe(true);
        expect(shownAutoSwitch(true, null)).toBe(true);
        expect(shownAutoSwitch(false, { enabled: true })).toBe(false);
        expect(shownAutoSwitch(false, null)).toBe(false);
    });
});

describe('auto-switch: restoreAutoSwitch', () => {
    it('puts a mixed legacy state back key by key', async () => {
        const d = deps({ storage: memStorage({ smartEnabled: 'false', smartAutoTest: 'false' }) });
        await restoreAutoSwitch({ failover: false, smart: true, autoTest: true }, d);
        expect(d.saveSmartConfig).toHaveBeenCalledWith({ enabled: true, latency_weight: 0.5 });
        expect(d.saveSetting).toHaveBeenCalledWith('failover_enabled', false);
        expect(d.setStore).toHaveBeenCalledWith('failoverEnabled', false);
        expect(d.storage.getItem('smartEnabled')).toBe('true');
        expect(d.storage.getItem('smartAutoTest')).toBe('true');
        expect(d.startAutoTest).toHaveBeenCalled();
        expect(d.stopAutoTest).not.toHaveBeenCalled();
    });

    it('leaves the failover policy alone even when failover goes back on', async () => {
        const getFailoverPolicy = vi.fn(async () => ({ enabled: false, threshold: 3 }));
        const setFailoverPolicy = vi.fn(async () => {});
        const d = deps({ getFailoverPolicy, setFailoverPolicy });
        await restoreAutoSwitch({ failover: true, smart: false, autoTest: false }, d);
        expect(d.saveSetting).toHaveBeenCalledWith('failover_enabled', true);
        expect(getFailoverPolicy).not.toHaveBeenCalled();
        expect(setFailoverPolicy).not.toHaveBeenCalled();
        expect(d.stopAutoTest).toHaveBeenCalled();
    });
});
