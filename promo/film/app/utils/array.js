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
    const withScore = candidates.map((name, idx) => {
        const proxy = data?.proxies?.[name];
        const lastDelay =
            proxy?.history && proxy.history.length > 0
                ? proxy.history[proxy.history.length - 1].delay
                : 0;
        const score = lastDelay > 0 && lastDelay < 999999 ? lastDelay : 1000000;
        return { name, score, idx };
    });

    withScore.sort((a, b) => (a.score !== b.score ? a.score - b.score : a.idx - b.idx));

    const queue = [];
    let left = 0;
    let right = withScore.length - 1;

    while (left <= right) {
        queue.push(withScore[left].name);
        if (left !== right) queue.push(withScore[right].name);
        left++;
        right--;
    }

    return queue;
}
