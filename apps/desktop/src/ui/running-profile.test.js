import { describe, it, expect, vi, beforeEach } from 'vitest';

const invoke = vi.fn();
vi.mock('../api.js', () => ({ invoke: (/** @type {any[]} */ ...args) => invoke(...args) }));

const { readRunningProfile } = await import('./running-profile.js');
const { noteActiveProfile, noteRunningProfile } = await import('./active-profile.js');

describe('readRunningProfile', () => {
    beforeEach(() => {
        invoke.mockReset();
        noteActiveProfile('', true);
        // No restart report: the name comes from the settings read.
        noteRunningProfile(undefined);
    });

    it('names the stored profile the core runs', async () => {
        invoke.mockResolvedValue({ last_config: 'b.yaml' });
        expect(await readRunningProfile()).toBe('b.yaml');
    });

    it('reads an unknown profile, not the minimal config, when the read fails', async () => {
        invoke.mockRejectedValue(new Error('ipc down'));
        expect(await readRunningProfile()).toBeNull();
    });

    it("reads '' while the minimal config runs", async () => {
        noteRunningProfile(null);
        invoke.mockResolvedValue({ last_config: 'a.yaml' });
        expect(await readRunningProfile()).toBe('');
    });
});
