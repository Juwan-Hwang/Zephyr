// @ts-check
import { describe, it, expect, beforeEach } from 'vitest';
import { activeProfile, noteActiveProfile } from './active-profile.js';
import { Bus, Events } from './events.js';

describe('activeProfile', () => {
    beforeEach(() => noteActiveProfile('', true));

    it('follows the stored profile normally', () => {
        expect(activeProfile({ last_config: 'a.yaml' })).toBe('a.yaml');
        expect(activeProfile(null, 'config.yaml')).toBe('config.yaml');
        expect(activeProfile({ last_config: null })).toBe('');
    });

    it('names the running profile while saving it failed, until a later save works', () => {
        noteActiveProfile('b.yaml', false);
        expect(activeProfile({ last_config: 'a.yaml' })).toBe('b.yaml');
        noteActiveProfile('c.yaml', true);
        expect(activeProfile({ last_config: 'c.yaml' })).toBe('c.yaml');
    });

    it('drops the record once a restart runs another profile', () => {
        noteActiveProfile('b.yaml', false);
        // A switch's own restart reports the profile it was saving.
        Bus.emit(Events.CORE_RESTARTED, { activeConfig: 'b.yaml' });
        expect(activeProfile({ last_config: 'a.yaml' })).toBe('b.yaml');
        // Restarts that do not say what runs leave it alone.
        Bus.emit(Events.CORE_RESTARTED, { handle: {} });
        expect(activeProfile({ last_config: 'a.yaml' })).toBe('b.yaml');
        // A Geo/TUN restart started the stored profile again.
        Bus.emit(Events.CORE_RESTARTED, { activeConfig: 'a.yaml' });
        expect(activeProfile({ last_config: 'a.yaml' })).toBe('a.yaml');
        // One that fell back to another profile names that one.
        Bus.emit(Events.CORE_RESTARTED, { activeConfig: 'c.yaml' });
        expect(activeProfile({ last_config: 'a.yaml' })).toBe('c.yaml');
        Bus.emit(Events.CORE_RESTARTED, { activeConfig: null });
        expect(activeProfile({ last_config: 'a.yaml' })).toBe('a.yaml');
    });
});
