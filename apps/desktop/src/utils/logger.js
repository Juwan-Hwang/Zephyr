// @ts-check
import { forwardToBackend } from './frontend-log.js';
/**
 * Logging system with colored console output.
 *
 * Architecture:
 *   Logger (abstract base)  <-  ConsoleLogger
 *   Registry (Map)          <-  factory + global level control
 *
 * ConsoleLogger forwards all log levels (debug/info/warn/error) to the
 * backend app log via `frontend-log.js` (fire-and-forget, rate-limited).
 *
 * @module logger
 */

// ---------------------------------------------------------------------------
// Log levels
// ---------------------------------------------------------------------------

/** @type {Record<string, number>} */
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3, off: 4 };

/**
 * Resolve a level name/number to its numeric value.
 * @param {string|number} level
 * @returns {number}
 */
function resolveLevel(level) {
    if (typeof level === 'number') return level;
    return LOG_LEVELS[level] ?? LOG_LEVELS.info;
}

// ---------------------------------------------------------------------------
// Abstract base Logger (template method pattern)
// ---------------------------------------------------------------------------

/**
 * Abstract base logger. Subclasses override `_write()` to implement output.
 * Provides the template method pattern: `debug/info/warn/error` all funnel
 * through `_dispatch()` which checks the level and delegates to `_write()`.
 */
class Logger {
    /**
     * @param {string} name
     * @param {'debug'|'info'|'warn'|'error'} [level='info']
     */
    constructor(name, level = 'info') {
        this.name = name;
        this.level = resolveLevel(level);
    }

    /**
     * Template method — subclasses override this to produce actual output.
     * @param {'debug'|'info'|'warn'|'error'} _level
     * @param {string} _prefix
     * @param {*[]} _args
     * @protected
     */
    _write(_level, _prefix, _args) {
        // Default: no-op. Subclasses provide real output.
    }

    /**
     * Internal dispatch. Returns empty string so log calls can be used
     * in expressions without side effects.
     *
     * @param {'debug'|'info'|'warn'|'error'} level
     * @param {*[]} args
     * @returns {string}
     * @private
     */
    _dispatch(level, args) {
        if (LOG_LEVELS[level] < this.level) return '';
        const ts = new Date().toISOString().slice(11, 23);
        const prefix = `[${ts}][${level.toUpperCase()}][${this.name}]`;
        this._write(level, prefix, args);
        return '';
    }

    /** Log at debug level */
    debug(/** @type {...*} */ ...args) { return this._dispatch('debug', args); }

    /** Log at info level */
    info(/** @type {...*} */ ...args)  { return this._dispatch('info', args); }

    /** Log at warn level */
    warn(/** @type {...*} */ ...args)  { return this._dispatch('warn', args); }

    /** Log at error level */
    error(/** @type {...*} */ ...args) { return this._dispatch('error', args); }

    /**
     * Check whether a given level would be logged.
     * @param {'debug'|'info'|'warn'|'error'} level
     * @returns {boolean}
     */
    shouldLog(level) {
        return LOG_LEVELS[level] >= this.level;
    }
}

// ---------------------------------------------------------------------------
// Console logger — colored prefix output
// ---------------------------------------------------------------------------

/**
 * Format a single argument for log forwarding.
 * Handles Error objects (with stack), strings, and objects.
 * @param {*} arg
 * @returns {string}
 */
function _formatArg(arg) {
    if (arg instanceof Error) {
        return arg.stack || `${arg.name}: ${arg.message}`;
    }
    if (typeof arg === 'string') return arg;
    try {
        return JSON.stringify(arg) ?? String(arg);
    } catch {
        return String(arg);
    }
}

/** @type {Record<string, string>} */
const CONSOLE_STYLES = {
    debug: 'color:#6b7280;font-weight:bold',
    info:  'color:#3b82f6;font-weight:bold',
    warn:  'color:#f59e0b;font-weight:bold',
    error: 'color:#ef4444;font-weight:bold',
};

class ConsoleLogger extends Logger {
    /**
     * @param {'debug'|'info'|'warn'|'error'} level
     * @param {string} prefix
     * @param {*[]} args
     */
    _write(level, prefix, args) {
        const style = CONSOLE_STYLES[level] || CONSOLE_STYLES.info;
        /** @type {'log'|'info'|'warn'|'error'} */
        const method = level === 'debug' ? 'log' : level;
        if (typeof console[method] === 'function') {
            console[method](`%c${prefix}`, style, ...args);
        }

        // Forward all levels to the backend app log (fire-and-forget, rate-limited).
        // debug is included because it only reaches _write when the user has
        // explicitly lowered the log level — in that case they want full visibility.
        const msg = args.map(_formatArg).join(' ');
        forwardToBackend(level, 'console', `${prefix} ${msg}`);
    }
}

// ---------------------------------------------------------------------------
// Logger registry — centralized instance management
// ---------------------------------------------------------------------------

/** @type {Map<string, Logger>} */
const _registry = new Map();

/**
 * Create (or retrieve) a named logger and register it.
 *
 * @param {string}   name           Unique logger identifier
 * @param {'debug'|'info'|'warn'|'error'} [level='info']  Default log level
 * @returns {Logger}
 */
function createLogger(name, level = 'info') {
    if (_registry.has(name)) return /** @type {Logger} */ (_registry.get(name));
    const logger = new ConsoleLogger(name, level);
    _registry.set(name, logger);
    return logger;
}

/**
 * Retrieve a previously created logger by name.
 *
 * @param {string} name
 * @returns {Logger|undefined}
 */
function getLogger(name) {
    return _registry.get(name);
}

/**
 * Set the log level on every registered logger.
 *
 * @param {'debug'|'info'|'warn'|'error'|'off'} level
 */
function setGlobalLevel(level) {
    const numeric = resolveLevel(level);
    for (const logger of _registry.values()) {
        logger.level = numeric;
    }
}

// ---------------------------------------------------------------------------
// Pre-built module-level logger instances
// ---------------------------------------------------------------------------

/** API communication */
export const apiLogger        = createLogger('API',          'info');

/** WebSocket connections */
export const wsLogger         = createLogger('WebSocket',    'info');

/** UI rendering and interaction */
export const uiLogger         = createLogger('UI',           'info');

/** Internationalization */
export const i18nLogger       = createLogger('I18n',         'info');

/** Core configuration management */
export const coreLogger       = createLogger('Core',         'info');

/** Rule processing */
export const rulesLogger      = createLogger('Rules',        'info');

/** Settings management */
export const settingsLogger   = createLogger('Settings',     'info');

/** Connection monitoring */
export const connectionsLogger = createLogger('Connections', 'info');

/** Traffic charts (verbose — default warn to reduce noise) */
export const trafficLogger    = createLogger('Traffic',      'warn');

/** System tray */
export const trayLogger       = createLogger('Tray',         'info');

/** TUN mode */
export const tunLogger        = createLogger('TUN',          'info');

/** DNS configuration */
export const dnsLogger        = createLogger('DNS',          'info');

/** Proxy modes */
export const modesLogger      = createLogger('Modes',        'info');

/** Proxy nodes */
export const proxyLogger      = createLogger('Proxy',        'info');

/** Theme management */
export const themeLogger      = createLogger('Theme',        'info');

/** Cache layer */
export const cacheLogger      = createLogger('Cache',        'info');

/** Navigation */
export const navLogger        = createLogger('Nav',          'info');

/** Advanced settings */
export const advancedLogger   = createLogger('Advanced',     'info');

/** System proxy */
export const sysproxyLogger   = createLogger('SysProxy',     'info');

/** Node wheel / selector */
export const nodeWheelLogger  = createLogger('NodeWheel',    'info');

/** Proxy memory */
export const proxyMemoryLogger = createLogger('ProxyMemory', 'info');
export const observedGroupLogger = createLogger('ObservedGroup', 'info');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export { createLogger, getLogger, setGlobalLevel };
