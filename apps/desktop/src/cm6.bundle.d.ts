// Type declarations for cm6.bundle.js (bundled CodeMirror 6)
// This overrides the minified module's type information.

// ── Extension (must be structurally compatible with @codemirror/state) ──
export type Extension = { extension: Extension } | readonly Extension[];

// ── Transaction ───────────────────────────────────────────────────
export interface TransactionSpec {
  changes?: unknown;
  selection?: unknown;
  effects?: unknown;
  scrollIntoView?: boolean;
}

// ── Core ──────────────────────────────────────────────────────────
export declare class EditorView {
  constructor(config: { state: EditorState; parent?: HTMLElement; dispatchTransactions?: unknown });

  state: EditorState;
  visibleRanges: readonly { from: number; to: number }[];
  destroy(): void;
  dispatch(...specs: TransactionSpec[]): void;
  decorations: DecorationSet;
  requestMeasure(): void;

  static theme(spec: object, options?: object): Extension;
  static updateListener: {
    of(handler: (update: ViewUpdate) => void): Extension;
  };
}

export declare class EditorState {
  doc: { readonly length: number; lineAt(pos: number): { number: number; from: number; length: number }; toString(): string; sliceString(from: number, to?: number): string };
  selection: { main: { from: number; to: number; anchor: number; head: number } };

  static create(config: { doc: string; extensions: Extension }): EditorState;
  static readOnly: {
    of(value: boolean): Extension;
  };
}

// ── Compartment ───────────────────────────────────────────────────
export declare class Compartment {
  of(value: Extension): Extension;
  reconfigure(state: EditorState, value: Extension): TransactionSpec;
}

// ── Decoration ────────────────────────────────────────────────────
export declare class Decoration {
  static widget(spec: object): Decoration;
  static replace(spec: object): Decoration;
  static line(spec: object): Decoration;
  static mark(spec: object): Decoration;
  static range(from: number, to: number, value: Decoration): Range<Decoration>;
  static set(ranges: readonly Range<Decoration>[], sort?: boolean): DecorationSet;
  range(from: number, to?: number): Range<Decoration>;
}

export declare class DecorationSet {
  update(changes?: { changes?: any; docChanged?: boolean }): DecorationSet;
  iter(): { value: Decoration; from: number; to: number; next(): void };
  readonly size: number;
}

// ── Range ─────────────────────────────────────────────────────────
export declare class Range<T> {
  readonly from: number;
  readonly to: number;
  readonly value: T;
}

// ── ViewPlugin ────────────────────────────────────────────────────
export declare function ViewPlugin(define: object): Extension;
export declare namespace ViewPlugin {
  function fromClass(cls: any, spec?: object): Extension;
}

// ── ViewUpdate ────────────────────────────────────────────────────
export declare class ViewUpdate {
  view: EditorView;
  docChanged: boolean;
  selectionSet: boolean;
  stateChanged: boolean;
  viewportChanged: boolean;
  state: EditorState;
  decorations: DecorationSet;
}

// ── Re-exports: codemirror ────────────────────────────────────────
export declare function minimalSetup(config?: object): Extension;
export declare function yaml(): Extension;

// ── Re-exports: @codemirror/language ──────────────────────────────
export declare function syntaxHighlighting(highlighter: object, fallback?: object): Extension;
export declare function foldGutter(config?: object): Extension;
export declare function indentOnInput(): Extension;
export declare function bracketMatching(config?: object): Extension;
export declare const defaultHighlightStyle: object;

// ── Re-exports: @codemirror/view ──────────────────────────────────
export interface KeymapFacet {
  of(bindings: readonly object[]): Extension;
}
export declare const keymap: KeymapFacet;
export declare function drawSelection(): Extension;
export declare function highlightActiveLine(): Extension;
export declare function highlightActiveLineGutter(): Extension;
export declare function lineNumbers(): Extension;
export declare function rectangularSelection(): Extension;

// ── Re-exports: @codemirror/commands ──────────────────────────────
export declare const defaultKeymap: object[];
export declare const indentWithTab: object;

// ── Re-exports: @codemirror/search ────────────────────────────────
export declare function search(config?: object): Extension;
export declare function highlightSelectionMatches(): Extension;

// ── Re-exports: @codemirror/autocomplete ──────────────────────────
export declare function autocompletion(config?: object): Extension;

// ── Re-exports: @codemirror/lint ──────────────────────────────────
export declare function linter(source: unknown, config?: object): Extension;
export declare function lintGutter(): Extension;

// ── Re-exports: @codemirror/lang-javascript ───────────────────────
export declare function javascript(config?: object): Extension;

// ── Tags & HighlightStyle ─────────────────────────────────────────
export declare const tags: Record<string, object>;
export declare class HighlightStyle {
  static define(specs: object[]): Extension;
}

// ── Theme ─────────────────────────────────────────────────────────
export declare function theme(spec: object, options?: object): Extension;

// ── StateField ────────────────────────────────────────────────────
export declare function StateField<T>(spec: object): Extension;

// ── StateEffect ───────────────────────────────────────────────────
export declare namespace StateEffect {
  function define<T>(spec?: object): { of(value: T): StateEffect<T> };
  const appendConfig: { of(config: object[]): StateEffect<object[]> };
}

export declare class StateEffect<T> {
  value: T;
  static define: typeof StateEffect.define;
}

// ── Facet ─────────────────────────────────────────────────────────
export declare function Facet<T>(config?: object): { of(value: T): Extension };