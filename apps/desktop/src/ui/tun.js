// @ts-check
/**
 * TUN toggle logic - manage TUN virtual adapter mode.
 * Extracted from ui.js for modularity.
 */

import { patchConfig, closeAllConnections, invoke, restartCore, setSecret, getConfig } from '../api.js';
import { tunLogger } from '../utils/logger.js';
import { setWsSecret } from '../websocket.js';
import { showNotification } from './notifications.js';
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
                            showNotification(t.tunPrefSaveFailed, 'warning');
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
                        t.tunPrefSaveFailed,
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
                showNotification(t.configSuccess, 'success');
            }

            renderTunStatus(statusText, enable);
        } catch (_err) {
            toggle.checked = !enable;
            appStore.set('isTunEnabled', !enable);
            renderTunStatus(statusText, !enable);

            const isLinux = navigator.userAgent.toLowerCase().includes('linux');
            if (isLinux && enable) {
                const grantPermission = confirm(
                    t.tunLinuxPermissionPrompt ||
                    'TUN mode requires network capabilities and polkit rules.\nGrant permission now?'
                );
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
                            await closeAllConnections();

                            appStore.set('isTunEnabled', true);
                            toggle.checked = true;
                            renderTunStatus(statusText, true);
                            showNotification(t.configSuccess, 'success');
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
            } else {
                showNotification(isMac ? t.tunFailedMac : t.tunFailed, 'error');
            }

        } finally {
            if (spinner) spinner.classList.add('hidden');
            appStore.set('isNetworkUpdating', false);
            invoke(COMMANDS.RELEASE_TUN_TOGGLE).catch(() => {});
        }
    };
}
