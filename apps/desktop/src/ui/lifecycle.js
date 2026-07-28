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
      // Use the resolver's uiGroupName when available (it may normalize
      // or fall back from the raw appStore value), falling back to the
      // raw groupName only on timeout.
      const resolvedGroup = currentProxyGroups?.uiGroupName
        || currentProxyGroups?.mainGroup
        || groupName
        || null;
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
 * Post-restart recovery: rebuild prism patches, reapply all override scripts,
 * restore the last proxy selection, and refresh the proxy UI.
 *
 * Must be called after every `restartCore()` invocation — `restartCore`
 * rewrites `run_config.yaml` from the raw profile, so all previously-applied
 * overrides (JS proxy-groups, Prism YAML patches, etc.) are lost.
 *
 * @param {string} configName - The active profile name (used for restoreProxySelection).
 */
export async function postRestartRecovery(configName) {
  invalidateRunConfigCache();

  // 1. Rebuild prism patches (__when__.profile conditions need re-evaluation)
  try {
    const { rebuild } = await import('./prism.js');
    await rebuild();
  } catch (e) {
    apiLogger.warn('[postRestartRecovery] prism.rebuild failed:', e);
  }

  // 2. Re-apply all enabled override scripts
  //    JS overrides may modify proxy-groups; without re-execution, rules
  //    referencing those groups will fail.
  try {
    const { overrideApplyAll } = await import('./prism.js');
    const logs = await overrideApplyAll();
    const overrideLogs = Array.isArray(logs) ? logs : [];
    const successCount = overrideLogs.filter(l => l?.success).length;
    const failCount = overrideLogs.filter(l => !l?.success).length;
    if (overrideLogs.length > 0) {
      apiLogger.info(`[postRestartRecovery] override_apply_all: ${successCount} succeeded, ${failCount} failed`);
    }
  } catch (e) {
    apiLogger.warn('[postRestartRecovery] override_apply_all failed:', e);
  }

  // 3. Restore last proxy selection for this profile
  //    Re-invalidate run_config cache — the concurrent CORE_RESTARTED
  //    → renderProxies() handler may have repopulated it with pre-override
  //    data (GH#603 race condition).
  invalidateRunConfigCache();
  try {
    const { restoreProxySelection } = await import('./proxy-memory.js');
    await restoreProxySelection(configName);
  } catch (e) {
    apiLogger.warn('[postRestartRecovery] restoreProxySelection failed:', e);
  }

  // 4. Refresh frontend proxy display (overrides may have modified proxy-groups)
  //    Cache invalidations happen AFTER overrides are applied and BEFORE rendering.
  //    The earlier invalidation at the top of this function may have been
  //    repopulated by the CORE_RESTARTED → renderProxies() handler, which runs
  //    concurrently and can re-fill run_config/proxies caches with pre-override
  //    data (race condition — see GH#603).
  try {
    const { Bus, Events } = await import('./events.js');
    const { startSmartAutoTest, syncCoreConfig } = await import('./proxies.js');
    const { waitForMihomoReady } = await import('./proxy-memory.js');
    await waitForMihomoReady();
    // Re-invalidate all caches after overrides applied, before rendering.
    // This clears any stale data repopulated by the CORE_RESTARTED render cycle.
    // Rendering is handled by the CONFIG_UPDATED event below — no need for
    // an explicit renderProxies() call (which would cause a redundant double render).
    invalidateProxiesCache();
    invalidateConfigCache();
    invalidateRunConfigCache();
    await syncCoreConfig();
    Bus.emit(Events.CONFIG_UPDATED);
    startSmartAutoTest();
  } catch (e) {
    apiLogger.warn('[postRestartRecovery] refresh proxies failed:', e);
  }
}
