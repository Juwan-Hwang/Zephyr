// @ts-check
/**
 * Plugin management module — manages the plugin panel overlay on the
 * subscriptions page. Handles plugin discovery, enable/disable, unload,
 * delete, and script editing / execution / validation.
 *
 * @module ui/plugins
 */

import {
    pluginDiscover,
    pluginUnload,
    pluginEnable,
    pluginDelete,
    scriptExecute,
    scriptValidate,
} from './prism.js';
import { t } from '../i18n.js';
import { showNotification } from './notifications.js';
import { createEditor, getEditorContent } from './editor/prism-editor.js';

// ═══════════════════════════════════════════════════════════════════════
//  Internal state
// ═══════════════════════════════════════════════════════════════════════

/** Currently active plugin name (used as script context). */
let activePluginName = '';

/** CodeMirror EditorView for the plugin script editor (null when not active). */
let scriptEditorView = null;

// ═══════════════════════════════════════════════════════════════════════
//  Public entry point
// ═══════════════════════════════════════════════════════════════════════

export function initPlugins() {
    // ── DOM references ──────────────────────────────────────────────
    const openBtn = document.getElementById('open-plugins-btn');
    const closeBtn = document.getElementById('close-plugins-btn');
    const panel = document.getElementById('plugin-panel');
    const backdrop = document.getElementById('plugin-panel-backdrop');
    const pluginList = document.getElementById('plugin-list');
    const scriptArea = document.getElementById('plugin-script-area');
    const scriptEditor = document.getElementById('plugin-script-editor');
    const scriptCm6 = document.getElementById('plugin-script-cm6');
    const scriptOutput = document.getElementById('plugin-script-output');
    const scriptTitle = document.getElementById('plugin-script-title');
    const scriptRunBtn = document.getElementById('plugin-script-run-btn');
    const scriptValidateBtn = document.getElementById('plugin-script-validate-btn');
    const scriptStatus = document.getElementById('plugin-script-status');
    const scriptBackBtn = document.getElementById('plugin-script-back-btn');

    if (!panel) return;

    // ── Panel open / close ──────────────────────────────────────────
    openBtn?.addEventListener('click', () => {
        panel.classList.remove('hidden');
        loadPlugins();
    });

    const closePanel = () => panel.classList.add('hidden');

    closeBtn?.addEventListener('click', closePanel);
    backdrop?.addEventListener('click', closePanel);

    // ── Script area back button ─────────────────────────────────────
    scriptBackBtn?.addEventListener('click', () => {
        pluginList?.classList.remove('hidden');
        scriptArea?.classList.add('hidden');
        // Destroy CM6 editor when leaving script area
        if (scriptEditorView) { scriptEditorView.destroy(); scriptEditorView = null; }
    });

    // ── Script validate ─────────────────────────────────────────────
    scriptValidateBtn?.addEventListener('click', async () => {
        if (!scriptStatus) return;
        const source = (scriptEditorView ? getEditorContent(scriptEditorView) : (scriptEditor?.value ?? '')).trim();
        if (!source) return;

        scriptStatus.textContent = t('pluginValidating');
        scriptStatus.className = 'text-xs text-zinc-400';

        try {
            const safe = await scriptValidate(source);
            if (safe) {
                scriptStatus.textContent = t('pluginScriptSafe');
                scriptStatus.className = 'text-xs text-emerald-400';
            } else {
                scriptStatus.textContent = t('pluginScriptUnsafe');
                scriptStatus.className = 'text-xs text-rose-400';
            }
        } catch (err) {
            scriptStatus.textContent = (err instanceof Error ? err.message : String(err));
            scriptStatus.className = 'text-xs text-rose-400';
        }
    });

    // ── Script run ──────────────────────────────────────────────────
    scriptRunBtn?.addEventListener('click', async () => {
        if (!scriptOutput) return;
        const source = (scriptEditorView ? getEditorContent(scriptEditorView) : (scriptEditor?.value ?? '')).trim();
        if (!source) return;

        scriptOutput.textContent = '';
        scriptOutput.className = 'text-xs text-zinc-400 font-mono whitespace-pre-wrap break-all';

        try {
            const result = await scriptExecute(source, activePluginName || 'plugin');

            // Build output lines
            const lines = [];

            if (result.logs?.length) {
                lines.push('── logs ──────────────────────');
                for (const log of result.logs) {
                    lines.push(typeof log === 'string' ? log : JSON.stringify(log));
                }
                lines.push('');
            }

            if (result.patches?.length) {
                lines.push('── patches ───────────────────');
                for (const patch of result.patches) {
                    lines.push(typeof patch === 'string' ? patch : JSON.stringify(patch));
                }
                lines.push('');
            }

            lines.push(`── result ───────────────────`);
            lines.push(`success : ${result.success}`);
            lines.push(`duration: ${result.duration_us ?? '?'} us`);
            if (result.error) {
                lines.push(`error   : ${result.error}`);
            }

            scriptOutput.textContent = lines.join('\n');
            scriptOutput.className = result.success
                ? 'text-xs text-emerald-400 font-mono whitespace-pre-wrap break-all'
                : 'text-xs text-rose-400 font-mono whitespace-pre-wrap break-all';
        } catch (err) {
            scriptOutput.textContent = err instanceof Error ? err.message : String(err);
            scriptOutput.className = 'text-xs text-rose-400 font-mono whitespace-pre-wrap break-all';
        }
    });

    // ═══════════════════════════════════════════════════════════════
    //  loadPlugins — discover & render plugin list
    // ═══════════════════════════════════════════════════════════════

    async function loadPlugins() {
        if (!pluginList) return;

        pluginList.innerHTML = '';

        let plugins = [];
        try {
            plugins = (await pluginDiscover()) ?? [];
        } catch {
            // Empty list on failure
        }

        if (plugins.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'text-center text-zinc-500 text-sm py-12';
            empty.dataset.i18n = 'pluginNoPlugins';
            empty.textContent = t('pluginNoPlugins');
            pluginList.appendChild(empty);
            return;
        }

        for (const plugin of plugins) {
            const id = plugin.id ?? plugin.name ?? '';
            const name = plugin.name ?? id;
            const version = plugin.version ?? '';
            const type = plugin.type ?? 'script';
            const enabled = plugin.enabled ?? false;

            const row = document.createElement('div');
            row.className = 'flex items-center justify-between gap-3 p-3 rounded-xl hover:bg-white/5 transition-colors';

            // ── Left: toggle ────────────────────────────────────
            const toggleWrap = document.createElement('label');
            toggleWrap.className = 'ios-switch switch-sm shrink-0';

            const toggleInput = document.createElement('input');
            toggleInput.type = 'checkbox';
            toggleInput.checked = enabled;
            toggleInput.addEventListener('change', async () => {
                try {
                    await pluginEnable(id, toggleInput.checked);
                } catch (err) {
                    toggleInput.checked = !toggleInput.checked;
                    showNotification(String(err), 'error');
                }
            });

            const toggleSlider = document.createElement('span');
            toggleSlider.className = 'switch-slider';

            toggleWrap.appendChild(toggleInput);
            toggleWrap.appendChild(toggleSlider);

            // ── Center: name + version + type badge ─────────────
            const info = document.createElement('div');
            info.className = 'flex flex-col gap-0.5 min-w-0';

            const nameEl = document.createElement('span');
            nameEl.className = 'text-sm text-zinc-200 truncate';
            nameEl.textContent = version ? `${name}  ${version}` : name;

            const badge = document.createElement('span');
            badge.className = 'type-badge text-2xs';
            badge.textContent = type;

            info.appendChild(nameEl);
            info.appendChild(badge);

            // ── Right: action buttons ───────────────────────────
            const actions = document.createElement('div');
            actions.className = 'flex items-center gap-1 shrink-0';

            // Edit script button
            const editBtn = document.createElement('button');
            editBtn.className = 'btn-ghost text-xs px-2 py-1 rounded-lg';
            editBtn.dataset.i18n = 'pluginEditScript';
            editBtn.textContent = t('pluginEditScript');
            editBtn.addEventListener('click', () => {
                activePluginName = name;
                if (scriptTitle) scriptTitle.textContent = name;
                const initialContent = `// ${t('pluginScriptPlaceholder')}\n// ${name} (${type})\n`;
                if (scriptEditor) {
                    scriptEditor.value = initialContent;
                }
                if (scriptOutput) scriptOutput.textContent = '';
                if (scriptStatus) {
                    scriptStatus.textContent = '';
                    scriptStatus.className = 'text-xs text-zinc-400';
                }
                pluginList?.classList.add('hidden');
                scriptArea?.classList.remove('hidden');
                // Create CM6 editor for JavaScript
                if (scriptEditorView) { scriptEditorView.destroy(); scriptEditorView = null; }
                if (scriptCm6) {
                    scriptCm6.innerHTML = '';
                    scriptEditorView = createEditor({
                        parent: scriptCm6,
                        content: initialContent,
                        language: 'javascript',
                        prismDsl: false,
                    });
                }
            });

            // Unload button
            const unloadBtn = document.createElement('button');
            unloadBtn.className = 'btn-ghost text-xs px-2 py-1 rounded-lg text-rose-400 hover:text-rose-300';
            unloadBtn.dataset.i18n = 'pluginUnload';
            unloadBtn.textContent = t('pluginUnload');
            unloadBtn.addEventListener('click', () => {
                showUnloadConfirm(id, name, loadPlugins);
            });

            actions.appendChild(editBtn);
            actions.appendChild(unloadBtn);

            // ── Assemble row ────────────────────────────────────
            row.appendChild(toggleWrap);
            row.appendChild(info);
            row.appendChild(actions);
            pluginList.appendChild(row);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  Custom confirm dialog for plugin unload / delete
// ═══════════════════════════════════════════════════════════════════════

/**
 * Show an inline confirm dialog for unloading (and optionally deleting) a plugin.
 * Uses glass-card styling consistent with the rest of the UI — no window.confirm().
 *
 * @param {string} pluginId
 * @param {string} pluginName
 * @param {() => Promise<void>} onDone — callback after unload completes
 */
function showUnloadConfirm(pluginId, pluginName, onDone) {
    // Remove any existing confirm dialog
    const existing = document.getElementById('plugin-unload-confirm');
    existing?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'plugin-unload-confirm';
    overlay.className = 'fixed inset-0 z-[9999] flex items-center justify-center';
    overlay.style.background = 'rgba(0,0,0,0.5)';

    const card = document.createElement('div');
    card.className = 'glass-card p-6 flex flex-col gap-4 min-w-[320px] max-w-[420px] shadow-2xl';

    // Title
    const title = document.createElement('div');
    title.className = 'text-sm font-semibold text-zinc-200';
    title.textContent = t('pluginUnloadConfirmTitle');

    // Message
    const msg = document.createElement('div');
    msg.className = 'text-xs text-zinc-400';
    msg.textContent = t('pluginUnloadConfirmMsg');

    // Checkbox — also delete files
    const checkboxWrap = document.createElement('label');
    checkboxWrap.className = 'flex items-center gap-2 cursor-pointer select-none';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'accent-rose-500 w-3.5 h-3.5';

    const checkboxLabel = document.createElement('span');
    checkboxLabel.className = 'text-xs text-zinc-400';
    checkboxLabel.textContent = t('pluginDeleteFiles');

    checkboxWrap.appendChild(checkbox);
    checkboxWrap.appendChild(checkboxLabel);

    // Buttons row
    const btnRow = document.createElement('div');
    btnRow.className = 'flex items-center justify-end gap-2';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-ghost text-xs px-4 py-1.5 rounded-lg';
    cancelBtn.dataset.i18n = 'cancel';
    cancelBtn.textContent = t('cancel');
    cancelBtn.addEventListener('click', () => overlay.remove());

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn-accent text-xs px-4 py-1.5 rounded-lg';
    confirmBtn.dataset.i18n = 'confirm';
    confirmBtn.textContent = t('confirm');
    confirmBtn.addEventListener('click', async () => {
        confirmBtn.disabled = true;
        cancelBtn.disabled = true;
        confirmBtn.textContent = '...';

        try {
            await pluginUnload(pluginId);
            if (checkbox.checked) {
                await pluginDelete(pluginId);
            }
        } catch (err) {
            showNotification(String(err), 'error');
        }

        overlay.remove();
        onDone();
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(confirmBtn);

    // Assemble card
    card.appendChild(title);
    card.appendChild(msg);
    card.appendChild(checkboxWrap);
    card.appendChild(btnRow);
    overlay.appendChild(card);

    // Close on backdrop click
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);

    // Focus the confirm button for keyboard accessibility
    confirmBtn.focus();
}
