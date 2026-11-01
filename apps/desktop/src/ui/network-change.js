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
    if (watching || typeof appStore.subscribe !== 'function') return;
    watching = true;
    appStore.subscribe('isNetworkUpdating', (/** @type {unknown} */ busy) => {
        if (busy) changesBegun += 1;
    });
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
