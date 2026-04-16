// @ts-check
/// <reference path="../js-yaml.d.ts" />
/**
 * Advanced settings editor - dynamic core configuration engine.
 * Uses createCollapsible for reusable panel rendering.
 */

import { getConfig, patchConfig } from '../api.js';
import { invoke } from '../api.js';
import { escapeHtml } from '../utils/sanitize.js';
import { SVG_ICONS } from './icons.js';
import { showNotification } from './notifications.js';
import { createCollapsible } from './collapsible.js';
import { invalidateConfigCache } from './cache.js';
import { advancedLogger } from '../utils/logger.js';
import { toError } from '../types/guards.js';

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
 * @param {*} target
 * @param {*} source
 * @returns {*}
 */
function deepMerge(target, source) {
    if (!isPlainObject(target)) return source;
    if (!isPlainObject(source)) return source;

    // Arrays are fully replaced (not merged by index).
    if (Array.isArray(target) && Array.isArray(source)) return source;

    const blockedKeys = new Set(['__proto__', 'constructor', 'prototype']);

    for (const key of Object.keys(source)) {
        if (blockedKeys.has(key)) continue;

        const sourceValue = source[key];
        const targetHasOwnKey = Object.prototype.hasOwnProperty.call(target, key);
        const canRecurse =
            targetHasOwnKey &&
            isPlainObject(target[key]) &&
            isPlainObject(sourceValue);

        if (canRecurse) {
            target[key] = deepMerge(target[key], sourceValue);
        } else {
            target[key] = sourceValue;
        }
    }
    return target;
}

/**
 * @returns {Promise<{ configName: string, content: string } | null>}
 */
async function getActiveConfigContent() {
    const settings = await invoke('get_settings');
    let configName = settings.last_config || 'config.yaml';
    let content = '';
    try {
        content = await invoke('read_config_file', { configPath: configName });
        return { configName, content };
    } catch (e) {
        const configs = await invoke('list_configs');
        if (configs && configs.length > 0) {
            configName = configs[0].name;
            content = await invoke('read_config_file', { configPath: configName });
            return { configName, content };
        } else {
            return null;
        }
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
        await invoke('write_config_file', { configPath: configName, content: newYaml });
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
        await persistConfigChanges(payload);

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
 * @param {number} depth
 */
function renderArrayContent(container, arr, parentKey, depth) {
    if (arr.length === 0) {
        const empty = document.createElement('div');
        empty.className = "text-xs text-zinc-500 italic";
        empty.textContent = "(empty array)";
        container.appendChild(empty);
        return;
    }

    if (typeof arr[0] === 'object' && arr[0] !== null) {
        /** @type {Array<*>} */
        const items = arr;
        items.forEach((item, index) => {
            const itemCard = document.createElement('div');
            itemCard.className = "bg-black/20 rounded-lg p-3 space-y-2";

            const idxHeader = document.createElement('div');
            idxHeader.className = "text-2xs text-zinc-500 font-mono mb-2";
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

    const { content, card } = createCollapsible(wrapper, {
        title,
        defaultOpen: false,
        badgeText: `${arr.length}`,
        cardClass: 'bg-black/20 rounded-xl overflow-hidden',
        headerClass: 'p-3',
        contentClass: 'border-t border-white/5 space-y-2 p-3',
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
    textarea.className = "w-full min-h-[60px] bg-black/40 border border-white/5 rounded-lg px-3 py-2 text-2xs text-zinc-300 focus:outline-none focus:border-accent/50 transition-all font-mono resize-y";
    textarea.value = arr.join('\n');
    textarea.rows = Math.min(arr.length, 10);

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
        label.className = "text-xs font-medium text-zinc-300 capitalize truncate";
        label.textContent = key.replace(/-/g, ' ');
        labelContainer.appendChild(label);
    }

    const subLabel = document.createElement('p');
    subLabel.className = "text-2xs text-zinc-600 font-mono truncate";
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
        input.className = "w-full max-w-[100px] bg-black/40 border border-white/5 rounded-lg px-3 py-1 text-xs text-zinc-300 focus:outline-none focus:border-accent/50 transition-all text-right font-mono";
        input.onchange = () => handleConfigUpdate(fullKey, Number(input.value));
        valueContainer.appendChild(input);
    } else if (typeof value === 'string') {
        const input = document.createElement('input');
        input.type = "text";
        input.value = value;
        input.className = "w-full bg-black/40 border border-white/5 rounded-lg px-3 py-1 text-xs text-zinc-300 focus:outline-none focus:border-accent/50 transition-all text-right font-mono";
        input.onchange = () => handleConfigUpdate(fullKey, input.value);
        valueContainer.appendChild(input);
    } else if (Array.isArray(value)) {
        const wrapper = document.createElement('div');
        wrapper.className = "flex items-center gap-1.5";

        const badge = document.createElement('span');
        badge.className = "text-2xs text-zinc-400 px-2 py-0.5 bg-black/30 rounded-md";
        badge.textContent = value.length === 1 ? `1 item` : `${value.length} items`;
        wrapper.appendChild(badge);

        if (value.length > 0 && typeof value[0] !== 'object') {
            const preview = document.createElement('span');
            preview.className = "text-2xs text-zinc-600 font-mono truncate max-w-[80px]";
            preview.textContent = String(value[0]);
            wrapper.appendChild(preview);
        }

        valueContainer.appendChild(wrapper);
    } else if (typeof value === 'object' && value !== null) {
        const badge = document.createElement('span');
        badge.className = "text-2xs text-zinc-400 px-2 py-0.5 bg-black/30 rounded-md";
        const keyCount = Object.keys(value).length;
        badge.textContent = keyCount === 1 ? `1 field` : `${keyCount} fields`;
        valueContainer.appendChild(badge);
    } else if (value === null || value === undefined) {
        const wrapper = document.createElement('div');
        wrapper.className = "flex items-center gap-1";

        const badge = document.createElement('span');
        badge.className = "text-2xs text-zinc-600 italic px-2 py-0.5 bg-black/30 rounded";
        badge.textContent = value === null ? "null" : "undefined";
        wrapper.appendChild(badge);

        const setBtn = document.createElement('button');
        setBtn.className = "text-2xs text-accent hover:text-accent/80 px-1.5 py-0.5 rounded transition-colors";
        setBtn.title = "Set value";
        setBtn.innerHTML = SVG_ICONS.plus;
        setBtn.onclick = (e) => {
            e.stopPropagation();
            const input = document.createElement('input');
            input.type = "text";
            input.className = "w-full max-w-[120px] bg-black/40 border border-accent/50 rounded-lg px-2 py-1 text-xs text-zinc-300 focus:outline-none font-mono";
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
export { deepMerge, isPlainObject, getActiveConfigContent };
