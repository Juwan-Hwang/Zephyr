// @ts-check
import { setWsBaseUrl, setWsSecret } from './websocket.js';
import { COMMANDS } from '@zephyr/shared';
import { apiLogger } from './utils/logger.js';
import { Bus, Events } from './ui/events.js';
import { appStore } from './ui/state.js';
import { invalidateSettingsCache } from './ui/cache.js';
import { invalidateRunConfigCache } from './ui/run-config-cache.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Internal state (declared early — used by apiFetch below)
// ═══════════════════════════════════════════════════════════════════════════════

/** @type {string} mihomo RESTful API 基地址 */
let BASE_URL = 'http://127.0.0.1:9090';

/** 运行时状态（sealed，防止意外扩展） */
const _state = Object.seal({ secret: '' });

// ═══════════════════════════════════════════════════════════════════════════════
//  ApiError — 统一错误类型
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * REST API 统一错误类。
 * 所有 apiFetch 及上层业务函数在遇到异常时均抛出此类型，
 * 方便调用方按 `instanceof ApiError` 做统一拦截。
 *
 * @example
 * try {
 *   const cfg = await getConfig();
 * } catch (e) {
 *   if (e instanceof ApiError) console.warn(e.status, e.endpoint);
 * }
 */
export class ApiError extends Error {
  /**
   * @param {string}  message   - 人类可读的错误描述
   * @param {object}  [opts]
   * @param {number}  [opts.status]    - HTTP 状态码（若有）
   * @param {string}  [opts.endpoint]  - 请求的 API 路径
   * @param {Error}   [opts.cause]     - 原始异常
   */
  constructor(message, { status, endpoint, cause } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status ?? null;
    this.endpoint = endpoint ?? null;
    this.cause = cause ?? null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  apiFetch — 带超时的 fetch 封装
// ═══════════════════════════════════════════════════════════════════════════════

/** @type {number} 默认超时 10 s */
const DEFAULT_TIMEOUT = 10_000;

/**
 * 对原生 fetch 的封装，自动注入请求头、超时控制与错误归一化。
 *
 * - 自动携带 `Authorization`（若已设置 secret）
 * - 默认 10 s 超时，可通过 `timeout` 选项覆盖
 * - HTTP 非 2xx 响应统一抛出 {@link ApiError}
 * - 网络异常 / 超时同样抛出 {@link ApiError}
 *
 * @param {string} endpoint  - 相对于 BASE_URL 的路径，如 `/proxies`
 * @param {RequestInit & { timeout?: number }} [init]
 * @returns {Promise<Response>}
 * @throws {ApiError}
 */
async function apiFetch(endpoint, init = {}) {
  const { timeout = DEFAULT_TIMEOUT, signal: externalSignal, headers, ...rest } = init;
  const safeTimeout = Math.max(1000, Math.min(timeout, 300000));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), safeTimeout);

  // 外部信号（如 testProxy 的全局中止）与内部超时联动
  if (externalSignal?.aborted) {
    clearTimeout(timer);
    throw new ApiError(`Request cancelled: ${endpoint}`, { endpoint, cause: new DOMException('Aborted', 'AbortError') });
  }
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    const res = await fetch(`${BASE_URL}${endpoint}`, {
      ...rest,
      signal: controller.signal,
      headers: { ...getHeaders(), ...headers },
    });

    if (!res.ok) {
      throw new ApiError(`HTTP ${res.status}: ${res.statusText}`, {
        status: res.status,
        endpoint,
      });
    }

    return res;
  } catch (err) {
    if (err instanceof ApiError) throw err;

    const error = /** @type {Error} */ (err);
    const isAbort = error.name === 'AbortError';
    throw new ApiError(
      isAbort ? `Request timeout (${timeout}ms): ${endpoint}` : `Network request failed: ${endpoint}`,
      { endpoint, cause: error },
    );
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Tauri IPC bridge (withGlobalTauri: false)
// ═══════════════════════════════════════════════════════════════════════════════
// When withGlobalTauri is false, Tauri v2 still injects __TAURI_INTERNALS__
// into the webview. Unlike __TAURI__, the internal object has a FLAT structure:
//   invoke / transformCallback / metadata are directly on the root — NOT under .core
const _t = typeof window !== 'undefined' ? window.__TAURI_INTERNALS__ : undefined;

/** Raw IPC invoke: sends a command to the Rust backend
 * @param {string} cmd
 * @param {any} [args]
 * @returns {Promise<any>}
 */
function invoke(cmd, args) {
  if (!_t?.invoke) throw new Error('[API] Tauri IPC not available');
  return _t.invoke(cmd, args);
}

/** Listen to a Tauri event emitted from Rust backend.
 *  Since the event plugin's JS shim isn't loaded without global Tauri,
 *  we manually wire up via transformCallback + raw IPC.
 * @param {string} event
 * @param {(event: any) => void} handler
 * @returns {Promise<() => void>}
 */
async function listen(event, handler) {
  if (!_t?.transformCallback) throw new Error('[API] Tauri IPC not available');
  const callbackId = _t.transformCallback(/** @type {(...args: any[]) => void} */ (handler));
  let eventId;
  try {
    eventId = await invoke('plugin:event|listen', {
      event,
      target: { kind: 'Any' },
      handler: callbackId,
    });
  } catch (e) {
    _t.transformCallback(undefined, false, callbackId);
    throw e;
  }
  return async () => {
    _t.transformCallback(undefined, false, callbackId);
    await invoke('plugin:event|unlisten', { event, eventId });
  };
}

/** Open URL in system default browser
 * @param {string} url
 * @returns {Promise<void>}
 */
async function openUrl(url) {
  return invoke('plugin:opener|open_url', { url });
}

/** Get a lightweight current-window handle (manual IPC wrapper) */
function getCurrentWindow() {
  const label = _t?.metadata?.currentWindow?.label ?? 'main';
  return {
    label,
    hide:        () => invoke('plugin:window|set_visible', { label, value: false }),
    show:        () => invoke('plugin:window|set_visible', { label, value: true }),
    close:       () => invoke('plugin:window|close',           { label }),
    minimize:    () => invoke('plugin:window|minimize',         { label }),
    maximize:    () => invoke('plugin:window|maximize',         { label }),
    setTitle: (/** @type {string} */ t) => invoke('plugin:window|set_title',         { label, value: t }),
    /** @returns {Promise<boolean>} */
    isVisible:    () => invoke('plugin:window|is_visible',      { label }),
    setFocus:     () => invoke('plugin:window|set_focus',        { label }),
  };
}

// Re-export for all other modules
export { invoke, listen, openUrl, getCurrentWindow };

// ═══════════════════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 设置 API 基地址
 * @param {string} url - 完整的 HTTP 基地址，如 `http://127.0.0.1:9090`
 */
export function setBaseUrl(url) {
  BASE_URL = url;
}

/**
 * 设置 API Secret（用于 Bearer Token 认证）
 * @param {string} s
 */
export function setSecret(s) {
  _state.secret = s || '';
}

/**
 * 构造通用请求头
 * @returns {Record<string, string>}
 */
function getHeaders() {
  /** @type {Record<string, string>} */
  const headers = { 'Content-Type': 'application/json' };
  if (_state.secret) {
    headers['Authorization'] = `Bearer ${_state.secret}`;
  }
  return headers;
}

/**
 * 判断是否为"自启动注册表项不存在"的系统错误。
 * Windows 上表现为 os error 2 或中文/英文找不到文件的提示。
 *
 * @param {*} err
 * @returns {boolean}
 */
function isMissingAutostartEntryError(err) {
  const message = String(err || '').toLowerCase();
  return (
    message.includes('os error 2') ||
    message.includes('系统找不到指定的文件') ||
    message.includes('cannot find the file specified')
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  REST API — Proxies
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 获取全部代理组数据
 * @returns {Promise<Object>} mihomo `/proxies` 响应体
 * @throws {ApiError} 请求失败时抛出
 */
export async function getProxies() {
  const res = await apiFetch('/proxies');
  return res.json();
}

/**
 * 切换代理组中的选中节点
 * @param {string} group - 代理组名称
 * @param {string} name  - 目标节点名称
 * @returns {Promise<boolean>} 是否成功
 * @throws {ApiError}
 */
export async function switchProxy(group, name) {
  try {
    const res = await apiFetch(`/proxies/${encodeURIComponent(group)}`, {
      method: 'PUT',
      body: JSON.stringify({ name }),
    });
    return res.ok;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  REST API — Config
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 获取当前核心运行配置
 * @returns {Promise<Object>} mihomo `/configs` 响应体
 * @throws {ApiError} 请求失败时抛出
 */
export async function getConfig() {
  const res = await apiFetch('/configs');
  return res.json();
}

/**
 * 动态修改核心配置 (PATCH)
 * @param {Object} payload - 要合并的配置片段
 * @returns {Promise<boolean>} 是否成功
 * @throws {ApiError}
 */
export async function patchConfig(payload) {
  await apiFetch('/configs', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  return true;
}

/**
 * 从磁盘热重载核心配置文件
 * @param {string} [path='run_config.yaml'] - 配置文件名（仅用于语义，实际由 core 决定）
 * @returns {Promise<boolean>} 是否成功
 */
export async function reloadConfig(_path = 'run_config.yaml') {
  try {
    const res = await apiFetch('/configs?force=true', {
      method: 'PUT',
      body: JSON.stringify({ path: '', payload: '' }),
    });
    return res.ok;
  } catch (err) {
    apiLogger.debug('reloadConfig failed:', err);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  REST API — Connections
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 断开所有活跃连接
 * @returns {Promise<void>}
 */
export async function closeAllConnections() {
  await apiFetch('/connections', { method: 'DELETE' });
}

/**
 * 获取当前活跃连接列表
 * @returns {Promise<Object>} mihomo `/connections` 响应体
 * @throws {ApiError}
 */
export async function getConnections() {
  const res = await apiFetch('/connections');
  return res.json();
}

/**
 * 关闭指定连接
 * @param {string|string[]} id - 单个连接 ID 或 ID 数组
 * @returns {Promise<void>}
 */
export async function closeConnection(id) {
  const ids = typeof id === 'string' ? [id] : id;
  await apiFetch('/connections', {
    method: 'DELETE',
    body: JSON.stringify({ ids }),
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  REST API — Latency Test
// ═══════════════════════════════════════════════════════════════════════════════

/** 全局延迟测试中止控制器 */
let latencyTestController = new AbortController();

/**
 * 中止所有正在进行的延迟测试，并重置控制器以供后续使用。
 */
export function abortLatencyTests() {
  latencyTestController.abort();
  latencyTestController = new AbortController();
}

/**
 * 测试指定代理节点的延迟
 *
 * 使用 gstatic 204 作为测试 URL，通过 mihomo 的 `/proxies/:name/delay` 端点
 * 发起延迟测量。支持全局中止（`abortLatencyTests`）和单次超时。
 *
 * @param {string}  name            - 代理节点名称
 * @param {number}  [customTimeout=5000] - 单次测试超时（ms）
 * @returns {Promise<number>} 延迟（ms），失败或中止时返回 -1
 */
export async function testProxy(name, customTimeout = 5000) {
  const localController = new AbortController();
  const timeout = setTimeout(() => localController.abort(), customTimeout + 1000);

  const onGlobalAbort = () => localController.abort();
  latencyTestController.signal.addEventListener('abort', onGlobalAbort, { once: true });

  try {
    const testUrl = 'http://www.gstatic.com/generate_204';
    const apiUrl = `/proxies/${encodeURIComponent(name)}/delay?timeout=${customTimeout}&url=${encodeURIComponent(testUrl)}`;

    const res = await apiFetch(apiUrl, {
      signal: localController.signal,
      timeout: customTimeout + 2000,
    });

    if (res.ok) {
      const data = await res.json();
      return data.delay;
    }

    return -1;
  } catch (err) {
    if (err instanceof ApiError && err.status != null) {
      // HTTP 错误（如 404/503/504）— 延迟测试中的正常情况
      return -1;
    }

    if (err instanceof ApiError && err.cause?.name === 'AbortError') {
      // 超时或手动中止
      return -1;
    }

    // 其他网络异常（ERR_CONNECTION_RESET 等）同样静默
    return -1;
  } finally {
    clearTimeout(timeout);
    latencyTestController.signal.removeEventListener('abort', onGlobalAbort);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Tauri Commands — AutoStart / Config / Core
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 启用系统开机自启动
 * @returns {Promise<boolean>} 是否成功
 * @throws {Error}
 */
export async function enableAutoStart() {
  await invoke('plugin:autostart|enable');
  return true;
}

/**
 * 禁用系统开机自启动。
 * 若当前未启用或注册表项不存在，直接返回 false 而不抛异常。
 *
 * @returns {Promise<boolean>} 是否成功禁用
 * @throws {Error}
 */
export async function disableAutoStart() {
  try {
    const enabled = await isAutoStartEnabled();
    if (!enabled) return false;
    await invoke('plugin:autostart|disable');
    return true;
  } catch (err) {
    if (isMissingAutostartEntryError(err)) return false;
    throw err;
  }
}

/**
 * 查询系统开机自启动是否已启用
 * @returns {Promise<boolean>}
 */
export async function isAutoStartEnabled() {
  try {
    return await invoke('plugin:autostart|is_enabled');
  } catch (err) {
    apiLogger.debug('isAutoStartEnabled failed:', err);
    return false;
  }
}

/**
 * 在系统文件管理器中打开配置文件夹
 * @returns {Promise<void>}
 * @throws {Error}
 */
export async function openConfigFolder() {
  return invoke(COMMANDS.OPEN_FOLDER);
}

/**
 * Open the Prism rule library folder in the system file manager.
 */
export async function openPrismFolder() {
  return invoke(COMMANDS.RULE.OPEN_PRISM_FOLDER);
}

/**
 * 重启 mihomo 核心，并同步更新本模块及 websocket 模块的连接参数。
 *
 * @param {string}   configPath        - 配置文件路径
 * @param {string[]} [customArgs=[]]   - 传递给核心的额外命令行参数
 * @returns {Promise<Object>} 核心启动结果（含 port、secret 等）
 * @throws {Error}
 */
export async function restartCore(configPath, customArgs = []) {
  // eslint-disable-next-line no-console
  console.log(`[API] restartCore called (config=${configPath})`);
  const coreResult = await invoke(COMMANDS.START_CORE, {
    configPath,
    test: false,
    customArgs,
  });
  setBaseUrl(`http://127.0.0.1:${coreResult.port}`);
  setSecret(coreResult.secret);
  setWsBaseUrl(`ws://127.0.0.1:${coreResult.port}`);
  setWsSecret(coreResult.secret);
  Bus.emit(Events.CORE_RESTARTED);
  return coreResult;
}

/**
 * Switch to a different subscription config with full lifecycle management.
 * Shared by UI subscription switch and tray subscription switch.
 *
 * Steps:
 *   1. Abort any ongoing latency tests (user-invisible)
 *   2. Save current proxy selection
 *   3. Restart core with new config
 *   4. Update settings, close connections, rebuild prism, restore proxy selection
 *
 * @param {string} configName - Target config file name
 * @param {string[]} [customArgs=[]] - Custom core arguments
 * @returns {Promise<Object>} coreResult from restartCore
 */
export async function switchToConfig(configName, customArgs = []) {
  const t0 = performance.now();

  // Abort ongoing latency tests so mihomo is idle for faster kill
  abortLatencyTests();
  // Also close all connections to unblock mihomo's request queue
  // (delay tests may still be processing server-side even after frontend abort)
  try { await closeAllConnections(); } catch { /* non-fatal */ }
  // eslint-disable-next-line no-console
  console.log(`[switchToConfig] abortLatencyTests took ${Math.round(performance.now() - t0)}ms`);

  // Save current proxy selection before switching
  const t1 = performance.now();
  try {
    const { fetchProxyGroups } = await import('./ui/proxy-groups.js');
    const groupName = appStore.get('uiGroupName');
    // Use a short timeout — if mihomo is busy (e.g. delay tests still queued),
    // fall back to appStore state instead of blocking for seconds
    const fetchPromise = fetchProxyGroups();
    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 500));
    const currentProxyGroups = await Promise.race([fetchPromise, timeoutPromise]);
    if (currentProxyGroups && currentProxyGroups.current) {
      const liveSettings = await invoke(COMMANDS.GET_SETTINGS);
      const activeConfig = liveSettings.last_config || 'config.yaml';
      const { saveProxySelection } = await import('./ui/proxy-memory.js');
      await saveProxySelection(activeConfig, {
        node: currentProxyGroups.current,
        group: groupName,
      });
    }
    // eslint-disable-next-line no-console
    console.log(`[switchToConfig] saveProxySelection took ${Math.round(performance.now() - t1)}ms (fetchProxyGroups ${currentProxyGroups ? 'resolved' : 'timed out'})`);
  } catch { /* non-fatal */ }

  // Restart core
  const t2 = performance.now();
  const coreResult = await restartCore(configName, customArgs);
  // eslint-disable-next-line no-console
  console.log(`[switchToConfig] restartCore took ${Math.round(performance.now() - t2)}ms`);
  if (!coreResult?.secret) throw new Error('Core start failed: no secret returned');

  // Persist new active config
  const t3 = performance.now();
  /** @type {any} */
  const s = await invoke(COMMANDS.GET_SETTINGS);
  s.last_config = configName;
  await invoke(COMMANDS.SAVE_SETTINGS, { settings: s });
  invalidateSettingsCache();
  invalidateRunConfigCache();
  // eslint-disable-next-line no-console
  console.log(`[switchToConfig] saveSettings took ${Math.round(performance.now() - t3)}ms`);

  // Close stale connections
  const t4 = performance.now();
  await closeAllConnections();
  // eslint-disable-next-line no-console
  console.log(`[switchToConfig] closeAllConnections took ${Math.round(performance.now() - t4)}ms`);

  // Rebuild prism patches (__when__.profile conditions need re-evaluation)
  const t5 = performance.now();
  try {
    const { default: prism } = await import('./ui/prism.js');
    await prism.rebuild();
  } catch { /* non-fatal */ }
  // eslint-disable-next-line no-console
  console.log(`[switchToConfig] prism.rebuild took ${Math.round(performance.now() - t5)}ms`);

  // Restore proxy selection
  const t6 = performance.now();
  try {
    const { restoreProxySelection } = await import('./ui/proxy-memory.js');
    await restoreProxySelection(configName);
  } catch { /* non-fatal */ }
  // eslint-disable-next-line no-console
  console.log(`[switchToConfig] restoreProxySelection took ${Math.round(performance.now() - t6)}ms`);

  // eslint-disable-next-line no-console
  console.log(`[switchToConfig] TOTAL: ${Math.round(performance.now() - t0)}ms`);
  return coreResult;
}

/**
 * Read mihomo core log (incremental)
 * @param {number} [offset=0] - Byte offset to start reading from
 * @param {number} [limit=500] - Max lines to read
 * @returns {Promise<{lines: string[], next_offset: number, file_size: number, has_more: boolean, rotated?: boolean}>}
 */
export async function readCoreLog(offset = 0, limit = 500) {
  return invoke(COMMANDS.READ_LOG, { offset, limit });
}
