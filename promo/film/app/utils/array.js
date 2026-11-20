// @ts-check
/**
 * Array utility functions.
 *
 * @module array
 */

/**
 * Build a latency priority queue for testing (alternating low-high pattern).
 * Sorts candidates by their last measured delay, then interleaves from
 * both ends of the sorted list to produce an alternating low-high sequence.
 *
 * @param {{proxies?: Record<string, {history?: Array<{delay: number}>}>}} data - Proxy data object containing proxy information
 * @param {string[]} candidates - List of proxy names to prioritize
 * @returns {string[]} Ordered list of proxy names in alternating latency order
 *
 * @example
 * const queue = buildLatencyPriorityQueue(proxyData, ['proxy-a', 'proxy-b', 'proxy-c']);
 */
export function buildLatencyPriorityQueue(data, candidates) {
    const len = candidates ? candidates.length : 0;
    if (len === 0) return [];
    if (len === 1) return [candidates[0]];

    const proxies = data?.proxies;
    // Performance optimization: Use flat typed arrays for scores and candidate indices
    // to eliminate object literal allocations ({ name, score, idx }) per proxy candidate
    // during high-frequency latency test queue construction.
    const scores = new Float64Array(len);
    const indices = new Int32Array(len);

    for (let i = 0; i < len; i++) {
        indices[i] = i;
        const proxy = proxies?.[candidates[i]];
        const history = proxy?.history;
        const lastDelay = history && history.length > 0 ? history[history.length - 1].delay : 0;
        scores[i] = lastDelay > 0 && lastDelay < 999999 ? lastDelay : 1000000;
    }

    // Sort indices by score ascending, using original candidate index for tie-breaking
    indices.sort((a, b) => {
        const sa = scores[a];
        const sb = scores[b];
        return sa !== sb ? sa - sb : a - b;
    });

    // Interleave low-high sequence directly into a pre-allocated result array
    const queue = new Array(len);
    let left = 0;
    let right = len - 1;
    let outIdx = 0;

    while (left <= right) {
        queue[outIdx++] = candidates[indices[left]];
        if (left !== right) {
            queue[outIdx++] = candidates[indices[right]];
        }
        left++;
        right--;
    }

    return queue;
}
