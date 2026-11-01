import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const api = {
    invoke: vi.fn(),
    closeAllConnections: vi.fn(async () => {}),
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

const { showNotification } = await import('./notifications.js');
const { getActiveConfigContent } = await import('./advanced.js');
const { validateConfig } = await import('./prism.js');
const { initRulesPage, PROFILE_CHANGED_MEANWHILE } = await import('./rules.js');

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
    beforeEach(() => {
        vi.clearAllMocks();
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

    it('still saves when the profile fails the check without the new rules too', async () => {
        vi.mocked(validateConfig).mockImplementation(async () => false);
        await addRuleAndSave({
            files_saved: true, run_config_saved: true, profile_saved: true, hot_reload_success: true, message: 'ok',
        });
        expect(api.invoke.mock.calls.some(([cmd]) => cmd === 'update_config')).toBe(true);
        expect(showNotification).toHaveBeenCalledWith(expect.anything(), 'success');
    });

    it('skips the check, and still saves, when the running config cannot be read', async () => {
        await saveWith(async (cmd) => {
            if (cmd === 'update_config') return SAVED;
            if (cmd === 'get_settings') return { last_config: 'a.yaml' };
            if (cmd === 'read_config') throw new Error('no run config');
            return 'rules';
        });
        expect(showNotification).toHaveBeenCalledWith(expect.anything(), 'success');
        expect(validateConfig).not.toHaveBeenCalled();
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
            // The read after the check fails: where the rules land is unknown.
            if (cmd === 'get_settings') {
                if (reads++ >= 1) throw new Error('settings unavailable');
                return { last_config: 'a.yaml' };
            }
            return 'rules';
        });
        expect(showNotification).toHaveBeenCalledWith(expect.anything(), 'warning');
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
