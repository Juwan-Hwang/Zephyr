// @ts-check
/**
 * 核心生命周期管理模块
 *
 * 负责订阅切换等高层 orchestration 逻辑。
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
    const fetchPromise = fetchProxyGroups();
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
      await saveProxySelection(activeConfig, {
        node: nodeToSave,
        group: groupName,
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
  invalidateRunConfigCache();

  // 重建 prism patches（__when__.profile 条件需要重新评估）
  try {
    const { rebuild } = await import('./prism.js');
    await rebuild();
  } catch (e) {
    apiLogger.warn('[switchToConfig] prism.rebuild failed:', e);
  }

  // 重新应用所有启用的覆写脚本（JS 覆写可能修改 proxy-groups 等，
  // 切换订阅后必须重新执行，否则规则引用的代理组可能不存在）
  try {
    const { overrideApplyAll } = await import('./prism.js');
    const logs = await overrideApplyAll();
    const successCount = logs?.filter(l => l.success).length ?? 0;
    const failCount = logs?.filter(l => !l.success).length ?? 0;
    if (logs && logs.length > 0) {
      apiLogger.info(`[switchToConfig] override_apply_all: ${successCount} succeeded, ${failCount} failed`);
    }
  } catch (e) {
    apiLogger.warn('[switchToConfig] override_apply_all failed:', e);
  }

  // 恢复代理选择（使用实际加载的配置）
  try {
    const { restoreProxySelection } = await import('./proxy-memory.js');
    await restoreProxySelection(configToPersist);
  } catch (e) {
    apiLogger.warn('[switchToConfig] restoreProxySelection failed:', e);
  }

  // 刷新前端代理组数据（复用「保存并执行」的逻辑）
  // 覆写脚本可能修改 proxy-groups，必须清缓存并重新渲染
  invalidateProxiesCache();
  invalidateConfigCache();
  (async () => {
    const { renderProxies, startSmartAutoTest } = await import('./proxies.js');
    const { waitForMihomoReady } = await import('./proxy-memory.js');
    await waitForMihomoReady();
    await renderProxies();
    startSmartAutoTest();
  })().catch(e => apiLogger.warn('[switchToConfig] renderProxies failed:', e));

  return {
    ...coreResult,
    /** @type {boolean} Whether a fallback occurred (requested config was invalid) */
    fallbackOccurred: !!(fallbackOccurred || noConfigLoaded),
    /** @type {string|null} The actual config that was loaded */
    actualConfig: actualConfig,
  };
}
