// CodeMirror 6 bundled entry point.
// Rebuild: pnpm run build:cm6
// This file is the source for src/cm6.bundle.js — do not import directly.
// After rebuilding, commit the updated bundle to the repository.

export { EditorState, RangeSetBuilder, StateField, StateEffect } from '@codemirror/state';
export { EditorView, keymap, Decoration, ViewPlugin, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
export { yaml } from '@codemirror/lang-yaml';
export { javascript } from '@codemirror/lang-javascript';
export { autocompletion } from '@codemirror/autocomplete';
export { indentWithTab } from '@codemirror/commands';
export { syntaxHighlighting, defaultHighlightStyle, foldGutter, indentOnInput, bracketMatching } from '@codemirror/language';
