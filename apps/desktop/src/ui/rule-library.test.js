// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as yaml from '../js-yaml.min.js';

const invokeMock = vi.fn();
vi.mock('../api.js', () => ({ invoke: (...a) => invokeMock(...a) }));

const prismMock = {
    status: vi.fn(async () => ({ state: 'idle' })),
    stats: vi.fn(async () => null),
    listRules: vi.fn(async () => [{ group_id: 'ai.prism.yaml', label: 'ai', enabled: true, rules: [{ raw: 'DOMAIN,a.com,DIRECT', index: 0 }] }]),
    insertRule: vi.fn(async () => 0),
    insertRuleStr: vi.fn(async () => 0),
    apply: vi.fn(async () => ({})),
    rebuild: vi.fn(async () => ({})),
    rebuildWithOverrides: vi.fn(async () => ({})),
    toggleGroup: vi.fn(async () => true),
    traceReportText: vi.fn(async () => 'trace body'),
};
vi.mock('./prism.js', () => prismMock);
vi.mock('./proxy-groups.js', () => ({ fetchProxyGroups: vi.fn(async () => ({ orderedGroupNames: ['OpenAI', 'Proxy'] })) }));
vi.mock('./editor/prism-editor.js', () => ({ createEditor: vi.fn(({ content }) => ({ content, destroy() {} })), getEditorContent: vi.fn((view) => view.content) }));

const notify = vi.fn();
vi.mock('./notifications.js', async () => {
    const actual = await vi.importActual('./notifications.js');
    return { ...actual, showNotification: (...a) => notify(...a) };
});

const FILES = [
    { filename: 'ai.prism.yaml', rule_count: 2, source: 'clash', enabled: true },
    { filename: 'ads.prism.yaml', rule_count: 1, source: 'surge', enabled: false },
];
const FILE_CONTENT = 'rules:\n  $append:\n    - DOMAIN-SUFFIX,openai.com,OpenAI\n    - DOMAIN-SUFFIX,anthropic.com,OpenAI\n';

function setupDom() {
    document.body.innerHTML = `
        <div data-page="rule-library"><span id="rl-status"></span><span id="rl-stats"></span>
            <button id="rl-btn-new-group"></button><button id="rl-btn-import"></button>
            <div id="rl-content"></div></div>
        <div id="modal-bg" class="hidden opacity-0"><div id="modal-container" class="scale-95">
            <h3 id="modal-title"></h3><div id="modal-content-area"></div>
            <button id="modal-cancel"></button><button id="modal-confirm" class="btn-primary"></button>
        </div></div>`;
}

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const frames = () => new Promise((r) => setTimeout(r, 40));

// happy-dom has no layout: give scroll containers a viewport so the virtual list mounts rows.
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 600; } });

describe('rule library page', () => {
    afterEach(async () => {
        try {
            // Assertions can fail before a test's normal close/wait. Release
            // the shared modal before the next fixture replaces its DOM.
            const backdrop = document.getElementById('modal-bg');
            if (backdrop && !backdrop.classList.contains('hidden')) {
                document.getElementById('modal-cancel')?.click();
                await vi.waitFor(() => expect(backdrop.classList.contains('hidden')).toBe(true));
            }
        } finally { vi.unstubAllGlobals(); }
    });
    beforeEach(() => {
        vi.resetModules();
        vi.stubGlobal('jsyaml', yaml);
        setupDom();
        invokeMock.mockReset();
        invokeMock.mockImplementation(async (cmd, args) => {
            if (cmd === 'rule_list') return FILES;
            if (cmd === 'rule_group_list') return { groups: [] };
            if (cmd === 'rule_read') return FILE_CONTENT;
            if (cmd === 'rule_update') return args;
            return null;
        });
        Object.values(prismMock).forEach((f) => f.mockClear());
        notify.mockClear();
    });

    it('keeps the newest file list when an earlier page refresh finishes last', async () => {
        let finishFirst;
        let listReads = 0;
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation((command, args) => {
            if (command !== 'rule_list') return previous(command, args);
            if (++listReads === 1) return new Promise((resolve) => { finishFirst = resolve; });
            return [{ ...FILES[0], filename: 'newer.prism.yaml' }];
        });
        const { initRuleLibraryPage } = await import('./rule-library.js');
        const first = initRuleLibraryPage();
        await initRuleLibraryPage();
        expect(document.getElementById('rl-content').textContent).toContain('newer');
        finishFirst(FILES);
        await first;
        expect(document.querySelectorAll('.rl-file-card')).toHaveLength(1);
        expect(document.getElementById('rl-content').textContent).toContain('newer');
    });

    it('file cards show the switch, edit and ⋯ without right-click', async () => {
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        const cards = document.querySelectorAll('.rl-file-card');
        expect(cards.length).toBe(2);
        const [ai, ads] = cards;
        expect(/** @type {HTMLInputElement} */ (ai.querySelector('.rl-file-toggle')).checked).toBe(true);
        expect(/** @type {HTMLInputElement} */ (ads.querySelector('.rl-file-toggle')).checked).toBe(false);
        expect(ads.classList.contains('is-disabled')).toBe(true);
        expect(/** @type {HTMLButtonElement} */ (ads.querySelector('.rl-file-edit')).disabled).toBe(true);
        expect(ai.querySelector('.rl-file-more')).not.toBeNull();

        const toggle = /** @type {HTMLInputElement} */ (ads.querySelector('.rl-file-toggle'));
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));
        await flush();
        expect(prismMock.toggleGroup).toHaveBeenCalledWith('ads.prism.yaml', true);
        expect(prismMock.rebuildWithOverrides).toHaveBeenCalled();
    });

    it('keeps a disabled file saved when rebuild fails without applying the stale config', async () => {
        prismMock.rebuildWithOverrides.mockRejectedValueOnce(new Error('Profile rebuild failed'));
        let enabled = true;
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation((command, args) => command === 'rule_list'
            ? [{ ...FILES[0], enabled }] : previous(command, args));
        prismMock.toggleGroup.mockImplementationOnce(async () => { enabled = false; return true; });
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        const toggle = document.querySelector('.rl-file-toggle');
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change'));
        await flush();
        expect(prismMock.toggleGroup).toHaveBeenCalledWith('ai.prism.yaml', false);
        expect(prismMock.apply).not.toHaveBeenCalled();
        expect(notify).toHaveBeenCalledWith(expect.stringContaining('Profile rebuild failed'), 'warning');
        expect(document.querySelector('.rl-file-toggle').checked).toBe(false);
        expect(document.querySelector('.rl-file-card').classList.contains('is-disabled')).toBe(true);
    });

    it('shows the resolved rebuild failure after saving a toggle', async () => {
        prismMock.rebuildWithOverrides.mockResolvedValueOnce({ hot_reload_success: false, hot_reload_error: 'Unknown policy: Removed' });
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        const toggle = document.querySelector('.rl-file-toggle');
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change'));
        await flush();
        expect(notify).toHaveBeenCalledWith(expect.stringContaining('Unknown policy: Removed'), 'warning');
    });

    it('distinguishes running rules from failed DNS restoration', async () => {
        prismMock.rebuildWithOverrides.mockResolvedValueOnce({ hot_reload_success: false, core_reload_confirmed: true, runtime_restore_success: false });
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        const toggle = document.querySelector('.rl-file-toggle');
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change'));
        await flush();
        expect(notify).toHaveBeenCalledWith('Rules are running, but DNS restoration failed. Check DNS settings and retry.', 'warning');
    });

    it('editor: Add rule keeps the list and inserts on ✓; rows edit in place', async () => {
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        /** @type {HTMLElement} */ (document.querySelector('.rl-file-edit')).click();
        await flush();
        await frames();
        const rows = () => [...document.querySelectorAll('#rl-vs-lines .rl-rule-row')];
        expect(rows().length).toBe(2);

        /** @type {HTMLElement} */ (document.getElementById('rl-editor-add')).click();
        expect(document.getElementById('rl-editor-new')?.classList.contains('hidden')).toBe(false);
        expect(rows().length).toBe(2); // list not cleared
        const input = /** @type {HTMLInputElement} */ (document.getElementById('rl-new-value'));
        input.value = 'gemini.google.com';
        input.dispatchEvent(new Event('input'));
        /** @type {HTMLElement} */ (document.getElementById('rl-new-ok')).click();
        expect(rows().length).toBe(3);
        expect(rows()[0].textContent).toContain('gemini.google.com');
        expect(document.getElementById('rl-editor-dirty')?.classList.contains('hidden')).toBe(false);

        // click a row → inline form with its values
        rows()[1].click();
        await frames();
        const edit = /** @type {HTMLInputElement} */ (document.getElementById('rl-edit-value'));
        expect(edit.value).toBe('openai.com');
        edit.value = 'chatgpt.com';
        edit.dispatchEvent(new Event('input'));
        /** @type {HTMLElement} */ (document.getElementById('rl-edit-ok')).click();
        expect(rows()[1].textContent).toContain('chatgpt.com');

        /** @type {HTMLElement} */ (document.getElementById('rl-editor-save')).click();
        await flush();
        const update = invokeMock.mock.calls.find(([c]) => c === 'rule_update');
        expect(update?.[1].content).toContain('DOMAIN-SUFFIX,gemini.google.com,OpenAI');
        expect(update?.[1].content).toContain('DOMAIN-SUFFIX,chatgpt.com,OpenAI');
        await new Promise((r) => setTimeout(r, 350));
    });

    it('shows the rebuild error after deleting a file and does not reapply stale rules', async () => {
        prismMock.rebuildWithOverrides.mockRejectedValueOnce(new Error('Invalid target: missing-group'));
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        /** @type {HTMLElement} */ (document.querySelector('.rl-file-more')).click();
        const actions = [...document.querySelectorAll('.ctx-menu-root button')];
        /** @type {HTMLElement} */ (actions.at(-1)).click();
        await flush();
        /** @type {HTMLElement} */ (document.getElementById('modal-confirm')).click();
        await new Promise((resolve) => setTimeout(resolve, 350));
        await flush();
        expect(invokeMock).toHaveBeenCalledWith('rule_delete', { filename: 'ai.prism.yaml' });
        expect(notify).toHaveBeenCalledWith(expect.stringContaining('Invalid target: missing-group'), 'warning');
        expect(prismMock.apply).not.toHaveBeenCalled();
    });

    it.each([0, 1])('keeps the other duplicate in its list after deleting row %i', async (deleted) => {
        vi.stubGlobal('jsyaml', yaml);
        const duplicate = 'DOMAIN,a.com,DIRECT';
        const content = yaml.dump({ rules: { $prepend: [duplicate], $append: [duplicate] } });
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation(async (command, args) => command === 'rule_read' ? content : previous(command, args));
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        document.querySelector('.rl-file-edit').click();
        await flush();
        await frames();
        document.querySelectorAll('.btn-rl-rule-del')[deleted].click();
        document.getElementById('rl-editor-save').click();
        await flush();
        const saved = invokeMock.mock.calls.find(([command]) => command === 'rule_update')?.[1].content;
        expect(yaml.load(saved).rules).toEqual({
            $prepend: deleted === 0 ? [] : [duplicate],
            $append: deleted === 1 ? [] : [duplicate],
        });
        await new Promise((resolve) => setTimeout(resolve, 350));
    });

    it.each(['down', 'up'])('moves only the selected rule across the profile boundary: %s', async (direction) => {
        const a = 'DOMAIN,a.com,DIRECT';
        const b = 'DOMAIN,b.com,DIRECT';
        const c = 'DOMAIN,c.com,DIRECT';
        const content = yaml.dump({ rules: { $prepend: [a], $append: [b, c] } });
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation((command, args) => command === 'rule_read' ? content : previous(command, args));
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        document.querySelector('.rl-file-edit').click();
        await flush();
        await frames();
        const button = direction === 'down' ? document.querySelector('.btn-rl-rule-down') : document.querySelectorAll('.btn-rl-rule-up')[1];
        button.click();
        document.getElementById('rl-editor-save').click();
        await flush();
        const saved = invokeMock.mock.calls.find(([command]) => command === 'rule_update')?.[1].content;
        expect(yaml.load(saved).rules).toEqual(direction === 'down'
            ? { $prepend: [], $append: [b, a, c] }
            : { $prepend: [b, a], $append: [c] });
        await new Promise((resolve) => setTimeout(resolve, 350));
    });

    it.each([true, false])('uses the hovered row to choose the drop list (belowPrepend=%s)', async (belowPrepend) => {
        const rules = ['DOMAIN,a.com,DIRECT', 'DOMAIN,b.com,DIRECT', 'DOMAIN,c.com,DIRECT', 'DOMAIN,d.com,DIRECT'];
        const content = yaml.dump({ rules: { $prepend: rules.slice(0, 2), $append: rules.slice(2) } });
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation((command, args) => command === 'rule_read' ? content : previous(command, args));
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        document.querySelector('.rl-file-edit').click();
        await flush();
        await frames();
        const rows = document.querySelectorAll('#rl-vs-lines .rl-rule-row');
        expect(rows).toHaveLength(rules.length);
        rows[3].dispatchEvent(new Event('dragstart'));
        const target = rows[belowPrepend ? 1 : 2];
        vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 100 });
        target.dispatchEvent(new MouseEvent('drop', { clientY: belowPrepend ? 75 : 25 }));
        document.getElementById('rl-editor-save').click();
        await flush();
        const saved = yaml.load(invokeMock.mock.calls.find(([command]) => command === 'rule_update')?.[1].content).rules;
        expect(saved).toEqual(belowPrepend
            ? { $prepend: [rules[0], rules[1], rules[3]], $append: [rules[2]] }
            : { $prepend: rules.slice(0, 2), $append: [rules[3], rules[2]] });
        await new Promise((resolve) => setTimeout(resolve, 350));
    });

    it.each([true, false])('keeps operators when a boundary drop does not move the row (fromPrepend=%s)', async (fromPrepend) => {
        const expected = { $prepend: ['DOMAIN,a.com,DIRECT', 'DOMAIN,b.com,DIRECT'], $append: ['DOMAIN,c.com,DIRECT', 'DOMAIN,d.com,DIRECT'] };
        const content = yaml.dump({ rules: expected });
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation((command, args) => command === 'rule_read' ? content : previous(command, args));
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        document.querySelector('.rl-file-edit').click();
        await flush();
        await frames();
        const rows = document.querySelectorAll('#rl-vs-lines .rl-rule-row');
        rows[fromPrepend ? 1 : 2].dispatchEvent(new Event('dragstart'));
        const target = rows[fromPrepend ? 2 : 1];
        vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 100 });
        target.dispatchEvent(new MouseEvent('drop', { clientY: fromPrepend ? 25 : 75 }));
        document.getElementById('rl-editor-save').click();
        await flush();
        const saved = invokeMock.mock.calls.find(([command]) => command === 'rule_update')?.[1].content;
        expect(yaml.load(saved).rules).toEqual(expected);
        await new Promise((resolve) => setTimeout(resolve, 350));
    });

    it.each(['mine.prism.yml', 'mine.prism.YAML'])('normalizes a Prism extension when creating %s', async (filename) => {
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation((command, args) => command === 'rule_list' ? [] : previous(command, args));
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        document.getElementById('rl-btn-create-file').click();
        await vi.waitFor(() => expect(document.getElementById('modal-input')).not.toBeNull());
        document.getElementById('modal-input').value = filename;
        document.getElementById('modal-confirm').click();
        await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('rule_create', { name: 'mine.prism.yaml', content: 'rules:\n  $append: []\n' }));
    });

    it.each(['rules:\n  $append:\n', 'rules:\n  $append: []\n'])('keeps empty templates editable visually: %s', async (content) => {
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation((command, args) => command === 'rule_read' ? content : previous(command, args));
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        document.querySelector('.rl-file-edit').click();
        await flush();
        expect(document.querySelector('[data-rl-mode="visual"]').disabled).toBe(false);
        expect(document.getElementById('rl-editor-add').classList.contains('hidden')).toBe(false);
        document.getElementById('rl-editor-cancel').click();
        await new Promise((resolve) => setTimeout(resolve, 350));
    });

    it('preserves mixed-list identity when an edited rule becomes the other list\'s duplicate', async () => {
        vi.stubGlobal('jsyaml', yaml);
        const content = yaml.dump({ rules: { $prepend: ['DOMAIN,a.com,DIRECT'], $append: ['DOMAIN,b.com,DIRECT'] } });
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation(async (command, args) => command === 'rule_read' ? content : previous(command, args));
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        document.querySelector('.rl-file-edit').click();
        await flush();
        await frames();
        document.querySelector('#rl-vs-lines .rl-rule-row').click();
        await frames();
        const value = document.getElementById('rl-edit-value');
        value.value = 'b.com';
        value.dispatchEvent(new Event('input'));
        document.getElementById('rl-edit-ok').click();
        document.getElementById('rl-editor-save').click();
        await flush();
        const saved = invokeMock.mock.calls.find(([command]) => command === 'rule_update')?.[1].content;
        expect(yaml.load(saved).rules).toEqual({ $prepend: ['DOMAIN,b.com,DIRECT'], $append: ['DOMAIN,b.com,DIRECT'] });
        await new Promise((resolve) => setTimeout(resolve, 350));
    });

    it.each([
        'rules: true\n',
        'rules: {$append: false}\n',
        '- {type: DOMAIN, payload: a.com, proxy: DIRECT}\n',
        yaml.dump({ rules: { $prepend: [{ type: 'DOMAIN', payload: 'a.com', proxy: 'DIRECT' }] } }),
    ])('opens unrepresentable rules as YAML and disables the visual editor: %s', async (content) => {
        vi.stubGlobal('jsyaml', yaml);
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation(async (command, args) => command === 'rule_read' ? content : previous(command, args));
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        document.querySelector('.rl-file-edit').click();
        await flush();
        expect(document.querySelector('[data-rl-mode="visual"]').disabled).toBe(true);
        expect(document.getElementById('rl-editor-text').classList.contains('hidden')).toBe(false);
        const { createEditor } = await import('./editor/prism-editor.js');
        expect(createEditor).toHaveBeenCalledWith(expect.objectContaining({ content }));
        document.getElementById('rl-editor-cancel').click();
        await new Promise((resolve) => setTimeout(resolve, 350));
    });

    it('saves a root YAML sequence unchanged through the text editor', async () => {
        const content = '# retained\n- {type: DOMAIN, payload: a.com, proxy: DIRECT}\n';
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation((command, args) => command === 'rule_read' ? content : previous(command, args));
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        document.querySelector('.rl-file-edit').click();
        await flush();
        document.getElementById('rl-editor-save').click();
        await flush();
        expect(invokeMock).toHaveBeenCalledWith('rule_update', expect.objectContaining({ content, expectedContent: content }));
        await new Promise((resolve) => setTimeout(resolve, 350));
    });

    it('preserves a conflicting draft until the user chooses to reopen the current file', async () => {
        vi.stubGlobal('jsyaml', yaml);
        const latest = 'rules:\n  $append:\n    - DOMAIN,newer.com,DIRECT\n';
        const fixture = 'rules:\n  $prepend:\n    - DOMAIN-SUFFIX,openai.com,OpenAI\n  $append:\n    - DOMAIN-SUFFIX,anthropic.com,OpenAI\n';
        const draft = fixture.replace('openai.com', 'my-draft.com');
        let file = fixture;
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation(async (command, args) => {
            if (command === 'rule_read') return file;
            if (command === 'rule_update') {
                expect(args.expectedContent).toBe(fixture);
                expect(args.content).toBe(draft);
                file = latest;
                throw new Error('RULE_FILE_CHANGED: Reopen and retry.');
            }
            return previous(command, args);
        });
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        document.querySelector('.rl-file-edit').click();
        await flush();
        await frames();
        const { getEditorContent } = await import('./editor/prism-editor.js');
        document.querySelector('[data-rl-mode="text"]').click();
        getEditorContent.mockReturnValueOnce(draft);
        document.getElementById('rl-editor-save').click();
        await vi.waitFor(() => expect(document.querySelector('[data-conflict-draft]')).not.toBeNull());
        expect(document.querySelector('[data-conflict-draft]').value).toBe(draft);
        expect(document.getElementById('rl-editor-save').disabled).toBe(true);
        document.querySelector('[data-conflict-reopen]').click();
        await new Promise((resolve) => setTimeout(resolve, 350));
        await flush();
        await frames();
        expect(document.querySelector('#rl-vs-lines').textContent).toContain('newer.com');
        expect(prismMock.rebuildWithOverrides).not.toHaveBeenCalled();
        document.getElementById('rl-editor-cancel').click();
        await new Promise((resolve) => setTimeout(resolve, 350));
    });

    it('recovers the complete submitted YAML when a single-list text edit conflicts', async () => {
        const original = '__when__: {profile: Work}\ndns: {enable: false}\nrules:\n  $prepend: ["DOMAIN,old.com,Proxy"]\n';
        const rawDraft = 'DOMAIN,my-draft.com,DIRECT\n';
        let attempted;
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation((command, args) => {
            if (command === 'rule_read') return original;
            if (command === 'rule_update') { attempted = args; throw new Error('RULE_FILE_CHANGED: Reopen and retry.'); }
            return previous(command, args);
        });
        const { initRuleLibraryPage } = await import('./rule-library.js');
        const { getEditorContent } = await import('./editor/prism-editor.js');
        await initRuleLibraryPage();
        document.querySelector('.rl-file-edit').click();
        await flush();
        document.querySelector('[data-rl-mode="text"]').click();
        getEditorContent.mockReturnValueOnce(rawDraft);
        document.getElementById('rl-editor-save').click();
        await vi.waitFor(() => expect(document.querySelector('[data-conflict-draft]')).not.toBeNull());
        const recovery = document.querySelector('[data-conflict-draft]').value;
        expect(attempted.expectedContent).toBe(original);
        expect(recovery).toBe(attempted.content);
        expect(yaml.load(recovery)).toEqual({ __when__: { profile: 'Work' }, dns: { enable: false }, rules: { $prepend: ['DOMAIN,my-draft.com,DIRECT'] } });
        expect(prismMock.rebuildWithOverrides).not.toHaveBeenCalled();
        document.getElementById('rl-editor-cancel').click();
        await new Promise((resolve) => setTimeout(resolve, 350));
    });

    it('saves removal of all rules while keeping an independent patch in YAML mode', async () => {
        const original = 'dns: {enable: false}\nrules: {$prepend: ["MATCH,DIRECT"], $append: []}\n';
        const draft = '# keep this patch\ndns: {enable: false}\n';
        let file = original;
        let attempted;
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation((command, args) => {
            if (command === 'rule_read') return file;
            if (command === 'rule_update') { attempted = args; file = args.content; return null; }
            return previous(command, args);
        });
        const { initRuleLibraryPage } = await import('./rule-library.js');
        const { getEditorContent, createEditor } = await import('./editor/prism-editor.js');
        await initRuleLibraryPage();
        document.querySelector('.rl-file-edit').click();
        await flush();
        document.querySelector('[data-rl-mode="text"]').click();
        getEditorContent.mockReturnValueOnce(draft);
        document.getElementById('rl-editor-save').click();
        await vi.waitFor(() => expect(attempted?.content).toBe(draft));
        expect(attempted.expectedContent).toBe(original);
        await new Promise((resolve) => setTimeout(resolve, 350));
        document.querySelector('.rl-file-edit').click();
        await flush();
        expect(createEditor).toHaveBeenLastCalledWith(expect.objectContaining({ content: draft }));
        expect(document.querySelector('[data-rl-mode="visual"]').disabled).toBe(true);
        document.getElementById('rl-editor-cancel').click();
        await new Promise((resolve) => setTimeout(resolve, 350));
    });

    it('does not destroy a newer text editor when an older save finishes refreshing', async () => {
        const { queueRuleWrite } = await import('./rule-library/write-queue.js');
        const { createEditor, getEditorContent } = await import('./editor/prism-editor.js');
        const destroy = vi.fn();
        createEditor.mockImplementationOnce(({ content }) => ({ content, destroy }));
        getEditorContent.mockImplementationOnce((view) => view.content);
        let release;
        let finishRefresh;
        let holdRefresh = false;
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation((command, args) => {
            if (command === 'rule_update') return new Promise((resolve) => { release = resolve; });
            if (command === 'rule_list' && holdRefresh) return new Promise((resolve) => { finishRefresh = resolve; });
            return previous(command, args);
        });
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        try {
            document.querySelector('.rl-file-edit').click();
            await flush();
            document.getElementById('rl-editor-save').click();
            await vi.waitFor(() => expect(release).toBeTypeOf('function'));
            holdRefresh = true;
            release();
            // Once the save outcome is known, dismissal is allowed while its
            // independent library refresh remains pending.
            await queueRuleWrite(async () => {});
            await vi.waitFor(() => expect(finishRefresh).toBeTypeOf('function'));
            document.getElementById('rl-editor-cancel').click();
            await new Promise((resolve) => setTimeout(resolve, 350));
            document.querySelector('.rl-file-edit').click();
            await flush();
            document.querySelector('[data-rl-mode="text"]').click();
            finishRefresh([{ ...FILES[0], rule_count: 17 }, FILES[1]]);
            // Wait for the refresh to publish its new data and finish rendering.
            await vi.waitFor(() => expect(document.querySelector('.rl-file-card').textContent).toContain('17'));
            expect(destroy).not.toHaveBeenCalled();
            expect(document.getElementById('rl-editor-text').classList.contains('hidden')).toBe(false);
        } finally {
            release?.();
            finishRefresh?.(FILES);
            await queueRuleWrite(async () => {});
            document.getElementById('rl-editor-cancel')?.click();
            await new Promise((resolve) => setTimeout(resolve, 350));
        }
    });

    it('keeps pending saves open so cancellation cannot discard a conflict draft', async () => {
        const { queueRuleWrite } = await import('./rule-library/write-queue.js');
        const original = 'rules: {$prepend: ["DOMAIN,a.com,DIRECT"], $append: []}\n';
        const draft = original.replace('a.com', 'draft.com');
        let rejectWrite;
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation((command, args) => {
            if (command === 'rule_read') return original;
            if (command === 'rule_update') return new Promise((_resolve, reject) => { rejectWrite = reject; });
            return previous(command, args);
        });
        const { initRuleLibraryPage } = await import('./rule-library.js');
        const { getEditorContent } = await import('./editor/prism-editor.js');
        await initRuleLibraryPage();
        document.querySelector('.rl-file-edit').click();
        await flush();
        document.querySelector('[data-rl-mode="text"]').click();
        getEditorContent.mockReturnValueOnce(draft);
        document.getElementById('rl-editor-save').click();
        await vi.waitFor(() => expect(rejectWrite).toBeTypeOf('function'));
        try {
            expect(document.getElementById('rl-editor-cancel').disabled).toBe(true);
            const backdrop = document.getElementById('modal-bg');
            document.getElementById('rl-editor-cancel').click();
            backdrop.click();
            backdrop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            expect(backdrop.classList.contains('opacity-0')).toBe(false);
            rejectWrite(new Error('RULE_FILE_CHANGED: Reopen and retry.'));
            await vi.waitFor(() => expect(document.querySelector('[data-conflict-draft]')?.value).toBe(draft));
            expect(document.getElementById('rl-editor-cancel').disabled).toBe(false);
        } finally {
            rejectWrite(new Error('RULE_FILE_CHANGED: Reopen and retry.'));
            await queueRuleWrite(async () => {});
            document.getElementById('rl-editor-cancel')?.click();
            await new Promise((resolve) => setTimeout(resolve, 350));
        }
    });

    it('keeps generated override files read-only in library actions', async () => {
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation((command, args) => command === 'rule_list'
            ? [{ ...FILES[0], read_only: true }] : previous(command, args));
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        expect(document.querySelector('.rl-file-edit').disabled).toBe(true);
        expect(document.querySelector('.rl-file-toggle').disabled).toBe(true);
        document.querySelector('.rl-file-more').click();
        expect(document.querySelectorAll('.ctx-menu-root button')).toHaveLength(1);
    });

    it('refuses visual editing when the YAML parser is unavailable', async () => {
        vi.stubGlobal('jsyaml', undefined);
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        document.querySelector('.rl-file-edit').click();
        await flush();
        expect(document.getElementById('rl-editor-save')).toBeNull();
        expect(invokeMock.mock.calls.some(([command]) => command === 'rule_update')).toBe(false);
    });

    it.each(['', ' ', '\t'])('wraps a raw rule file with YAML-significant values and field whitespace: %j', async (space) => {
        const processRule = `PROCESS-NAME,${space}a: b,Proxy`;
        const content = `DOMAIN,a.com,DIRECT\n${processRule}\n`;
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation((command, args) => command === 'rule_read' ? content : previous(command, args));
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        document.querySelector('.rl-file-edit').click();
        await flush();
        document.querySelector('[data-rl-mode="text"]').click();
        document.getElementById('rl-editor-save').click();
        await flush();
        const written = invokeMock.mock.calls.find(([command]) => command === 'rule_update')?.[1];
        expect(written.expectedContent).toBe(content);
        expect(yaml.load(written.content).rules).toEqual({ $append: ['DOMAIN,a.com,DIRECT', processRule] });
        await new Promise((resolve) => setTimeout(resolve, 350));
    });

    it('preserves untouched YAML text across modes and rejects scalar rules', async () => {
        const original = '# original\nrules:\n  $prepend: ["DOMAIN,a.com,DIRECT"]\n  $append: ["MATCH,Proxy"]\n';
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation((command, args) => command === 'rule_read' ? original : previous(command, args));
        const { createEditor, getEditorContent } = await import('./editor/prism-editor.js');
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        document.querySelector('.rl-file-edit').click();
        await flush();
        document.querySelector('[data-rl-mode="text"]').click();
        expect(createEditor).toHaveBeenLastCalledWith(expect.objectContaining({ content: original }));
        getEditorContent.mockReturnValueOnce('rules: true');
        document.querySelector('[data-rl-mode="visual"]').click();
        expect(document.getElementById('rl-editor-text').classList.contains('hidden')).toBe(false);
        const withComment = '# extra comment\n' + original;
        getEditorContent.mockReturnValueOnce(withComment);
        document.querySelector('[data-rl-mode="visual"]').click();
        document.querySelector('[data-rl-mode="text"]').click();
        expect(createEditor).toHaveBeenLastCalledWith(expect.objectContaining({ content: withComment }));
        document.getElementById('rl-editor-cancel').click();
        await new Promise((resolve) => setTimeout(resolve, 350));
    });

    it('insert dialog: one form with visible positions', async () => {
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        /** @type {HTMLElement} */ (document.querySelector('[data-rl-tab="active-rules"]')).click();
        await flush();
        expect(document.getElementById('rl-btn-trace')).not.toBeNull();
        /** @type {HTMLElement} */ (document.getElementById('rl-btn-insert-rule')).click();
        await flush();
        await frames();
        const radios = document.querySelectorAll('input[name="rl-insert-pos"]');
        expect(radios.length).toBe(4); // before / after "ai" / after all / end
        expect(document.querySelector('.rl-pos-list')?.textContent).toContain('ai');
        const input = /** @type {HTMLInputElement} */ (document.getElementById('rl-insert-value'));
        input.value = 'example.com';
        /** @type {HTMLInputElement} */ (radios[1]).checked = true;
        /** @type {HTMLElement} */ (document.getElementById('rl-insert-confirm')).click();
        await flush();
        expect(prismMock.insertRuleStr).toHaveBeenCalledWith('DOMAIN-SUFFIX,example.com,OpenAI', 'after_group', 'ai.prism.yaml');
        await new Promise((r) => setTimeout(r, 350));
    });
});
