// @ts-check
import { describe, it, expect, beforeEach } from 'vitest';
import { appStore } from './state.js';
import { noNetworkChangeSince, networkChangesBegun } from './network-change.js';

describe('noNetworkChangeSince', () => {
    beforeEach(() => {
        appStore.set('isNetworkUpdating', false);
    });

    it('passes while no network change began', () => {
        const unchanged = noNetworkChangeSince();
        expect(unchanged()).toBe(true);
    });

    it('fails once a change began and ended before batched subscribers ran', () => {
        const unchanged = noNetworkChangeSince();
        appStore.set('isNetworkUpdating', true);
        appStore.set('isNetworkUpdating', false);
        expect(unchanged()).toBe(false);
    });

    it('fails for a change already running when the check was taken, also after it ends', async () => {
        appStore.set('isNetworkUpdating', true);
        const unchanged = noNetworkChangeSince();
        appStore.set('isNetworkUpdating', false);
        await Promise.resolve();
        expect(unchanged()).toBe(false);
    });

    it('counts each change as it begins, also a profile switch away and back', () => {
        const before = networkChangesBegun();
        appStore.set('isNetworkUpdating', true);
        appStore.set('isNetworkUpdating', false);
        appStore.set('isNetworkUpdating', true);
        appStore.set('isNetworkUpdating', false);
        expect(networkChangesBegun()).toBe(before + 2);
    });
});
