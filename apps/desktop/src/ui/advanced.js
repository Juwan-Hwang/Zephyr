// @ts-check
/// <reference path="../js-yaml.d.ts" />
/**
 * Advanced settings editor - dynamic core configuration engine.
 * Uses createCollapsible for reusable panel rendering.
 */

import { getConfig, patchConfig, invoke } from '../api.js';
import { SVG_ICONS } from './icons.js';
import { showNotification } from './notifications.js';
import { createCollapsible } from './collapsible.js';
import { invalidateConfigCache } from './cache.js';
import { advancedLogger } from '../utils/logger.js';
import { toError } from '../types/guards.js';
import { COMMANDS } from '@zephyr/shared';
import { validateConfig } from './prism.js';

// --- Helpers ---

/**
 * @param {*} value
 * @returns {boolean}
 */
function isPlainObject(value) {
    if (typeof value !== 'object' || value === null) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * @param {string} key
 * @returns {boolean}
 */
function isSafeMergeKey(key) {
    return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
}

/**
 * @param {*} target
 * @param {*} source
 * @returns {*}
 */
function deepMerge(target, source) {
    if (!isPlainObject(target) || Array.isArray(target)) return source;
    if (!isPlainObject(source) || Array.isArray(source)) return source;

    for (const key of Object.keys(source)) {
        if (!isSafeMergeKey(key)) continue;
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        if (!isPlainObject(target) || Array.isArray(target)) continue;

        const sourceValue = source[key];
        const targetHasOwnKey = Object.prototype.hasOwnProperty.call(target, key);
        const targetValue = targetHasOwnKey ? target[key] : undefined;
        const canRecurse =
            targetHasOwnKey &&
            isPlainObject(targetValue) &&
            !Array.isArray(targetValue) &&
            isPlainObject(sourceValue) &&
            !Array.isArray(sourceValue);

        if (canRecurse) {
            target[key] = deepMerge(targetValue, sourceValue);
        } else if (isPlainObject(sourceValue) && !Array.isArray(sourceValue)) {
            // Avoid assigning attacker-controlled object references directly.
            const nextTarget =
                targetHasOwnKey && isPlainObject(targetValue) && !Array.isArray(targetValue)
                    ? targetValue
                    : Object.create(null);
            Object.defineProperty(target, key, {
                value: deepMerge(nextTarget, sourceValue),
                writable: true,
                enumerable: true,
                configurable: true,
            });
        } else {
            // Use Object.defineProperty to avoid triggering setters on the prototype chain
            Object.defineProperty(target, key, {
                value: sourceValue,
                writable: true,
                enumerable: true,
                configurable: true,
            });
        }
    }
    return target;
}

/**
 * @returns {Promise<{ configName: string, content: string } | null>}
 */
async function getActiveConfigContent() {
    const settings = await invoke(COMMANDS.GET_SETTINGS);
    let configName = settings.last_config || 'config.yaml';
    let content = '';
    try {
        content = await invoke(COMMANDS.READ_CONFIG_FILE, { configPath: configName });
        return { configName, content };
    } catch {
        const configs = await invoke(COMMANDS.LIST_CONFIGS);
        if (configs && configs.length > 0) {
            configName = configs[0].name;
            content = await invoke(COMMANDS.READ_CONFIG_FILE, { configPath: configName });
            return { configName, content };
        }
        return null;
    }
}

/**
 * @param {Object} payload
 * @returns {Promise<boolean>}
 */
export async function persistConfigChanges(payload) {
    try {
        const activeConfig = await getActiveConfigContent();
        if (!activeConfig) return false;
        const { configName, content } = activeConfig;

        if (typeof jsyaml === 'undefined') return false;

        const config = jsyaml.load(content) || {};

        deepMerge(config, payload);

        const newYaml = jsyaml.dump(config, { indent: 2, lineWidth: -1 });

        // Validate config before writing to prevent core crash.
        // If validation is unavailable (e.g. mihomo not in PATH) or fails,
        // still write — the runtime config was already patched successfully.
        try {
            const isValid = await validateConfig(newYaml);
            if (!isValid) {
                advancedLogger.warn('Config validation failed, writing anyway');
            }
        } catch {
            // Validation unavailable (e.g. mihomo not in PATH) — proceed with write.
        }

        await invoke(COMMANDS.WRITE_CONFIG_FILE, { configPath: configName, content: newYaml });
        return true;
    } catch (err) {
        advancedLogger.error('Failed to persist config', err);
        throw err;
    }
}

// --- Config update ---

/**
 * @param {string} path
 * @param {*} value
 */
async function handleConfigUpdate(path, value) {
    const payload = buildNestedPayload(path, value);

    try {
        await patchConfig(payload);
        invalidateConfigCache();
        const persisted = await persistConfigChanges(payload);
        if (!persisted) {
            const { translations, currentLang } = await import('../i18n.js').then(m => m);
            const langKey = /** @type {'en'|'zh'|'ja'|'ko'} */(currentLang);
            const t = /** @type {Record<string, string>} */(translations[langKey]);
            showNotification(`${t.errorPrefix || 'Error'}: Config validation failed, changes not persisted`, 'error');
            renderAdvancedSettings();
            return;
        }

        const { translations, currentLang } = await import('../i18n.js').then(m => m);
        const langKey = /** @type {'en'|'zh'|'ja'|'ko'} */(currentLang);
        const t = /** @type {Record<string, string>} */(translations[langKey]);
        showNotification(t.configSuccess || 'Configuration saved', 'success');

        import('./proxies.js').then(m => m.syncCoreConfig());
    } catch (err) {
        advancedLogger.error('Failed to update config', err);
        const { translations, currentLang } = await import('../i18n.js').then(m => m);
        const langKey = /** @type {'en'|'zh'|'ja'|'ko'} */(currentLang);
        const t = /** @type {Record<string, string>} */(translations[langKey]);
        const errorObj = toError(err);
        showNotification(`${t.errorPrefix || 'Error'}: ${errorObj.message}`, 'error');
        renderAdvancedSettings();
    }
}

/**
 * @param {string} path
 * @param {*} value
 * @returns {Object}
 */
function buildNestedPayload(path, value) {
    /** @type {any} */
    const result = {};
    /** @type {any} */
    let current = result;

    const segments = [];
    const regex = /([^.\[\]]+)|\[(\d+)\]/g;
    let match;
    while ((match = regex.exec(path)) !== null) {
        if (match[1] !== undefined) {
            segments.push({ type: 'key', value: match[1] });
        } else if (match[2] !== undefined) {
            segments.push({ type: 'index', value: parseInt(match[2]) });
        }
    }

    for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i];
        const nextSeg = segments[i + 1];

        if (seg.type === 'key') {
            current[seg.value] = nextSeg.type === 'index' ? [] : {};
            current = current[seg.value];
        } else {
            while (current.length <= seg.value) {
                current.push(nextSeg.type === 'index' ? [] : {});
            }
            current = current[seg.value];
        }
    }

    const lastSeg = segments[segments.length - 1];
    if (lastSeg.type === 'key') {
        current[lastSeg.value] = value;
    } else {
        while (current.length <= lastSeg.value) {
            current.push(null);
        }
        current[lastSeg.value] = value;
    }

    return result;
}

// --- Render functions ---

export async function renderAdvancedSettings() {
    const container = document.getElementById('advanced-settings-container');
    if (!container) return;

    try {
        const config = await getConfig();
        if (!config) throw new Error("Failed to fetch config");

        const fragment = document.createDocumentFragment();

        for (const [key, value] of Object.entries(config)) {
            const card = renderConfigSection(key, value, key);
            if (card) fragment.appendChild(card);
        }

        container.innerHTML = '';
        container.appendChild(fragment);
    } catch (err) {
        advancedLogger.error('Advanced settings render error', err);
        container.innerHTML = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'p-8 text-center text-rose-400 text-xs font-bold';
        errDiv.textContent = toError(err).message;
        container.appendChild(errDiv);
    }
}

/**
 * @param {string} title
 * @param {*} obj
 * @param {string} fullKey
 * @param {number} [depth]
 * @returns {Element | null}
 */
function renderConfigSection(title, obj, fullKey, depth = 0) {
    const wrapper = document.createElement('div');

    const isObj = typeof obj === 'object' && obj !== null && !Array.isArray(obj);
    const badgeText = isObj ? `${Object.keys(obj).length}` : undefined;

    const { content, card } = createCollapsible(wrapper, {
        title,
        defaultOpen: depth === 0,
        subLabel: fullKey,
        badgeText,
    });

    card.dataset.key = fullKey;

    // Render content based on type
    if (typeof obj === 'object' && obj !== null) {
        if (Array.isArray(obj)) {
            renderArrayContent(content, obj, fullKey, depth);
        } else {
            renderObjectContent(content, obj, fullKey, depth);
        }
    } else {
        const item = renderConfigItem(title, obj, fullKey);
        content.appendChild(item);
    }

    return wrapper.firstElementChild;
}

/**
 * @param {HTMLElement} container
 * @param {Object} obj
 * @param {string} parentKey
 * @param {number} depth
 */
function renderObjectContent(container, obj, parentKey, depth) {
    for (const [key, value] of Object.entries(obj)) {
        const currentKey = `${parentKey}.${key}`;

        if (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0) {
            const subSection = renderConfigSection(key, value, currentKey, depth + 1);
            if (subSection) container.appendChild(subSection);
        } else if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
            const arraySection = renderArraySection(key, value, currentKey, depth + 1);
            if (arraySection) container.appendChild(arraySection);
        } else {
            const item = renderConfigItem(key, value, currentKey);
            container.appendChild(item);
        }
    }
}

/**
 * @param {HTMLElement} container
 * @param {Array<*>} arr
 * @param {string} parentKey
 * @param {number} _depth
 */
function renderArrayContent(container, arr, parentKey, _depth) {
    if (arr.length === 0) {
        const empty = document.createElement('div');
        empty.className = "text-xs text-[var(--text-muted)] italic";
        empty.textContent = "(empty array)";
        container.appendChild(empty);
        return;
    }

    if (typeof arr[0] === 'object' && arr[0] !== null) {
        /** @type {Array<*>} */
        const items = arr;
        items.forEach((item, index) => {
            const itemCard = document.createElement('div');
            itemCard.className = "bg-[var(--zephyr-bg-input)] rounded-lg p-3 space-y-2";

            const idxHeader = document.createElement('div');
            idxHeader.className = "text-2xs text-[var(--text-muted)] font-mono mb-2";
            idxHeader.textContent = `[${index}]`;
            itemCard.appendChild(idxHeader);

            if (typeof item === 'object' && !Array.isArray(item)) {
                for (const [k, v] of Object.entries(item)) {
                    const itemRow = renderConfigItem(k, v, `${parentKey}[${index}].${k}`);
                    itemCard.appendChild(itemRow);
                }
            } else {
                const itemRow = renderConfigItem('', item, `${parentKey}[${index}]`);
                itemCard.appendChild(itemRow);
            }

            container.appendChild(itemCard);
        });
    } else {
        renderSimpleArrayEditor(container, arr, parentKey);
    }
}

/**
 * @param {string} title
 * @param {Array<*>} arr
 * @param {string} fullKey
 * @param {number} depth
 * @returns {Element | null}
 */
function renderArraySection(title, arr, fullKey, depth) {
    const wrapper = document.createElement('div');

    const { content, card: _card } = createCollapsible(wrapper, {
        title,
        defaultOpen: false,
        badgeText: `${arr.length}`,
        cardClass: 'bg-[var(--zephyr-bg-input)] rounded-lg overflow-hidden',
        headerClass: 'p-3',
        contentClass: 'border-t border-[var(--zephyr-border-subtle)] space-y-2 p-3',
    });

    renderArrayContent(content, arr, fullKey, depth);

    return wrapper.firstElementChild;
}

/**
 * @param {HTMLElement} container
 * @param {Array<*>} arr
 * @param {string} fullKey
 */
function renderSimpleArrayEditor(container, arr, fullKey) {
    const wrapper = document.createElement('div');
    wrapper.className = "space-y-1";

    const textarea = document.createElement('textarea');
    textarea.className = "form-control form-control-mono w-full min-h-[60px] px-3 py-2 text-2xs resize-y";
    textarea.setAttribute('aria-label', `Edit ${fullKey}`);
    textarea.value = arr.join('\n');
    textarea.rows = Math.max(1, Math.min(arr.length, 10));

    textarea.onchange = () => {
        const newValue = textarea.value.split('\n').filter(line => line.trim() !== '');
        handleConfigUpdate(fullKey, newValue);
    };

    wrapper.appendChild(textarea);
    container.appendChild(wrapper);
}

/**
 * @param {string} key
 * @param {*} value
 * @param {string} fullKey
 * @returns {HTMLElement}
 */
function renderConfigItem(key, value, fullKey) {
    const row = document.createElement('div');
    row.className = "flex items-center justify-between w-full gap-4 py-1";
    row.dataset.fullKey = fullKey;

    // Label
    const labelContainer = document.createElement('div');
    labelContainer.className = "shrink-0 min-w-0";

    if (key) {
        const label = document.createElement('p');
        label.className = "text-xs font-medium text-[var(--text-secondary)] capitalize truncate";
        label.textContent = key.replace(/-/g, ' ');
        labelContainer.appendChild(label);
    }

    const subLabel = document.createElement('p');
    subLabel.className = "text-2xs text-[var(--text-tertiary)] font-mono truncate";
    subLabel.textContent = fullKey.split('.').pop() || '';
    labelContainer.appendChild(subLabel);

    row.appendChild(labelContainer);

    // Value container
    const valueContainer = document.createElement('div');
    valueContainer.className = "flex-1 max-w-[200px] flex justify-end";

    if (typeof value === 'boolean') {
        const toggleLabel = document.createElement('label');
        toggleLabel.className = "ios-switch";

        const input = document.createElement('input');
        input.type = "checkbox";
        input.checked = value;
        input.onchange = () => handleConfigUpdate(fullKey, input.checked);

        const slider = document.createElement('span');
        slider.className = "switch-slider";

        toggleLabel.appendChild(input);
        toggleLabel.appendChild(slider);
        valueContainer.appendChild(toggleLabel);
    } else if (typeof value === 'number') {
        const input = document.createElement('input');
        input.type = "number";
        input.value = String(value);
        input.className = "form-control form-control-md form-control-mono max-w-[100px] text-right";
        input.onchange = () => handleConfigUpdate(fullKey, Number(input.value));
        valueContainer.appendChild(input);
    } else if (typeof value === 'string') {
        const input = document.createElement('input');
        input.type = "text";
        input.value = value;
        input.className = "form-control form-control-md form-control-mono text-right";
        input.onchange = () => handleConfigUpdate(fullKey, input.value);
        valueContainer.appendChild(input);
    } else if (Array.isArray(value)) {
        const wrapper = document.createElement('div');
        wrapper.className = "flex items-center gap-1.5";

        const badge = document.createElement('span');
        badge.className = "type-badge";
        badge.textContent = value.length === 1 ? `1 item` : `${value.length} items`;
        wrapper.appendChild(badge);

        if (value.length > 0 && typeof value[0] !== 'object') {
            const preview = document.createElement('span');
            preview.className = "text-2xs text-[var(--text-tertiary)] font-mono truncate max-w-[80px]";
            preview.textContent = String(value[0]);
            wrapper.appendChild(preview);
        }

        valueContainer.appendChild(wrapper);
    } else if (typeof value === 'object' && value !== null) {
        const badge = document.createElement('span');
        badge.className = "type-badge";
        const keyCount = Object.keys(value).length;
        badge.textContent = keyCount === 1 ? `1 field` : `${keyCount} fields`;
        valueContainer.appendChild(badge);
    } else if (value === null || value === undefined) {
        const wrapper = document.createElement('div');
        wrapper.className = "flex items-center gap-1";

        const badge = document.createElement('span');
        badge.className = "type-badge italic";
        badge.textContent = value === null ? "null" : "undefined";
        wrapper.appendChild(badge);

        const setBtn = document.createElement('button');
        setBtn.type = "button";
        setBtn.className = "text-2xs text-accent hover:text-accent/80 px-1.5 py-0.5 rounded-sm transition-colors";
        setBtn.title = "Set value";
        setBtn.setAttribute('aria-label', 'Set value for ' + fullKey);
        // eslint-disable-next-line no-unsanitized/property -- static SVG constant
        setBtn.innerHTML = SVG_ICONS.plus;
        setBtn.onclick = (e) => {
            e.stopPropagation();
            const input = document.createElement('input');
            input.type = "text";
            input.className = "form-control w-full max-w-[120px] px-2 py-1 text-xs font-mono";
            input.setAttribute('aria-label', `New value for ${fullKey}`);
            input.placeholder = "value...";
            input.onkeydown = (ev) => {
                if (ev.key === 'Enter') {
                    const val = input.value.trim();
                    /** @type {string|boolean|number|Object} */
                    let parsed = val;
                    if (val === 'true') parsed = true;
                    else if (val === 'false') parsed = false;
                    else if (val !== '' && !isNaN(Number(val))) parsed = Number(val);
                    else if (val.startsWith('{') || val.startsWith('[')) {
                        try { parsed = JSON.parse(val); } catch {}
                    }
                    handleConfigUpdate(fullKey, parsed);
                } else if (ev.key === 'Escape') {
                    wrapper.innerHTML = '';
                    wrapper.appendChild(badge);
                    wrapper.appendChild(setBtn);
                }
            };
            wrapper.innerHTML = '';
            wrapper.appendChild(input);
            input.focus();
        };
        wrapper.appendChild(setBtn);
        valueContainer.appendChild(wrapper);
    }

    row.appendChild(valueContainer);
    return row;
}

// Re-export helpers for use by other modules
export { deepMerge, isPlainObject, isSafeMergeKey, getActiveConfigContent };
