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
    requireRuleInsertion: vi.fn(async () => {}),
    apply: vi.fn(async () => ({})),
    rebuild: vi.fn(async () => ({})),
    rebuildWithOverrides: vi.fn(async () => ({})),
    toggleGroup: vi.fn(async () => true),
    traceReportText: vi.fn(async () => 'trace body'),
    getLastTrace: vi.fn(async () => []),
    previewRules: vi.fn(async () => ({ added: [], removed: [], modified: [] })),
};
vi.mock('./prism.js', () => prismMock);
vi.mock('./proxy-groups.js', () => ({ fetchProxyGroups: vi.fn(async () => ({ orderedGroupNames: ['OpenAI', 'Proxy'] })) }));
const copyDraft = vi.fn(async () => {});
vi.mock('./tray.js', () => ({ copyToClipboard: (...args) => copyDraft(...args) }));
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
        copyDraft.mockClear();
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

    it('publishes a completed refresh when the newer refresh failed', async () => {
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        let complete;
        let reads = 0;
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation((command, args) => {
            if (command !== 'rule_list') return previous(command, args);
            if (++reads === 1) return new Promise((resolve) => { complete = resolve; });
            return Promise.reject(new Error('Newer refresh failed'));
        });
        const first = initRuleLibraryPage();
        await initRuleLibraryPage();
        complete([{ ...FILES[0], enabled: false }]);
        await first;
        expect(document.querySelectorAll('.rl-file-card')).toHaveLength(1);
        expect(document.querySelector('.rl-file-toggle').checked).toBe(false);
    });

    it('does not let an older status reply overwrite a newer one after a failed list refresh', async () => {
        let finishStatus;
        let finishStats;
        prismMock.status.mockImplementationOnce(() => new Promise((resolve) => { finishStatus = resolve; }))
            .mockResolvedValueOnce({ state: 'idle' });
        prismMock.stats.mockImplementationOnce(() => new Promise((resolve) => { finishStats = resolve; }))
            .mockResolvedValueOnce({ file_count: 2, rule_count: 3 });
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation(async (command, args) => {
            if (command === 'rule_list') throw new Error('List unavailable');
            return previous(command, args);
        });
        await initRuleLibraryPage();
        await flush();
        const status = document.getElementById('rl-status').textContent;
        const stats = document.getElementById('rl-stats').textContent;
        finishStatus({ state: 'error' });
        finishStats({ file_count: 99, rule_count: 99 });
        await flush();
        expect(document.getElementById('rl-status').textContent).toBe(status);
        expect(document.getElementById('rl-stats').textContent).toBe(stats);
        expect(stats).toContain('2');
        expect(stats).toContain('3');
    });

    it('reports unavailable ownership metadata once for all affected rule files', async () => {
        const reason = 'Override ownership metadata unavailable (overrides/meta.json): invalid JSON';
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation(async (command, args) => command === 'rule_list'
            ? FILES.map((file) => ({ ...file, read_only: true, read_only_reason: reason })) : previous(command, args));
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        await initRuleLibraryPage();
        expect(notify).toHaveBeenCalledExactlyOnceWith(reason, 'warning');
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

    it('keeps an explicit full-YAML rules sequence after a visual row edit', async () => {
        const original = 'rules: {$prepend: ["DOMAIN,a.com,DIRECT"], $append: []}\n';
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation((command, args) => command === 'rule_read' ? original : previous(command, args));
        const { createEditor } = await import('./editor/prism-editor.js');
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        document.querySelector('.rl-file-edit').click();
        await flush();
        document.querySelector('[data-rl-mode="text"]').click();
        createEditor.mock.results.at(-1).value.content = 'rules: ["DOMAIN,a.com,DIRECT"]\n';
        document.querySelector('[data-rl-mode="visual"]').click();
        await frames();
        document.querySelector('#rl-vs-lines .rl-rule-row').click();
        await frames();
        const value = document.getElementById('rl-edit-value');
        value.value = 'b.com';
        value.dispatchEvent(new Event('input'));
        document.getElementById('rl-edit-ok').click();
        document.getElementById('rl-editor-save').click();
        await flush();
        const saved = invokeMock.mock.calls.find(([command]) => command === 'rule_update')[1].content;
        expect(yaml.load(saved).rules).toEqual(['DOMAIN,b.com,DIRECT']);
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
        'DOMAIN,example.com,DIRECT: note\n',
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
        await vi.waitFor(() => expect(document.querySelector('#rl-vs-lines')?.textContent).toContain('newer.com'));
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

    it('preserves complete YAML pasted into a single-list text editor', async () => {
        const original = 'rules: {$prepend: ["DOMAIN,old.com,DIRECT"]}\n';
        const draft = '__when__: {profile: Work}\ndns: {enable: false}\nrules: {$append: ["DOMAIN,draft.com,Proxy"]}\n';
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation((command, args) => command === 'rule_read' ? original : previous(command, args));
        const { initRuleLibraryPage } = await import('./rule-library.js');
        const { getEditorContent } = await import('./editor/prism-editor.js');
        await initRuleLibraryPage();
        document.querySelector('.rl-file-edit').click();
        await flush();
        document.querySelector('[data-rl-mode="text"]').click();
        getEditorContent.mockReturnValueOnce(draft);
        document.getElementById('rl-editor-save').click();
        await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('rule_update', expect.objectContaining({ content: draft, expectedContent: original })));
        await new Promise((resolve) => setTimeout(resolve, 350));
    });

    it.each([false, true])('keeps raw colon payloads attached to their source metadata (edited=%s)', async (edited) => {
        const original = '__when__: {profile: Work}\nrules:\n  $prepend:\n    - "PROCESS-NAME,a: b,Proxy"\n';
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation((command, args) => command === 'rule_read' ? original : previous(command, args));
        const { initRuleLibraryPage } = await import('./rule-library.js');
        const { getEditorContent } = await import('./editor/prism-editor.js');
        await initRuleLibraryPage();
        document.querySelector('.rl-file-edit').click();
        await flush();
        document.querySelector('[data-rl-mode="text"]').click();
        if (edited) getEditorContent.mockReturnValueOnce('PROCESS-NAME,c: d,Proxy');
        document.getElementById('rl-editor-save').click();
        await vi.waitFor(() => expect(invokeMock.mock.calls.some(([command]) => command === 'rule_update')).toBe(true));
        const written = invokeMock.mock.calls.find(([command]) => command === 'rule_update')[1].content;
        expect(yaml.load(written)).toEqual({ __when__: { profile: 'Work' }, rules: { $prepend: [`PROCESS-NAME,${edited ? 'c: d' : 'a: b'},Proxy`] } });
        if (!edited) expect(written).toBe(original);
        await new Promise((resolve) => setTimeout(resolve, 350));
    });

    it.each(['rules: true', 'rules: {$append: ['])('keeps raw text format after a rejected Visual transition: %s', async (invalid) => {
        const { initRuleLibraryPage } = await import('./rule-library.js');
        const { getEditorContent } = await import('./editor/prism-editor.js');
        await initRuleLibraryPage();
        document.querySelector('.rl-file-edit').click();
        await flush();
        document.querySelector('[data-rl-mode="text"]').click();
        getEditorContent.mockReturnValueOnce(invalid);
        document.querySelector('[data-rl-mode="visual"]').click();
        expect(document.getElementById('rl-editor-text').classList.contains('hidden')).toBe(false);
        getEditorContent.mockReturnValueOnce('DOMAIN,repaired.com,DIRECT');
        document.getElementById('rl-editor-save').click();
        await vi.waitFor(() => expect(invokeMock.mock.calls.some(([command]) => command === 'rule_update')).toBe(true));
        const written = invokeMock.mock.calls.find(([command]) => command === 'rule_update')[1].content;
        expect(yaml.load(written).rules.$append).toEqual(['DOMAIN,repaired.com,DIRECT']);
        await new Promise((resolve) => setTimeout(resolve, 350));
    });

    it.each(['\n', '\r\n'])('reopens the exact conflict draft against the latest file version (newline=%j)', async (newline) => {
        const original = 'rules: {$prepend: ["DOMAIN,old.com,DIRECT"]}\n';
        const draft = ['__when__: {profile: Work}', 'rules: {$prepend: ["DOMAIN,draft.com,DIRECT"]}', ''].join(newline);
        const latest = 'rules: {$prepend: ["DOMAIN,newer.com,DIRECT"]}\n';
        let file = original;
        let writes = 0;
        let secondWrite;
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation(async (command, args) => {
            if (command === 'rule_read') return file;
            if (command === 'rule_update') {
                if (++writes === 1) { file = latest; throw new Error('RULE_FILE_CHANGED: Reopen and retry.'); }
                secondWrite = args;
                return null;
            }
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
        await vi.waitFor(() => expect(document.querySelector('[data-conflict-edit-yaml]')).not.toBeNull());
        document.querySelector('[data-conflict-copy]').click();
        await vi.waitFor(() => expect(copyDraft).toHaveBeenCalledWith(draft));
        const editorCallsBeforeReopen = createEditor.mock.calls.length;
        document.querySelector('[data-conflict-edit-yaml]').click();
        // The replacement HTML is inserted before the modal's next-frame
        // onReady callback mounts CodeMirror; an enabled Save alone is too early.
        await vi.waitFor(() => {
            expect(createEditor.mock.calls.length).toBeGreaterThan(editorCallsBeforeReopen);
            expect(createEditor).toHaveBeenLastCalledWith(expect.objectContaining({ content: draft }));
        });
        expect(document.querySelector('[data-conflict-current]').value).toBe(latest);
        expect(document.getElementById('rl-editor-save').disabled).toBe(true);
        document.getElementById('rl-editor-save').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(writes).toBe(1);
        expect(document.querySelector('[data-rl-mode="visual"]').disabled).toBe(true);
        const confirmation = document.querySelector('[data-conflict-confirm]');
        confirmation.checked = true;
        confirmation.dispatchEvent(new Event('change'));
        document.getElementById('rl-editor-save').click();
        await vi.waitFor(() => expect(writes).toBe(2));
        expect(secondWrite).toMatchObject({ content: draft, expectedContent: latest });
        await new Promise((resolve) => setTimeout(resolve, 350));
    });

    it.each(['data-conflict-reopen', 'data-conflict-edit-yaml'])('keeps the rejected draft when recovery cannot read the current file: %s', async (action) => {
        const original = 'rules: {$prepend: ["DOMAIN,old.com,DIRECT"]}\n';
        const draft = '__when__: {profile: Work}\nrules: {$prepend: ["DOMAIN,draft.com,DIRECT"]}\n';
        let conflict = false;
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation(async (command, args) => {
            if (command === 'rule_read') {
                if (conflict) throw new Error('Current file is missing');
                return original;
            }
            if (command === 'rule_update') { conflict = true; throw new Error('RULE_FILE_CHANGED: Reopen and retry.'); }
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
        await vi.waitFor(() => expect(document.querySelector('[data-conflict-draft]')).not.toBeNull());
        const shownDraft = document.querySelector('[data-conflict-draft]');
        document.querySelector(`[${action}]`).click();
        await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringContaining('Current file is missing'), 'error'));
        expect(shownDraft.isConnected).toBe(true);
        expect(document.getElementById('modal-bg').classList.contains('hidden')).toBe(false);
        document.querySelector('[data-conflict-copy]').click();
        await vi.waitFor(() => expect(copyDraft).toHaveBeenCalledWith(draft));
    });

    it.each(['ai.prism.yaml', 'ai.yaml'])('rejects malformed non-rule text before updating %s', async (filename) => {
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation(async (command, args) => command === 'rule_list' ? [{ ...FILES[0], filename }] : previous(command, args));
        const { initRuleLibraryPage } = await import('./rule-library.js');
        const { getEditorContent } = await import('./editor/prism-editor.js');
        await initRuleLibraryPage();
        document.querySelector('.rl-file-edit').click();
        await flush();
        document.querySelector('[data-rl-mode="text"]').click();
        getEditorContent.mockReturnValueOnce('rules: {$append: [');
        document.getElementById('rl-editor-save').click();
        await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(expect.any(String), 'error'));
        expect(invokeMock.mock.calls.some(([command]) => command === 'rule_update')).toBe(false);
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

    it('captures the visual draft and locks mode changes while its save waits in the queue', async () => {
        const { queueRuleWrite } = await import('./rule-library/write-queue.js');
        let release;
        const held = queueRuleWrite(() => new Promise((resolve) => { release = resolve; }));
        const original = 'rules:\n  $append:\n    - "DOMAIN,a.com,DIRECT  "\n';
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation((command, args) => command === 'rule_read' ? original : previous(command, args));
        try {
            const { initRuleLibraryPage } = await import('./rule-library.js');
            await initRuleLibraryPage();
            document.querySelector('.rl-file-edit').click();
            await flush();
            document.getElementById('rl-editor-save').click();
            const tabs = [...document.querySelectorAll('.rl-editor-mode')];
            expect(tabs.every((tab) => tab.disabled)).toBe(true);
            document.querySelector('[data-rl-mode="text"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
            expect(document.getElementById('rl-editor-text').classList.contains('hidden')).toBe(true);
            release();
            await held;
            await queueRuleWrite(async () => {});
            const written = invokeMock.mock.calls.find(([command]) => command === 'rule_update')[1];
            expect(written.expectedContent).toBe(original);
            expect(yaml.load(written.content).rules.$append).toEqual(['DOMAIN,a.com,DIRECT  ']);
            await new Promise((resolve) => setTimeout(resolve, 350));
        } finally { release?.(); await held; }
    });

    it('preserves retained row whitespace across text and visual mode changes', async () => {
        const original = 'rules:\n  $append:\n    - "DOMAIN,a.com,DIRECT  "\n';
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation((command, args) => command === 'rule_read' ? original : previous(command, args));
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        document.querySelector('.rl-file-edit').click();
        await vi.waitFor(() => expect(document.querySelector('#rl-vs-lines')?.textContent).toContain('a.com'));
        document.querySelector('[data-rl-mode="text"]').click();
        document.querySelector('[data-rl-mode="visual"]').click();
        document.getElementById('rl-editor-save').click();
        await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('rule_update', expect.objectContaining({
            expectedContent: original,
        })));
        const written = invokeMock.mock.calls.find(([command]) => command === 'rule_update')[1];
        expect(yaml.load(written.content).rules.$append).toEqual(['DOMAIN,a.com,DIRECT  ']);
        await vi.waitFor(() => expect(document.getElementById('modal-bg').classList.contains('hidden')).toBe(true));
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

    it.each([false, true])('keeps impact viewing read-only with cached trace=%s', async (cached) => {
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation((command, args) => command === 'rule_list'
            ? [{ ...FILES[0], read_only: true }] : previous(command, args));
        prismMock.getLastTrace.mockResolvedValueOnce(cached ? [{ source_file: FILES[0].filename, patch_id: 'patch-ai' }] : []);
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        document.querySelector('.rl-file-more').click();
        document.querySelector('.ctx-menu-root button').click();
        await flush();
        expect(prismMock.apply).not.toHaveBeenCalled();
        expect(prismMock.rebuildWithOverrides).not.toHaveBeenCalled();
        if (cached) expect(prismMock.previewRules).toHaveBeenCalledExactlyOnceWith('patch-ai');
        else {
            expect(prismMock.previewRules).not.toHaveBeenCalled();
            expect(notify).toHaveBeenCalledWith(expect.any(String), 'warning');
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

    it.each([['', true], [' ', true], ['\t', true], ['', false]])('wraps a raw rule file with YAML-significant values (space=%j, multiple=%s)', async (space, multiple) => {
        const processRule = `PROCESS-NAME,${space}a: b,Proxy`;
        const rows = multiple ? ['DOMAIN,a.com,DIRECT', processRule] : [processRule];
        const content = rows.join('\n') + '\n';
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
        expect(yaml.load(written.content)).toEqual({ rules: { $append: rows } });
        const { countRulesInYaml } = await import('./rule-library/yaml-utils.js');
        expect(countRulesInYaml(written.content)).toBe(rows.length);
        await new Promise((resolve) => setTimeout(resolve, 350));
    });

    it('preserves an untouched CRLF document with the real CodeMirror editor', async () => {
        const original = '# original\r\nrules:\r\n  $prepend: ["DOMAIN,a.com,DIRECT"]\r\n  $append: ["MATCH,Proxy"]\r\n';
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation((command, args) => command === 'rule_read' ? original : previous(command, args));
        const mockedEditor = await import('./editor/prism-editor.js');
        const actualEditor = await vi.importActual('./editor/prism-editor.js');
        const oldCreate = mockedEditor.createEditor.getMockImplementation();
        const oldRead = mockedEditor.getEditorContent.getMockImplementation();
        mockedEditor.createEditor.mockImplementation(actualEditor.createEditor);
        mockedEditor.getEditorContent.mockImplementation(actualEditor.getEditorContent);
        try {
            const { initRuleLibraryPage } = await import('./rule-library.js');
            await initRuleLibraryPage();
            document.querySelector('.rl-file-edit').click();
            await flush();
            document.querySelector('[data-rl-mode="text"]').click();
            const view = mockedEditor.createEditor.mock.results.at(-1).value;
            expect(actualEditor.getEditorContent(view)).toBe(original.replaceAll('\r\n', '\n'));
            expect(document.getElementById('rl-editor-dirty').classList.contains('hidden')).toBe(true);
            document.querySelector('[data-rl-mode="visual"]').click();
            document.querySelector('[data-rl-mode="text"]').click();
            expect(document.getElementById('rl-editor-dirty').classList.contains('hidden')).toBe(true);
            document.getElementById('rl-editor-save').click();
            await flush();
            expect(invokeMock).toHaveBeenCalledWith('rule_update', expect.objectContaining({ content: original, expectedContent: original }));
            await new Promise((resolve) => setTimeout(resolve, 350));
        } finally {
            document.getElementById('rl-editor-cancel')?.click();
            mockedEditor.createEditor.mockImplementation(oldCreate);
            mockedEditor.getEditorContent.mockImplementation(oldRead);
        }
    });

    it.each(['2025-01-01', 'rules: 2025-01-01', 'rules: !!binary SGVsbG8='])('refuses scalar YAML objects before writing: %s', async (invalid) => {
        const original = 'rules: {$prepend: ["DOMAIN,a.com,DIRECT"], $append: []}\n';
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation((command, args) => command === 'rule_read' ? original : previous(command, args));
        const { createEditor } = await import('./editor/prism-editor.js');
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        document.querySelector('.rl-file-edit').click();
        await flush();
        document.querySelector('[data-rl-mode="text"]').click();
        createEditor.mock.results.at(-1).value.content = invalid;
        document.getElementById('rl-editor-save').click();
        await flush();
        expect(invokeMock.mock.calls.some(([command]) => command === 'rule_update')).toBe(false);
        expect(notify).toHaveBeenCalledWith(expect.any(String), 'error');
        document.getElementById('rl-editor-cancel').click();
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

    it('keeps direct insertion disabled with a saved-source recovery path when the compiled output is stale', async () => {
        prismMock.requireRuleInsertion.mockRejectedValueOnce(new Error('The compiled insertion cache is stale'));
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        document.querySelector('[data-rl-tab="active-rules"]').click();
        await flush();
        expect(document.getElementById('rl-btn-insert-rule').disabled).toBe(true);
        expect(document.querySelector('[data-insert-unavailable]').classList.contains('hidden')).toBe(false);
        expect(document.querySelector('[data-insert-unavailable]').textContent).toContain('saved rule file');
        expect(prismMock.insertRuleStr).not.toHaveBeenCalled();
    });

    it('rechecks insertion on a reused active list and ignores superseded replies', async () => {
        let finishOld;
        let rejectCurrent;
        const oldRequest = new Promise((resolve) => { finishOld = resolve; });
        prismMock.requireRuleInsertion.mockImplementationOnce(() => oldRequest)
            .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCurrent = reject; }))
            .mockResolvedValueOnce(undefined);
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        document.querySelector('[data-rl-tab="active-rules"]').click();
        await vi.waitFor(() => expect(document.querySelector('#arl-vs-lines [aria-expanded]')).not.toBeNull());
        const button = document.getElementById('rl-btn-insert-rule');
        document.querySelector('#arl-vs-lines [aria-expanded]').click();
        expect(document.getElementById('rl-btn-insert-rule')).toBe(button);
        rejectCurrent(new Error('Compiled output changed'));
        await vi.waitFor(() => expect(document.querySelector('[data-insert-unavailable]').classList.contains('hidden')).toBe(false));
        finishOld();
        await oldRequest;
        expect(button.disabled).toBe(true);
        expect(button.title).toContain('saved rule file');
        document.querySelector('#arl-vs-lines [aria-expanded]').click();
        await vi.waitFor(() => expect(button.disabled).toBe(false));
        expect(button.title).toBe('');
        expect(document.querySelector('[data-insert-unavailable]').classList.contains('hidden')).toBe(true);
    });

    it('rechecks insertion availability before sending a dialog draft', async () => {
        prismMock.requireRuleInsertion.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Stale after overrides'));
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        document.querySelector('[data-rl-tab="active-rules"]').click();
        await flush();
        document.getElementById('rl-btn-insert-rule').click();
        await flush();
        await frames();
        document.getElementById('rl-insert-value').value = 'example.com';
        document.getElementById('rl-insert-confirm').click();
        await vi.waitFor(() => expect(document.getElementById('rl-insert-error').textContent).toContain('saved rule file'));
        expect(prismMock.insertRuleStr).not.toHaveBeenCalled();
        expect(prismMock.apply).not.toHaveBeenCalled();
        document.getElementById('rl-insert-cancel').click();
        await new Promise((resolve) => setTimeout(resolve, 350));
    });

    it.each(['button', 'escape'])('does not insert after cancellation during validation: %s', async (cancel) => {
        let finish;
        prismMock.requireRuleInsertion.mockResolvedValueOnce(undefined)
            .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        document.querySelector('[data-rl-tab="active-rules"]').click();
        await vi.waitFor(() => expect(document.getElementById('rl-btn-insert-rule')?.disabled).toBe(false));
        document.getElementById('rl-btn-insert-rule').click();
        await vi.waitFor(() => expect(document.getElementById('rl-insert-value')).not.toBeNull());
        document.getElementById('rl-insert-value').value = 'example.com';
        document.getElementById('rl-insert-confirm').click();
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        if (cancel === 'button') document.getElementById('rl-insert-cancel').click();
        else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        finish();
        await vi.waitFor(() => expect(document.getElementById('modal-bg').classList.contains('hidden')).toBe(true));
        expect(prismMock.insertRuleStr).not.toHaveBeenCalled();
        expect(prismMock.insertRule).not.toHaveBeenCalled();
        expect(prismMock.apply).not.toHaveBeenCalled();
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
