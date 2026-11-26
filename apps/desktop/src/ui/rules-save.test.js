import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const api = {
    invoke: vi.fn(),
    closeAllConnections: vi.fn(async () => {}),
    coreReplacements: vi.fn(() => 0),
};
vi.mock('../api.js', () => api);
vi.mock('./notifications.js', () => ({ showNotification: vi.fn() }));
vi.mock('./dropdown.js', () => ({ initCustomDropdown: vi.fn(() => ({ setValue: vi.fn() })) }));
vi.mock('../rules.js', () => ({ fetchAndConvertSRRules: vi.fn() }));
vi.mock('./advanced.js', () => ({
    getActiveConfigContent: vi.fn(async () => ({ configName: 'a.yaml', content: 'rules' })),
}));
vi.mock('./prism.js', () => ({
    validateConfig: vi.fn(async () => true),
    isPrismRule: vi.fn(async () => false),
}));

/** @type {any} */ let showNotification;
/** @type {any} */ let getActiveConfigContent;
/** @type {any} */ let validateConfig;
/** @type {any} */ let initRulesPage;
/** @type {any} */ let PROFILE_CHANGED_MEANWHILE;
/** A fresh rules module (and its mocks) for each test: its state, such as
 * rules a partial save left unsaved, must not carry into the next one. */
async function freshModules() {
    vi.resetModules();
    ({ showNotification } = await import('./notifications.js'));
    ({ getActiveConfigContent } = await import('./advanced.js'));
    ({ validateConfig } = await import('./prism.js'));
    ({ initRulesPage, PROFILE_CHANGED_MEANWHILE } = await import('./rules.js'));
}

/** The run config `read_config` answers with. */
let runningConfig = { rules: ['DOMAIN,a.example.com,DIRECT'] };
const SAVED = { files_saved: true, profile_saved: true, hot_reload_success: true, message: 'ok' };

/** Rules page with one saved rule, then one more added and saved. */
async function addRuleAndSave(updateResult) {
    api.invoke.mockImplementation(async (cmd) => {
        if (cmd === 'update_config') return updateResult;
        if (cmd === 'get_settings') return { last_config: 'a.yaml' };
        if (cmd === 'read_config') return runningConfig;
        return 'rules';
    });
    await initRulesPage();

    const save = /** @type {HTMLElement} */ (document.getElementById('save-rules-btn'));
    /** @type {HTMLInputElement} */ (document.getElementById('new-rule-value')).value = 'b.example.com';
    document.getElementById('confirm-add-rule-btn')?.click();
    expect(save.classList.contains('hidden')).toBe(false);

    save.click();
    await vi.waitFor(() => expect(showNotification).toHaveBeenCalled());
    return save;
}

/** Add one rule and press Save with `invoke` answering as `answer` does. */
async function saveWith(answer) {
    api.invoke.mockImplementation(answer);
    await initRulesPage();
    const save = /** @type {HTMLElement} */ (document.getElementById('save-rules-btn'));
    /** @type {HTMLInputElement} */ (document.getElementById('new-rule-value')).value = 'b.example.com';
    document.getElementById('confirm-add-rule-btn')?.click();
    save.click();
    await vi.waitFor(() => expect(showNotification).toHaveBeenCalled());
    return save;
}

describe('saving rules', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        await freshModules();
        vi.mocked(validateConfig).mockImplementation(async () => true);
        runningConfig = { rules: ['DOMAIN,a.example.com,DIRECT'] };
        globalThis.jsyaml = {
            load: () => ({ rules: ['DOMAIN,a.example.com,DIRECT'] }),
            dump: (v) => JSON.stringify(v),
        };
        document.body.innerHTML = `
            <div id="rules-list"></div>
            <div id="add-rule-form" class="hidden"></div>
            <select id="new-rule-type"><option value="DOMAIN" selected>DOMAIN</option></select>
            <input id="new-rule-value">
            <select id="new-rule-policy"><option value="DIRECT" selected>DIRECT</option></select>
            <button id="confirm-add-rule-btn"></button>
            <button id="save-rules-btn" class="hidden"></button>`;
    });
    afterEach(() => {
        delete globalThis.jsyaml;
        document.body.innerHTML = '';
    });

    it('hides Save once the profile took the rules', async () => {
        const save = await addRuleAndSave({
            files_saved: true, run_config_saved: true, profile_saved: true, hot_reload_success: true, message: 'ok',
        });
        expect(save.classList.contains('hidden')).toBe(true);
        expect(showNotification).toHaveBeenCalledWith(expect.anything(), 'success');
    });

    it('validates the whole running config with the new rules, not the rules alone', async () => {
        // The running config: the profile with its overrides (a group one adds).
        runningConfig = {
            'proxy-groups': [{ name: 'Example', type: 'select', proxies: ['DIRECT'] }],
            rules: ['DOMAIN,a.example.com,DIRECT'],
        };
        await addRuleAndSave({
            files_saved: true, run_config_saved: true, profile_saved: true, hot_reload_success: true, message: 'ok',
        });
        const checked = JSON.parse(vi.mocked(validateConfig).mock.calls[0][0]);
        expect(checked['proxy-groups']).toEqual([{ name: 'Example', type: 'select', proxies: ['DIRECT'] }]);
        expect(checked.rules).toEqual(['DOMAIN,b.example.com,DIRECT', 'DOMAIN,a.example.com,DIRECT']);
    });

    it('does not save rules the core rejects in a profile it otherwise accepts', async () => {
        // The running config with the new rules fails the check; as it runs, it passes.
        vi.mocked(validateConfig).mockImplementation(async (config) => config === JSON.stringify(runningConfig));
        const save = await addRuleAndSave({
            files_saved: true, run_config_saved: true, profile_saved: true, hot_reload_success: true, message: 'ok',
        });
        expect(api.invoke.mock.calls.some(([cmd]) => cmd === 'update_config')).toBe(false);
        expect(showNotification).toHaveBeenCalledWith(expect.stringContaining('rejected'), 'error');
        expect(save.classList.contains('hidden')).toBe(false);
    });

    it('does not save rules that pass with the overrides but fail the profile the next start checks', async () => {
        // An override adds the group the new rule needs; the profile file has none.
        runningConfig = {
            'proxy-groups': [{ name: 'Example', type: 'select', proxies: ['DIRECT'] }],
            rules: ['DOMAIN,a.example.com,DIRECT'],
        };
        // Rejected: a config that has the new rule and no groups.
        vi.mocked(validateConfig).mockImplementation(async (config) => {
            const parsed = JSON.parse(config);
            return !(parsed.rules?.includes('DOMAIN,b.example.com,DIRECT') && !parsed['proxy-groups']);
        });
        const save = await addRuleAndSave(SAVED);
        expect(api.invoke).toHaveBeenCalledWith('read_config_file', { configPath: 'a.yaml' });
        expect(api.invoke.mock.calls.some(([cmd]) => cmd === 'update_config')).toBe(false);
        expect(showNotification).toHaveBeenCalledWith(expect.stringContaining('rejected'), 'error');
        expect(save.classList.contains('hidden')).toBe(false);
    });

    it('still saves when the profile fails the check without the new rules too', async () => {
        vi.mocked(validateConfig).mockImplementation(async () => false);
        await addRuleAndSave({
            files_saved: true, run_config_saved: true, profile_saved: true, hot_reload_success: true, message: 'ok',
        });
        expect(api.invoke.mock.calls.some(([cmd]) => cmd === 'update_config')).toBe(true);
        expect(showNotification).toHaveBeenCalledWith(expect.anything(), 'success');
    });

    it('skips the running config\'s check, and still saves, when it cannot be read', async () => {
        await saveWith(async (cmd) => {
            if (cmd === 'update_config') return SAVED;
            if (cmd === 'get_settings') return { last_config: 'a.yaml' };
            if (cmd === 'read_config') throw new Error('no run config');
            return 'rules';
        });
        expect(showNotification).toHaveBeenCalledWith(expect.anything(), 'success');
        // Only the profile, as the next start checks it, was checked.
        expect(validateConfig).toHaveBeenCalledTimes(1);
        expect(api.invoke).toHaveBeenCalledWith('update_config', expect.objectContaining({ expectProfile: 'a.yaml' }));
    });

    it('keeps Save available when only the run config was saved', async () => {
        const save = await addRuleAndSave({
            files_saved: false,
            run_config_saved: true,
            profile_saved: false,
            profile_error: 'profile is read-only',
            hot_reload_success: true,
            message: 'Rules are live but the profile was not saved',
        });
        expect(showNotification).toHaveBeenCalledWith('Rules are live but the profile was not saved', 'warning');
        expect(save.classList.contains('hidden')).toBe(false);
    });

    it.each([false, true])('keeps the draft available for retry after an incomplete save (unconfirmed=%s)', async (unconfirmed) => {
        await addRuleAndSave({
            files_saved: false, run_config_saved: true, profile_saved: false,
            hot_reload_success: !unconfirmed, reload_unconfirmed: unconfirmed,
            message: 'The profile was not saved',
        });
        expect(showNotification).toHaveBeenCalledWith('The profile was not saved', 'warning');
        if (unconfirmed) expect(api.closeAllConnections).not.toHaveBeenCalled();
        // Read again: the profile file still has only the old rule.
        await initRulesPage();
        const save = /** @type {HTMLElement} */ (document.getElementById('save-rules-btn'));
        expect(save.classList.contains('hidden')).toBe(false);
        expect(document.getElementById('rules-list')?.textContent).toContain('b.example.com');
        // A full save afterwards clears it.
        vi.mocked(showNotification).mockClear();
        api.invoke.mockImplementation(async (cmd) => {
            if (cmd === 'update_config') return { ...SAVED, run_config_saved: true };
            if (cmd === 'get_settings') return { last_config: 'a.yaml' };
            if (cmd === 'read_config') return runningConfig;
            return 'rules';
        });
        save.click();
        await vi.waitFor(() => expect(showNotification).toHaveBeenCalled());
        await initRulesPage();
        expect(save.classList.contains('hidden')).toBe(true);
    });

    it.each([false, true])('does not restore or retry an obsolete unconfirmed snapshot after another profile edit (reread=%s)', async (reread) => {
        let profile = { rules: ['DOMAIN,a.example.com,DIRECT'] };
        let writes = 0;
        globalThis.jsyaml = { load: (text) => JSON.parse(text), dump: (value) => JSON.stringify(value) };
        const save = await saveWith(async (command, args) => {
            if (command === 'update_config') {
                writes++;
                profile = { rules: args.patch.rules };
                return { files_saved: true, profile_saved: true, hot_reload_success: false, reload_unconfirmed: true, message: 'Not confirmed' };
            }
            if (command === 'get_settings') return { last_config: 'a.yaml' };
            if (command === 'read_config') return runningConfig;
            return JSON.stringify(profile);
        });
        profile = { rules: ['DOMAIN,newer.example.com,DIRECT'] };
        if (reread) await initRulesPage();
        else {
            vi.mocked(showNotification).mockClear();
            save.click();
            await vi.waitFor(() => expect(showNotification).toHaveBeenCalledWith(expect.stringContaining('profile rules changed'), 'warning'));
        }
        await vi.waitFor(() => expect(document.getElementById('rules-list').textContent).toContain('newer.example.com'));
        expect(document.getElementById('rules-list').textContent).not.toContain('b.example.com');
        expect(writes).toBe(1);
    });

    it('keeps the pending rules when a retry cannot read its profile', async () => {
        const save = await addRuleAndSave({ files_saved: false, profile_saved: false, hot_reload_success: false, reload_unconfirmed: true, message: 'Not confirmed' });
        const originalInvoke = api.invoke.getMockImplementation();
        api.invoke.mockImplementation((command, args) => command === 'read_config_file' ? Promise.reject(new Error('temporarily unreadable')) : originalInvoke(command, args));
        vi.mocked(showNotification).mockClear();
        const writes = api.invoke.mock.calls.filter(([command]) => command === 'update_config').length;
        save.click();
        await vi.waitFor(() => expect(showNotification).toHaveBeenCalledWith(expect.stringContaining('pending rules are retained'), 'warning'));
        expect(save.classList.contains('hidden')).toBe(false);
        expect(document.getElementById('rules-list').textContent).toContain('b.example.com');
        expect(api.invoke.mock.calls.filter(([command]) => command === 'update_config').length).toBe(writes);
    });

    it('shows the saved rules when a read of the same profile finished while the save ran', async () => {
        /** @type {(v: any) => void} */
        let answerSave = () => {};
        api.invoke.mockImplementation(async (cmd) => {
            if (cmd === 'update_config') return new Promise((resolve) => { answerSave = resolve; });
            if (cmd === 'get_settings') return { last_config: 'a.yaml' };
            if (cmd === 'read_config') return runningConfig;
            return 'rules';
        });
        await initRulesPage();
        const save = /** @type {HTMLElement} */ (document.getElementById('save-rules-btn'));
        /** @type {HTMLInputElement} */ (document.getElementById('new-rule-value')).value = 'b.example.com';
        document.getElementById('confirm-add-rule-btn')?.click();
        save.click();
        await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledWith('update_config', expect.anything()));
        // The page is read again while the save runs: the file has the old rule.
        await initRulesPage();
        expect(document.getElementById('rules-list')?.textContent).not.toContain('b.example.com');
        answerSave(SAVED);
        await vi.waitFor(() => expect(showNotification).toHaveBeenCalled());
        expect(document.getElementById('rules-list')?.textContent).toContain('b.example.com');
        expect(save.classList.contains('hidden')).toBe(true);
    });

    it('shows the saved rules when a read during the save brought back rules a partial save left live', async () => {
        // A partial save leaves b live but not in the file.
        const save = await addRuleAndSave({
            files_saved: false, run_config_saved: true, profile_saved: false,
            hot_reload_success: true, message: 'Rules are live but the profile was not saved',
        });
        vi.mocked(showNotification).mockClear();
        api.invoke.mockClear();
        /** @type {(v: any) => void} */
        let answerSave = () => {};
        api.invoke.mockImplementation(async (cmd) => {
            if (cmd === 'update_config') return new Promise((resolve) => { answerSave = resolve; });
            if (cmd === 'get_settings') return { last_config: 'a.yaml' };
            if (cmd === 'read_config') return runningConfig;
            return 'rules';
        });
        // The user adds c and saves again.
        /** @type {HTMLInputElement} */ (document.getElementById('new-rule-value')).value = 'c.example.com';
        document.getElementById('confirm-add-rule-btn')?.click();
        save.click();
        await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledWith('update_config', expect.anything()));
        // Read again while it runs: the page shows b, still unsaved, without c.
        await initRulesPage();
        expect(document.getElementById('rules-list')?.textContent).not.toContain('c.example.com');
        answerSave(SAVED);
        await vi.waitFor(() => expect(showNotification).toHaveBeenCalled());
        // The page shows what was saved, as saved: a later Save cannot put b back over it.
        expect(document.getElementById('rules-list')?.textContent).toContain('c.example.com');
        expect(save.classList.contains('hidden')).toBe(true);
    });

    it('keeps Save after a partial save when the page was edited after a read during it', async () => {
        /** @type {(v: any) => void} */
        let answerSave = () => {};
        api.invoke.mockImplementation(async (cmd) => {
            if (cmd === 'update_config') return new Promise((resolve) => { answerSave = resolve; });
            if (cmd === 'get_settings') return { last_config: 'a.yaml' };
            if (cmd === 'read_config') return runningConfig;
            return 'rules';
        });
        await initRulesPage();
        const save = /** @type {HTMLElement} */ (document.getElementById('save-rules-btn'));
        const input = /** @type {HTMLInputElement} */ (document.getElementById('new-rule-value'));
        input.value = 'b.example.com';
        document.getElementById('confirm-add-rule-btn')?.click();
        save.click();
        await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledWith('update_config', expect.anything()));
        // Read again while the save runs (the file has a only), then c is added.
        await initRulesPage();
        input.value = 'c.example.com';
        document.getElementById('confirm-add-rule-btn')?.click();
        answerSave({
            files_saved: false, run_config_saved: true, profile_saved: false,
            hot_reload_success: true, message: 'Rules are live but the profile was not saved',
        });
        await vi.waitFor(() => expect(showNotification).toHaveBeenCalled());
        // c removed again: the page matches the file, but the core runs b.
        /** @type {HTMLElement} */ (document.querySelector('#rules-list .btn-delete-rule')).click();
        await vi.waitFor(() => expect(document.getElementById('rules-list')?.textContent).not.toContain('c.example.com'));
        expect(save.classList.contains('hidden')).toBe(false);
    });

    it('drops the live rules of a partial save once the core that took them was replaced', async () => {
        await addRuleAndSave({
            files_saved: false, run_config_saved: true, profile_saved: false,
            hot_reload_success: true, message: 'Rules are live but the profile was not saved',
        });
        // The core restarted (a profile switch away and back): it runs the file.
        api.coreReplacements.mockReturnValue(1);
        try {
            await initRulesPage();
            expect(document.getElementById('rules-list')?.textContent).not.toContain('b.example.com');
            const save = /** @type {HTMLElement} */ (document.getElementById('save-rules-btn'));
            expect(save.classList.contains('hidden')).toBe(true);
        } finally {
            api.coreReplacements.mockReturnValue(0);
        }
    });

    it('a retry of a partial save, with a read during it, ends saved', async () => {
        const save = await addRuleAndSave({
            files_saved: false, run_config_saved: true, profile_saved: false,
            hot_reload_success: true, message: 'Rules are live but the profile was not saved',
        });
        expect(save.classList.contains('hidden')).toBe(false);
        vi.mocked(showNotification).mockClear();
        api.invoke.mockClear();
        /** @type {(v: any) => void} */
        let answerSave = () => {};
        api.invoke.mockImplementation(async (cmd) => {
            if (cmd === 'update_config') return new Promise((resolve) => { answerSave = resolve; });
            if (cmd === 'get_settings') return { last_config: 'a.yaml' };
            if (cmd === 'read_config') return runningConfig;
            return 'rules';
        });
        // Retry the same rules; the page is read while it runs and shows them, unsaved.
        save.click();
        await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledWith('update_config', expect.anything()));
        await initRulesPage();
        answerSave(SAVED);
        await vi.waitFor(() => expect(showNotification).toHaveBeenCalled());
        expect(save.classList.contains('hidden')).toBe(true);
    });

    it('reads again when a save finished while an older read of the page was still running', async () => {
        let fileRules = ['DOMAIN,a.example.com,DIRECT'];
        const load = globalThis.jsyaml.load;
        globalThis.jsyaml.load = () => ({ rules: [...fileRules] });
        /** @type {(v: any) => void} */
        let answerSave = () => {};
        /** @type {Array<(v: any) => void>} */
        const heldReads = [];
        let holdReads = false;
        api.invoke.mockImplementation(async (cmd) => {
            if (cmd === 'update_config') return new Promise((resolve) => { answerSave = resolve; });
            if (cmd === 'get_settings') return { last_config: 'a.yaml' };
            if (cmd === 'read_config') return runningConfig;
            if (holdReads && cmd === 'read_config_file') return new Promise((resolve) => { heldReads.push(resolve); });
            return 'rules';
        });
        await initRulesPage();
        const save = /** @type {HTMLElement} */ (document.getElementById('save-rules-btn'));
        /** @type {HTMLInputElement} */ (document.getElementById('new-rule-value')).value = 'b.example.com';
        document.getElementById('confirm-add-rule-btn')?.click();
        save.click();
        await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledWith('update_config', expect.anything()));
        // A read starts while the save runs and is answered only after it.
        holdReads = true;
        const reading = initRulesPage();
        await vi.waitFor(() => expect(heldReads.length).toBe(1));
        holdReads = false;
        answerSave(SAVED);
        await vi.waitFor(() => expect(showNotification).toHaveBeenCalled());
        // The old read hands back the file from before the save.
        const before = [...fileRules];
        fileRules = ['DOMAIN,a.example.com,DIRECT', 'DOMAIN-SUFFIX,b.example.com,DIRECT'];
        globalThis.jsyaml.load = (/** @type {string} */ content) => ({ rules: [...(content === 'old file' ? before : fileRules)] });
        heldReads[0]('old file');
        await reading;
        await vi.waitFor(() => expect(document.getElementById('rules-list')?.textContent).toContain('b.example.com'));
        expect(save.classList.contains('hidden')).toBe(true);
        globalThis.jsyaml.load = load;
    });

    it('keeps a rule added while a read of the same profile ran', async () => {
        /** @type {Array<(v: any) => void>} */
        const heldReads = [];
        let holdReads = false;
        api.invoke.mockImplementation(async (cmd) => {
            if (cmd === 'get_settings') return { last_config: 'a.yaml' };
            if (cmd === 'read_config') return runningConfig;
            if (holdReads && cmd === 'read_config_file') return new Promise((resolve) => { heldReads.push(resolve); });
            return 'rules';
        });
        await initRulesPage();
        // The page is read again (reopened) and the user adds a rule meanwhile.
        holdReads = true;
        const reading = initRulesPage();
        await vi.waitFor(() => expect(heldReads.length).toBe(1));
        holdReads = false;
        /** @type {HTMLInputElement} */ (document.getElementById('new-rule-value')).value = 'b.example.com';
        document.getElementById('confirm-add-rule-btn')?.click();
        heldReads[0]('rules');
        await reading;
        expect(document.getElementById('rules-list')?.textContent).toContain('b.example.com');
        const save = /** @type {HTMLElement} */ (document.getElementById('save-rules-btn'));
        expect(save.classList.contains('hidden')).toBe(false);
    });

    it('reports a save neither the core nor the profile took as an error and keeps Save', async () => {
        const save = await addRuleAndSave({
            files_saved: false,
            run_config_saved: true,
            profile_saved: false,
            profile_error: 'profile is read-only',
            hot_reload_success: false,
            message: 'The profile was not saved and the core did not reload it',
        });
        expect(showNotification).toHaveBeenCalledWith('The profile was not saved and the core did not reload it', 'error');
        expect(save.classList.contains('hidden')).toBe(false);
    });

    it('does not save rules checked against a profile that was switched away meanwhile', async () => {
        let running = 'a.yaml';
        vi.mocked(validateConfig).mockImplementation(async () => {
            running = 'b.yaml'; // a profile switch lands while the check runs
            return true;
        });
        const save = await saveWith(async (cmd) => {
            if (cmd === 'update_config') return SAVED;
            if (cmd === 'get_settings') return { last_config: running };
            if (cmd === 'read_config') return runningConfig;
            return 'rules';
        });
        expect(showNotification).toHaveBeenCalledWith(expect.anything(), 'warning');
        expect(api.invoke.mock.calls.some(([cmd]) => cmd === 'update_config')).toBe(false);
        expect(save.classList.contains('hidden')).toBe(false);
    });

    it('does not save rules read from a profile that no longer runs', async () => {
        let running = 'a.yaml';
        api.invoke.mockImplementation(async (cmd) => {
            if (cmd === 'update_config') return SAVED;
            if (cmd === 'get_settings') return { last_config: running };
            if (cmd === 'read_config') return runningConfig;
            return 'rules';
        });
        await initRulesPage();
        const save = /** @type {HTMLElement} */ (document.getElementById('save-rules-btn'));
        /** @type {HTMLInputElement} */ (document.getElementById('new-rule-value')).value = 'b.example.com';
        document.getElementById('confirm-add-rule-btn')?.click();
        running = 'b.yaml'; // switched after the page read a.yaml's rules
        save.click();
        await vi.waitFor(() => expect(showNotification).toHaveBeenCalledWith(expect.anything(), 'warning'));
        expect(api.invoke.mock.calls.some(([cmd]) => cmd === 'update_config')).toBe(false);
        // The page now shows the running profile's rules.
        await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledWith('read_config_file', { configPath: 'b.yaml' }));
    });

    it('does not save while no profile runs or rules belong to none known', async () => {
        const { noteRunningProfile } = await import('./active-profile.js');
        // a.yaml's file is unreadable: the first profile listed is shown.
        vi.mocked(getActiveConfigContent).mockResolvedValue({ configName: 'other.yaml', content: 'rules' });
        const save = await saveWith(async (cmd) => {
            if (cmd === 'update_config') return SAVED;
            if (cmd === 'get_settings') return { last_config: 'a.yaml' };
            if (cmd === 'read_config_file') throw new Error('unreadable');
            return 'rules';
        });
        // Another profile's rules are shown while a.yaml runs: refused.
        expect(api.invoke.mock.calls.some(([cmd]) => cmd === 'update_config')).toBe(false);
        // The minimal config runs: nothing to save the rules into.
        noteRunningProfile(null);
        vi.mocked(showNotification).mockClear();
        /** @type {HTMLInputElement} */ (document.getElementById('new-rule-value')).value = 'c.example.com';
        document.getElementById('confirm-add-rule-btn')?.click();
        save.click();
        await vi.waitFor(() => expect(showNotification).toHaveBeenCalledWith(expect.anything(), 'warning'));
        expect(api.invoke.mock.calls.some(([cmd]) => cmd === 'update_config')).toBe(false);
        noteRunningProfile('a.yaml');
        vi.mocked(getActiveConfigContent).mockResolvedValue({ configName: 'a.yaml', content: 'rules' });
    });


    it('does not save when the running profile cannot be read', async () => {
        let reads = 0;
        const save = await saveWith(async (cmd) => {
            if (cmd === 'update_config') return SAVED;
            // The page's first read and the read before the check succeed;
            // the read after the check fails: where the rules land is unknown.
            if (cmd === 'get_settings') {
                if (reads++ >= 2) throw new Error('settings unavailable');
                return { last_config: 'a.yaml' };
            }
            return 'rules';
        });
        await vi.waitFor(() => expect(showNotification).toHaveBeenCalledWith(expect.anything(), 'warning'));
        // The save reached the read after the check.
        expect(reads).toBe(3);
        expect(api.invoke.mock.calls.some(([cmd]) => cmd === 'update_config')).toBe(false);
        expect(save.classList.contains('hidden')).toBe(false);
    });

    it('asks the backend to refuse the save once another profile runs', async () => {
        const save = await saveWith(async (cmd) => {
            if (cmd === 'update_config') throw new Error(PROFILE_CHANGED_MEANWHILE);
            if (cmd === 'get_settings') return { last_config: 'a.yaml' };
            return 'rules';
        });
        const sent = api.invoke.mock.calls.find(([cmd]) => cmd === 'update_config')?.[1];
        expect(sent?.expectProfile).toBe('a.yaml');
        // Shown as a profile change, and Save stays for another try.
        expect(showNotification).toHaveBeenCalledWith(expect.anything(), 'warning');
        expect(save.classList.contains('hidden')).toBe(false);
    });

    it('matches the backend refusal message', () => {
        const rust = fs.readFileSync(path.resolve(here, '../../src-tauri/src/config_manager.rs'), 'utf8');
        expect(rust.replace(/\s+/g, ' ')).toContain(`"${PROFILE_CHANGED_MEANWHILE}"`);
    });

    it('keeps Save available for a rule added while the save was in flight', async () => {
        let releaseClose;
        api.closeAllConnections.mockImplementationOnce(() => new Promise((resolve) => { releaseClose = resolve; }));
        api.invoke.mockImplementation(async (cmd) => {
            if (cmd === 'update_config') {
                return { files_saved: true, run_config_saved: true, profile_saved: true, hot_reload_success: true, message: 'ok' };
            }
            if (cmd === 'get_settings') return { last_config: 'a.yaml' };
            return 'rules';
        });
        await initRulesPage();
        const save = /** @type {HTMLElement} */ (document.getElementById('save-rules-btn'));
        const value = /** @type {HTMLInputElement} */ (document.getElementById('new-rule-value'));
        value.value = 'b.example.com';
        document.getElementById('confirm-add-rule-btn')?.click();
        save.click();
        await vi.waitFor(() => expect(releaseClose).toBeTypeOf('function'));

        // Added while the save waits for connections to close.
        value.value = 'c.example.com';
        document.getElementById('confirm-add-rule-btn')?.click();
        releaseClose();
        await vi.waitFor(() => expect(showNotification).toHaveBeenCalledWith(expect.anything(), 'success'));

        const sent = api.invoke.mock.calls.find(([cmd]) => cmd === 'update_config')?.[1]?.patch?.rules;
        expect(sent).toEqual(['DOMAIN,b.example.com,DIRECT', 'DOMAIN,a.example.com,DIRECT']);
        expect(save.classList.contains('hidden')).toBe(false);
    });
    it('shows the backend reason, not a parse error, when the save is refused', async () => {
        api.invoke.mockImplementation(async (cmd) => {
            if (cmd === 'update_config') throw new Error('core is already starting; please wait and try again');
            if (cmd === 'get_settings') return { last_config: 'a.yaml' };
            return 'rules';
        });
        await initRulesPage();
        const save = /** @type {HTMLElement} */ (document.getElementById('save-rules-btn'));
        /** @type {HTMLInputElement} */ (document.getElementById('new-rule-value')).value = 'b.example.com';
        document.getElementById('confirm-add-rule-btn')?.click();
        save.click();
        await vi.waitFor(() => expect(showNotification).toHaveBeenCalled());
        expect(showNotification).toHaveBeenCalledWith('core is already starting; please wait and try again', 'error');
        expect(save.classList.contains('hidden')).toBe(false);
    });

    it('still saves when the browser YAML parser rejects the profile', async () => {
        api.invoke.mockImplementation(async (cmd) => {
            if (cmd === 'update_config') {
                return { files_saved: true, run_config_saved: true, profile_saved: true, hot_reload_success: true, message: 'ok' };
            }
            if (cmd === 'get_settings') return { last_config: 'a.yaml' };
            return 'rules';
        });
        await initRulesPage();
        globalThis.jsyaml.load = () => { throw new Error('unknown tag !profile'); };
        const save = /** @type {HTMLElement} */ (document.getElementById('save-rules-btn'));
        /** @type {HTMLInputElement} */ (document.getElementById('new-rule-value')).value = 'b.example.com';
        document.getElementById('confirm-add-rule-btn')?.click();
        save.click();
        await vi.waitFor(() => expect(showNotification).toHaveBeenCalled());
        expect(api.invoke.mock.calls.some(([cmd]) => cmd === 'update_config')).toBe(true);
        expect(showNotification).toHaveBeenCalledWith(expect.anything(), 'success');
        expect(save.classList.contains('hidden')).toBe(true);
    });

    it('a failed close of old connections after the save is not a failed save', async () => {
        api.closeAllConnections.mockRejectedValueOnce(new Error('core busy'));
        const save = await addRuleAndSave({
            files_saved: true, run_config_saved: true, profile_saved: true, hot_reload_success: true, message: 'ok',
        });
        expect(showNotification).toHaveBeenCalledWith(expect.anything(), 'success');
        expect(save.classList.contains('hidden')).toBe(true);
    });
});
