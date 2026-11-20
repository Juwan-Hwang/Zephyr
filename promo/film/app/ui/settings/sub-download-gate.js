// @ts-check
/**
 * The backend refuses a second `download_sub` within 5 s of the last one (for
 * any subscription). Downloads that follow each other (a link saved while its
 * update ran, two cards updated in a row) wait for a slot instead of failing.
 * @param {number} gapMs
 * @param {(ms: number) => Promise<void>} [sleep]
 * @param {() => number} [now]  a monotonic clock, as the backend's: a wall-clock jump must not open a slot early
 * @returns {() => Promise<void>} Resolves when the next download may start.
 */
export function createDownloadGate(gapMs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => performance.now()) {
    let last = -Infinity;
    /** @type {Promise<void>} */
    let queue = Promise.resolve();
    return () => {
        const slot = queue.then(async () => {
            const wait = last + gapMs - now();
            if (wait > 0) await sleep(wait);
            last = now();
        });
        queue = slot;
        return slot;
    };
}

/**
 * A little over the backend's 5 s `download_sub` limit. The one gate every `download_sub` call goes through (subscription cards, the
 * edit panel, adding one, deep-link imports): the limit is shared by all of them.
 */
export const subDownloadSlot = createDownloadGate(5200);
