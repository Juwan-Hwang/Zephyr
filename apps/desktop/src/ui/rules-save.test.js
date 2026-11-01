import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
const { initRulesPage } = await import('./rules.js');

/** Rules page with one saved rule, then one more added and saved. */
async function addRuleAndSave(updateResult) {
    api.invoke.mockImplementation(async (cmd) => {
        if (cmd === 'update_config') return updateResult;
        if (cmd === 'get_settings') return { last_config: 'a.yaml' };
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

describe('saving rules', () => {
    beforeEach(() => {
        vi.clearAllMocks();
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
});
