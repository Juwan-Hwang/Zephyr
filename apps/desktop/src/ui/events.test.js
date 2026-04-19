import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Bus, Events } from './events.js';

describe('Events constants', () => {
    it('is frozen', () => expect(Object.isFrozen(Events)).toBe(true));

    it('has expected event names', () => {
        expect(Events.THEME_CHANGED).toBe('theme-changed');
        expect(Events.PROXY_SELECTED).toBe('proxy-selected');
        expect(Events.MODE_CHANGED).toBe('mode-changed');
    });

    it('has no duplicate values', () => {
        const values = Object.values(Events);
        expect(new Set(values).size).toBe(values.length);
    });
});

describe('EventBus', () => {
    beforeEach(() => {
        // Clean up all listeners before each test
        Bus.offAll('*');
        // Remove all named events by iterating known keys
        for (const key of [
            'test', 'event-a', 'event-b', 'limit-test', 'no-warn',
            ...Object.values(Events),
        ]) {
            Bus.offAll(key);
        }
    });

    it('on returns unsubscribe function', () => {
        const fn = vi.fn();
        const unsub = Bus.on('test', fn);
        expect(typeof unsub).toBe('function');
        unsub();
        Bus.emit('test', 'data');
        expect(fn).not.toHaveBeenCalled();
    });

    it('on delivers data to handler', () => {
        const fn = vi.fn();
        Bus.on('test', fn);
        Bus.emit('test', { key: 'value' });
        expect(fn).toHaveBeenCalledWith({ key: 'value' });
        Bus.off('test', fn);
    });

    it('multiple handlers on same event', () => {
        const fn1 = vi.fn();
        const fn2 = vi.fn();
        Bus.on('test', fn1);
        Bus.on('test', fn2);
        Bus.emit('test', 42);
        expect(fn1).toHaveBeenCalledWith(42);
        expect(fn2).toHaveBeenCalledWith(42);
        Bus.off('test', fn1);
        Bus.off('test', fn2);
    });

    it('once fires only once', () => {
        const fn = vi.fn();
        Bus.once('test', fn);
        Bus.emit('test', 'first');
        Bus.emit('test', 'second');
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith('first');
    });

    it('off removes specific handler', () => {
        const fn1 = vi.fn();
        const fn2 = vi.fn();
        Bus.on('test', fn1);
        Bus.on('test', fn2);
        Bus.off('test', fn1);
        Bus.emit('test', 'data');
        expect(fn1).not.toHaveBeenCalled();
        expect(fn2).toHaveBeenCalledWith('data');
        Bus.off('test', fn2);
    });

    it('offAll removes all handlers for event', () => {
        const fn1 = vi.fn();
        const fn2 = vi.fn();
        Bus.on('test', fn1);
        Bus.on('test', fn2);
        Bus.offAll('test');
        Bus.emit('test', 'data');
        expect(fn1).not.toHaveBeenCalled();
        expect(fn2).not.toHaveBeenCalled();
    });

    it('wildcard * receives all events', () => {
        const fn = vi.fn();
        Bus.on('*', fn);
        Bus.emit('event-a', 'data-a');
        Bus.emit('event-b', 'data-b');
        expect(fn).toHaveBeenCalledTimes(2);
        expect(fn).toHaveBeenCalledWith('event-a', 'data-a');
        expect(fn).toHaveBeenCalledWith('event-b', 'data-b');
        Bus.off('*', fn);
    });

    it('hasListeners returns false for unknown event', () => {
        expect(Bus.hasListeners('nonexistent')).toBe(false);
    });

    it('hasListeners returns true after on', () => {
        const fn = vi.fn();
        Bus.on('test', fn);
        expect(Bus.hasListeners('test')).toBe(true);
        Bus.off('test', fn);
    });

    it('listenerCount returns correct count', () => {
        const fn1 = vi.fn();
        const fn2 = vi.fn();
        expect(Bus.listenerCount('test')).toBe(0);
        Bus.on('test', fn1);
        expect(Bus.listenerCount('test')).toBe(1);
        Bus.on('test', fn2);
        expect(Bus.listenerCount('test')).toBe(2);
        Bus.off('test', fn1);
        expect(Bus.listenerCount('test')).toBe(1);
        Bus.off('test', fn2);
        expect(Bus.listenerCount('test')).toBe(0);
    });

    it('error in handler does not affect other handlers', () => {
        const badFn = () => { throw new Error('boom'); };
        const goodFn = vi.fn();
        Bus.on('test', badFn);
        Bus.on('test', goodFn);
        // Should not throw
        Bus.emit('test', 'data');
        expect(goodFn).toHaveBeenCalledWith('data');
        Bus.off('test', badFn);
        Bus.off('test', goodFn);
    });

    it('on throws for non-function listener', () => {
        expect(() => Bus.on('test', /** @type {any} */ ('not-a-function'))).toThrow(TypeError);
    });

    it('setMaxListeners changes the limit', () => {
        Bus.setMaxListeners(2);
        const fn1 = vi.fn();
        const fn2 = vi.fn();
        const fn3 = vi.fn();
        Bus.on('limit-test', fn1);
        Bus.on('limit-test', fn2);
        // Adding 3rd listener should trigger warning (logged via uiLogger.warn)
        Bus.on('limit-test', fn3);
        Bus.offAll('limit-test');
        Bus.setMaxListeners(50); // Reset
    });

    it('setMaxListeners throws for negative number', () => {
        expect(() => Bus.setMaxListeners(-1)).toThrow(RangeError);
    });

    it('setMaxListeners(0) disables warning', () => {
        Bus.setMaxListeners(0);
        for (let i = 0; i < 100; i++) Bus.on('no-warn', vi.fn());
        Bus.offAll('no-warn');
        Bus.setMaxListeners(50);
    });
});
