// @ts-check
/**
 * @module websocket
 *
 * Traffic stream connection manager using Fetch Stream API.
 *
 * Provides a resilient, auto-reconnecting stream client for real-time
 * traffic data.  Exposes a finite state machine (DISCONNECTED / CONNECTING /
 * CONNECTED / RECONNECTING) so the UI can reflect live connection status.
 *
 * Features:
 *  - Exponential back-off reconnection (base 1 s, max 30 s, 15 attempts)
 *  - Heartbeat detection (30 s silence => dead connection)
 *  - Structured logging via {@link wsLogger}
 */

import { wsLogger as log } from './utils/logger.js';
import { setCoreReachable, isConnectionRefusedError } from './api.js';

/* ------------------------------------------------------------------ */
/*  Connection state enum                                             */
/* ------------------------------------------------------------------ */

/**
 * Enum-like connection states for UI consumption.
 *
 * @readonly
 * @enum {number}
 */
export const ConnectionState = Object.freeze({
  /** No active connection, not attempting to connect. */
  DISCONNECTED: 0,
  /** A connection attempt is in progress. */
  CONNECTING: 1,
  /** Stream is open and receiving data. */
  CONNECTED: 2,
  /** A previous connection was lost; reconnection is in progress. */
  RECONNECTING: 3,
});

/* ------------------------------------------------------------------ */
/*  Internal shared state                                             */
/* ------------------------------------------------------------------ */

/** @type {{ secret: string }} */
const _wsState = Object.seal({ secret: '' });

/** @type {string} */
let wsBaseUrl = 'ws://127.0.0.1:9090';

/** @type {ConnectionState} */
let _connectionState = ConnectionState.DISCONNECTED;

/** @type {{close: Function, reconnect: Function, isMaxRetriesReached: Function} | null} */
let globalConnectionHandle = null;

/** @type {Function | null} Stored callback so forceReconnect() can re-create the stream. */
let _trafficCallback = null;

/** @type {Function | null} */
let connectionLostCallback = null;

/* ------------------------------------------------------------------ */
/*  Public helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Set the secret used for Bearer authentication on the stream endpoint.
 *
 * @param {string} s - Authentication secret
 */
export function setWsSecret(s) {
  _wsState.secret = s || '';
}

/** @alias setWsSecret — kept for backward compatibility with main.js */
export { setWsSecret as setSecret };

/**
 * Set the base URL of the traffic stream server.
 *
 * @param {string} url - WebSocket-style URL (ws:// or wss://);
 *                       the protocol is automatically converted to http(s).
 */
export function setWsBaseUrl(url) {
  wsBaseUrl = url;
}

/** @alias setWsBaseUrl — kept for backward compatibility with main.js */
export { setWsBaseUrl as setBaseUrl };

/**
 * Register a callback invoked when the maximum number of reconnection
 * attempts is exhausted.
 *
 * @param {Function} callback - No-arg notification callback
 */
export function onConnectionLost(callback) {
  connectionLostCallback = callback;
}

/**
 * Programmatically trigger a reconnection attempt.
 * Resets retry counters and aborts the current stream.
 * If the handle was released by close(), creates a new connection with the
 * stored callback and returns the new handle. The caller must replace its
 * own handle reference with the returned value.
 * @returns {ReturnType<typeof connectTraffic> | null}
 */
export function forceReconnect() {
  if (globalConnectionHandle) {
    globalConnectionHandle.reconnect();
    return globalConnectionHandle;
  } else if (_trafficCallback) {
    // Handle was lost — re-create the stream with the stored callback.
    return connectTraffic(_trafficCallback);
  }
  return null;
}

/**
 * Check whether the traffic stream is currently connected (or attempting
 * to reconnect and has not yet exhausted retries).
 *
 * @returns {boolean}
 */
export function isTrafficConnected() {
  return (
    globalConnectionHandle !== null &&
    !globalConnectionHandle.isMaxRetriesReached()
  );
}

/**
 * Read-only snapshot of the current connection state.
 *
 * @returns {ConnectionState}
 */
export function getConnectionState() {
  return _connectionState;
}

/* ------------------------------------------------------------------ */
/*  Internal utilities                                                */
/* ------------------------------------------------------------------ */

/**
 * Format a byte-rate into a human-readable speed string.
 *
 * @param {number} bytes - Bytes per second
 * @returns {string} Formatted speed (e.g. "1.50 MB/s")
 */
function formatSpeed(bytes) {
  if (bytes < 1024) return `${bytes.toFixed(0)} B/s`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB/s`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB/s`;
}

/**
 * Transition the global connection state and log the change.
 *
 * @param {ConnectionState} newState
 */
function setState(newState) {
  if (_connectionState === newState) return;
  const labels = Object.entries(ConnectionState)
    .find(([, v]) => v === newState)?.[0] ?? 'UNKNOWN';
  log.info(`state => ${labels}`);
  _connectionState = newState;
}

/* ------------------------------------------------------------------ */
/*  connectTraffic                                                    */
/* ------------------------------------------------------------------ */

/**
 * Open a persistent traffic stream and feed formatted data to `callback`.
 *
 * The stream uses the Fetch ReadableStream API (not WebSocket).  On
 * disconnection it automatically reconnects with exponential back-off.
 * A 30-second heartbeat timeout treats a silent connection as dead.
 *
 * @param {Function} callback - Receives `{ up: string, down: string, raw: Object }`
 * @returns {{ close: Function, reconnect: Function, isMaxRetriesReached: Function }}
 */
export function connectTraffic(callback) {
  // Store callback first so it survives the close() call below.
  // close() no longer clears _trafficCallback, preserving it for recovery.
  _trafficCallback = callback;

  // Close any existing connection to prevent resource leaks.
  if (globalConnectionHandle) {
    globalConnectionHandle.close();
    globalConnectionHandle = null;
  }

  /** @type {AbortController} */
  let abortController = new AbortController();

  /** @type {number | null} */
  let retryTimer = null;

  /** @type {number} */
  let retryCount = 0;

  /** @type {boolean} */
  let isClosed = false;

  /** @type {boolean} */
  let maxRetriesReached = false;

  /** @type {number} Generation token — incremented on each reconnect to invalidate stale callbacks */
  let _generation = 0;

  /** @type {boolean} Whether the last error was a connection-refused (core not running) */
  let isConnectionRefused = false;

  /* ---- constants ---- */
  const MAX_RETRIES = 15;
  const MAX_RETRIES_REFUSED = 3; // 内核未运行时最多重试 3 次
  const BASE_DELAY = 1000;
  const MAX_DELAY = 30000;
  const HEARTBEAT_TIMEOUT = 30_000; // 30 s

  /* ---- heartbeat timer ---- */
  /** @type {number|null} */
  let heartbeatTimer = null;

  /** Reset the heartbeat countdown. */
  const touchHeartbeat = () => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      log.warn('heartbeat timeout — no data for 30 s, reconnecting');
      abortController.abort(); // triggers catch => handleClose
    }, HEARTBEAT_TIMEOUT);
  };

  /** Stop the heartbeat timer. */
  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  /* ---------------------------------------------------------------- */

  /**
   * Core connection routine.
   * @private
   */
  const connect = async () => {
    if (retryTimer) clearTimeout(retryTimer);
    if (isClosed) return;

    // Capture generation so stale callbacks from aborted streams can be ignored.
    const gen = _generation;

    setState(
      retryCount > 0
        ? ConnectionState.RECONNECTING
        : ConnectionState.CONNECTING,
    );

    // Convert ws(s) to http(s) for the Fetch API
    const httpUrl = wsBaseUrl
      .replace('ws://', 'http://')
      .replace('wss://', 'https://');
    const streamUrl = `${httpUrl}/traffic`;

    abortController = new AbortController();

    try {
      /** @type {HeadersInit} */
      const headers = {};
      if (_wsState.secret) {
        headers['Authorization'] = `Bearer ${_wsState.secret}`;
      }

      log.debug(`fetching ${streamUrl} ...`);

      const response = await fetch(streamUrl, {
        headers,
        signal: abortController.signal,
      });

      // Bail out immediately if a newer generation has superseded this stream.
      // Prevents stale fetch responses from mutating shared state.
      if (gen !== _generation) return;

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      // --- stream established ---
      retryCount = 0;
      maxRetriesReached = false;
      isConnectionRefused = false;
      setState(ConnectionState.CONNECTED);
      touchHeartbeat();

      if (!response.body) throw new Error('Response body is null');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      /** @type {string} */
      let buffer = '';
      let parseErrorCount = 0;
      let lastCallbackTime = 0;

      /**
       * Process a single JSON line from the traffic stream.
       * @param {string} trimmed
       */
      function processLine(trimmed) {
        const data = JSON.parse(trimmed);
        parseErrorCount = 0;

        const now = Date.now();
        if (now - lastCallbackTime >= 500) {
          const formatted = {
            up: formatSpeed(data.up),
            down: formatSpeed(data.down),
            raw: data,
          };

          if (typeof callback === 'function') {
            callback(formatted);
            lastCallbackTime = now;
          }
        }
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Stop processing if a newer generation has replaced this stream.
        if (gen !== _generation) return;

        touchHeartbeat(); // any data counts as a heartbeat

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = /** @type {string} */ (lines.pop()); // keep incomplete tail

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            processLine(trimmed);
          } catch {
            parseErrorCount++;
            if (parseErrorCount > 10) {
              log.error('too many parse errors — reconnecting');
              throw new Error('Too many parse errors');
            }
          }
        }
      }

      // Stream ended gracefully — ignore if a newer generation has replaced us.
      if (gen !== _generation) return;
      handleClose();
    } catch (err) {
      const error = /** @type {Error} */ (err);
      if (error.name === 'AbortError') {
        // Stale stream aborted by reconnect(), or permanently closed.
        if (isClosed || gen !== _generation) return;
        // Heartbeat timeout or force-reconnect — treat as disconnection
        handleClose();
        return;
      }

      // Reject stale errors before any shared-state mutation.
      if (gen !== _generation) return;

      // 检测连接被拒绝（内核未运行）
      isConnectionRefused = isConnectionRefusedError(error);

      if (isConnectionRefused) {
        setCoreReachable(false);
        // 连接被拒绝时降级日志：首次 warn，后续 debug
        if (retryCount === 0) {
          log.warn('stream error: core unreachable');
        } else {
          log.debug(`stream error: core unreachable (retry #${retryCount})`);
        }
      } else {
        log.error('stream error:', error.message || error);
      }
      handleClose();
    }
  };

  /**
   * Handle disconnection — schedule retry or notify permanent failure.
   * @private
   */
  function handleClose() {
    stopHeartbeat();

    if (isClosed) return;

    // 内核未运行时使用更少的重试次数
    const effectiveMaxRetries = isConnectionRefused ? MAX_RETRIES_REFUSED : MAX_RETRIES;

    if (retryCount < effectiveMaxRetries) {
      retryCount++;
      const delay = Math.min(
        MAX_DELAY,
        BASE_DELAY * Math.pow(2, retryCount - 1),
      );
      // 连接被拒绝时降级重连日志
      if (isConnectionRefused) {
        log.debug(`reconnect #${retryCount} in ${delay} ms (core unreachable)`);
      } else {
        log.warn(`reconnect #${retryCount} in ${delay} ms`);
      }
      setState(ConnectionState.RECONNECTING);
      retryTimer = setTimeout(connect, delay);
    } else {
      if (isConnectionRefused) {
        log.warn('core unreachable — traffic stream stopped, restart core to reconnect');
      } else {
        log.error('max reconnection attempts reached — giving up');
      }
      maxRetriesReached = true;
      setState(ConnectionState.DISCONNECTED);

      // User-facing notification
      /** @type {any} */ (window).showNotification?.(
        isConnectionRefused
          ? 'Core is not running. Restart core to reconnect.'
          : 'Lost connection to core traffic monitor. Click to reconnect.',
        'warning',
      );

      if (typeof connectionLostCallback === 'function') {
        connectionLostCallback();
      }
    }
  }

  /* ---- kick off ---- */
  connect();

  /* ---- handle object ---- */
  const handle = {
    /**
     * Permanently close the connection and release resources.
     */
    close() {
      isClosed = true;
      _generation++;  // Invalidate any in-flight fetch callbacks
      maxRetriesReached = false;
      stopHeartbeat();
      if (retryTimer) clearTimeout(retryTimer);
      abortController.abort();
      setState(ConnectionState.DISCONNECTED);
      if (globalConnectionHandle === handle) {
        globalConnectionHandle = null;
      }
    },

    /**
     * Force an immediate reconnection (resets retry counters).
     */
    reconnect() {
      if (isClosed) return;
      if (retryTimer) clearTimeout(retryTimer);
      stopHeartbeat();
      maxRetriesReached = false;
      retryCount = 0;
      isConnectionRefused = false;
      // Increment generation to invalidate stale callbacks from the old stream.
      _generation++;
      abortController.abort();
      abortController = new AbortController();
      connect();
    },

    /**
     * @returns {boolean} Whether the max retry limit has been reached.
     */
    isMaxRetriesReached() {
      return maxRetriesReached;
    },
  };

  globalConnectionHandle = handle;
  return handle;
}
