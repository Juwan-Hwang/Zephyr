// @ts-check
/**
 * Rules engine UI - manage custom routing rules.
 * Extracted from ui.js for modularity.
 */

import { escapeHtml, escapeAttr } from '../utils/sanitize.js';
import { getPolicyColor } from '../utils/rule-utils.js';
import { rulesLogger } from '../utils/logger.js';
import { showNotification } from './notifications.js';
import { initCustomDropdown } from './dropdown.js';
import { translations, currentLang } from '../i18n.js';
import { invoke, closeAllConnections } from '../api.js';
import { COMMANDS } from '@zephyr/shared';
import { fetchAndConvertSRRules } from '../rules.js';
import { SVG_ICONS } from './icons.js';
import { getActiveConfigContent } from './advanced.js';
import { validateConfig, isPrismRule } from './prism.js';

// --- State ---

/** @type {string[]} */
let currentConfigRules = [];
/** @type {string[]} */
let originalConfigRules = [];

// --- Public API ---

export async function initRulesPage() {
    const list = document.getElementById('rules-list');
    if (!list) return;

    // Fetch initial original rules state silently
    if (!originalConfigRules || originalConfigRules.length === 0) {
        try {
            const settings = await invoke(COMMANDS.GET_SETTINGS);
            const configName = settings.last_config || 'config.yaml';
            const content = await invoke(COMMANDS.READ_CONFIG_FILE, { configPath: configName });
            if (typeof jsyaml !== 'undefined') {
                const _config = jsyaml.load(content);
                originalConfigRules = (/** @type {any} */ (_config)).rules || [];
                if (currentConfigRules.length === 0) {
                    currentConfigRules = [...originalConfigRules];
                }
            }
        } catch {
            // Silently ignore on first init
        }
    }

    // Add UI Listeners (only once)
    if (!list.dataset.init) {
        list.dataset.init = 'true';
        const form = document.getElementById('add-rule-form');
        const addBtn = document.getElementById('add-rule-btn');
        const cancelBtn = document.getElementById('cancel-add-rule-btn');
        const confirmBtn = document.getElementById('confirm-add-rule-btn');

        // Initialize custom dropdowns for rule form
        /** @type {any} */ (window).__ruleTypeDropdown = initCustomDropdown({
            wrapId: 'new-rule-type-wrap',
            triggerId: 'new-rule-type-trigger',
            menuId: 'new-rule-type-menu',
            labelId: 'new-rule-type-label',
            selectId: 'new-rule-type',
        });
        /** @type {any} */ (window).__rulePolicyDropdown = initCustomDropdown({
            wrapId: 'new-rule-policy-wrap',
            triggerId: 'new-rule-policy-trigger',
            menuId: 'new-rule-policy-menu',
            labelId: 'new-rule-policy-label',
            selectId: 'new-rule-policy',
        });

        addBtn?.addEventListener('click', () => {
            if (!form) return;
            form.classList.remove('hidden');
            (/** @type {HTMLInputElement} */ (document.getElementById('new-rule-value'))).focus();
        });

        cancelBtn?.addEventListener('click', () => {
            if (!form) return;
            form.classList.add('hidden');
            (/** @type {HTMLInputElement} */ (document.getElementById('new-rule-value'))).value = '';
        });

        confirmBtn?.addEventListener('click', () => {
            if (!form) return;
            const type = (/** @type {HTMLSelectElement} */ (document.getElementById('new-rule-type'))).value;
            const value = (/** @type {HTMLInputElement} */ (document.getElementById('new-rule-value'))).value.trim();
            const policy = (/** @type {HTMLSelectElement} */ (document.getElementById('new-rule-policy'))).value;

            if (type !== 'MATCH' && !value) {
                const t = /** @type {any} */ (translations)[currentLang];
                showNotification(t.valueEmpty || 'Value cannot be empty', 'error');
                return;
            }

            const newRule = type === 'MATCH' ? `${type},${policy}` : `${type},${value},${policy}`;
            currentConfigRules.unshift(newRule);
            renderRulesList();
            updateSaveRulesBtnVisibility();

            form.classList.add('hidden');
            (/** @type {HTMLInputElement} */ (document.getElementById('new-rule-value'))).value = '';
        });

        document.getElementById('save-rules-btn')?.addEventListener('click', saveRules);
        document.getElementById('import-sr-btn')?.addEventListener('click', importSRRules);

        // Search functionality
        const searchInput = document.getElementById('rules-search-input');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                const target = /** @type {HTMLInputElement} */ (e.target);
                renderRulesList(target.value);
            });
        }
    }

    await loadRules();
}

// --- Internal ---

async function loadRules() {
    try {
        const activeConfig = await getActiveConfigContent();
        if (!activeConfig) {
            currentConfigRules = [];
            originalConfigRules = [];
            renderRulesList();
            return;
        }
        const { content } = activeConfig;

        if (typeof jsyaml === 'undefined') {
            const t = /** @type {any} */ (translations)[currentLang];
            showNotification(t.jsYamlError || 'js-yaml is not loaded. Check internet connection.', 'error');
            return;
        }
        const _loadedConfig = jsyaml.load(content);
        currentConfigRules = (/** @type {any} */ (_loadedConfig)).rules || [];
        originalConfigRules = [...currentConfigRules];
        renderRulesList();
        updateSaveRulesBtnVisibility();
    } catch (err) {
        showNotification(/** @type {any} */ (translations)[currentLang].notifRulesLoadFailed, 'error');
        rulesLogger.error('Failed to load rules', err);
    }
}

async function renderRulesList(searchQuery = '') {
    const container = document.getElementById('rules-list');
    if (!container) return;
 
container.innerHTML = '';

const query = searchQuery.toLowerCase();

    for (let i = 0; i < currentConfigRules.length; i++) {
        const rule = currentConfigRules[i];
        const index = i;
        if (query && !rule.toLowerCase().includes(query)) continue;

        const parts = typeof rule === 'string' ? rule.split(',').map((/** @type {string} */ s) => s.trim()) : [];
        if (parts.length < 2) continue;

        const type = parts[0];
        const value = parts[1];
        const policy = parts[2] || 'Proxy';

        const item = document.createElement('div');
        item.className = 'glass-card p-4 flex items-center justify-between group hover:translate-x-1 transition-transform duration-300 cursor-pointer';

        // Mark Prism-managed rules with a visual indicator
        const isPrismManaged = await isPrismRule(index);
        if (isPrismManaged) {
            item.classList.add('ring-1', 'ring-accent/30');
            item.title = 'This rule is managed by Prism Engine';
        }

// SECURITY FIX: use setAttribute for title instead of innerHTML with escaped value
// eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml()
item.innerHTML = `
            <div class="flex items-center gap-4 flex-1">
                <div class="type-badge text-zinc-500">${escapeHtml(type)}</div>
                <div class="text-xs text-zinc-300 font-mono truncate max-w-[240px]">${escapeHtml(value)}</div>
            </div>
            <div class="flex items-center gap-2">
                <div class="text-2xs font-bold ${getPolicyColor(policy)} uppercase tracking-wider mr-2">${escapeHtml(policy)}</div>

                <button class="btn-move-top-rule opacity-0 group-hover:opacity-100 p-1.5 rounded-sm text-zinc-500 hover:text-accent hover:bg-accent/10 transition-all" title="${escapeAttr(/** @type {any} */ (translations)[currentLang].moveToTop || 'Move to Top')}">
                    ${SVG_ICONS.arrowUp}
                </button>
                <button class="btn-move-bottom-rule opacity-0 group-hover:opacity-100 p-1.5 rounded-sm text-zinc-500 hover:text-accent hover:bg-accent/10 transition-all" title="${escapeAttr(/** @type {any} */ (translations)[currentLang].moveToBottom || 'Move to Bottom')}">
                    ${SVG_ICONS.arrowDown}
                </button>
                <button class="btn-delete-rule opacity-0 group-hover:opacity-100 btn-delete-icon">
                    ${SVG_ICONS.trash}
                </button>
            </div>
        `;

        // Set title attribute safely (no innerHTML injection)
        const valueDiv = item.querySelector('.font-mono.truncate');
        if (valueDiv) valueDiv.setAttribute('title', value);

        // Edit rule on click
        item.addEventListener('click', (e) => {
            const target = /** @type {HTMLElement} */ (e.target);
            if (target.closest('.btn-delete-rule') || target.closest('.btn-move-top-rule') || target.closest('.btn-move-bottom-rule')) return;

            const form = document.getElementById('add-rule-form');
            if (!form) return;
            form.classList.remove('hidden');

            (/** @type {HTMLSelectElement} */ (document.getElementById('new-rule-type'))).value = type;
            (/** @type {HTMLInputElement} */ (document.getElementById('new-rule-value'))).value = value || '';
            (/** @type {HTMLSelectElement} */ (document.getElementById('new-rule-policy'))).value = policy;
            if (/** @type {any} */ (window).__ruleTypeDropdown) /** @type {any} */ (window).__ruleTypeDropdown.setValue(type);
            if (/** @type {any} */ (window).__rulePolicyDropdown) /** @type {any} */ (window).__rulePolicyDropdown.setValue(policy);

            currentConfigRules.splice(index, 1);

            (/** @type {HTMLElement} */ (document.getElementById('rules-list'))).scrollTop = 0;
            (/** @type {HTMLInputElement} */ (document.getElementById('new-rule-value'))).focus();
        });

        (/** @type {HTMLElement} */ (item.querySelector('.btn-move-top-rule')))?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (index > 0) {
                const movedRule = currentConfigRules.splice(index, 1)[0];
                currentConfigRules.unshift(movedRule);
                renderRulesList((/** @type {HTMLInputElement} */ (document.getElementById('rules-search-input')))?.value || '');
                updateSaveRulesBtnVisibility();
            }
        });

        (/** @type {HTMLElement} */ (item.querySelector('.btn-move-bottom-rule')))?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (index < currentConfigRules.length - 1) {
                const movedRule = currentConfigRules.splice(index, 1)[0];
                currentConfigRules.push(movedRule);
                renderRulesList((/** @type {HTMLInputElement} */ (document.getElementById('rules-search-input')))?.value || '');
                updateSaveRulesBtnVisibility();
            }
        });

        (/** @type {HTMLElement} */ (item.querySelector('.btn-delete-rule')))?.addEventListener('click', (e) => {
            e.stopPropagation();
            currentConfigRules.splice(index, 1);
            renderRulesList((/** @type {HTMLInputElement} */ (document.getElementById('rules-search-input')))?.value || '');
            updateSaveRulesBtnVisibility();
        });

        container.appendChild(item);
    }
}

async function importSRRules() {
    const input = /** @type {HTMLInputElement} */ (document.getElementById('import-sr-input'));
    const url = input?.value.trim();
    if (!url) return;

    const btn = /** @type {HTMLButtonElement} */ (document.getElementById('import-sr-btn'));
    if (!btn) return;
    const originalText = btn.textContent;
    btn.textContent = '...';
    btn.disabled = true;

    try {
        const newRules = await fetchAndConvertSRRules(url);
        currentConfigRules = [...newRules, ...currentConfigRules];
        renderRulesList();
        updateSaveRulesBtnVisibility();
        showNotification(/** @type {any} */ (translations)[currentLang].notifSRImportSuccess, 'success');
        input.value = '';
    } catch {
        showNotification(/** @type {any} */ (translations)[currentLang].notifSRImportFailed, 'error');
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

async function saveRules() {
    const btn = /** @type {HTMLButtonElement} */ (document.getElementById('save-rules-btn'));
    if (!btn) return;
const originalContent = btn.innerHTML;
// eslint-disable-next-line no-unsanitized/property -- static SVG constant
btn.innerHTML = SVG_ICONS.loadingSmall2;
    btn.disabled = true;

    try {
        const activeConfig = await getActiveConfigContent();
        if (!activeConfig) {
            throw new Error("No valid configuration file found to save rules.");
        }
        const { configName: _configName, content } = activeConfig;

        if (typeof jsyaml === 'undefined') {
            const t = /** @type {any} */ (translations)[currentLang];
            showNotification(t.jsYamlSaveError || 'js-yaml is not loaded. Cannot save/load rules.', 'error');
            return;
        }
        const _saveConfig = jsyaml.load(content);

        // Validate rules config before applying
        try {
            const testConfig = jsyaml.dump({ rules: currentConfigRules });
            const isValid = await validateConfig(testConfig);
            if (!isValid) {
                rulesLogger.warn('Rules validation failed, applying anyway');
            }
        } catch (validationErr) {
            rulesLogger.warn('Rules validation skipped:', validationErr);
        }

        const result = await invoke(COMMANDS.UPDATE_CONFIG, { patch: { rules: currentConfigRules } });
        await closeAllConnections();

        originalConfigRules = [...currentConfigRules];
        updateSaveRulesBtnVisibility();

        if (result && (/** @type {any} */ (result)).hot_reload_success) {
            showNotification(/** @type {any} */ (translations)[currentLang].notifRulesSaved, 'success');
        } else {
            showNotification(result?.message || /** @type {any} */ (translations)[currentLang].notifRulesSaved, 'info');
        }
    } catch (err) {
        showNotification(/** @type {any} */ (translations)[currentLang].notifRulesParseFailed, 'error');
        rulesLogger.error('Save failed', err);
    } finally {
        // eslint-disable-next-line no-unsanitized/property -- restoring saved innerHTML (same DOM element)
btn.innerHTML = originalContent;
        btn.disabled = false;
    }
}

function updateSaveRulesBtnVisibility() {
    const saveBtn = document.getElementById('save-rules-btn');
    if (!saveBtn) return;

    const isModified = JSON.stringify(currentConfigRules) !== JSON.stringify(originalConfigRules);

    if (isModified) {
        saveBtn.classList.remove('hidden');
    } else {
        saveBtn.classList.add('hidden');
    }
}
