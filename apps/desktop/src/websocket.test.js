import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    ConnectionState,
    setWsSecret,
    setWsBaseUrl,
    onConnectionLost,
    forceReconnect,
    isTrafficConnected,
    getConnectionState,
    connectTraffic,
} from './websocket.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  ConnectionState enum
// ═══════════════════════════════════════════════════════════════════════════════

describe('ConnectionState', () => {
    it('has correct values', () => {
        expect(ConnectionState.DISCONNECTED).toBe(0);
        expect(ConnectionState.CONNECTING).toBe(1);
        expect(ConnectionState.CONNECTED).toBe(2);
        expect(ConnectionState.RECONNECTING).toBe(3);
    });

    it('is frozen', () => {
        expect(Object.isFrozen(ConnectionState)).toBe(true);
    });

    it('has exactly 4 states', () => {
        expect(Object.keys(ConnectionState)).toHaveLength(4);
    });

    it('values are sequential integers', () => {
        const values = Object.values(ConnectionState).sort((a, b) => a - b);
        expect(values).toEqual([0, 1, 2, 3]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  setWsSecret
// ═══════════════════════════════════════════════════════════════════════════════

describe('setWsSecret', () => {
    it('sets secret without error', () => {
        expect(() => setWsSecret('test-secret')).not.toThrow();
    });

    it('handles empty string', () => {
        expect(() => setWsSecret('')).not.toThrow();
    });

    it('handles falsy values', () => {
        expect(() => setWsSecret(null)).not.toThrow();
        expect(() => setWsSecret(undefined)).not.toThrow();
    });

    it('is a function', () => {
        expect(typeof setWsSecret).toBe('function');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  setWsBaseUrl
// ═══════════════════════════════════════════════════════════════════════════════

describe('setWsBaseUrl', () => {
    it('sets URL without error', () => {
        expect(() => setWsBaseUrl('ws://127.0.0.1:9090')).not.toThrow();
    });

    it('handles wss:// URLs', () => {
        expect(() => setWsBaseUrl('wss://example.com:9090')).not.toThrow();
    });

    it('is a function', () => {
        expect(typeof setWsBaseUrl).toBe('function');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  onConnectionLost
// ═══════════════════════════════════════════════════════════════════════════════

describe('onConnectionLost', () => {
    it('accepts a callback without error', () => {
        expect(() => onConnectionLost(() => {})).not.toThrow();
    });

    it('accepts null without error', () => {
        expect(() => onConnectionLost(null)).not.toThrow();
    });

    it('is a function', () => {
        expect(typeof onConnectionLost).toBe('function');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  getConnectionState
// ═══════════════════════════════════════════════════════════════════════════════

describe('getConnectionState', () => {
    it('returns DISCONNECTED initially', () => {
        expect(getConnectionState()).toBe(ConnectionState.DISCONNECTED);
    });

    it('returns a ConnectionState value', () => {
        const state = getConnectionState();
        expect(Object.values(ConnectionState)).toContain(state);
    });

    it('is a function', () => {
        expect(typeof getConnectionState).toBe('function');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  isTrafficConnected
// ═══════════════════════════════════════════════════════════════════════════════

describe('isTrafficConnected', () => {
    it('returns false when no connection handle exists', () => {
        expect(isTrafficConnected()).toBe(false);
    });

    it('returns a boolean', () => {
        expect(typeof isTrafficConnected()).toBe('boolean');
    });

    it('is a function', () => {
        expect(typeof isTrafficConnected).toBe('function');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  forceReconnect
// ═══════════════════════════════════════════════════════════════════════════════

describe('forceReconnect', () => {
    it('does not throw when no connection handle exists', () => {
        expect(() => forceReconnect()).not.toThrow();
    });

    it('is a function', () => {
        expect(typeof forceReconnect).toBe('function');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  connectTraffic
// ═══════════════════════════════════════════════════════════════════════════════

describe('connectTraffic', () => {
    let handle;

    afterEach(() => {
        if (handle) {
            handle.close();
            handle = null;
        }
    });

    it('returns a handle object', () => {
        handle = connectTraffic(() => {});
        expect(handle).toBeDefined();
        expect(typeof handle).toBe('object');
    });

    it('handle has close method', () => {
        handle = connectTraffic(() => {});
        expect(typeof handle.close).toBe('function');
    });

    it('handle has reconnect method', () => {
        handle = connectTraffic(() => {});
        expect(typeof handle.reconnect).toBe('function');
    });

    it('handle has isMaxRetriesReached method', () => {
        handle = connectTraffic(() => {});
        expect(typeof handle.isMaxRetriesReached).toBe('function');
    });

    it('close can be called without error', () => {
        handle = connectTraffic(() => {});
        expect(() => handle.close()).not.toThrow();
    });

    it('isMaxRetriesReached returns false initially', () => {
        handle = connectTraffic(() => {});
        expect(handle.isMaxRetriesReached()).toBe(false);
    });

    it('after close, isTrafficConnected returns false', () => {
        handle = connectTraffic(() => {});
        handle.close();
        expect(isTrafficConnected()).toBe(false);
    });

    it('is a function', () => {
        expect(typeof connectTraffic).toBe('function');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Module exports
// ═══════════════════════════════════════════════════════════════════════════════

describe('websocket exports', () => {
    it('exports ConnectionState as frozen object', () => {
        expect(ConnectionState).toBeDefined();
        expect(Object.isFrozen(ConnectionState)).toBe(true);
    });

    it('exports setWsSecret', () => {
        expect(typeof setWsSecret).toBe('function');
    });

    it('exports setWsBaseUrl', () => {
        expect(typeof setWsBaseUrl).toBe('function');
    });

    it('exports onConnectionLost', () => {
        expect(typeof onConnectionLost).toBe('function');
    });

    it('exports forceReconnect', () => {
        expect(typeof forceReconnect).toBe('function');
    });

    it('exports isTrafficConnected', () => {
        expect(typeof isTrafficConnected).toBe('function');
    });

    it('exports getConnectionState', () => {
        expect(typeof getConnectionState).toBe('function');
    });

    it('exports connectTraffic', () => {
        expect(typeof connectTraffic).toBe('function');
    });
});
