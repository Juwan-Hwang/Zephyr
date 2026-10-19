import { describe, it, expect, vi } from 'vitest';
import { deriveAutoSwitch, autoSwitchTargets, readAutoSwitchState, applyAutoSwitch } from './auto-switch.js';

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

    it('still writes the other keys when the smart engine fails, then reports it', async () => {
        const d = deps({ saveSmartConfig: vi.fn(async () => { throw new Error('engine down'); }) });
        await expect(applyAutoSwitch(true, d)).rejects.toThrow('engine down');
        expect(d.saveSetting).toHaveBeenCalledWith('failover_enabled', true);
        expect(d.storage.getItem('smartAutoTest')).toBe('true');
    });
});
