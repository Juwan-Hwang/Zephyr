// @ts-check
/**
 * 核心生命周期管理模块
 *
 * 负责订阅切换、重启后恢复等高层 orchestration 逻辑。
 * 此模块可以导入 api.js 和 UI 模块，避免 api.js 出现分层违规。
 */

import { abortLatencyTests, closeAllConnections, restartCore, invoke } from '../api.js';
import { COMMANDS } from '@zephyr/shared';
import { appStore } from './state.js';
import { invalidateSettingsCache, invalidateProxiesCache, invalidateConfigCache } from './cache.js';
import { invalidateRunConfigCache } from './run-config-cache.js';
import { apiLogger } from '../utils/logger.js';
import { showNotification } from './notifications.js';
import { t } from '../i18n.js';

/**
 * 切换到指定配置（订阅）
 * @param {string} configName - 目标配置文件名
 * @param {string[]} [customArgs=[]] - 自定义核心参数
 * @returns {Promise<{secret: string, port: number, active_config: string|null, fallbackOccurred: boolean, actualConfig: string|null}>} coreResult
 */
export async function switchToConfig(configName, customArgs = []) {
  // 中止正在进行的延迟测试，让 mihomo 处于空闲状态以便更快 kill
  abortLatencyTests();
  // 关闭所有连接以解除 mihomo 的请求队列阻塞（给后续 fetchProxyGroups 解堵）
  try {
    await closeAllConnections();
  } catch (e) {
    apiLogger.warn('[switchToConfig] closeAllConnections failed:', e);
  }

  // 切换前保存当前代理选择
  try {
    const { fetchProxyGroups } = await import('./proxy-groups.js');
    const groupName = appStore.get('uiGroupName');
    // 使用短超时 —— 如果 mihomo 繁忙（如延迟测试仍在队列中），
    // 回退到 appStore 状态而不是阻塞数秒
    let timer;
    // Pass preferredGroupName so the resolver targets the user's chosen group
    // instead of the effective group.  Without this, `current` may come from
    // a different group (e.g., "兜底分流") whose `now` is a group name (e.g.,
    // "手动切换"), which would be incorrectly saved as the proxy node.
    const fetchPromise = fetchProxyGroups({ preferredGroupName: groupName ?? undefined });
    const timeoutPromise = new Promise(resolve => { timer = setTimeout(() => resolve(null), 500); });
    const currentProxyGroups = await Promise.race([fetchPromise, timeoutPromise]);
    clearTimeout(timer);

    let nodeToSave = null;
    if (currentProxyGroups && currentProxyGroups.current) {
      // fetch 成功，使用实时数据
      nodeToSave = currentProxyGroups.current;
    } else {
      // fetch 超时，回退到 appStore 中缓存的当前节点
      nodeToSave = appStore.get('currentProxy');
    }

    if (nodeToSave) {
      const liveSettings = await invoke(COMMANDS.GET_SETTINGS);
      const activeConfig = liveSettings.last_config || 'config.yaml';
      const { saveProxySelection } = await import('./proxy-memory.js');
      // Use the resolver's uiGroupName when live data was available
      // (it may normalize or fall back from the raw appStore value).
      // On timeout fallback, use the raw groupName to keep node and
      // group sources consistent.
      const resolvedGroup = (currentProxyGroups && currentProxyGroups.current)
        ? (currentProxyGroups.uiGroupName || currentProxyGroups.mainGroup || groupName || null)
        : (groupName || null);
      await saveProxySelection(activeConfig, {
        node: nodeToSave,
        group: resolvedGroup,
      });
    }
  } catch (e) {
    apiLogger.warn('[switchToConfig] Failed to save proxy selection:', e);
  }

  // 重启核心
  const coreResult = await restartCore(configName, customArgs);
  if (!coreResult?.secret) throw new Error('Core start failed: no secret returned');

  // 检测是否发生回退：实际加载的配置与请求的不一致
  const actualConfig = coreResult.active_config;
  const fallbackOccurred = actualConfig && actualConfig !== configName;
  const noConfigLoaded = actualConfig === null;
  appStore.set('noSubscription', noConfigLoaded);

  if (fallbackOccurred || noConfigLoaded) {
    if (noConfigLoaded) {
      // 没有有效配置，使用了最小配置
      showNotification(
        t('configFallbackMinimal', { requested: configName }),
        'warning'
      );
    } else {
      // 回退到其他配置
      showNotification(
        t('configFallback', { requested: configName, actual: actualConfig || '' }),
        'warning'
      );
    }
    apiLogger.warn(`[switchToConfig] Config fallback: requested=${configName}, actual=${actualConfig}`);
  }

  // 持久化实际活动配置（原子更新，避免 RMW 竞态）
  // 如果发生了回退，使用实际加载的配置名
  const configToPersist = actualConfig || configName;
  await invoke(COMMANDS.UPDATE_LAST_CONFIG, { configName: configToPersist });
  invalidateSettingsCache();

  // Post-restart recovery: rebuild prism, reapply overrides, restore proxy, refresh UI
  await postRestartRecovery(configToPersist);

  return {
    ...coreResult,
    /** @type {boolean} Whether a fallback occurred (requested config was invalid) */
    fallbackOccurred: !!(fallbackOccurred || noConfigLoaded),
    /** @type {string|null} The actual config that was loaded */
    actualConfig: actualConfig,
  };
}

/**
 * Recovery step 1. Each step logs its own failure and returns how many
 * failures to count; none throws.
 * @returns {Promise<number>}
 */
async function rebuildPrismStep() {
  try {
    const { rebuild } = await import('./prism.js');
    const result = await rebuild();
    // Rewritten config the core refused: the patches are saved but not running.
    if (result?.hot_reload_success === false) {
      apiLogger.warn('[postRestartRecovery] prism.rebuild: the core rejected the reload');
      return 1;
    }
    return 0;
  } catch (e) {
    apiLogger.warn('[postRestartRecovery] prism.rebuild failed:', e);
    return 1;
  }
}

/**
 * Recovery step 2: counts each override script that failed.
 * @returns {Promise<number>}
 */
async function reapplyOverridesStep() {
  try {
    const { overrideApplyAll } = await import('./prism.js');
    const logs = await overrideApplyAll();
    const overrideLogs = Array.isArray(logs) ? logs : [];
    const successCount = overrideLogs.filter(l => l?.success).length;
    const failCount = overrideLogs.filter(l => !l?.success).length;
    if (overrideLogs.length > 0) {
      apiLogger.info(`[postRestartRecovery] override_apply_all: ${successCount} succeeded, ${failCount} failed`);
    }
    return failCount;
  } catch (e) {
    apiLogger.warn('[postRestartRecovery] override_apply_all failed:', e);
    return 1;
  }
}

/**
 * Recovery step 3. The core is waited for once: one that is not ready
 * counts as one failure, and the selection restore (which needs it) is
 * skipped rather than waiting all over again.
 * @param {string} configName
 * @returns {Promise<number>}
 */
async function restoreSelectionStep(configName) {
  try {
    const { restoreProxySelectionResult, waitForMihomoReady } = await import('./proxy-memory.js');
    if (!(await waitForMihomoReady())) {
      apiLogger.warn('[postRestartRecovery] the core did not become ready');
      return 1;
    }
    // It reports its own errors instead of throwing.
    return await restoreProxySelectionResult(configName) === 'failed' ? 1 : 0;
  } catch (e) {
    apiLogger.warn('[postRestartRecovery] restoreProxySelection failed:', e);
    return 1;
  }
}

/**
 * Run a core restart started outside the network lock (custom arguments,
 * backup import, the Proxies page restart) under that lock, so a
 * lightweight-mode close only hides the page meanwhile. When another
 * operation (a core update, a subscription switch) holds the lock this
 * refuses instead of restarting over it: that holder could also release the
 * lock, and with it the page, while this work still runs.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withPageBusy(fn) {
  if (appStore.get('isNetworkUpdating')) {
    throw new Error(t('updNetworkBusy') || 'Another network change is in progress. Try again when it finishes.');
  }
  appStore.set('isNetworkUpdating', true);
  try {
    return await fn();
  } finally {
    appStore.set('isNetworkUpdating', false);
  }
}

/**
 * The profile a restart actually loaded, for postRestartRecovery: it may
 * have fallen back from the requested one ('' for the minimal config).
 * @param {any} coreResult what restartCore returned
 * @param {string} requested
 * @returns {string}
 */
export function restartedProfile(coreResult, requested) {
  if (coreResult && 'active_config' in coreResult) return coreResult.active_config ?? '';
  return requested;
}

/**
 * Post-restart recovery: rebuild prism patches, reapply all override scripts,
 * restore the last proxy selection, and refresh the proxy UI.
 *
 * Must be called after every `restartCore()` invocation — `restartCore`
 * rewrites `run_config.yaml` from the raw profile, so all previously-applied
 * overrides (JS proxy-groups, Prism YAML patches, etc.) are lost.
 *
 * Each step's failure is logged and the remaining steps still run.
 *
 * @param {string} configName - The active profile name (used for restoreProxySelection).
 * @returns {Promise<{ failed: number }>} How many steps did not complete,
 *   counting each override script that failed to apply.
 */
export async function postRestartRecovery(configName) {
  let failed = 0;
  invalidateRunConfigCache();

  // 1. Rebuild prism patches (__when__.profile conditions need re-evaluation)
  failed += await rebuildPrismStep();

  // 2. Re-apply all enabled override scripts
  //    JS overrides may modify proxy-groups; without re-execution, rules
  //    referencing those groups will fail.
  failed += await reapplyOverridesStep();

  // 3. Restore last proxy selection for this profile
  //    Re-invalidate run_config cache — the concurrent CORE_RESTARTED
  //    → renderProxies() handler may have repopulated it with pre-override
  //    data (GH#603 race condition).
  invalidateRunConfigCache();
  failed += await restoreSelectionStep(configName);

  // 4. Refresh frontend proxy display (overrides may have modified proxy-groups)
  //    Cache invalidations happen AFTER overrides are applied and BEFORE rendering.
  //    The earlier invalidation at the top of this function may have been
  //    repopulated by the CORE_RESTARTED → renderProxies() handler, which runs
  //    concurrently and can re-fill run_config/proxies caches with pre-override
  //    data (race condition — see GH#603).
  try {
    const { Bus, Events } = await import('./events.js');
    const { startSmartAutoTest, syncCoreConfig } = await import('./proxies.js');
    // Re-invalidate all caches after overrides applied, before rendering.
    // This clears any stale data repopulated by the CORE_RESTARTED render cycle.
    // Rendering is handled by the CONFIG_UPDATED event below — no need for
    // an explicit renderProxies() call (which would cause a redundant double render).
    invalidateProxiesCache();
    invalidateConfigCache();
    invalidateRunConfigCache();
    try {
      await syncCoreConfig();
    } catch (e) {
      apiLogger.warn('[postRestartRecovery] syncing the core config failed:', e);
      failed += 1;
    }
    // reloaded: the running config was replaced (DNS rewrite re-applies).
    // Emitted even when the sync above failed: the reload happened anyway.
    // Handlers hand back the work that restores the config (the DNS
    // rewrite); recovery, and the page hold around it, wait for it. Work
    // that resolves to false, or rejects, could not be restored.
    /** @type {Promise<unknown>[]} */
    const restoring = [];
    Bus.emit(Events.CONFIG_UPDATED, { reloaded: true, waitFor: (/** @type {Promise<unknown>} */ p) => { restoring.push(p); } });
    for (const r of await Promise.allSettled(restoring)) {
      if (r.status === 'rejected' || r.value === false) {
        apiLogger.warn('[postRestartRecovery] restoring the config after the reload failed', r.status === 'rejected' ? r.reason : '');
        failed += 1;
      }
    }
    startSmartAutoTest();
  } catch (e) {
    apiLogger.warn('[postRestartRecovery] refresh proxies failed:', e);
    failed += 1;
  }
  return { failed };
}
