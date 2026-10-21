// @ts-check
/**
 * TUN toggle logic - manage TUN virtual adapter mode.
 * Extracted from ui.js for modularity.
 */

import { patchConfig, closeAllConnections, invoke, restartCore, setSecret, getConfig, getCurrentWindow } from '../api.js';
import { tunLogger } from '../utils/logger.js';
import { setWsSecret } from '../websocket.js';
import { showNotification, showConfirmModal } from './notifications.js';
import { translations, currentLang } from '../i18n.js';
import { appStore } from './state.js';
import { COMMANDS } from '@zephyr/shared';
import { postRestartRecovery } from './lifecycle.js';
import { renderTunStatus } from './tun-status.js';

// Records the TUN preference only, for callers that
// have already applied TUN to the running core themselves — `patch_settings`
// now rejects a non-null `tun_enabled`, which is the owner-path split this
// command exists to serve.
const RECORD_TUN_ENABLED = COMMANDS.RECORD_TUN_ENABLED;

/** Re-syncs every mirrored TUN switch from the home toggle (see `mirrorTunToggle`). */
/** @type {Set<() => void>} */
const mirrorSyncs = new Set();

function syncTunMirrors() {
    for (const sync of mirrorSyncs) sync();
}

/**
 * Drive a secondary TUN switch (the console page's) through the home toggle.
 *
 * The home toggle owns the whole flow: authorisation, errors, rollback and the
 * success notice. A secondary switch only forwards the user's click to it and
 * then follows the settled state. Subscribing to `appStore.isTunEnabled` alone
 * is not enough: a failed switch rolls back without changing the store (it was
 * `false` before and is `false` after), so no change event fires and a switch
 * bound only to the store kept showing TUN as on after a failed start, e.g.
 * without administrator rights. Hence the explicit re-read once a switch
 * settles (and on rollback, via `syncTunMirrors`).
 *
 * The re-read takes the store, not the home checkbox: once a switch settles the
 * two agree, but the console is built before startup binds the home checkbox,
 * which until then reads unchecked even with TUN on.
 *
 * @param {HTMLInputElement} toggle
 * @returns {() => void} Detaches the switch.
 */
export function mirrorTunToggle(toggle) {
    const home = () => /** @type {HTMLInputElement|null} */ (document.getElementById('tun-proxy-toggle'));
    const sync = () => {
        toggle.checked = !!appStore.get('isTunEnabled');
    };
    const unsubs = [
        // A store change carries the new state (tray, Restore Defaults) even
        // before the home toggle has caught up.
        appStore.subscribe('isTunEnabled', (/** @type {boolean} */ on) => { toggle.checked = !!on; }),
        // No second click while a switch is in flight; re-read when it settles.
        appStore.subscribe('isNetworkUpdating', (/** @type {boolean} */ busy) => {
            toggle.disabled = !!busy;
            if (!busy) sync();
        }),
    ];
    const onChange = () => {
        const el = home();
        if (!el) { toggle.checked = !toggle.checked; return; }
        el.checked = toggle.checked;
        el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    toggle.addEventListener('change', onChange);
    toggle.disabled = !!appStore.get('isNetworkUpdating');
    mirrorSyncs.add(sync);
    sync();
    return () => {
        toggle.removeEventListener('change', onChange);
        mirrorSyncs.delete(sync);
        for (const off of unsubs) off();
    };
}

/**
 * Show the main window before a prompt the user must answer. A switch started
 * from the tray while the window is closed to the tray would otherwise wait on
 * an invisible dialog, keeping every later switch blocked until it is opened.
 */
async function revealMainWindow() {
    // This webview's own window, shown in place: `show_main_window` could
    // recreate it (stale heartbeat) and drop the flow that is running here.
    try {
        const win = getCurrentWindow();
        await win.show();
        await win.setFocus();
    } catch (err) {
        tunLogger.warn('could not show the window for the TUN prompt', err);
    }
}

/**
 * Windows: TUN needs an elevated process (the core inherits the app's token).
 * Offer to relaunch Zephyr as administrator, the counterpart of the macOS root
 * restart and the Linux permission grant. When the process is already
 * elevated it reports the failure itself (relaunching would not help). Returns
 * false only when elevation could not be checked, so the caller reports the
 * failure as before.
 *
 * @param {Record<string, string>} t
 * @returns {Promise<boolean>} Whether the prompt was handled here.
 */
async function offerWindowsAdminRelaunch(t) {
    const elevated = await invoke(COMMANDS.IS_PROCESS_ELEVATED).catch(() => null);
    if (elevated === true) {
        // Already administrator: "run as administrator" would be wrong advice.
        showNotification(t.tunFailedElevated || "Couldn't turn on TUN mode. Check the core log for details", 'error');
        return true;
    }
    if (elevated !== false) return false;
    await revealMainWindow();
    const relaunch = await showConfirmModal(
        'TUN',
        t.tunWindowsAdminPrompt || 'TUN mode needs administrator rights. Restart Zephyr as administrator?'
    );
    // Declined: the failure may not be about rights at all, so report it as is.
    if (!relaunch) return false;
    try {
        // On success the app exits and the elevated instance starts with TUN on.
        await invoke(COMMANDS.RESTART_AS_ADMIN, { enableTun: true });
    } catch (err) {
        tunLogger.error('Windows elevated relaunch failed', err);
        if (err === 'canceled') {
            showNotification(t.tunAuthCanceled || 'Authorization canceled', 'error');
        } else if (err === 'not_admin_user') {
            showNotification(t.tunWindowsNotAdmin || 'TUN mode needs administrator rights, and this Windows account is not an administrator', 'error');
        } else if (typeof err === 'string' && err.startsWith('pref_save_failed')) {
            showNotification(t.tunPrefSaveFailedNotEnabled, 'warning');
        } else {
            showNotification(t.tunWindowsRelaunchFailed || 'Could not restart as administrator', 'error');
        }
    }
    return true;
}

export function initTunToggle() {
    const toggle = /** @type {HTMLInputElement|null} */ (document.getElementById('tun-proxy-toggle'));
    const statusText = document.getElementById('tun-status-text');
    const spinner = document.getElementById('tun-spinner');
    if (!toggle) return;

    /**
     * Attempt to recover from a TUN root-start failure by restarting the core.
     */
    async function recoverFromRootStartFailure() {
        try {
            const settings = await invoke(COMMANDS.GET_SETTINGS);
            const currentConfig = settings.last_config || 'config.yaml';
            const customArgs = settings.custom_args || [];
            await restartCore(currentConfig, customArgs);
            await postRestartRecovery(currentConfig);
        } catch (recoverErr) {
            tunLogger.error('recovery failed', recoverErr);
        }
    }

    toggle.onchange = async () => {
        if (appStore.get('isNetworkUpdating')) {
            toggle.checked = !toggle.checked;
            return;
        }

        const enable = toggle.checked;
        /** @type {Record<string, string>} */
        const t = /** @type {Record<string, string>} */ (/** @type {any} */ (translations)[currentLang]);
        const isMac = navigator.platform.toLowerCase().includes('mac');
        appStore.set('isNetworkUpdating', true);

        // Show loading state
        if (spinner) spinner.classList.remove('hidden');
        if (statusText) {
            statusText.textContent = t.configuringTun;
            // Keep the i18n key in step so a language switch mid-toggle
            // re-translates "configuring" instead of the previous state.
            statusText.dataset.i18n = 'configuringTun';
            statusText.classList.add('text-accent');
        }

        // Set when the requested state was committed but a later step failed. The UI
        // keeps the committed state and suppresses the success notice rather than
        // claiming the whole operation worked.
        let committedWithLaterFailure = false;

        try {
            // On macOS, handle TUN mode with root privileges
            if (isMac) {
                if (enable) {
                    try {
                        const result = await invoke(COMMANDS.RESTART_AS_ROOT, { enableTun: true });
                        if (result) {
                            setSecret(result);
                            setWsSecret(result);
                        }
                    } catch (authErr) {
                        tunLogger.error('authErr', authErr);
                        if (authErr === 'canceled') {
                            showNotification(t.tunAuthCanceled || 'Authorization canceled', 'error');
                        } else if (typeof authErr === 'string' && authErr.startsWith('root_start_failed')) {
                            // The backend prefixes the marker and appends the
                            // detail, so this must be a prefix match: the script
                            // has already killed the user's core, and this branch
                            // is what runs the recovery for it.
                            showNotification(t.tunStartFailed || 'TUN failed to start, recovering...', 'error');
                            await recoverFromRootStartFailure();
                        } else {
                            showNotification(t.tunAuthFailed || 'Authorization failed', 'error');
                        }
                        toggle.checked = false;
                        renderTunStatus(statusText, false);
                        return;
                    }
                    // Recording the preference is a separate step from the
                    // privileged restart, and must not be reported as an
                    // authorization failure: if the write fails after the root TUN
                    // core is already running, the core *is* in TUN mode while
                    // `settings.json` still says otherwise. Unchecking the toggle
                    // would then make the UI disagree with the running core, and
                    // the stale flag would send the next start down the non-TUN
                    // path — which re-prompts for administrator rights to kill the
                    // core this very toggle just started.
                    try {
                        await invoke(RECORD_TUN_ENABLED, { enable: true });
                    } catch (recordErr) {
                        tunLogger.error('failed to record tun_enabled after root restart', recordErr);
                        committedWithLaterFailure = true;
                        showNotification(
                            t.tunPrefSaveFailed,
                            'warning'
                        );
                    }
                } else {
                    // Whether the backend already committed the new state. Once
                    // `DISABLE_CMD` has returned, TUN is off in `settings.json`
                    // and the root core is gone — a later failure cannot undo
                    // that, and reporting the toggle as enabled again would
                    // misdescribe state the user cannot act on while sending the
                    // next start down the TUN path. Only a failure of the
                    // disable itself restores the enabled UI.
                    let disableCommitted = false;
                    try {
                        // No preference write here. `disable_tun_cmd` records it
                        // itself once the verified kill has succeeded.
                        //
                        // Order was the real problem: writing first meant a
                        // cancelled administrator dialog left `settings.json`
                        // and `run_config.yaml` claiming TUN was off while the
                        // root core kept running and holding the ports, and the
                        // next start then took the non-TUN path and re-prompted.
                        // `false` means TUN is off but `settings.json` could
                        // not be updated: still a committed disable, so warn
                        // without restoring the enabled toggle.
                        const preferenceSaved = await invoke(COMMANDS.DISABLE_CMD);
                        disableCommitted = true;
                        if (preferenceSaved === false) {
                            committedWithLaterFailure = true;
                            showNotification(t.tunPrefSaveFailedOff, 'warning');
                        }
                        await new Promise(r => setTimeout(r, 1500));

                        const settings = await invoke(COMMANDS.GET_SETTINGS);
                        const currentConfig = settings.last_config || 'config.yaml';
                        const customArgs = settings.custom_args || [];
                        await new Promise(r => setTimeout(r, 1000));
                        await restartCore(currentConfig, customArgs);
                        await postRestartRecovery(currentConfig);
                    } catch (restartErr) {
                        tunLogger.error('failed to disable TUN', restartErr);
                        if (disableCommitted) {
                            // TUN is already off and the root core is gone. Keep
                            // that state, report the restart failure, and skip
                            // the success notice below — falling through to the
                            // outer catch here would put the toggle back to
                            // enabled and contradict the backend.
                            committedWithLaterFailure = true;
                            showNotification(t.tunRestartAfterDisableFailed, 'warning');
                        } else {
                            // The disable itself failed — most often a cancelled
                            // administrator dialog, with the root TUN core still
                            // running. Only here is the enabled state still the
                            // truth, so the outer catch restores the toggle.
                            throw restartErr;
                        }
                    }
                }
            } else {
                // Non-macOS: use API to update config
                await patchConfig({ tun: { enable } });

                const _coreConfig = await invoke(COMMANDS.READ_CONFIG).catch(() => null);
                const config = await getConfig();
                /** @type {{tun?: {enable?: boolean}}} */
                const typedConfig = /** @type {{tun?: {enable?: boolean}}} */ (config);
                if (typedConfig?.tun?.enable !== enable) {
                    throw new Error(t.tunRejected || "Core rejected TUN mode change");
                }
                // Recorded only now that the core has confirmed the change.
                // Writing it earlier would leave `settings.json` holding a value
                // the core refused, and `start_core_inner` injects that flag into
                // every later `run_config.yaml` — so each start would try to bring
                // TUN up again, on a platform where the user may have declined the
                // permission prompt or where the core lacks the rights.
                //
                // A preference-write failure at this point must not roll the UI
                // back either: the core has already made the change, so reverting
                // the toggle would make it disagree with the running core. Same
                // handling as the macOS branch.
                try {
                    await invoke(RECORD_TUN_ENABLED, { enable });
                } catch (recordErr) {
                    tunLogger.error('failed to record tun_enabled after core confirmed TUN', recordErr);
                    committedWithLaterFailure = true;
                    showNotification(
                        enable ? t.tunPrefSaveFailed : t.tunPrefSaveFailedOff,
                        'warning'
                    );
                }
            }

            // Best-effort: TUN is committed by now, and the core may be down
            // after a committed disable whose restart failed. A rejection here
            // must not reach the outer catch, which would revert the toggle.
            await closeAllConnections().catch((e) =>
                tunLogger.warn('closeAllConnections failed after TUN change', e)
            );

            appStore.set('isTunEnabled', enable);

            if (!committedWithLaterFailure) {
                showNotification(enable ? t.tunEnabled : t.tunDisabled, 'success');
            }

            renderTunStatus(statusText, enable);
        } catch (err) {
            // The prompts below replace this error with their own message: keep it in the log.
            tunLogger.error(`TUN ${enable ? 'enable' : 'disable'} failed`, err);
            toggle.checked = !enable;
            appStore.set('isTunEnabled', !enable);
            renderTunStatus(statusText, !enable);
            // The prompts below keep the switch busy; show the rollback now.
            syncTunMirrors();

            const ua = navigator.userAgent.toLowerCase();
            const isLinux = ua.includes('linux');
            const isWindows = ua.includes('windows');
            if (isLinux && enable) {
                await revealMainWindow();
                const grantPermission = await showConfirmModal(
                    'TUN',
                    t.tunLinuxPermissionPrompt ||
                    'TUN mode requires network capabilities and polkit rules.\nGrant permission now?'
                );
                if (!grantPermission) {
                    showNotification(t.tunAuthCanceled || 'Authorization canceled', 'info');
                }
                if (grantPermission) {
                    let permissionGranted = false;
                    try {
                        await invoke(COMMANDS.GRANT_LINUX_PERMISSION);
                        permissionGranted = true;
                    } catch (grantErr) {
                        tunLogger.error('Linux TUN permission grant failed', grantErr);
                        if (grantErr === 'canceled') {
                            showNotification(t.tunAuthCanceled || 'Authorization canceled', 'error');
                        } else {
                            showNotification(t.tunLinuxPermissionFailed || 'Failed to grant permission', 'error');
                        }
                    }

                    if (permissionGranted) {
                        try {
                            // Recorded *before* anything is restarted, and a
                            // failure here ends the flow rather than continuing.
                            //
                            // The restart regenerates `run_config.yaml` from the
                            // stored preference, and `prepare_runtime_config`
                            // lets `tun_enabled` override whatever `patchConfig`
                            // wrote. So with this write failed, restarting would
                            // set `tun.enable: false` and bring the core up
                            // without TUN — the restart would undo the change it
                            // was meant to apply, and the toggle would then claim
                            // TUN is on while the running core has no TUN.
                            //
                            // Letting it throw is not an option either:
                            // `catch (retryErr)` would record `false` (correct),
                            // but it also runs a fallback restart — and the core
                            // was never stopped in this path, so that restarts a
                            // healthy core and blames it for a settings write.
                            // Leaving the core as it is keeps the state exactly
                            // as it was before the permission grant.
                            await invoke(RECORD_TUN_ENABLED, { enable: true });
                        } catch (recordErr) {
                            tunLogger.error('failed to record tun_enabled after permission grant', recordErr);
                            showNotification(
                                t.tunPrefSaveFailedNotEnabled,
                                'warning'
                            );
                            return;
                        }
                        showNotification(t.tunLinuxPermissionGranted || 'Permission granted. Restarting core...', 'success');
                        try {
                            try { await invoke(COMMANDS.STOP_CORE); } catch (_) {}
                            const settings = await invoke(COMMANDS.GET_SETTINGS);
                            const currentConfig = settings.last_config || 'config.yaml';
                            const customArgs = settings.custom_args || [];
                            const coreResult = await restartCore(currentConfig, customArgs);
                            await postRestartRecovery(currentConfig);
                            if (coreResult?.secret) {
                                setSecret(coreResult.secret);
                                setWsSecret(coreResult.secret);
                            }
                            // Best-effort, as on the normal TUN path: the core
                            // is up with TUN by now, so a rejection here must
                            // not reach the retry-failure handling below.
                            await closeAllConnections().catch((e) =>
                                tunLogger.warn('closeAllConnections failed after TUN retry', e)
                            );

                            appStore.set('isTunEnabled', true);
                            toggle.checked = true;
                            renderTunStatus(statusText, true);
                            showNotification(t.tunEnabled, 'success');
                            return;
                        } catch (retryErr) {
                            tunLogger.error('TUN retry failed after permission grant', retryErr);
                            // The retry did not bring TUN up, so record the
                            // preference as off rather than leaving it at the
                            // value written before the attempt.
                            //
                            // Its own `try`, because a failure here would skip the
                            // fallback restart below: STOP_CORE already ran, so
                            // the core would simply stay stopped and the user
                            // would see no error for it.
                            try {
                                await invoke(RECORD_TUN_ENABLED, { enable: false });
                            } catch (recordErr) {
                                tunLogger.error('failed to record tun_enabled=false after retry failure', recordErr);
                            }
                            try {
                                const settings = await invoke(COMMANDS.GET_SETTINGS);
                                const currentConfig = settings.last_config || 'config.yaml';
                                const customArgs = settings.custom_args || [];
                                await restartCore(currentConfig, customArgs);
                                await postRestartRecovery(currentConfig);
                            } catch (restartErr) {
                                tunLogger.error('Core restart without TUN also failed', restartErr);
                            }
                            showNotification(t.tunFailed || 'TUN mode failed after permission grant', 'error');
                        }
                    }
                }
            } else if (!(isWindows && enable && await offerWindowsAdminRelaunch(t))) {
                showNotification(isMac ? t.tunFailedMac : t.tunFailed, 'error');
            }

        } finally {
            if (spinner) spinner.classList.add('hidden');
            syncTunMirrors();
            appStore.set('isNetworkUpdating', false);
            invoke(COMMANDS.RELEASE_TUN_TOGGLE).catch(() => {});
        }
    };
}
