// @ts-check
import { describe, it, expect, beforeEach } from 'vitest';
import { activeProfile, noteActiveProfile } from './active-profile.js';

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
});
