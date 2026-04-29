// @ts-check
/**
 * Prism DSL syntax highlighting for CodeMirror 6.
 * Adds keyword coloring for Prism-specific tokens on top of YAML.
 *
 * @module ui/editor/prism-highlight
 */

import { ViewPlugin, Decoration } from '../../cm6.bundle.js';

// ─── Keyword Sets ──────────────────────────────────────────────────

/** Prism DSL keywords — only match at word boundaries */
const PRISM_KEYWORDS = new Set([
    '__when__', '__after__', '__rule__',
    '$filter', '$prepend', '$append', '$transform', '$remove',
    '$override', '$default',
]);

// ─── Build Decorations ─────────────────────────────────────────────

/**
 * Scan visible ranges for Prism DSL tokens and build a DecorationSet.
 * Uses Decoration.set() for correctness instead of RangeSetBuilder.
 *
 * @param {import('../../cm6.bundle.js').EditorView} view
 * @returns {import('../../cm6.bundle.js').DecorationSet}
 */
function buildDecorations(view) {
    /** @type {import('../../cm6.bundle.js').Range<import('../../cm6.bundle.js').Decoration>[]} */
    const decoRanges = [];
    // Only match Prism-specific tokens (double-underscore or dollar-prefixed)
    const regex = /(__\w+__|\$\w+)/g;

    for (const { from, to } of view.visibleRanges) {
        const text = view.state.doc.sliceString(from, to);
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(text)) !== null) {
            const word = match[0];
            if (PRISM_KEYWORDS.has(word)) {
                const start = from + match.index;
                const end = start + word.length;
                decoRanges.push(
                    Decoration.mark({ class: 'cm-prism-keyword' }).range(start, end),
                );
            }
        }
    }

    return Decoration.set(decoRanges, true);
}

// ─── ViewPlugin ────────────────────────────────────────────────────

/**
 * ViewPlugin that scans lines for Prism DSL tokens and applies decorations.
 * Rebuilds decorations on document or viewport changes.
 */
const prismHighlightPlugin = ViewPlugin.fromClass(class {
    /** @type {import('../../cm6.bundle.js').DecorationSet} */
    decorations;

    /**
     * @param {import('../../cm6.bundle.js').EditorView} view
     */
    constructor(view) {
        this.decorations = buildDecorations(view);
    }

    /**
     * @param {import('../../cm6.bundle.js').ViewUpdate} update
     */
    update(update) {
        if (update.docChanged || update.viewportChanged) {
            this.decorations = buildDecorations(update.view);
        }
    }
}, {
    decorations: (v) => v.decorations,
});

export { prismHighlightPlugin };
