import { describe, it, expect } from 'vitest';
import { decideGroupMismatch, selectionChain, innermostSwitchable } from './group-mismatch.js';

// Anonymised shape of a real subscription that used to trigger false warnings:
// MATCH → "GFW" (select) → "Manual" (select) → "Auto" (url-test) → node.
const map = {
    GFW: { type: 'Selector', now: 'Manual', all: ['Manual', 'Auto', 'DIRECT'] },
    Manual: { type: 'Selector', now: 'Auto', all: ['Auto', 'HK 01', 'JP 01'] },
    Auto: { type: 'URLTest', now: 'HK 01', all: ['HK 01', 'JP 01'] },
    Apple: { type: 'Selector', now: 'DirectGroup', all: ['DirectGroup', 'Manual'] },
    DirectGroup: { type: 'Selector', now: 'DIRECT', all: ['DIRECT'] },
    Streaming: { type: 'Selector', now: 'JP 01', all: ['JP 01', 'HK 01'] },
    'HK 01': { type: 'Shadowsocks' },
    'JP 01': { type: 'Trojan' },
    DIRECT: { type: 'Direct' },
};

const base = { observedGroupName: null, observedNodeName: null, uiLeafNode: 'HK 01', proxyMap: map };

describe('selection chain helpers', () => {
    it('follows each group\'s current selection down to the last group', () => {
        expect(selectionChain('GFW', map)).toEqual(['GFW', 'Manual', 'Auto']);
        expect(selectionChain('HK 01', map)).toEqual([]);
    });

    it('picks the innermost group the user can switch by hand', () => {
        expect(innermostSwitchable('GFW', map)).toBe('Manual');
        expect(innermostSwitchable('Streaming', map)).toBe('Streaming');
    });

    it('survives a selection loop', () => {
        const loop = { A: { type: 'Selector', now: 'B', all: ['B'] }, B: { type: 'Selector', now: 'A', all: ['A'] } };
        expect(selectionChain('A', loop)).toEqual(['A', 'B']);
    });
});

describe('decideGroupMismatch', () => {
    it('does not warn when the catch-all group routes through the open group', () => {
        expect(decideGroupMismatch({ ...base, uiGroupName: 'Manual', effectiveGroupName: 'GFW' })).toBeNull();
    });

    it('does not warn when the open group selects the traffic group', () => {
        expect(decideGroupMismatch({ ...base, uiGroupName: 'GFW', effectiveGroupName: 'Manual' })).toBeNull();
    });

    it('does not warn when traffic exits through the node the open group resolves to', () => {
        expect(decideGroupMismatch({
            ...base, uiGroupName: 'Streaming', uiLeafNode: 'JP 01',
            observedGroupName: 'Manual', observedNodeName: 'JP 01', effectiveGroupName: 'GFW',
        })).toBeNull();
    });

    it('warns about the group that really carries the traffic, pointing at its innermost selector', () => {
        expect(decideGroupMismatch({ ...base, uiGroupName: 'Streaming', uiLeafNode: 'JP 01', effectiveGroupName: 'GFW' }))
            .toEqual({ kind: 'effective', target: 'Manual' });
        expect(decideGroupMismatch({
            ...base, uiGroupName: 'Streaming', uiLeafNode: 'JP 01', observedGroupName: 'Manual', observedNodeName: 'HK 01',
        })).toEqual({ kind: 'observed', target: 'Manual' });
    });

    it('stays quiet when nothing differs', () => {
        expect(decideGroupMismatch({ ...base, uiGroupName: 'Manual', effectiveGroupName: 'Manual', observedGroupName: 'Manual' })).toBeNull();
    });
});
