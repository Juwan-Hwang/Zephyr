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
import { configUpdateOutcome } from './config-update.js';
import { toError } from '../types/guards.js';
import { readRunningProfile } from './running-profile.js';

// --- State ---

/** @type {string[]} */
let currentConfigRules = [];
/** @type {string[]} */
let originalConfigRules = [];
/**
 * The profile the rules on the page were read from: '' when read while the
 * core ran its minimal config, null before a read or when they belong to no
 * profile known to run.
 * @type {string|null}
 */
let rulesProfile = null;

/** Bumped on each read of the rules: a save started before it owns no baseline. */
let rulesLoads = 0;

/**
 * A save left the rules live in the core but not in the profile (a partial
 * save): Save stays available, also once the list matches the profile again,
 * because the core still runs the other list.
 */
let profileBehindCore = false;
/**
 * Rules a partial save made live that their profile file did not take,
 * with that profile: the page shows them (still unsaved) when it is read
 * again while that profile runs, not the file's older rules.
 * @type {{ profile: string, rules: any[] } | null}
 */
let unsavedLiveRules = null;

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
            void renderRulesList();
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
                void renderRulesList(target.value);
            });
        }
    }

    await loadRules();
}

// --- Internal ---

async function loadRules() {
    rulesLoads += 1;
    // Reads can overlap (the page reopened, a refused save reading again):
    // only the newest one fills the page, so an older read finishing last
    // never puts another profile's rules under the newer owner.
    const load = rulesLoads;
    profileBehindCore = false;
    try {
        // The rules of the profile the core runs (which can be one not
        // stored as the active profile yet). With no profile known or its
        // file unreadable, the stored profile's rules are shown and owned
        // by no profile, so they cannot be saved (see `rulesSaveRefused`).
        const running = await readRunningProfile();
        const activeConfig = running
            ? await invoke(COMMANDS.READ_CONFIG_FILE, { configPath: running })
                .then((/** @type {string} */ content) => ({ configName: running, content }))
                .catch(() => getActiveConfigContent())
            : await getActiveConfigContent();
        if (load !== rulesLoads) return;
        if (!activeConfig) {
            currentConfigRules = [];
            originalConfigRules = [];
            rulesProfile = null;
            void renderRulesList();
            return;
        }
        const { content, configName } = activeConfig;

        if (typeof jsyaml === 'undefined') {
            const t = /** @type {any} */ (translations)[currentLang];
            showNotification(t.jsYamlError || 'js-yaml is not loaded. Check internet connection.', 'error');
            return;
        }
        const _loadedConfig = jsyaml.load(content);
        currentConfigRules = (/** @type {any} */ (_loadedConfig)).rules || [];
        originalConfigRules = [...currentConfigRules];
        if (running && configName === running) rulesProfile = running;
        else rulesProfile = running === '' ? '' : null;
        // A partial save of this profile left the core on newer rules than
        // its file: those are shown, with Save kept for the retry.
        if (unsavedLiveRules && rulesProfile && unsavedLiveRules.profile === rulesProfile) {
            currentConfigRules = [...unsavedLiveRules.rules];
            profileBehindCore = true;
        } else if (rulesProfile) {
            unsavedLiveRules = null;
        }
        void renderRulesList();
        updateSaveRulesBtnVisibility();
    } catch (err) {
        if (load !== rulesLoads) return;
        showNotification(/** @type {any} */ (translations)[currentLang].notifRulesLoadFailed, 'error');
        rulesLogger.error('Failed to load rules', err);
    }
}

/**
 * Render the rules list. Callers fire this and forget it, so it never
 * rejects: a failure is logged here.
 * @param {string} [searchQuery]
 * @returns {Promise<void>}
 */
function renderRulesList(searchQuery = '') {
    return renderRulesListUnguarded(searchQuery).catch((err) => {
        rulesLogger.warn('renderRulesList failed', err);
    });
}

async function renderRulesListUnguarded(/** @type {string} */ searchQuery) {
    const container = document.getElementById('rules-list');
    if (!container) return;
    container.replaceChildren();

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
        item.className = 'glass-card p-4 flex items-center justify-between group rtl-slide transition-transform duration-[var(--zephyr-time-standard)] cursor-pointer';

        // Mark Prism-managed rules with a visual indicator
        const isPrismManaged = await isPrismRule(index);
        if (isPrismManaged) {
            item.classList.add('ring-1', 'ring-accent/30');
            item.title = 'This rule is managed by Prism Engine';
        }

        // SECURITY FIX: use setAttribute for title instead of innerHTML with escaped value
        // eslint-disable-next-line no-unsanitized/property -- values escaped via escapeHtml() // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
        item.innerHTML = `
            <div class="flex items-center gap-4 flex-1">
                <div class="type-badge text-[var(--text-muted)]">${escapeHtml(type)}</div>
                <div class="text-xs text-[var(--text-secondary)] font-mono truncate max-w-[240px]">${escapeHtml(value)}</div>
            </div>
            <div class="flex items-center gap-2">
                <div class="text-2xs font-bold ${getPolicyColor(policy)} uppercase tracking-wider me-2">${escapeHtml(policy)}</div>

                <button type="button" class="btn-move-top-rule opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1.5 rounded-sm text-[var(--text-muted)] hover:text-accent hover:bg-accent/10 transition-[opacity,color]" title="${escapeAttr(/** @type {any} */ (translations)[currentLang]?.moveToTop || 'Move to Top')}" aria-label="${escapeAttr(/** @type {any} */ (translations)[currentLang]?.moveToTop || 'Move to Top')}">
                    ${SVG_ICONS.arrowUp}
                </button>
                <button type="button" class="btn-move-bottom-rule opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1.5 rounded-sm text-[var(--text-muted)] hover:text-accent hover:bg-accent/10 transition-[opacity,color]" title="${escapeAttr(/** @type {any} */ (translations)[currentLang]?.moveToBottom || 'Move to Bottom')}" aria-label="${escapeAttr(/** @type {any} */ (translations)[currentLang]?.moveToBottom || 'Move to Bottom')}">
                    ${SVG_ICONS.arrowDown}
                </button>
                <button type="button" class="btn-delete-rule opacity-0 group-hover:opacity-100 focus-visible:opacity-100 btn-delete-icon" title="${escapeAttr(/** @type {any} */ (translations)[currentLang]?.delete || 'Delete')}" aria-label="${escapeAttr(/** @type {any} */ (translations)[currentLang]?.delete || 'Delete')}">
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
                void renderRulesList((/** @type {HTMLInputElement} */ (document.getElementById('rules-search-input')))?.value || '');
                updateSaveRulesBtnVisibility();
            }
        });

        (/** @type {HTMLElement} */ (item.querySelector('.btn-move-bottom-rule')))?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (index < currentConfigRules.length - 1) {
                const movedRule = currentConfigRules.splice(index, 1)[0];
                currentConfigRules.push(movedRule);
                void renderRulesList((/** @type {HTMLInputElement} */ (document.getElementById('rules-search-input')))?.value || '');
                updateSaveRulesBtnVisibility();
            }
        });

        (/** @type {HTMLElement} */ (item.querySelector('.btn-delete-rule')))?.addEventListener('click', (e) => {
            e.stopPropagation();
            currentConfigRules.splice(index, 1);
            void renderRulesList((/** @type {HTMLInputElement} */ (document.getElementById('rules-search-input')))?.value || '');
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
        void renderRulesList();
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

/**
 * Whether the core rejects the config it runs once it carries `rules`. That
 * is the run config: the profile with its overrides applied (groups an
 * override adds included), whose rules the save replaces before the core
 * reloads it. Only when it accepts that config as it is: a config the check
 * cannot pass anyway (a provider path it cannot reach from the check, say)
 * tells nothing about the rules, and the check being unavailable or the
 * config unreadable skips it.
 * @param {unknown} config the run config as read_config returns it
 * @param {any[]} rules
 * @returns {Promise<boolean>}
 */
async function rulesRejected(config, rules) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        rulesLogger.warn('Rules validation skipped: the running config could not be read');
        return false;
    }
    try {
        if (await validateConfig(jsyaml.dump({ ...config, rules }))) return false;
        if (!await validateConfig(jsyaml.dump(config))) {
            rulesLogger.warn('Rules validation inconclusive: the running config fails the check without them');
            return false;
        }
        return true;
    } catch (validationErr) {
        rulesLogger.warn('Rules validation skipped:', validationErr);
        return false;
    }
}

/**
 * The backend's error when the running profile changed before the save
 * (config_manager.rs PROFILE_CHANGED_MEANWHILE); nothing was saved.
 */
export const PROFILE_CHANGED_MEANWHILE = 'the running profile changed before the save; nothing was saved';

function notifyProfileChanged() {
    showNotification(/** @type {any} */ (translations)[currentLang].notifRulesProfileChanged
        || 'The active profile changed while the rules were checked, so they were not saved.', 'warning');
}

function notifyNoProfile() {
    showNotification(/** @type {any} */ (translations)[currentLang].notifRulesNoProfile
        || 'No profile is running (the core runs its minimal config), so the rules were not saved.', 'warning');
}

/**
 * Whether the rules on the page cannot be saved while `running` runs:
 * which profile runs is unknown, none does (the minimal config), or the
 * rules belong to another profile or to none known (switched away since
 * they were read, or read when the running profile was unknown): saving
 * them would replace the running profile's rules, so they are read again.
 * @param {string|null} running the running profile, read uncached
 * @param {string|null} owner the profile the rules were read from, taken
 *   with them when the save began
 * @returns {Promise<boolean>}
 */
async function rulesSaveRefused(running, owner) {
    if (running === null) {
        notifyProfileUnknown();
        return true;
    }
    if (running === '') {
        notifyNoProfile();
        // The rules on the page belong to no running profile now: they are
        // read again, so Save no longer offers them.
        if (owner !== '') await loadRules();
        return true;
    }
    if (owner === running) return false;
    if (owner === null) notifyProfileUnknown();
    else notifyProfileChanged();
    await loadRules();
    return true;
}

function notifyProfileUnknown() {
    showNotification(/** @type {any} */ (translations)[currentLang].notifRulesProfileUnknown
        || 'The active profile could not be read, so the rules were not saved. Try saving again.', 'warning');
}

async function saveRules() {
    const btn = /** @type {HTMLButtonElement} */ (document.getElementById('save-rules-btn'));
    if (!btn) return;
    const originalContent = btn.innerHTML;
    // eslint-disable-next-line no-unsanitized/property -- static SVG constant
    btn.innerHTML = SVG_ICONS.loadingSmall2; // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
    btn.disabled = true;

    try {
        // The list this save sends and the profile it was read from, taken
        // together before any await: a reload for another profile meanwhile
        // replaces both, and its rules must not go out under this check.
        // Edits made while the save is in flight are not in it, so they stay
        // unsaved (Save stays visible) when it ends.
        const savingRules = [...currentConfigRules];
        const ownerAtSave = rulesProfile;
        const loadAtSave = rulesLoads;
        // The profile these rules are checked against; a switch while the
        // check runs would otherwise save them into a profile never checked.
        // Unreadable: which profile they would land in cannot be told.
        const profileBefore = await readRunningProfile();
        if (await rulesSaveRefused(profileBefore, ownerAtSave)) return;
        // The config the core runs now: the save replaces its rules and the
        // core reloads it. Unreadable: the check is skipped, the backend
        // still saves and reports what it could not save.
        /** @type {unknown} */
        const runningConfig = await invoke(COMMANDS.READ_CONFIG).catch((readErr) => {
            rulesLogger.warn('Reading the running config for the rules check failed:', readErr);
            return null;
        });

        if (typeof jsyaml === 'undefined') {
            const t = /** @type {any} */ (translations)[currentLang];
            showNotification(t.jsYamlSaveError || 'js-yaml is not loaded. Cannot save/load rules.', 'error');
            return;
        }
        // The profile as the next start checks it: without the overrides,
        // which apply only after that check. Unreadable: that check is skipped.
        /** @type {unknown} */
        const profileConfig = await invoke(COMMANDS.READ_CONFIG_FILE, { configPath: profileBefore })
            .then((content) => jsyaml.load(String(content)))
            .catch((readErr) => {
                rulesLogger.warn('Reading the profile for the rules check failed:', readErr);
                return null;
            });

        // Validate before applying: the whole running config with the new
        // rules, since rules name its groups and providers (rules alone
        // would fail on every policy that is a group); and the profile with
        // them, since a rule that names a group only an override adds passes
        // the first and fails the check the next start of the profile runs.
        if (await rulesRejected(runningConfig, savingRules) || await rulesRejected(profileConfig, savingRules)) {
            // Not saved: the next start of the profile would fail its check.
            showNotification(/** @type {any} */ (translations)[currentLang].notifRulesInvalid
                || 'The core rejected the profile with these rules, so they were not saved.', 'error');
            return;
        }
        const profileNow = await readRunningProfile();
        if (profileNow === null) {
            notifyProfileUnknown();
            return;
        }
        if (profileNow !== profileBefore) {
            notifyProfileChanged();
            return;
        }

        /** @type {any} */
        let result;
        try {
            // The backend refuses the save, under the start lock, once
            // another profile runs: a switch can still land after the read
            // above. An empty name (the minimal config runs) is refused once
            // a profile runs, too.
            result = await invoke(COMMANDS.UPDATE_CONFIG, {
                patch: { rules: savingRules },
                expectProfile: profileBefore,
            });
        } catch (saveErr) {
            // Not a parse failure: the backend could not save them (the core
            // is still starting, say). Show its reason; the rules stay unsaved.
            rulesLogger.error('Save failed', saveErr);
            if (String(saveErr).includes(PROFILE_CHANGED_MEANWHILE)) {
                notifyProfileChanged();
                return;
            }
            showNotification(toError(saveErr).message || /** @type {any} */ (translations)[currentLang].notifRulesParseFailed, 'error');
            return;
        }
        const outcome = configUpdateOutcome(/** @type {any} */ (result));
        // Kept across page reads too: the core runs these rules, the
        // profile file still has the older ones. Recorded before any await,
        // so a read of the page while connections close shows them.
        if (outcome === 'partial' && ownerAtSave) {
            unsavedLiveRules = { profile: ownerAtSave, rules: savingRules };
        } else if (outcome !== 'failed' && unsavedLiveRules?.profile === ownerAtSave) {
            unsavedLiveRules = null;
        }
        // A read of the same profile that finished while the save ran found
        // the file's older rules: the core runs these, so they are shown
        // again as unsaved, unless the page was edited since that read.
        if (outcome === 'partial' && loadAtSave !== rulesLoads && ownerAtSave
            && rulesProfile === ownerAtSave && !profileBehindCore
            && JSON.stringify(currentConfigRules) === JSON.stringify(originalConfigRules)) {
            currentConfigRules = [...savingRules];
            profileBehindCore = true;
            void renderRulesList();
            updateSaveRulesBtnVisibility();
        }

        // Connections that keep the old routing are closed once the core
        // runs the new rules; while it does not (a restart is still needed),
        // closing them would only cut traffic. A failed close is a leftover,
        // not a failed save.
        if ((/** @type {any} */ (result))?.hot_reload_success) {
            await closeAllConnections().catch((closeErr) => rulesLogger.warn('Failed to close connections after saving rules', closeErr));
        }

        // The page was read again meanwhile (reopened for another profile):
        // its baseline is that read's, not this save's.
        if (loadAtSave === rulesLoads) {
            // A partial save left the active profile without the rules: keep
            // them marked unsaved so Save stays available for a retry.
            if (outcome === 'partial') {
                profileBehindCore = true;
            } else if (outcome !== 'failed') {
                originalConfigRules = savingRules;
                profileBehindCore = false;
            }
            updateSaveRulesBtnVisibility();
        }

        if (outcome === 'applied') {
            showNotification(/** @type {any} */ (translations)[currentLang].notifRulesSaved, 'success');
        } else if (outcome === 'failed') {
            // Neither the core nor the active profile took the rules.
            showNotification((/** @type {any} */ (result))?.message || /** @type {any} */ (translations)[currentLang].notifRulesParseFailed, 'error');
        } else if (outcome === 'partial') {
            // Live now, but the active profile did not take the rules.
            showNotification((/** @type {any} */ (result))?.message || /** @type {any} */ (translations)[currentLang].notifRulesSaved, 'warning');
        } else {
            showNotification((/** @type {any} */ (result))?.message || /** @type {any} */ (translations)[currentLang].notifRulesSaved, 'info');
        }
    } catch (err) {
        showNotification(/** @type {any} */ (translations)[currentLang].notifRulesParseFailed, 'error');
        rulesLogger.error('Save failed', err);
    } finally {
        // eslint-disable-next-line no-unsanitized/property -- restoring saved innerHTML (same DOM element)
        btn.innerHTML = originalContent; // nosemgrep: js-innerhtml-assignment — verified safe, see eslint-disable above
        btn.disabled = false;
    }
}

function updateSaveRulesBtnVisibility() {
    const saveBtn = document.getElementById('save-rules-btn');
    if (!saveBtn) return;

    const isModified = profileBehindCore
        || JSON.stringify(currentConfigRules) !== JSON.stringify(originalConfigRules);

    if (isModified) {
        saveBtn.classList.remove('hidden');
    } else {
        saveBtn.classList.add('hidden');
    }
}
