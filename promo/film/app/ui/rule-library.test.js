// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    toggleGroup: vi.fn(async () => true),
    traceReportText: vi.fn(async () => 'trace body'),
};
vi.mock('./prism.js', () => prismMock);
vi.mock('./proxy-groups.js', () => ({ fetchProxyGroups: vi.fn(async () => ({ orderedGroupNames: ['OpenAI', 'Proxy'] })) }));
vi.mock('./editor/prism-editor.js', () => ({ createEditor: vi.fn(() => ({ destroy() {} })), getEditorContent: vi.fn(() => '') }));

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
    beforeEach(() => {
        vi.resetModules();
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
        expect(prismMock.rebuild).toHaveBeenCalled();
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
