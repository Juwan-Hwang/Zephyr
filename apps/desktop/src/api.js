// @ts-check
import { DEFAULT_LATENCY_TEST_URL } from './latency-defaults.js';
import { setWsBaseUrl, setWsSecret } from './websocket.js';
import { COMMANDS } from '@zephyr/shared';
import { apiLogger } from './utils/logger.js';
import { Bus, Events } from './ui/events.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Internal state (declared early — used by apiFetch below)
// ═══════════════════════════════════════════════════════════════════════════════

/** @type {string} mihomo RESTful API 基地址 */
let BASE_URL = 'http://127.0.0.1:9090';

/** 运行时状态（sealed，防止意外扩展） */
const _state = Object.seal({ secret: '' });

/** @type {boolean} 内核是否可达（连接未被拒绝） */
let _coreReachable = true;

/** @type {boolean} 是否已输出过一次连接拒绝日志（避免重复报错） */
let _connectionRefusedLogged = false;

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
   * @param {string}  [opts.body]      - 非 2xx 响应的正文（截断，若可读）
   */
  constructor(message, { status, endpoint, cause, body } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status ?? null;
    this.endpoint = endpoint ?? null;
    this.cause = cause ?? null;
    this.body = body ?? null;
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
 * @param {RequestInit & { timeout?: number, abortAfterHeaders?: boolean }} [init]
 *   `abortAfterHeaders`: the caller's `signal` keeps aborting the request
 *   after the response is returned (while its body is read); otherwise it is
 *   detached.
 * @returns {Promise<Response>}
 * @throws {ApiError}
 */
async function apiFetch(endpoint, init = {}) {
  const { timeout = DEFAULT_TIMEOUT, signal: externalSignal, abortAfterHeaders = false, headers, ...rest } = init;
  // Query values can contain signed test URLs. Diagnostics only need the route.
  const diagnosticEndpoint = endpoint.split('?')[0];
  const safeTimeout = Math.max(1000, Math.min(timeout, 300000));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), safeTimeout);

  // 外部信号（如 testProxy 的全局中止）与内部超时联动
  if (externalSignal?.aborted) {
    clearTimeout(timer);
    throw new ApiError(`Request cancelled: ${diagnosticEndpoint}`, { endpoint: diagnosticEndpoint, cause: new DOMException('Aborted', 'AbortError') });
  }
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  const detachExternal = () => externalSignal?.removeEventListener('abort', onExternalAbort);

  try {
    const res = await fetch(`${BASE_URL}${endpoint}`, {
      ...rest,
      signal: controller.signal,
      headers: { ...getHeaders(), ...headers },
    });

    if (!res.ok) {
      /** @type {string|undefined} */
      let body;
      try { body = (await res.text()).slice(0, 2000); } catch { /* unreadable body */ }
      throw new ApiError(`HTTP ${res.status}: ${res.statusText}`, {
        status: res.status,
        endpoint: diagnosticEndpoint,
        body,
      });
    }

    // 请求成功 — 标记内核可达
    if (!_coreReachable) {
      _coreReachable = true;
      _connectionRefusedLogged = false;
      apiLogger.info('core connection restored');
    }

    if (!abortAfterHeaders) detachExternal();
    return res;
  } catch (err) {
    detachExternal();
    if (err instanceof ApiError) throw err;

    const error = /** @type {Error} */ (err);
    const isAbort = error.name === 'AbortError';

    // 检测连接被拒绝（内核未运行）
    const isConnectionRefused = !isAbort && isConnectionRefusedError(error);

    if (isConnectionRefused) {
      _coreReachable = false;
      // 只在首次连接拒绝时输出 warn，后续降级为 debug
      if (!_connectionRefusedLogged) {
        _connectionRefusedLogged = true;
        apiLogger.warn(`core unreachable: ${diagnosticEndpoint}`);
      } else {
        apiLogger.debug(`core unreachable: ${diagnosticEndpoint}`);
      }
    }

    throw new ApiError(
      isAbort ? (externalSignal?.aborted ? `Request cancelled: ${diagnosticEndpoint}` : `Request timeout (${timeout}ms): ${diagnosticEndpoint}`) : `Network request failed: ${diagnosticEndpoint}`,
      { endpoint: diagnosticEndpoint, cause: error },
    );
  } finally {
    clearTimeout(timer);
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

/**
 * Whether the Tauri IPC bridge is available in this page. Callers
 * whose call is best-effort check this first instead of catching the
 * synchronous throw `invoke` makes without a bridge: the throw happens
 * after the caller's own work already applied, and catching it around
 * a promise-returning call reads as if the catch were for the
 * rejection.
 * @returns {boolean}
 */
export function isIpcAvailable() {
  return typeof _t?.invoke === 'function';
}

/** Listen to a Tauri event emitted from Rust backend.
 *  Since the event plugin's JS shim isn't loaded without global Tauri,
 *  we manually wire up via transformCallback + raw IPC.
 *
 *  When Tauri v2 fires an event via `WebviewWindow::emit()`, the runtime's
 *  `event_initialization_script` dispatches to the callback registered
 *  here. The callback receives the full TauriEvent object:
 *  `{ event: string, payload: T, id: number }`.
 *
 * @param {string} event
 * @param {(event: { payload: any, event: string, id: number }) => void} handler
 * @returns {Promise<() => Promise<void>>}
 */
async function listen(event, handler) {
  if (!_t?.transformCallback) throw new Error('[API] Tauri IPC not available');

  const callbackId = _t.transformCallback(handler);
  let eventId;
  try {
    eventId = await invoke('plugin:event|listen', {
      event,
      target: { kind: 'Window', label: 'main' },
      handler: callbackId,
    });
  } catch (e) {
    // Best-effort cleanup: if this throws, we must still rethrow the
    // original `invoke('plugin:event|listen')` error, not the cleanup error.
    try {
      if (typeof _t.unregisterCallback === 'function') {
        _t.unregisterCallback(callbackId);
      } else {
        _t.transformCallback(undefined, false, callbackId);
      }
    } catch (cleanupErr) {
      apiLogger.warn(`[API] cleanup after failed listen for event "${event}" threw:`, cleanupErr);
    }
    throw e;
  }
  return async () => {
    // Deregister the JS callback. Tauri v2 exposes `unregisterCallback(id)`
    // for this purpose; `transformCallback(undefined, …)` does NOT
    // deregister an existing callback — the third argument is ignored.
    // Fall back to transformCallback for older Tauri versions that lack
    // unregisterCallback.
    try {
      if (typeof _t.unregisterCallback === 'function') {
        _t.unregisterCallback(callbackId);
      } else {
        _t.transformCallback(undefined, false, callbackId);
      }
    } catch (err) {
      apiLogger.warn(`[API] unregisterCallback(${callbackId}) failed:`, err);
    }
    // Clean up the listener entry from the internal listeners object.
    // Tauri's unlisten_js_script only calls unregisterCallback but does NOT
    // delete `obj[event][eventId]`, leaving a stale entry. This causes
    // emit_to_main to falsely believe a listener still exists and dispatch
    // events to a dead callback (which silently fails, losing the event).
    //
    // The `delete` may throw TypeError if the property is non-configurable
    // (sealed/frozen internal object). We only catch TypeError so that other
    // unexpected failures are not silently masked.
    try {
      const obj = /** @type {any} */ (window)['__internal_unstable_listeners_object_id__'];
      if (obj?.[event]) {
        delete obj[event][eventId];
        // If no listeners remain for this event, clean up the event key too
        // so emit_to_main correctly detects "no listeners" and buffers the event.
        if (Object.getOwnPropertyNames(obj[event]).length === 0) {
          delete obj[event];
        }
      }
    } catch (err) {
      if (err instanceof TypeError) {
        // Non-configurable property — expected on sealed/frozen internal objects.
        apiLogger.warn(`[API] listener-map cleanup for event "${event}" skipped (non-configurable)`);
      } else {
        throw err;
      }
    }
    await invoke('plugin:event|unlisten', { event, eventId });
  };
}

/** Open URL in system default browser
 * @param {string} url
 * @returns {Promise<void>}
 */
async function openUrl(url) {
  const raw = typeof url === 'string' ? url : '';
  // Strip leading/trailing Unicode whitespace AND control characters: the
  // old String.trim() missed controls like U+0001, while a <=0x20-only loop
  // missed Unicode padding like U+00A0/U+FEFF.
  const trimmed = raw.replace(/^[\s\u0000-\u0020]+|[\s\u0000-\u0020]+$/g, '');

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ApiError('openUrl only supports http and https URLs');
  }

  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    !parsed.hostname ||
    !/^https?:\/\/[^/\\]/i.test(trimmed)
  ) {
    throw new ApiError('openUrl only supports http and https URLs');
  }

  // Forward the parsed, normalized URL — never the raw input: the WHATWG
  // parser silently drops embedded tab/LF/CR, so forwarding the raw string
  // would hand the OS handler a different URL than the one validated here.
  return invoke('plugin:opener|open_url', { url: parsed.href });
}

/** Get a lightweight current-window handle (manual IPC wrapper) */
function getCurrentWindow() {
  const label = _t?.metadata?.currentWindow?.label ?? 'main';
  return {
    label,
    hide:        () => invoke('plugin:window|hide',             { label }),
    show:        () => invoke('plugin:window|show',             { label }),
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
  if (BASE_URL !== url) clearProviderCache();
  BASE_URL = url;
}

/**
 * 设置 API Secret（用于 Bearer Token 认证）
 * @param {string} s
 */
export function setSecret(s) {
  if (_state.secret !== (s || '')) clearProviderCache();
  _state.secret = s || '';
}

/**
 * 判断错误是否为"连接被拒绝"（内核未运行）
 * 用于 apiFetch 和 websocket.js 共享同一检测逻辑。
 *
 * @param {Error} error
 * @returns {boolean}
 */
export function isConnectionRefusedError(error) {
  const msg = typeof error?.message === 'string' ? error.message : '';
  if (!msg) return false;
  return (
    msg.includes('Failed to fetch') ||
    msg.includes('NetworkError') ||
    msg.includes('Connection refused') ||
    msg.includes('ERR_CONNECTION_REFUSED') ||
    msg.includes('Load failed')
  );
}

/**
 * 查询内核是否可达
 * @returns {boolean}
 */
export function isCoreReachable() {
  return _coreReachable;
}

/**
 * 设置内核可达状态（内核重启成功后调用重置为 true）
 * @param {boolean} reachable
 */
export function setCoreReachable(reachable) {
  _coreReachable = reachable;
  if (reachable) {
    _connectionRefusedLogged = false;
  }
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
  const desktop = isIpcAvailable();
  // A known reload spanning this read is retried once. If native IPC is
  // unavailable on either side, keep ordinary controller data usable under
  // the frontend generation check, without claiming native confirmation.
  for (let attempt = 0; attempt < 2; attempt++) {
    const generation = _providerGen;
    const nativeBefore = desktop ? await speedTestGeneration().catch(() => null) : null;
    let data;
    try {
      data = await apiJson('/proxies');
    } catch (error) {
      const nativeAfter = desktop ? await speedTestGeneration().catch(() => null) : null;
      const changed = generation !== _providerGen
        || (nativeBefore !== null && nativeAfter !== null && nativeBefore !== nativeAfter);
      if (attempt === 0 && changed) continue;
      throw error;
    }
    const reserved = hasOwn(data?.proxies ?? {}, SPEED_TEST_GROUP);
    const owned = !desktop || !reserved ? false : nativeBefore === null ? null
      : await diagnosticInvoke(COMMANDS.SPEED_TEST_GROUP_OWNED).catch(() => null);
    const nativeAfter = desktop ? await speedTestGeneration().catch(() => null) : null;
    const nativeUnknown = nativeBefore === null || nativeAfter === null;
    if (generation === _providerGen && (nativeUnknown || nativeBefore === nativeAfter)) {
      // Unknown native generation is a degraded REST read: ownership is
      // unknown too, so withhold only the reserved entry. A later backend
      // invalidation refreshes ordinary nodes; confirmed user entries stay.
      return stripSpeedTestGroup(data, desktop && nativeUnknown ? null : owned);
    }
  }
  throw new ApiError('Proxy configuration kept changing during the read');
}

/** Hidden group the app adds to every runtime config for the download speed test. */
export const SPEED_TEST_GROUP = 'ZEPHYR-SPEED-TEST';

/**
 * Remove the speed-test group from a `/proxies` body: it is plumbing, never
 * something to show or pick, and GLOBAL would otherwise list it as a card.
 * Only the hidden group the app adds goes: a profile's own node, or its own
 * visible group, under that name stays (the backend then adds nothing).
 * @template T
 * @param {T} data
 * @param {boolean|null} [owned] null withholds the ambiguous reserved entry
 * @returns {T}
 */
export function stripSpeedTestGroup(data, owned = false) {
  const proxies = /** @type {any} */ (data)?.proxies;
  if (owned === false || !proxies || typeof proxies !== 'object' || !hasOwn(proxies, SPEED_TEST_GROUP)) return data;
  const entry = proxies[SPEED_TEST_GROUP];
  if (!Array.isArray(entry?.all) || entry.hidden === false) return data;
  if (owned === null && entry.type && String(entry.type).toLowerCase() !== 'selector') return data;
  delete proxies[SPEED_TEST_GROUP];
  for (const entry of Object.values(proxies)) {
    if (Array.isArray(entry?.all) && entry.all.includes(SPEED_TEST_GROUP)) {
      entry.all = entry.all.filter((/** @type {string} */ n) => n !== SPEED_TEST_GROUP);
    }
  }
  return data;
}

/**
 * 获取全部代理提供者数据（含 provider 下载的节点详情）
 * mihomo 的 /proxies API 不包含 proxy-provider 下载的节点，
 * 需要通过 /providers/proxies 获取。
 * @returns {Promise<Object>} mihomo `/providers/proxies` 响应体
 * @throws {ApiError}
 */
export async function getProxyProviders() {
  return apiJson('/providers/proxies');
}

/** @param {unknown} err */
function isNotFound(err) {
  return err instanceof ApiError && err.status === 404;
}

/**
 * Resolves null once `signal` aborts (now, when it already has).
 * @param {AbortSignal} signal
 * @returns {Promise<null>}
 */
function whenAborted(signal) {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(null);
    else signal.addEventListener('abort', () => resolve(null), { once: true });
  });
}

/** @type {{ gen: number, ts: number, map: Map<string, string> } | null} */
let _nodeProviders = null;
const _NODE_PROVIDERS_TTL = 30_000;
/** Negative lookup retry timestamps, avoiding one refresh for every missing node probe. */
const _providerMisses = new Map();
/** The read under way, shared by every test waiting on it. @type {{ gen: number, done: Promise<boolean> } | null} */
let _nodeProvidersLoad = null;

/** Read which provider supplies each node, once for all callers at a time. */
function loadNodeProviders() {
  if (_nodeProvidersLoad && _nodeProvidersLoad.gen === _providerGen) return _nodeProvidersLoad.done;
  const gen = _providerGen;
  const ts = Date.now();
  /** @type {{ gen: number, done: Promise<boolean> }} */
  const entry = { gen, done: Promise.resolve(false) };
  _nodeProvidersLoad = entry;
  entry.done = (async () => {
    try {
      const resp = /** @type {any} */ (await getProxyProviders());
      // The config reloaded meanwhile: this list may name the old providers.
      if (gen !== _providerGen) return false;
      /** @type {Map<string, string>} */
      const map = new Map();
      const ambiguous = new Set();
      for (const [key, provider] of Object.entries(resp?.providers ?? {})) {
        const pname = typeof provider?.name === 'string' && provider.name ? provider.name : key;
        for (const proxy of Array.isArray(provider?.proxies) ? provider.proxies : []) {
          if (!proxy?.name) continue;
          // Group provider order, not this JSON object's order, decides which
          // duplicate is selected. A name alone cannot identify its endpoint.
          if (map.has(proxy.name)) ambiguous.add(proxy.name);
          else map.set(proxy.name, pname);
        }
      }
      for (const name of ambiguous) map.delete(name);
      _nodeProviders = { gen, ts, map };
      return true;
    } catch {
      // No list: the callers find no provider.
      return false;
    } finally {
      if (_nodeProvidersLoad === entry) _nodeProvidersLoad = null;
    }
  })();
  return entry.done;
}

/**
 * The proxy-provider that supplies node `name`, or null. Mihomo's
 * `/proxies/:name` routes do not reach such nodes (404); its provider's
 * `/providers/proxies/:provider/:name` routes do. Read once per 30 s, so a
 * group of provider nodes tested in a row asks the core once; a node the
 * list lacks (added by a provider since) has it read again.
 * @param {string} name
 * @param {boolean} [refresh] refresh after a cached provider route disappeared
 * @returns {Promise<string | null>}
 */
async function providerOfNode(name, refresh = false) {
  const generation = _providerGen;
  const current = () => (_nodeProviders && _nodeProviders.gen === _providerGen ? _nodeProviders : null);
  const age = () => Date.now() - (current()?.ts ?? 0);
  if (refresh || !current() || age() >= _NODE_PROVIDERS_TTL || (!current()?.map.has(name) && Date.now() - (_providerMisses.get(name) ?? 0) >= 2000)) {
    const loaded = await loadNodeProviders();
    if (!loaded) return null;
    if (generation !== _providerGen) return null;
    if (!current()?.map.has(name)) _providerMisses.set(name, Date.now());
  }
  return generation === _providerGen ? current()?.map.get(name) ?? null : null;
}

// ── Provider 缓存（避免轮询期间重复拉取 /providers/proxies） ─────────────
/** @type {any} */
let _providerCache = null;
/** @type {any} */
let _providerInFlight = null;
let _providerGen = 0; // Incremented on core restart to invalidate in-flight requests
const _PROVIDER_CACHE_TTL = 5000;
const _PROVIDER_CACHE_PARTIAL_TTL = 1500; // Aligned with poller interval (1.5s)

// Safari/old WebView compat: Object.hasOwn is not available everywhere
const hasOwn = (/** @type {any} */ obj, /** @type {string} */ key) => Object.prototype.hasOwnProperty.call(obj, key); // NOSONAR — intentional compat workaround

/**
 * Built-in proxy names that never have detail records in /proxies.
 * Shared between api.js and ui/proxies.js to prevent drift.
 */
export const SPECIAL_PROXY_NAMES = Object.freeze(new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'COMPATIBLE', 'PASS', 'PASS-RULE']));

/**
 * Clear provider cache. Called on core restart to prevent stale data.
 */
export function clearProviderCache() {
  _providerMisses.clear();
  // A latency result belongs to the configuration under which it started.
  // Aborting its pass lets callers discard it instead of scoring a timeout.
  abortLatencyTests();
  // Future probes belong to the new configuration; old callers retain their
  // aborted signal and cannot publish the previous generation's results.
  resetLatencyTestController();
  _providerCache = null;
  _providerInFlight = null;
  _providerGen++;
}

/** Current controller configuration/cache generation for asynchronous UI reads. */
export function providerGeneration() {
  return _providerGen;
}

/**
 * Collect proxy names from all group.all[] arrays.
 * @param {Record<string, any>} proxiesMap - The proxies map from /proxies
 * @returns {Set<string>} All names found in any group's all[]
 */
function collectAllProxyNames(proxiesMap) {
  const names = new Set();
  for (const key of Object.keys(proxiesMap)) {
    const entry = proxiesMap[key];
    if (entry?.all && Array.isArray(entry.all)) {
      for (const name of entry.all) {
        if (typeof name === 'string') names.add(name);
      }
    }
  }
  return names;
}

/**
 * Extract provider nodes from /providers/proxies response into a flat map.
 * @param {any} providersResp - Response from /providers/proxies
 * @returns {Record<string, any>} Map of proxy name → proxy detail
 */
function extractProviderNodes(providersResp) {
  const result = Object.create(null);
  const providers = Object.values(providersResp?.providers ?? {});
  for (const provider of providers) {
    const proxies = Array.isArray(provider?.proxies) ? provider.proxies : [];
    for (const proxy of proxies) {
      if (proxy?.name) result[proxy.name] = proxy;
    }
  }
  return result;
}

/**
 * Check provider cache for a valid hit and merge cached nodes.
 * Returns merged data object if cache hit, null if cache miss.
 * @param {string[]} missingNames - Names missing from /proxies
 * @param {Record<string, any>} mergedProxies - Cloned proxies map to merge into
 * @param {number} now - Current timestamp
 * @param {any} data - Original /proxies response (for spreading)
 * @returns {any | null} Merged data or null
 */
function tryProviderCache(missingNames, mergedProxies, now, data) {
  if (!_providerCache) return null;
  const age = now - _providerCache.ts;
  const cached = _providerCache.proxies;
  // Merge cached provider nodes into mergedProxies (shared by both paths below)
  const mergeCached = () => {
    for (const name of missingNames) {
      if (cached[name]) mergedProxies[name] = cached[name];
    }
  };
  // If previous fetch failed, skip retry within full TTL but still merge
  // last-known-good nodes so UI doesn't lose provider data on transient errors.
  if (_providerCache.failed && age < _PROVIDER_CACHE_TTL) {
    mergeCached();
    return { ...data, proxies: mergedProxies };
  }
  if (age >= _PROVIDER_CACHE_TTL) return null;
  // Merge whatever cached nodes we have (even partial coverage).
  const hasAnyMissing = missingNames.some(n => !cached[n]);
  // If cache doesn't cover all missing names, only use it for a shorter TTL
  // so provider downloads converge faster.
  if (hasAnyMissing && age >= _PROVIDER_CACHE_PARTIAL_TTL) return null;
  mergeCached();
  return { ...data, proxies: mergedProxies };
}

/**
 * 合并 /proxies + /providers/proxies 的数据。
 * 按需懒加载：只有当 /proxies 的节点缺失时才拉 provider 数据。
 *
 * @param {any} [existingData] - 已有的 /proxies 响应（避免重复请求）
 * @returns {Promise<any>} 合并后的数据
 * @throws {ApiError}
 */
export async function getProxiesMerged(existingData) {
  const data = existingData || await getProxies();
  if (!data?.proxies) return data;

  const allNames = collectAllProxyNames(data.proxies);
  const missingNames = [...allNames].filter(
    n => !SPECIAL_PROXY_NAMES.has(n.toUpperCase()) && !hasOwn(data.proxies, n)
  );
  if (missingNames.length === 0) {
    // Opportunistically expire stale cache to free memory
    if (_providerCache && (Date.now() - _providerCache.ts) >= _PROVIDER_CACHE_TTL) {
      _providerCache = null;
    }
    return data;
  }

  const now = Date.now();

  // Clone proxies map with null prototype to prevent prototype pollution
  const mergedProxies = Object.assign(Object.create(null), data.proxies);

  // Cache hit: TTL valid AND cached map covers all currently-missing names.
  const cached = tryProviderCache(missingNames, mergedProxies, now, data);
  if (cached) return cached;

  // Dedup concurrent requests — reuse in-flight promise if same generation
  const gen = _providerGen;
  if (_providerInFlight?.gen !== gen) {
    _providerInFlight = {
      gen,
      promise: getProxyProviders().then(providersResp => {
        const providerProxies = extractProviderNodes(providersResp);
        // Only write cache if generation hasn't changed (no restart)
        if (gen === _providerGen) {
          _providerCache = { proxies: providerProxies, ts: Date.now() };
          _providerInFlight = null;
        }
        return providerProxies;
      }).catch(err => {
        if (gen === _providerGen) {
          // Preserve previous cache if it had valid data; only set failed flag
          // so we don't wipe good nodes on a transient failure.
          if (_providerCache && !_providerCache.failed) {
            _providerCache.failed = true;
            _providerCache.ts = Date.now();
          } else {
            _providerCache = { proxies: Object.create(null), ts: Date.now(), failed: true };
          }
          _providerInFlight = null;
        }
        apiLogger.warn('[getProxiesMerged] /providers/proxies fetch failed, using raw /proxies data', err);
        return null;
      }),
    };
  }

  const providerProxies = await _providerInFlight.promise;
  // Ignore results from a previous generation (pre-restart)
  if (providerProxies && gen === _providerGen) {
    for (const name of missingNames) {
      if (providerProxies[name] && !hasOwn(mergedProxies, name)) {
        mergedProxies[name] = providerProxies[name];
      }
    }
  }

  return { ...data, proxies: mergedProxies };
}

/**
 * 切换代理组中的选中节点，并带回这一次被拒绝的原因
 * @param {string} group - 代理组名称
 * @param {string} name  - 目标节点名称
 * @param {{ prepare?: () => Promise<any>, canSend?: () => boolean, skipIfCurrent?: boolean, beforeSend?: () => void }} [options]
 *   prepare: run in the switch's turn, right before it is sent (a click
 *   reads the profile it files the node under there, so its read cannot let
 *   a later click go out first); its value comes back as `prepared`.
 *   canSend: checked right before sending; false drops the switch unsent
 *   with reason SWITCH_BUSY (a profile, mode or TUN change began), as is
 *   one whose turn comes after a core restart began.
 * @returns {Promise<{ ok: boolean, reason: unknown, error?: ApiError, maybeApplied?: boolean, prepared?: any, seq?: number, unchanged?: boolean }>}
 *   reason is the backend's rejection for this request (null when it
 *   succeeded or gave none); error is the HTTP refusal itself when the core
 *   answered non-2xx; maybeApplied: a GLOBAL switch reached the core and
 *   went unanswered; seq numbers this switch for isLatestSwitch
 * @throws {ApiError}
 */
export async function switchProxyResult(group, name, options = {}) {
  proxySwitchStarts += 1;
  const seq = proxySwitchStarts;
  proxySwitchesInFlight += 1;
  unansweredSwitches.add(seq);
  /** @type {() => void} */
  let finished = () => {};
  const done = new Promise((/** @type {(v?: unknown) => void} */ resolve) => { finished = resolve; });
  runningSwitches.add(done);
  // Switches of one group go out one at a time, in the order they were
  // made: the core then ends on the last one made (the one a user click
  // records), whatever order it would answer overlapping requests in.
  const before = switchQueues.get(group) ?? Promise.resolve();
  // A switch still waiting when the core restarts (a profile switch, a
  // restart after resume) was made for the core before: its same-named
  // group in the new one is another group, so it is not sent. The
  // generation is the one at the time it was made, also when `prepare`
  // still runs.
  const generation = coreGeneration;
  // A hot reload can replace same-named groups without replacing the process.
  // Capture its invalidation before waiting for this group's earlier switches.
  const providersGeneration = _providerGen;
  const outdated = () => generation !== coreGeneration || providersGeneration !== _providerGen || restartsRunning > 0;
  // Whether the request went out: one that failed after that (no answer)
  // may still have been applied by the core.
  let sent = false;
  const mine = before.then(async () => {
    if (outdated()) return { ok: false, reason: SWITCH_BUSY };
    if (!options.prepare && !options.canSend && !options.skipIfCurrent && !options.beforeSend) {
      sent = true;
      return sendProxySwitch(group, name);
    }
    const prepared = options.prepare ? await options.prepare() : undefined;
    if (outdated()) return { ok: false, reason: SWITCH_BUSY, prepared };
    if (options.canSend && !options.canSend()) return { ok: false, reason: SWITCH_BUSY, prepared };
    // GLOBAL selections must reach the native restore lock even if they look
    // unchanged: an active fallback must observe the user's intent.
    if (options.skipIfCurrent && group !== 'GLOBAL') {
      const providersAtRead = _providerGen;
      const nativeBefore = isIpcAvailable() ? await speedTestGeneration().catch(() => null) : null;
      // This read only avoids a redundant PUT; a failed read must not block
      // the user's selection while the same core can still accept writes.
      const data = /** @type {any} */ (await getProxies().catch(() => null));
      const nativeAfter = isIpcAvailable() ? await speedTestGeneration().catch(() => null) : null;
      const nativeChanged = nativeBefore !== null && nativeAfter !== null && nativeBefore !== nativeAfter;
      if (outdated() || nativeChanged || providersAtRead !== _providerGen || (options.canSend && !options.canSend())) return { ok: false, reason: SWITCH_BUSY, prepared };
      if (data?.proxies?.[group]?.now === name) {
        if (isIpcAvailable()) {
          const ready = await diagnosticInvoke(COMMANDS.SPEED_TEST_READY_GENERATION).catch(() => null);
          if (ready === null || nativeAfter === null || ready !== nativeAfter || outdated() || (options.canSend && !options.canSend())) return { ok: false, reason: SWITCH_BUSY, prepared };
        }
        return { ok: true, reason: null, unchanged: true, prepared };
      }
    }
    options.beforeSend?.();
    sent = true;
    return { ...(await sendProxySwitch(group, name)), prepared };
  });
  /** @type {Promise<unknown>} */
  const settled = mine.catch(() => undefined);
  switchQueues.set(group, settled);
  try {
    /** @type {Awaited<typeof mine>} */
    let result;
    try {
      result = await mine;
    } catch (error) {
      // `prepare` threw before anything went out: nothing changed on the
      // core. A request sent without an answer may have been applied, so it
      // is not filed as refused: callers asking for landed switches count
      // it, and read the core's selection instead of trusting an older one.
      if (!sent) noteRefusedSwitch(seq);
      // Sent with no answer: the core may run it, so an earlier switch is
      // no longer the newest it took (isLatestSwitch), and is not saved
      // over it.
      else noteAcceptedSwitch(group, seq, generation, providersGeneration);
      throw error;
    }
    // One the core may have applied without confirming counts as landed, as
    // a sent switch with no answer does above.
    if (sent && (result.ok || ('maybeApplied' in result && result.maybeApplied))) noteAcceptedSwitch(group, seq, generation, providersGeneration);
    else noteRefusedSwitch(seq);
    return { ...result, seq };
  } finally {
    proxySwitchesInFlight -= 1;
    unansweredSwitches.delete(seq);
    if (switchQueues.get(group) === settled) switchQueues.delete(group);
    runningSwitches.delete(done);
    finished();
  }
}

/**
 * Node switches started and not finished yet, each resolving once its
 * answer is in (or it was dropped unsent).
 * @type {Set<Promise<unknown>>}
 */
const runningSwitches = new Set();

/**
 * Wait until the node switches started so far have their answers (or were
 * dropped unsent), at most `timeoutMs`: the core's selection read after
 * that is the one they left. A profile switch saves the node the core runs
 * after them, before its restart drops the ones still queued.
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} false when some were still running at the timeout
 */
export async function settleProxySwitches(timeoutMs) {
  const pending = [...runningSwitches];
  if (pending.length === 0) return true;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
  try {
    return await Promise.race([Promise.all(pending).then(() => true), timeout]) === true;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The reason a switch was not sent: a profile, mode or TUN change, or a
 * core restart, began before its turn. Every surface reports it as a busy
 * moment to try again after, not as a failed switch.
 */
export const SWITCH_BUSY = 'a profile, mode or TUN change began before this switch was sent';

/**
 * Bumped when a restart through restartCore begins and ends, and when the
 * backend replaced the core itself (noteCoreReplaced): a switch queued
 * before is dropped.
 */
let coreGeneration = 0;

/**
 * A core this module did not start replaced the one it talks to (the
 * backend restarted it after resume, or a core update did): switches made
 * for the old core and not sent yet are dropped, as after restartCore.
 */
export function noteCoreReplaced() {
  coreGeneration += 1;
}

/**
 * Run `replace`, a backend call that replaces the core itself (the macOS
 * restart as root for TUN), counted like restartCore: switches queued for
 * the core before it, or made while it runs, are not sent.
 * @template T
 * @param {() => Promise<T>} replace
 * @returns {Promise<T>}
 */
export async function whileCoreReplaced(replace) {
  coreGeneration += 1;
  restartsRunning += 1;
  try {
    return await replace();
  } finally {
    restartsRunning -= 1;
    coreGeneration += 1;
  }
}

/**
 * How many core replacements began so far: a value read before an await
 * that differs after it means what was read came from the core before.
 */
export function coreReplacements() {
  return coreGeneration;
}

/**
 * Restarts through restartCore still running: a switch whose turn comes
 * then would reach the core being replaced, so it is not sent.
 */
let restartsRunning = 0;

/** Node switches started so far, and the ones not answered yet. */
let proxySwitchStarts = 0;
let proxySwitchesInFlight = 0;
/**
 * Recent switches the core refused (or that were dropped unsent), by their
 * start number: they changed nothing on the core.
 * @type {number[]}
 */
const refusedSwitches = [];
const MAX_REFUSED_SWITCHES = 256;

/**
 * The recent switches the core accepted: start number to the core
 * replacement count it was sent under.
 * @type {Map<number, { generation: number, providersGeneration: number }>}
 */
const acceptedSwitches = new Map();
const MAX_ACCEPTED_SWITCHES = 256;

/**
 * The newest switch the core accepted for each group, with the core
 * replacement count it was sent under. Kept apart from the bounded
 * histories above, so trimming them never makes an older switch look
 * like the newest.
 * @type {Map<string, { seq: number, generation: number, providersGeneration: number }>}
 */
const latestAcceptedSwitch = new Map();
const MAX_LATEST_ACCEPTED_GROUPS = 1024;
/**
 * The newest switch the core accepted in any group. A profile keeps one
 * saved selection, whichever group it is in, so a later choice in another
 * group also makes an older one stale for that record.
 * @type {{ seq: number, generation: number, providersGeneration: number } | null}
 */
let latestAcceptedAny = null;

/**
 * @param {string} group
 * @param {number} seq
 * @param {number} generation
 * @param {number} providersGeneration
 */
function noteAcceptedSwitch(group, seq, generation, providersGeneration) {
  const latest = latestAcceptedSwitch.get(group);
  if (!latest || latest.seq < seq) {
    latestAcceptedSwitch.delete(group);
    latestAcceptedSwitch.set(group, { seq, generation, providersGeneration });
    if (latestAcceptedSwitch.size > MAX_LATEST_ACCEPTED_GROUPS) {
      const oldest = latestAcceptedSwitch.keys().next().value;
      if (oldest !== undefined) latestAcceptedSwitch.delete(oldest);
    }
  }
  if (!latestAcceptedAny || latestAcceptedAny.seq < seq) latestAcceptedAny = { seq, generation, providersGeneration };
  acceptedSwitches.set(seq, { generation, providersGeneration });
  if (acceptedSwitches.size > MAX_ACCEPTED_SWITCHES) {
    const oldest = acceptedSwitches.keys().next().value;
    if (oldest !== undefined) acceptedSwitches.delete(oldest);
  }
}

/**
 * Whether switch `seq` of `group` is still the newest accepted one,
 * whichever surface made it (a node card, the wheel, the home picker): the
 * core accepted no later switch of the group. A later one still waiting for
 * its answer does not count: if the core takes it, its own caller records
 * it after this one (switches of a group are answered in order); if not,
 * this one is what the core runs and must be recorded. False too once
 * the core was replaced after it was sent, and once the same core accepted
 * a later switch in another group: the profile keeps one saved selection,
 * and the later choice is the one it must keep.
 * @param {string} group
 * @param {number | undefined} seq the `seq` switchProxyResult returned
 */
export function isLatestSwitch(group, seq) {
  if (seq === undefined) return true;
  // A core replaced since runs its own selection, not this switch.
  const sentUnder = acceptedSwitches.get(seq);
  if (sentUnder && (sentUnder.generation !== coreGeneration || sentUnder.providersGeneration !== _providerGen)) return false;
  if (latestAcceptedAny && latestAcceptedAny.seq > seq
    && latestAcceptedAny.generation === coreGeneration && latestAcceptedAny.providersGeneration === _providerGen) return false;
  const latest = latestAcceptedSwitch.get(group);
  if (!latest) return true;
  if (latest.seq === seq) return latest.generation === coreGeneration && latest.providersGeneration === _providerGen;
  return latest.seq < seq;
}

/** @param {number} seq */
function noteRefusedSwitch(seq) {
  refusedSwitches.push(seq);
  if (refusedSwitches.length > MAX_REFUSED_SWITCHES) refusedSwitches.shift();
}

/**
 * The last switch sent or waiting for each group (settles, never rejects).
 * @type {Map<string, Promise<unknown>>}
 */
const switchQueues = new Map();

/**
 * How many node switches were started so far: one that differs from a
 * count taken right before a switch call, by more than that one switch,
 * means another switch was started meanwhile.
 * @returns {number}
 */
export function proxySwitchStartCount() {
  return proxySwitchStarts;
}

/**
 * Where an automatic switch (failover, a carried node) starts: pass it to
 * proxySwitchedSince right before sending its own switch.
 * @returns {number}
 */
export function proxySwitchMark() {
  // A switch still waiting for its answer counts as one made after the
  // mark: it can land, and its caller record its node, after the mark was
  // taken, so a check against this mark sees it also once it is answered.
  let oldest = proxySwitchStarts + 1;
  for (const seq of unansweredSwitches) oldest = Math.min(oldest, seq);
  return oldest - 1;
}

/** Numbers of the switches not answered yet. @type {Set<number>} */
const unansweredSwitches = new Set();

/**
 * Whether a node switch started after `mark` was taken, or one is still
 * waiting for the core's answer: a choice the user sent may then land after
 * (or not be visible yet to) a check of the live selection, and an automatic
 * switch sent now could replace it.
 * @param {number} mark proxySwitchMark() from before
 * @param {number} [own] switches the caller itself sent since `mark` and
 *   saw answered: they do not count
 * @param {{ landedOnly?: boolean, ownInFlight?: number }} [options]
 *   landedOnly: switches the core refused do not count either (they changed
 *   nothing on it); only when the refusals since `mark` are still
 *   remembered. ownInFlight: switches of the caller's own that are still
 *   running (counted in `own` too), as in a canSend check of its own switch
 * @returns {boolean}
 */
export function proxySwitchedSince(mark, own = 0, options = {}) {
  if (proxySwitchesInFlight - (options.ownInFlight ?? 0) > 0) return true;
  let started = proxySwitchStarts - mark;
  if (options.landedOnly && started > 0) {
    const refused = refusedSwitches.filter((seq) => seq > mark).length;
    // Older refusals already forgotten: count what is not known as refused.
    const known = refusedSwitches.length < MAX_REFUSED_SWITCHES
      || (refusedSwitches[0] ?? Infinity) <= mark + 1;
    if (known) started -= refused;
  }
  return started - own !== 0;
}

/**
 * The start of the backend's message when a GLOBAL switch was not confirmed by
 * the core (`GLOBAL_SWITCH_UNCONFIRMED` in core/subscription.rs): keep the two
 * in step.
 */
const GLOBAL_SWITCH_UNCONFIRMED = 'Failed to switch GLOBAL proxy group';

/**
 * @param {string} group
 * @param {string} name
 * @returns {Promise<{ ok: boolean, reason: unknown, error?: ApiError, maybeApplied?: boolean }>}
 */
async function sendProxySwitch(group, name) {
  try {
    // GLOBAL switches go through the backend so the user-change generation is
    // bumped under the restore lock; otherwise an in-flight fallback restore
    // could silently overwrite the user's selection. Only the reserved GLOBAL
    // group (exact name) uses this path. Other desktop groups share the
    // runtime config lock with DNS reloads so selections survive an overlay.
    if (group === 'GLOBAL') {
      await invoke(COMMANDS.SWITCH_GLOBAL_NODE, { name });
      return { ok: true, reason: null };
    }
    if (isIpcAvailable()) {
      await invoke(COMMANDS.SWITCH_PROXY_NODE, { group, name });
      return { ok: true, reason: null };
    }
    await apiFetch(`/proxies/${encodeURIComponent(group)}`, {
      method: 'PUT',
      body: JSON.stringify({ name }),
    });
    return { ok: true, reason: null };
  } catch (err) {
    if (err instanceof ApiError) {
      // A refused switch is a non-2xx answer with the cause in the body
      // ({"message": "..."}); network failures (no status) still throw.
      if (err.status == null) {
        // Timed out waiting for the answer: the request went out and the
        // core may have switched, as an unconfirmed GLOBAL switch may have.
        // Any other network failure still throws. A refused connection and
        // one dropped after the request went out look the same here, so the
        // caller counts a sent switch that threw as possibly applied: an
        // older switch is then not saved over one the core may run.
        if (/** @type {any} */ (err.cause)?.name === 'AbortError') {
          return { ok: false, reason: err.message, maybeApplied: true };
        }
        throw err;
      }
      const text = String(err.body || '').trim();
      /** @type {string|null} */
      let reason = null;
      try { reason = String(JSON.parse(text)?.message || '').trim() || null; } catch { reason = text || null; }
      return { ok: false, reason: (reason || err.message).slice(0, 300), error: err };
    }
    // The backend rejects with a plain Error carrying the real reason (e.g.
    // "Subscription update in progress, please try again", "GLOBAL proxy group
    // no longer contains node '<name>'").
    apiLogger.warn(`switchProxy('${group}', '${name}') rejected:`, err);
    // The backend says when a request reached the core but got no answer (a
    // timeout, a lost reply): the core may have switched, so the switch is
    // reported failed but not filed as refused. No core, a failed
    // connection or an error answer changed nothing.
    const message = String(/** @type {any} */ (err)?.message ?? err);
    const maybeApplied = message.startsWith(GLOBAL_SWITCH_UNCONFIRMED) || message.startsWith('Proxy switch outcome is unconfirmed');
    return { ok: false, reason: err, maybeApplied };
  }
}

/**
 * 切换代理组中的选中节点
 * @param {string} group - 代理组名称
 * @param {string} name  - 目标节点名称
 * @returns {Promise<boolean>} 是否成功
 * @throws {ApiError}
 */
export async function switchProxy(group, name) {
  const result = await switchProxyResult(group, name);
  // Callers of this form expect an HTTP refusal to reject, as before.
  if (result.error) throw result.error;
  return result.ok;
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
  return apiJson('/configs');
}

/**
 * 动态修改核心配置 (PATCH)
 * @param {Object} payload - 要合并的配置片段
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<boolean>} 是否成功
 * @throws {ApiError}
 */
export async function patchConfig(payload, { signal } = {}) {
  await apiFetch('/configs', {
    method: 'PATCH',
    signal,
    body: JSON.stringify(payload),
  });
  return true;
}

/**
 * 从磁盘热重载核心配置文件
 * @param {string} [_path='run_config.yaml'] - 配置文件名（仅用于语义，实际由 core 决定）
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
 * @returns {Promise<{ connections: Array<object> }>} mihomo `/connections` 响应体
 * @throws {ApiError}
 */
export async function getConnections() {
  // apiFetch's timeout ends with the headers: a body that never completes
  // would leave this pending (and the page's refresh waiting on it) forever.
  // The request stays tied to this controller until the body is read, so a
  // body timeout aborts the fetch itself rather than only giving up on it.
  const request = new AbortController();
  const res = await apiFetch('/connections', { signal: request.signal, abortAfterHeaders: true });
  return readJsonWithin(res, DEFAULT_TIMEOUT, '/connections', () => request.abort());
}

/**
 * `res.json()`, failing with an {@link ApiError} when the body has not
 * arrived within `ms`. `abort` then aborts the request the body belongs to
 * (a body that `res.json()` is reading is locked and cannot be cancelled).
 * @param {Response} res
 * @param {number} ms
 * @param {string} endpoint
 * @param {() => void} abort
 * @param {AbortSignal} [signal]
 * @returns {Promise<any>}
 */
async function readJsonWithin(res, ms, endpoint, abort, signal = undefined) {
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  const body = res.json();
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      body.catch(() => { /* aborted below */ });
      abort();
      reject(new ApiError(`Request timeout (${ms}ms): ${endpoint}`, { endpoint }));
    }, ms);
  });
  try {
    return await abortableRead(Promise.race([body, timeout]), signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Stop one caller waiting for shared work without cancelling the other callers.
 * @template T
 * @param {Promise<T>} pending
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<T>}
 */
async function abortableRead(pending, signal) {
  if (!signal) return pending;
  let onAbort = () => {};
  /** @type {Promise<never>} */
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(new DOMException('Request cancelled', 'AbortError'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([pending, cancelled]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

/** JSON reads used during startup and serialized actions must bound the body too.
 * @param {string} endpoint
 * @param {AbortSignal} [signal]
 * @returns {Promise<any>}
 */
async function apiJson(endpoint, signal) {
  const request = new AbortController();
  const onAbort = () => request.abort();
  if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await apiFetch(endpoint, { signal: request.signal, abortAfterHeaders: true });
    return await readJsonWithin(response, DEFAULT_TIMEOUT, endpoint, () => request.abort(), signal);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    request.abort();
  }
}

/**
 * 关闭指定连接
 * @param {string|string[]} id - 单个连接 ID 或 ID 数组
 * @returns {Promise<void>}
 */
export async function closeConnection(id) {
  // Mihomo closes one connection at DELETE /connections/:id; a bare DELETE /connections closes all.
  const ids = typeof id === 'string' ? [id] : id;
  await Promise.all(ids.map((one) => apiFetch(`/connections/${encodeURIComponent(one)}`, { method: 'DELETE' })));
}

// ═══════════════════════════════════════════════════════════════════════════════
//  REST API — Latency Test
// ═══════════════════════════════════════════════════════════════════════════════

/** 全局延迟测试中止控制器 */
let latencyTestController = new AbortController();

/**
 * Controllers that still have tests in flight, with how many. A test keeps the
 * controller it started under, so a reset for a new run must not detach Stop
 * from a single-node retest that began just before it.
 * @type {Map<AbortController, number>}
 */
const liveLatencyControllers = new Map();

/**
 * 获取当前延迟测试的 AbortSignal（供 worker 循环检查是否被中止）。
 */
export function getLatencyTestSignal() {
  return latencyTestController.signal;
}

/**
 * 重置延迟测试控制器（在每次测速开始前调用）。
 * 必须在 api.js 内部调用，确保每次测速都有新的未中止的 controller。
 */
export function resetLatencyTestController() {
  latencyTestController = new AbortController();
}

/**
 * 中止所有正在进行的延迟测试。
 *
 * 不再创建新 controller —— 新 controller 在下次测速开始时通过 resetLatencyTestController() 创建。
 * 旧实现中 abort 后立即 new 会导致后续 testProxy() 绑定到新的未中止 signal，
 * 使 abort 形同虚设。
 */
export function abortLatencyTests() {
  latencyTestController.abort();
  for (const controller of liveLatencyControllers.keys()) controller.abort();
}

export { DEFAULT_LATENCY_TEST_URL };
let _latencyTestUrl = DEFAULT_LATENCY_TEST_URL;

/**
 * Address the latency test asks for through each node. Empty or invalid falls
 * back to the built-in default; only http(s) addresses are taken.
 * @param {string|null|undefined} url
 */
export function setLatencyTestUrl(url) {
  const v = typeof url === 'string' ? url.trim() : '';
  // The parsed form is what is sent: `https:example.com` passes the check
  // but is not an address the core can fetch as written.
  let href = '';
  try {
    const u = new URL(v);
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname) href = u.href;
  } catch { /* not an address */ }
  _latencyTestUrl = href || DEFAULT_LATENCY_TEST_URL;
}

/** @returns {string} */
export function getLatencyTestUrl() {
  return _latencyTestUrl;
}

/**
 * 测试指定代理节点的延迟
 *
 * 使用 gstatic 204 作为测试 URL，通过 mihomo 的 `/proxies/:name/delay` 端点
 * 发起延迟测量。支持全局中止（`abortLatencyTests`）和单次超时。
 *
 * @param {string}  name            - 代理节点名称
 * @param {number}  [customTimeout=5000] - 单次测试超时（ms）
 * @param {AbortSignal} [signal] - 只中止这一次测试（如下载测速的预检被停止）
 * @param {{ shared?: boolean, url?: string }} [opts] - `shared: false`: not stopped by
 *   `abortLatencyTests` (a download test's precheck follows its own run's
 *   signal; a node switch on Home must not skip its nodes)
 * @returns {Promise<number>} 延迟（ms），失败或中止时返回 -1
 */
export async function testProxy(name, customTimeout = 5000, signal = undefined, { shared = true, url = _latencyTestUrl } = {}) {
  const generation = _providerGen;
  const localController = new AbortController();
  const timeout = setTimeout(() => localController.abort(), customTimeout + 1000);
  const onOwnAbort = () => localController.abort();
  if (signal?.aborted) localController.abort();
  else signal?.addEventListener('abort', onOwnAbort, { once: true });

  const onGlobalAbort = () => localController.abort();
  // Keep the controller this test started under: a reset during the request
  // swaps the module-level one, and cleanup must detach from the original.
  const globalController = shared ? latencyTestController : null;
  if (globalController) {
    liveLatencyControllers.set(globalController, (liveLatencyControllers.get(globalController) ?? 0) + 1);
    globalController.signal.addEventListener('abort', onGlobalAbort, { once: true });
  }

  try {
    const testUrl = url;
    const apiUrl = `/proxies/${encodeURIComponent(name)}/delay?timeout=${customTimeout}&url=${encodeURIComponent(testUrl)}`;

    // The test's own timeout and Stop keep aborting the request while the
    // body is read: a body that stalls after the headers would otherwise
    // leave the test pending.
    const fetchOpts = {
      signal: localController.signal,
      timeout: customTimeout + 2000,
      abortAfterHeaders: true,
    };
    let res;
    try {
      res = await apiFetch(apiUrl, fetchOpts);
    } catch (err) {
      // A proxy-provider's node: `/proxies/:name` does not know it.
      // Stop and the test's deadline end this wait too.
      let provider = !localController.signal.aborted && isNotFound(err) && generation === _providerGen
        ? await Promise.race([providerOfNode(name), whenAborted(localController.signal)]) : null;
      if (!provider || localController.signal.aborted || generation !== _providerGen) throw err;
      const providerRequest = (/** @type {string} */ owner) => apiFetch(`/providers/proxies/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/healthcheck?timeout=${customTimeout}&url=${encodeURIComponent(testUrl)}`, fetchOpts);
      try {
        res = await providerRequest(provider);
      } catch (routeError) {
        if (!isNotFound(routeError) || generation !== _providerGen || localController.signal.aborted) throw routeError;
        provider = await Promise.race([providerOfNode(name, true), whenAborted(localController.signal)]);
        if (!provider || localController.signal.aborted || generation !== _providerGen) throw routeError;
        res = await providerRequest(provider);
      }
    }

    if (res.ok) {
      const data = await res.json();
    return !localController.signal.aborted && generation === _providerGen ? data.delay : -1;
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
    signal?.removeEventListener('abort', onOwnAbort);
    if (globalController) {
      globalController.signal.removeEventListener('abort', onGlobalAbort);
      const left = (liveLatencyControllers.get(globalController) ?? 1) - 1;
      if (left > 0) liveLatencyControllers.set(globalController, left);
      else liveLatencyControllers.delete(globalController);
    }
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
    // Read here rather than through isAutoStartEnabled, which reports a
    // failed check as off: an unknown state is disabled anyway, so a reset
    // never saves autostart as off while the system still starts the app.
    let enabled = true;
    try {
      enabled = await invoke('plugin:autostart|is_enabled');
    } catch (err) {
      apiLogger.debug('autostart state unknown, disabling anyway:', err);
    }
    if (!enabled) return false;
    await invoke('plugin:autostart|disable');
    return true;
  } catch (err) {
    if (isMissingAutostartEntryError(err)) return false;
    throw err;
  }
}

/**
 * 查询系统开机自启动是否已启用；读取失败时抛出，而不是当作未启用。
 * @returns {Promise<boolean>}
 * @throws {Error}
 */
export async function readAutoStartEnabled() {
  return Boolean(await invoke('plugin:autostart|is_enabled'));
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
 * @returns {Promise<{ port: number, secret: string, active_config: string | null }>} 核心启动结果（含 port、secret、active_config 等）
 * @throws {Error}
 */
export async function restartCore(configPath, customArgs = []) {
  // eslint-disable-next-line no-console
  console.log(`[API] restartCore called (config=${configPath})`);
  // Counted when the restart begins too: a switch queued before it and sent
  // while it runs would reach the core being replaced (or the address it
  // had), and one made while it runs was made for that core.
  coreGeneration += 1;
  restartsRunning += 1;
  let coreResult;
  try {
    coreResult = await invoke(COMMANDS.START_CORE, {
      configPath,
      customArgs,
      force: true,
    });
  } finally {
    restartsRunning -= 1;
    coreGeneration += 1;
  }
  setBaseUrl(`http://127.0.0.1:${coreResult.port}`);
  setSecret(coreResult.secret);
  setWsBaseUrl(`ws://127.0.0.1:${coreResult.port}`);
  setWsSecret(coreResult.secret);
  setCoreReachable(true);
  clearProviderCache();
  Bus.emit(Events.CORE_RESTARTED, { activeConfig: coreResult.active_config });
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
// Note: switchToConfig has been moved to ui/lifecycle.js to avoid layering violations.
// Import it from there instead of from api.js.

/**
 * Read mihomo core log (incremental)
 * @param {number} [offset=0] - Byte offset to start reading from
 * @param {number} [limit=500] - Max lines to read
 * @returns {Promise<{lines: string[], next_offset: number, file_size: number, has_more: boolean, rotated?: boolean}>}
 */
export async function readCoreLog(offset = 0, limit = 500) {
  return invoke(COMMANDS.READ_LOG, { offset, limit });
}


// ═══════════════════════════════════════════════════════════════════════════════
//  Download speed test / exit IP (see src-tauri/src/speed_test.rs)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Port of the speed-test listener in the running config, or null when this
 * profile has none (it already uses the reserved names, or no core runs).
 * @returns {Promise<number|null>}
 */
export async function speedTestPort() {
  try {
    const p = await diagnosticInvoke(COMMANDS.SPEED_TEST_PORT);
    return typeof p === 'number' && p > 0 ? p : null;
  } catch {
    return null;
  }
}

/** @param {string} command @returns {Promise<any>} */
async function diagnosticInvoke(command) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    return await Promise.race([
      invoke(command),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Diagnostic settings read timed out')), 3000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Capture once per download run, before latency checks. @returns {Promise<number>} */
export async function speedTestGeneration() {
  const value = await diagnosticInvoke(COMMANDS.SPEED_TEST_GENERATION);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Diagnostic state unavailable');
  return value;
}

/** Capture diagnostic generation only while no config transition is active. */
export async function speedTestReadyGeneration() {
  const value = await diagnosticInvoke(COMMANDS.SPEED_TEST_READY_GENERATION);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Diagnostic state unavailable');
  return value;
}

/** Whether a confirmed full runtime base is available for DNS catch-up. */
export async function runtimeDnsReady() {
  const ready = await diagnosticInvoke(COMMANDS.RUNTIME_DNS_READY);
  return typeof ready === 'boolean' ? ready : null;
}

/**
 * Point the hidden speed-test group at `node`.
 * @param {string} node
 * @param {number} generation captured before preparing this diagnostic
 * @param {string|null} [run] download run whose cancellation also blocks selection
 */
export async function selectSpeedTestNode(node, generation, run = null) {
  await invoke(COMMANDS.SPEED_TEST_SELECT_NODE, { name: node, generation, run });
}

/**
 * Download `url` through the speed-test listener.
 * @param {{ url: string, maxSecs: number, maxBytes?: number|null, id: string, run?: string|null, generation: number }} opts
 * @returns {Promise<{ bytes: number, elapsedMs: number, peakBps: number, cancelled: boolean }>}
 */
export function speedTestDownload({ url, maxSecs, maxBytes = null, id, run = null, generation }) {
  return invoke(COMMANDS.SPEED_TEST_DOWNLOAD, { url, maxSecs, maxBytes, id, run, generation });
}

/**
 * Stop the downloads the speed test is running. With `run`, a download of
 * that run that has not started yet is stopped too, when it starts.
 * @param {string|null} [run]
 */
export async function speedTestCancel(run = null) {
  try { await invoke(COMMANDS.SPEED_TEST_CANCEL, { run }); } catch { /* nothing running */ }
}

/**
 * The address sites see for traffic through the local proxy port, with
 * whatever location and network details the lookup service returned
 * (see ui/exit-ip.js). Never sent anywhere but through that port.
 * @param {number} port
 * @param {string} leaf the node whose selection the backend must confirm
 * @returns {Promise<{ ip: string, country: string, source?: string } & Record<string, unknown>>}
 */
export function lookupExitIp(port, leaf) {
  return invoke(COMMANDS.LOOKUP_EXIT_IP, { port, leaf });
}

/** Stop the exit-address lookups in flight: no retry or fallback request goes out after. */
export async function cancelExitIpLookups() {
  try { await invoke(COMMANDS.LOOKUP_EXIT_IP_CANCEL); } catch { /* nothing running */ }
}

/**
 * One entry of `/proxies` (provider nodes included), as the core reports it.
 * @param {string} name
 * @param {AbortSignal} [signal]
 * @returns {Promise<any>}
 */
export async function getProxyRecord(name, signal) {
  const generation = _providerGen;
  const requireCurrent = () => {
    if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
    if (generation !== _providerGen) throw new ApiError('Proxy configuration changed during the read');
  };
  try {
    const data = await apiJson(`/proxies/${encodeURIComponent(name)}`, signal);
    requireCurrent();
    return data;
  } catch (err) {
    // `/proxies/:name` only knows the profile's own nodes and groups; a node
    // a proxy-provider supplies lives under its provider.
    requireCurrent();
    let provider = isNotFound(err) ? await abortableRead(providerOfNode(name, true), signal) : null;
    requireCurrent();
    if (!provider) throw err;
    const readProvider = (/** @type {string} */ owner) => apiJson(`/providers/proxies/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, signal);
    let data;
    try {
      data = await readProvider(provider);
    } catch (routeError) {
      requireCurrent();
      if (!isNotFound(routeError)) throw routeError;
      provider = await abortableRead(providerOfNode(name, true), signal);
      requireCurrent();
      if (!provider) throw routeError;
      data = await readProvider(provider);
    }
    requireCurrent();
    return data;
  }
}
