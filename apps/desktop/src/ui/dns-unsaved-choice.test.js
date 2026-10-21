import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./settings-helpers.js', () => ({
    getSetting: vi.fn(),
    saveSetting: vi.fn(async () => {}),
    saveSettingChecked: vi.fn(),
}));

import { getSetting, saveSettingChecked } from './settings-helpers.js';
import { persistDnsChoice, dnsRewriteWanted, forgetUnsavedDnsChoice } from './dns-shared.js';

describe('DNS rewrite choice that could not be saved', () => {
    beforeEach(() => {
        forgetUnsavedDnsChoice();
        vi.mocked(getSetting).mockResolvedValue(true);
        vi.mocked(saveSettingChecked).mockReset();
    });

    it('re-applies follow the switch, not the stale saved "on"', async () => {
        vi.mocked(saveSettingChecked).mockRejectedValueOnce(new Error('disk full'));
        await expect(persistDnsChoice(false)).resolves.toBe(false);
        await expect(dnsRewriteWanted()).resolves.toBe(false);
    });

    it('reads the setting again once a later save succeeds', async () => {
        vi.mocked(saveSettingChecked).mockRejectedValueOnce(new Error('disk full'));
        await persistDnsChoice(false);
        vi.mocked(saveSettingChecked).mockResolvedValueOnce(undefined);
        await expect(persistDnsChoice(true)).resolves.toBe(true);
        await expect(dnsRewriteWanted()).resolves.toBe(true);
    });

    it('reads the setting again after another save wrote the choice', async () => {
        vi.mocked(saveSettingChecked).mockRejectedValueOnce(new Error('disk full'));
        await persistDnsChoice(false);
        forgetUnsavedDnsChoice();
        await expect(dnsRewriteWanted()).resolves.toBe(true);
    });
});
