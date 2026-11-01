// @ts-check
/**
 * Network changes (a profile, mode or TUN change) counted as they begin, so a
 * node switch queued before one can tell that it happened, also once it is
 * over by the time the switch gets its turn.
 */
import { appStore } from './state.js';

let changesBegun = 0;
let watching = false;

function watch() {
    if (watching) return;
    // Each start is counted as it is set: a change that begins and ends
    // before batched subscribers run would not reach them.
    // Only per-value watchers see a change that begins and ends at once: a
    // batched subscription would miss it, so there is no fallback to one.
    const store = /** @type {any} */ (appStore);
    if (typeof store.watchEach !== 'function') return;
    store.watchEach('isNetworkUpdating', (/** @type {unknown} */ busy) => {
        if (busy) changesBegun += 1;
    });
    watching = true;
}

/**
 * How many network changes (a profile, mode or TUN change) have begun so
 * far: a read that sees the count unchanged had no change begin during it.
 * @returns {number}
 */
export function networkChangesBegun() {
    watch();
    return changesBegun;
}

/**
 * A check for switchProxyResult's canSend, taken when the user clicks: false
 * once a network change is running or has begun since the click (a queued
 * switch in rule mode is no longer the right one after a change to global).
 * @returns {() => boolean}
 */
export function noNetworkChangeSince() {
    watch();
    const at = changesBegun;
    // A change already running when the snapshot is taken began before it:
    // its start is not counted, so its end would otherwise pass the check.
    const busyAtStart = Boolean(appStore.get('isNetworkUpdating'));
    return () => !busyAtStart && !appStore.get('isNetworkUpdating') && changesBegun === at;
}
