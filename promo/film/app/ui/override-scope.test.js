import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const { overrideScopeInfo } = await import('./plugins.js');

describe('overrideScopeInfo', () => {
    it('shows profile names without .yaml/.yml, like the scope dialog', () => {
        expect(overrideScopeInfo({ global: false, profileIds: ['home.yaml', 'Work.YML'] }).label).toBe('home, Work');
    });

    it('keeps the two-name limit and the extra count', () => {
        expect(overrideScopeInfo({ global: false, profileIds: ['a.yaml', 'b.yml', 'c.yaml', 'd'] }).label).toBe('a, b +2');
    });

    it('leaves a name with yaml elsewhere in it alone', () => {
        expect(overrideScopeInfo({ global: false, profileIds: ['yaml-sub'] }).label).toBe('yaml-sub');
    });
});
