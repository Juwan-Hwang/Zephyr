import { describe, it, expect } from 'vitest';
import { configUpdateOutcome } from './config-update.js';

describe('configUpdateOutcome', () => {
    it('reports a full save with a hot reload as applied', () => {
        expect(configUpdateOutcome({
            files_saved: true, run_config_saved: true, profile_saved: true,
            hot_reload_success: true, message: 'Configuration saved and applied successfully',
        })).toBe('applied');
    });

    it('reports a full save without a hot reload as needing a restart', () => {
        expect(configUpdateOutcome({
            files_saved: true, profile_saved: true, hot_reload_success: false, message: 'Configuration saved.',
        })).toBe('restart');
    });

    it('reports a profile that did not take the patch as partial, even after a hot reload', () => {
        const result = {
            files_saved: false, run_config_saved: true, profile_saved: false,
            profile_error: 'it could not be parsed or merged', hot_reload_success: true,
            message: 'Changes applied. Run config saved, but profile sample.yaml could not be updated',
        };
        expect(configUpdateOutcome(result)).toBe('partial');
        expect(configUpdateOutcome({ ...result, hot_reload_success: false })).toBe('partial');
    });

    it('keeps reading results without the profile fields', () => {
        expect(configUpdateOutcome({ files_saved: true, hot_reload_success: true, message: '' })).toBe('applied');
        expect(configUpdateOutcome(null)).toBe('restart');
    });
});
