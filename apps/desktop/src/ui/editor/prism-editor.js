// @ts-check
/**
 * CodeMirror 6 editor factory with Prism DSL support.
 * Creates pre-configured editor instances for YAML/JS editing.
 *
 * @module ui/editor/prism-editor
 */

import {
    EditorState,
    EditorView,
    keymap,
    lineNumbers,
    highlightActiveLine,
    highlightActiveLineGutter,
    yaml,
    javascript,
    autocompletion,
    indentWithTab,
    syntaxHighlighting,
    defaultHighlightStyle,
    foldGutter,
    indentOnInput,
    bracketMatching,
} from '../../cm6.bundle.js';
import { prismHighlightPlugin } from './prism-highlight.js';
import { prismCompletion } from './prism-completion.js';

/** @typedef {import('@codemirror/state').Extension} Extension */

// ─── Theme ─────────────────────────────────────────────────────────

/**
 * Zephyr dark/light theme for CodeMirror.
 * Uses CSS custom properties for seamless integration with the app theme.
 *
 * @returns {Extension}
 */
function zephyrTheme() {
    return EditorView.theme({
        '&': {
            fontSize: '0.75rem',
            backgroundColor: 'transparent',
            color: 'var(--text-primary, #e4e4e7)',
            height: '100%',
        },
        '.cm-content': {
            fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', 'DejaVu Sans Mono', 'Ubuntu Mono', monospace",
            padding: '0.75rem 0',
            caretColor: 'var(--accent-primary, #6366f1)',
        },
        '.cm-cursor': {
            borderLeftColor: 'var(--accent-primary, #6366f1)',
        },
        '.cm-activeLine': {
            backgroundColor: 'rgba(255, 255, 255, 0.03)',
        },
        '.cm-activeLineGutter': {
            backgroundColor: 'rgba(255, 255, 255, 0.03)',
        },
        '.cm-selectionBackground': {
            backgroundColor: 'var(--accent-primary, #6366f1) !important',
            opacity: '0.2',
        },
        '.cm-gutters': {
            backgroundColor: 'transparent',
            color: 'var(--text-muted, #52525b)',
            border: 'none',
            paddingRight: '0.5rem',
        },
        '.cm-lineNumbers .cm-gutterElement': {
            fontSize: '0.625rem',
            minWidth: '2rem',
        },
        '.cm-foldGutter': {
            width: '1rem',
        },

        // Prism DSL keyword colors
        '.cm-prism-keyword': {
            color: 'var(--accent-primary, #6366f1)',
            fontWeight: '600',
        },
        '.cm-prism-meta': {
            color: 'var(--text-secondary, #a1a1aa)',
        },

        // Autocomplete styling
        '.cm-tooltip': {
            backgroundColor: 'rgba(0, 0, 0, 0.85)',
            backdropFilter: 'blur(16px)',
            border: '1px solid var(--border-primary, rgba(255,255,255,0.1))',
            borderRadius: '0.75rem',
            boxShadow: '0 12px 32px -8px rgba(0, 0, 0, 0.5)',
            padding: '0.25rem',
        },
        '.cm-tooltip-autocomplete > ul > li': {
            padding: '0.375rem 0.75rem',
            borderRadius: '0.5rem',
            fontSize: '0.75rem',
        },
        '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
            backgroundColor: 'var(--accent-primary, #6366f1)',
            color: '#fff',
        },
        '.cm-completionLabel': {
            fontFamily: "'SF Mono', 'Fira Code', 'DejaVu Sans Mono', monospace",
            fontSize: '0.75rem',
        },
        '.cm-completionDetail': {
            fontStyle: 'italic',
            color: 'var(--text-muted, #71717a)',
            marginLeft: '0.5rem',
        },

        // Scrollbar
        '.cm-scroller': {
            overflow: 'auto',
        },
    }, { dark: true });
}

// ─── Types ─────────────────────────────────────────────────────────

/** @typedef {'yaml' | 'javascript'} EditorLanguage */

/**
 * Options for creating a CodeMirror editor instance.
 *
 * @typedef {Object} CreateEditorOptions
 * @property {HTMLElement} parent - Parent DOM element to mount the editor into
 * @property {string} content - Initial document content
 * @property {EditorLanguage} language - Language mode
 * @property {boolean} [prismDsl=false] - Enable Prism DSL extensions (highlighting + completion)
 * @property {boolean} [readOnly=false] - Whether the editor is read-only
 * @property {(content: string) => void} [onChange] - Callback when content changes
 * @property {number} [lineHeight] - Line height in pixels
 */

// ─── Editor Factory ────────────────────────────────────────────────

/**
 * Create a CodeMirror editor instance.
 * Returns the EditorView — call `view.destroy()` to clean up.
 *
 * @param {CreateEditorOptions} options
 * @returns {EditorView}
 */
export function createEditor(options) {
    const {
        parent,
        content,
        language,
        prismDsl = false,
        readOnly = false,
        onChange,
        lineHeight,
    } = options;

    /** @type {Extension[]} */
    const extensions = [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        foldGutter(),
        indentOnInput(),
        bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([indentWithTab]),
        zephyrTheme(),
        EditorState.readOnly.of(readOnly),
    ];

    // Language support
    if (language === 'yaml') {
        extensions.push(yaml());
    } else if (language === 'javascript') {
        extensions.push(javascript());
    }

    // Prism DSL extensions (only for YAML)
    if (prismDsl && language === 'yaml') {
        extensions.push(prismHighlightPlugin);
        extensions.push(autocompletion({
            override: [prismCompletion],
            activateOnTyping: true,
            maxRenderedOptions: 30,
        }));
    } else if (language === 'javascript') {
        // Basic JS autocompletion
        extensions.push(autocompletion());
    }

    // onChange callback
    if (onChange) {
        extensions.push(EditorView.updateListener.of((/** @type {import('../../cm6.bundle.js').ViewUpdate} */ update) => {
            if (update.docChanged) {
                onChange(update.state.doc.toString());
            }
        }));
    }

    // Custom line height
    if (lineHeight) {
        extensions.push(EditorView.theme({
            '.cm-line': { height: `${lineHeight}px`, lineHeight: `${lineHeight}px` },
        }));
    }

    const state = EditorState.create({
        doc: content,
        extensions,
    });

    const view = new EditorView({
        state,
        parent,
    });

    return view;
}

/**
 * Get the current content of an editor instance.
 *
 * @param {EditorView} view
 * @returns {string}
 */
export function getEditorContent(view) {
    return view.state.doc.toString();
}

/**
 * Replace the entire content of an editor instance.
 *
 * @param {EditorView} view
 * @param {string} content
 */
export function setEditorContent(view, content) {
    view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
    });
}
