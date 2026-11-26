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
    afterEach(() => vi.unstubAllGlobals());
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

    it('opens structured rules as YAML and disables the lossy visual editor', async () => {
        vi.stubGlobal('jsyaml', yaml);
        const content = yaml.dump({ rules: { $prepend: [{ type: 'DOMAIN', payload: 'a.com', proxy: 'DIRECT' }] } });
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

    it('preserves a conflicting draft until the user chooses to reopen the current file', async () => {
        vi.stubGlobal('jsyaml', yaml);
        const latest = 'rules:\n  $append:\n    - DOMAIN,newer.com,DIRECT\n';
        const fixture = 'rules:\n  $prepend:\n    - DOMAIN-SUFFIX,openai.com,OpenAI\n  $append:\n    - DOMAIN-SUFFIX,anthropic.com,OpenAI\n';
        let file = fixture;
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation(async (command, args) => {
            if (command === 'rule_read') return file;
            if (command === 'rule_update') {
                expect(args.expectedContent).toBe(fixture);
                expect(args.content).toBe(fixture);
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
        getEditorContent.mockReturnValueOnce(fixture).mockReturnValueOnce(fixture);
        document.querySelector('[data-rl-mode="text"]').click();
        document.getElementById('rl-editor-save').click();
        await vi.waitFor(() => expect(document.querySelector('[data-conflict-draft]')).not.toBeNull());
        expect(document.querySelector('[data-conflict-draft]').value).toBe(fixture);
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

    it('does not destroy a newer text editor when a closed editor finishes saving', async () => {
        const { queueRuleWrite } = await import('./rule-library/write-queue.js');
        const { createEditor, getEditorContent } = await import('./editor/prism-editor.js');
        const destroy = vi.fn();
        createEditor.mockImplementationOnce(({ content }) => ({ content, destroy }));
        getEditorContent.mockImplementationOnce((view) => view.content);
        let release;
        const previous = invokeMock.getMockImplementation();
        invokeMock.mockImplementation((command, args) => command === 'rule_update'
            ? new Promise((resolve) => { release = resolve; }) : previous(command, args));
        const { initRuleLibraryPage } = await import('./rule-library.js');
        await initRuleLibraryPage();
        try {
            document.querySelector('.rl-file-edit').click();
            await flush();
            document.getElementById('rl-editor-save').click();
            await vi.waitFor(() => expect(release).toBeTypeOf('function'));
            document.getElementById('rl-editor-cancel').click();
            await new Promise((resolve) => setTimeout(resolve, 350));
            document.querySelector('.rl-file-edit').click();
            await flush();
            document.querySelector('[data-rl-mode="text"]').click();
            release();
            // A queued sentinel settles only after the actual save and apply.
            await queueRuleWrite(async () => {});
            expect(destroy).not.toHaveBeenCalled();
            expect(document.getElementById('rl-editor-text').classList.contains('hidden')).toBe(false);
        } finally {
            release?.();
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
