import { setWsBaseUrl, setWsSecret } from './websocket.js';

let BASE_URL = 'http://127.0.0.1:9090';
const _state = Object.seal({ secret: '' });
const { invoke } = window.__TAURI__.core;
const autostartApi = window.__TAURI__.autostart;

export function setBaseUrl(url) {
  BASE_URL = url;
}

function getAutostartApi() {
  if (!autostartApi) {
    throw new Error('Autostart plugin is not available');
  }
  return autostartApi;
}

function isMissingAutostartEntryError(err) {
  const message = String(err || '').toLowerCase();
  return message.includes('os error 2') ||
    message.includes('系统找不到指定的文件') ||
    message.includes('cannot find the file specified');
}

/**
 * 设置 Secret
 */
export function setSecret(s) {
  console.log('[API] setSecret called with:', s ? `${s.substring(0, 8)}...` : '(empty)');
  _state.secret = s || '';
}

/**
 * 获取请求头
 */
function getHeaders() {
  const headers = {
    'Content-Type': 'application/json'
  };
  if (_state.secret) {
    headers['Authorization'] = `Bearer ${_state.secret}`;
  } else {
    console.warn('[API] getHeaders called with empty secret!');
  }
  return headers;
}

/**
 * 获取代理组数据
 */
export async function getProxies() {
  try {
    const res = await fetch(`${BASE_URL}/proxies`, { headers: getHeaders() });
    const data = await res.json();
    return data;
  } catch (err) {
    console.error('[API] Failed to get proxies:', err);
  }
}

/**
 * 切换节点
 */
export async function switchProxy(group, name) {
  try {
    const res = await fetch(`${BASE_URL}/proxies/${encodeURIComponent(group)}`, {
      method: 'PUT',
      body: JSON.stringify({ name }),
      headers: getHeaders()
    });
    return res.ok;
  } catch (err) {
    console.error('[API] Failed to switch proxy:', err);
  }
}

/**
 * 获取当前核心配置
 */
export async function getConfig() {
  try {
    const headers = getHeaders();
    console.log('[API] getConfig called, Authorization:', headers['Authorization'] ? 'Bearer ***' : 'MISSING');
    const res = await fetch(`${BASE_URL}/configs`, { headers });
    if (!res.ok) {
      console.error('[API] getConfig failed with status:', res.status);
      return null;
    }
    const data = await res.json();
    return data;
  } catch (err) {
    console.error('[API] Failed to get config:', err);
  }
}

/**
 * 修改核心配置 (PATCH)
 */
export async function patchConfig(payload) {
  try {
    const res = await fetch(`${BASE_URL}/configs`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
      headers: getHeaders()
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return true;
  } catch (err) {
    console.error('[API] Patch config failed:', err);
    throw err;
  }
}

/**
 * 获取当前所有连接
 */
export async function getConnections() {
  try {
    const res = await fetch(`${BASE_URL}/connections`, { headers: getHeaders() });
    const data = await res.json();
    return data;
  } catch (err) {
    console.error('[API] Failed to get connections:', err);
  }
}

/**
 * 断开所有连接
 */
export async function closeAllConnections() {
  try {
    await fetch(`${BASE_URL}/connections`, {
      method: 'DELETE',
      headers: getHeaders()
    });
  } catch (err) {
    console.error('[Core] Flush connections error:', err);
  }
}

let latencyTestController = new AbortController();

export function abortLatencyTests() {
  latencyTestController.abort();
  latencyTestController = new AbortController();
}

/**
 * 测试节点延迟
 */
export async function testProxy(name, customTimeout = 5000) {
  // Create a combined signal for timeout and global abort
  const localController = new AbortController();
  const timeout = setTimeout(() => localController.abort(), customTimeout + 1000);
  
  const abortHandler = () => localController.abort();
  latencyTestController.signal.addEventListener('abort', abortHandler);

  try {
    // 换一个更通用的测试地址，并确保编码正确
    const testUrl = "http://www.gstatic.com/generate_204";
    const apiUrl = `${BASE_URL}/proxies/${encodeURIComponent(name)}/delay?timeout=${customTimeout}&url=${encodeURIComponent(testUrl)}`;
    
    const res = await fetch(apiUrl, { 
      headers: getHeaders(),
      signal: localController.signal
    });
    
    clearTimeout(timeout);
    latencyTestController.signal.removeEventListener('abort', abortHandler);
    
    if (res.ok) {
      const data = await res.json();
      return data.delay;
    }
    
    // Handle expected error statuses silently (these are normal during latency tests)
    // 401: Unauthorized - secret mismatch
    // 404: Not Found - proxy name not in config
    // 503: Service Unavailable - proxy test failed on core side
    // 504: Gateway Timeout - proxy timed out
    const silentStatusCodes = [401, 404, 503, 504];
    if (!silentStatusCodes.includes(res.status)) {
      // Only log unexpected errors
      console.warn(`[API] Proxy test for "${name}" returned status ${res.status}`);
    }
    return -1;
  } catch (err) {
    clearTimeout(timeout);
    latencyTestController.signal.removeEventListener('abort', abortHandler);
    if (err.name === 'AbortError') {
      // Return -1 silently for aborted tests
      return -1;
    } else {
      // Only log network errors that aren't expected
      // ERR_CONNECTION_RESET, network errors during proxy tests are expected
      if (!err.message?.includes('network') && !err.message?.includes('reset')) {
        console.error(`[API] Failed to test proxy ${name}:`, err);
      }
    }
    return -1;
  }
}

/**
 * 热重载核心配置
 */
export async function reloadConfig(path = 'run_config.yaml') {
  try {
    // We must pass the payload object to patch config dynamically, or use PUT to reload from file
    // For Mihomo, if we want to dynamically patch it in memory, we use PATCH.
    // If we want to reload the file from disk, we send a PUT to /configs with { path: "", payload: "" }
    const res = await fetch(`${BASE_URL}/configs?force=true`, {
      method: 'PUT',
      body: JSON.stringify({ path: "", payload: "" }),
      headers: getHeaders()
    });
    return res.ok;
  } catch (err) {
    console.error('[API] Failed to reload config:', err);
    return false;
  }
}

export async function enableAutoStart() {
  try {
    await getAutostartApi().enable();
    return true;
  } catch (err) {
    console.error('[API] Failed to enable autostart:', err);
    throw err;
  }
}

export async function disableAutoStart() {
  try {
    const enabled = await isAutoStartEnabled();
    if (!enabled) {
      return false;
    }
    await getAutostartApi().disable();
    return true;
  } catch (err) {
    if (isMissingAutostartEntryError(err)) {
      return false;
    }
    console.error('[API] Failed to disable autostart:', err);
    throw err;
  }
}

export async function isAutoStartEnabled() {
  try {
    return await getAutostartApi().isEnabled();
  } catch (err) {
    console.error('[API] Failed to get autostart state:', err);
    return false;
  }
}

export async function openConfigFolder() {
  try {
    return await invoke('open_config_folder');
  } catch (err) {
    console.error('[API] Failed to open config folder:', err);
    throw err;
  }
}

export async function restartCore(configPath, customArgs = []) {
  try {
    const coreResult = await invoke('start_core', { 
      configPath, 
      test: false,
      customArgs
    });
    setBaseUrl(`http://127.0.0.1:${coreResult.port}`);
    setSecret(coreResult.secret);
    setWsBaseUrl(`ws://127.0.0.1:${coreResult.port}`);
    setWsSecret(coreResult.secret);
    return coreResult;
  } catch (err) {
    console.error('[API] Failed to restart core:', err);
    throw err;
  }
}
