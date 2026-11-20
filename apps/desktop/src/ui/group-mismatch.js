// @ts-check
/**
 * Decide whether the Proxies page should warn that traffic is really going through
 * another group than the one the user has open.
 *
 * Purpose of the warning: a user picks a node in the open group, but most traffic is
 * routed by a different group, so their IP does not change. It must not fire when
 * the open group is already on the path of that traffic, e.g. MATCH → 「GFW 列表」
 * (selects 「手动选择」) → 「手动选择」 (selects 「自动选择」) → node: changing
 * 「手动选择」 does change the traffic, so there is nothing to warn about.
 *
 * @module ui/group-mismatch
 */

import { isWritableGroupType } from './proxy-groups.js';

/**
 * The groups a name resolves through by following each group's current selection.
 * @param {string|null|undefined} name
 * @param {Record<string, any>} proxyMap
 * @returns {string[]} the name itself first, then each selected group in turn (leaf nodes excluded)
 */
export function selectionChain(name, proxyMap) {
    /** @type {string[]} */
    const chain = [];
    const seen = new Set();
    let cur = name;
    while (cur && !seen.has(cur)) {
        const entry = proxyMap?.[cur];
        if (!entry || !Array.isArray(entry.all)) break; // leaf node or unknown
        chain.push(cur);
        seen.add(cur);
        cur = entry.now;
    }
    return chain;
}

/**
 * Innermost group along `name`'s selection chain that the user can switch by hand
 * (a Selector) — the group whose choice actually picks the node.
 * @param {string} name
 * @param {Record<string, any>} proxyMap
 * @returns {string}
 */
export function innermostSwitchable(name, proxyMap) {
    const chain = selectionChain(name, proxyMap);
    for (let i = chain.length - 1; i >= 0; i--) {
        const group = proxyMap?.[chain[i]];
        // Hidden selectors cannot be opened in the list, so they are not a switch target.
        if (isWritableGroupType(group?.type || '') && !group?.hidden) return chain[i];
    }
    return name;
}

/**
 * @param {{ uiGroupName: string, effectiveGroupName: string|null, observedGroupName: string|null,
 *           observedNodeName: string|null, uiLeafNode: string|null, proxyMap: Record<string, any> }} input
 * @returns {{ kind: 'observed'|'effective', target: string } | null} null = no warning
 */
export function decideGroupMismatch({ uiGroupName, effectiveGroupName, observedGroupName, observedNodeName, uiLeafNode, proxyMap }) {
    // Traffic exits through the very node the open group resolves to: nothing to explain.
    if (observedNodeName && uiLeafNode && observedNodeName === uiLeafNode) return null;

    /** @param {string|null} candidate */
    const mismatch = (candidate) => {
        if (!candidate || candidate === uiGroupName) return null;
        // The open group is on the path of that traffic (or selects that group): changing it
        // already changes where the traffic goes.
        if (selectionChain(candidate, proxyMap).includes(uiGroupName)) return null;
        if (selectionChain(uiGroupName, proxyMap).includes(candidate)) return null;
        const target = innermostSwitchable(candidate, proxyMap);
        if (target === uiGroupName) return null;
        return target;
    };

    const observedTarget = mismatch(observedGroupName);
    if (observedTarget) return { kind: 'observed', target: observedTarget };
    const effectiveTarget = mismatch(effectiveGroupName);
    if (effectiveTarget) return { kind: 'effective', target: effectiveTarget };
    return null;
}
