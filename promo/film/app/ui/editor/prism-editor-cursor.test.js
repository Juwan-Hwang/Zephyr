import { describe, it, expect } from 'vitest';
import { createEditor } from './prism-editor.js';

describe('createEditor onCursor', () => {
    it('reports line, column and length on open and on every move', () => {
        const parent = document.createElement('div');
        document.body.appendChild(parent);
        /** @type {{ line: number, col: number, length: number }[]} */
        const seen = [];
        const view = createEditor({ parent, content: 'ab\ncdef', language: 'javascript', onCursor: (p) => seen.push(p) });
        expect(seen[0]).toEqual({ line: 1, col: 1, length: 7 });
        view.dispatch({ selection: { anchor: 6 } });
        expect(seen.at(-1)).toEqual({ line: 2, col: 4, length: 7 });
        view.dispatch({ changes: { from: 7, insert: 'g' }, selection: { anchor: 8 } });
        expect(seen.at(-1)).toEqual({ line: 2, col: 6, length: 8 });
        view.destroy();
    });
});
