const _wsState = Object.seal({ secret: '' });

/**
 * 设置 WebSocket 使用的 Secret
 */
export function setWsSecret(s) {
  _wsState.secret = s || '';
}

/**
 * 格式化速度显示
 * @param {number} bytes - 每秒字节数
 * @returns {string} - 格式化后的字符串
 */
function formatSpeed(bytes) {
  if (bytes < 1024) {
    return `${bytes.toFixed(0)} B/s`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(2)} KB/s`;
  } else {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB/s`;
  }
}

let wsBaseUrl = 'ws://127.0.0.1:9090';

export function setWsBaseUrl(url) {
  wsBaseUrl = url;
}

// Global state for connection management
let globalConnectionHandle = null;
let connectionLostCallback = null;

/**
 * Register a callback to be notified when connection is lost permanently
 * @param {Function} callback - Function to call when max retries are reached
 */
export function onConnectionLost(callback) {
  connectionLostCallback = callback;
}

/**
 * Manually trigger reconnection after connection was lost
 */
export function forceReconnect() {
  if (globalConnectionHandle) {
    globalConnectionHandle.reconnect();
  }
}

/**
 * Check if traffic connection is currently active
 */
export function isTrafficConnected() {
  return globalConnectionHandle !== null && !globalConnectionHandle.isMaxRetriesReached();
}

/**
 * 连接流量统计 WebSocket / Stream
 * @param {Function} callback - 接收格式化数据后的回调函数
 */
export function connectTraffic(callback) {
  let abortController = new AbortController();
  let retryTimer = null;
  let retryCount = 0;
  let isClosed = false;
  let maxRetriesReached = false;
  const MAX_RETRIES = 15;
  const BASE_DELAY = 1000;
  const MAX_DELAY = 30000;

  const connect = async () => {
    if (retryTimer) clearTimeout(retryTimer);
    if (isClosed) return;
    
    // We use http/https for fetch instead of ws/wss
    const httpUrl = wsBaseUrl.replace('ws://', 'http://').replace('wss://', 'https://');
    const streamUrl = `${httpUrl}/traffic`;
    
    abortController = new AbortController();
    
    try {
      const headers = {};
      if (_wsState.secret) {
        headers['Authorization'] = `Bearer ${_wsState.secret}`;
      }
      
      const response = await fetch(streamUrl, {
        headers,
        signal: abortController.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      retryCount = 0; // 连接成功，重置重试计数
      maxRetriesReached = false; // Reset max retries flag on successful connection
      
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      let parseErrorCount = 0;
      let lastCallbackTime = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep the incomplete line
        
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          
          try {
            const data = JSON.parse(trimmed);
            parseErrorCount = 0; // reset on success

            const now = Date.now();
            if (now - lastCallbackTime >= 500) {
              const formatted = {
                up: formatSpeed(data.up),
                down: formatSpeed(data.down),
                raw: data 
              };
              
              if (callback && typeof callback === 'function') {
                callback(formatted);
                lastCallbackTime = now;
              }
            }
          } catch (err) {
            parseErrorCount++;
            if (parseErrorCount > 10) {
              console.error('[Stream] Too many parse errors, reconnecting...');
              throw new Error('Too many parse errors');
            }
          }
        }
      }
      
      // If we exit the loop, the stream was closed
      handleClose();
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('[Stream] Traffic monitor error:', err);
      handleClose();
    }
  };

  const handleClose = () => {
    if (isClosed) return;
    if (retryCount < MAX_RETRIES) {
      retryCount++;
      const delay = Math.min(MAX_DELAY, BASE_DELAY * Math.pow(2, retryCount - 1));
      retryTimer = setTimeout(connect, delay);
    } else {
      console.warn('[Stream] Max reconnection attempts reached, stopping reconnection.');
      maxRetriesReached = true;
      
      // Notify about connection loss
      if (window.showNotification) {
          const t = window.translations?.[window.currentLang] || {};
          window.showNotification(t.connectionLost || 'Lost connection to core traffic monitor. Click to reconnect.', 'warning');
      }
      
      // Call registered callback if any
      if (connectionLostCallback) {
        connectionLostCallback();
      }
    }
  };

  connect();

  const handle = {
    close: () => {
      isClosed = true;
      maxRetriesReached = false;
      if (retryTimer) clearTimeout(retryTimer);
      abortController.abort();
    },
    reconnect: () => {
        maxRetriesReached = false;
        retryCount = 0;
        abortController.abort(); // Triggers handleClose -> reconnect
        connect();
    },
    isMaxRetriesReached: () => maxRetriesReached
  };
  
  // Store handle globally for manual reconnection
  globalConnectionHandle = handle;
  
  return handle;
}
