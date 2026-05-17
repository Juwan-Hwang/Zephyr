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
import { invalidateSettingsCache } from './cache.js';
import { invalidateRunConfigCache } from './run-config-cache.js';

/**
 * 切换到指定配置（订阅）
 * @param {string} configName - 目标配置文件名
 * @param {string[]} [customArgs=[]] - 自定义核心参数
 * @returns {Promise<Object>} coreResult
 */
export async function switchToConfig(configName, customArgs = []) {
  // 中止正在进行的延迟测试，让 mihomo 处于空闲状态以便更快 kill
  abortLatencyTests();
  // 关闭所有连接以解除 mihomo 的请求队列阻塞（给后续 fetchProxyGroups 解堵）
  try { await closeAllConnections(); } catch { /* non-fatal */ }

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
  } catch { /* non-fatal */ }

  // 重启核心
  const coreResult = await restartCore(configName, customArgs);
  if (!coreResult?.secret) throw new Error('Core start failed: no secret returned');

  // 持久化新活动配置（原子更新，避免 RMW 竞态）
  await invoke(COMMANDS.UPDATE_LAST_CONFIG, { configName });
  invalidateSettingsCache();
  invalidateRunConfigCache();

  // 重建 prism patches（__when__.profile 条件需要重新评估）
  try {
    const { default: prism } = await import('./prism.js');
    await prism.rebuild();
  } catch { /* non-fatal */ }

  // 恢复代理选择
  try {
    const { restoreProxySelection } = await import('./proxy-memory.js');
    await restoreProxySelection(configName);
  } catch { /* non-fatal */ }

  return coreResult;
}
