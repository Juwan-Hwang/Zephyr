// @ts-check
/**
 * Context-aware autocompletion for Prism DSL.
 * Detects cursor position and returns relevant completions.
 *
 * @module ui/editor/prism-completion
 */

// ─── Completion Data ───────────────────────────────────────────────

/** @typedef {{ label: string, type?: string, detail?: string }} Completion */
/** @typedef {{ pos: number, state: import('../../cm6.bundle.js').EditorState, matchBefore?: (pattern: RegExp) => { from: number, text: string } | null, abortSignal?: AbortSignal }} CompletionContext */
/** @typedef {{ from: number, to?: number, options: Completion[], validFor?: RegExp }} CompletionResult */

/** @type {Completion[]} */
const TOP_LEVEL_KEYS = [
    { label: '__when__', type: 'keyword', detail: 'Conditional scope' },
    { label: '__after__', type: 'keyword', detail: 'Dependency declaration' },
    { label: 'dns', type: 'property', detail: 'DNS configuration' },
    { label: 'tun', type: 'property', detail: 'TUN configuration' },
    { label: 'rules', type: 'property', detail: 'Routing rules' },
    { label: 'proxies', type: 'property', detail: 'Proxy definitions' },
    { label: 'proxy-groups', type: 'property', detail: 'Proxy group definitions' },
    { label: 'proxy-providers', type: 'property', detail: 'Proxy provider definitions' },
    { label: 'hosts', type: 'property', detail: 'Hosts mapping' },
    { label: 'sniffer', type: 'property', detail: 'Sniffer configuration' },
    { label: 'authentication', type: 'property', detail: 'Authentication config' },
    { label: 'tls', type: 'property', detail: 'TLS configuration' },
    { label: 'profile', type: 'property', detail: 'Profile configuration' },
    { label: 'experimental', type: 'property', detail: 'Experimental features' },
];

/** @type {Completion[]} */
const ARRAY_OPERATORS = [
    { label: '$prepend', type: 'keyword', detail: 'Prepend items to array' },
    { label: '$append', type: 'keyword', detail: 'Append items to array' },
    { label: '$filter', type: 'keyword', detail: 'Filter array items (static fields)' },
    { label: '$transform', type: 'keyword', detail: 'Transform array items (static fields)' },
    { label: '$remove', type: 'keyword', detail: 'Remove matching items (static fields)' },
    { label: '$default', type: 'keyword', detail: 'Default value injection' },
];

/** @type {Completion[]} */
const DICT_OPERATORS = [
    { label: '$override', type: 'keyword', detail: 'Force override (no merge)' },
    { label: '$default', type: 'keyword', detail: 'Default value injection' },
];

/** @type {Completion[]} */
const WHEN_FIELDS = [
    { label: 'core', type: 'property', detail: 'Core type: mihomo | clash-rs' },
    { label: 'platform', type: 'property', detail: 'OS: windows | macos | linux | android | ios' },
    { label: 'profile', type: 'property', detail: 'Profile name (supports regex)' },
    { label: 'time', type: 'property', detail: 'Time range: HH:mm-HH:mm' },
    { label: 'enabled', type: 'property', detail: 'Enable/disable toggle (boolean)' },
    { label: 'ssid', type: 'property', detail: 'WiFi SSID condition' },
];

/** @type {Completion[]} */
const FILTER_EXPRESSIONS = [
    { label: 'p.name', type: 'variable', detail: 'Proxy name' },
    { label: 'p.type', type: 'variable', detail: 'Proxy type (ss, vmess, trojan...)' },
    { label: 'p.server', type: 'variable', detail: 'Server address' },
    { label: 'p.port', type: 'variable', detail: 'Server port' },
    { label: 'p.uuid', type: 'variable', detail: 'UUID (ss/vmess)' },
    { label: 'p.cipher', type: 'variable', detail: 'Cipher method' },
    { label: 'p.tls', type: 'variable', detail: 'TLS enabled' },
    { label: 'p.sni', type: 'variable', detail: 'SNI hostname' },
    { label: 'p.network', type: 'variable', detail: 'Network type (ws, grpc, h2...)' },
    { label: 'p.flow', type: 'variable', detail: 'Flow control' },
    { label: 'p.fingerprint', type: 'variable', detail: 'TLS fingerprint' },
    { label: 'p.alpn', type: 'variable', detail: 'ALPN protocols' },
    { label: 'p.skip-cert-verify', type: 'variable', detail: 'Skip certificate verification' },
];

/** @type {Completion[]} */
const RULE_ITEM_FIELDS = [
    { label: '__when__', type: 'keyword', detail: 'Rule-level condition' },
    { label: '__rule__', type: 'keyword', detail: 'Rule content (when condition matches)' },
];

// ─── Context Detection ─────────────────────────────────────────────

/**
 * @typedef {'top-level' | 'when-children' | 'array-operators' | 'dict-operators' | 'filter-expression' | 'rule-item' | 'none'} ContextType
 */

/**
 * Detect the current context based on the text before the cursor.
 * Detects cursor position (indent level, parent keys, expression context)
 *
 * @param {string} textBefore - Full text from document start to cursor
 * @returns {ContextType}
 */
function detectContext(textBefore) {
    const lines = textBefore.split('\n');
    const currentLine = lines[lines.length - 1];
    const trimmed = currentLine.trimStart();

    // Count indentation of current line
    const indent = currentLine.length - currentLine.trimStart().length;

    // Check if we're inside a $filter or $transform value (expression string)
    const lastFilterMatch = textBefore.lastIndexOf('$filter');
    const lastTransformMatch = textBefore.lastIndexOf('$transform');
    const lastExpr = Math.max(lastFilterMatch, lastTransformMatch);
    if (lastExpr !== -1) {
        const afterExpr = textBefore.slice(lastExpr);
        // If we're on a line after $filter and it looks like an expression
        const exprLines = afterExpr.split('\n');
        if (exprLines.length > 1 || (exprLines.length === 1 && afterExpr.includes('"'))) {
            return 'filter-expression';
        }
    }

    // Top level (indent 0)
    if (indent === 0) {
        return 'top-level';
    }

    // Inside __when__ block (indent 2 or 4)
    const hasWhen = textBefore.includes('__when__');
    if (hasWhen && indent <= 8) {
        // Check if we're inside a $prepend/$append array item
        if (textBefore.includes('$prepend') || textBefore.includes('$append')) {
            return 'rule-item';
        }
        return 'when-children';
    }

    // Inside $prepend/$append array (check for __when__/__rule__)
    if (textBefore.includes('$prepend') || textBefore.includes('$append')) {
        return 'rule-item';
    }

    // Inside an array field (rules, proxies, etc.) — offer array operators
    // Heuristic: if the line starts with a known array field name at some parent level
    const arrayFieldPattern = /^(rules|proxies|proxy-groups|proxy-providers|hosts):/;
    for (let i = lines.length - 1; i >= 0; i--) {
        if (arrayFieldPattern.test(lines[i].trim())) {
            // We're inside an array field
            if (trimmed.startsWith('$')) {
                return 'array-operators';
            }
            return 'none';
        }
    }

    // Inside a dict field — offer dict operators
    if (trimmed.startsWith('$')) {
        return 'dict-operators';
    }

    return 'none';
}

// ─── Completion Source ─────────────────────────────────────────────

/**
 * Completion source function for Prism DSL.
 * Inspects the text before the cursor to determine context,
 * then returns the appropriate completion list.
 *
 * @param {CompletionContext} context
 * @returns {CompletionResult | null}
 */
function prismCompletion(context) {
    const pos = context.pos;
    const textBefore = context.state.doc.sliceString(0, pos);

    // Get the current word being typed (for filtering)
    const wordMatch = textBefore.match(/([\w$]+)$/);
    const prefix = wordMatch ? wordMatch[1] : '';

    // Don't trigger inside comments
    const lineStart = textBefore.lastIndexOf('\n') + 1;
    const lineText = textBefore.slice(lineStart);
    if (lineText.trimStart().startsWith('#')) {
        return null;
    }

    const ctx = detectContext(textBefore);
    /** @type {Completion[]} */
    let options = [];

    switch (ctx) {
        case 'top-level':
            options = [...TOP_LEVEL_KEYS];
            break;
        case 'when-children':
            options = [...WHEN_FIELDS];
            break;
        case 'array-operators':
            options = [...ARRAY_OPERATORS];
            break;
        case 'dict-operators':
            options = [...DICT_OPERATORS];
            break;
        case 'filter-expression':
            options = [...FILTER_EXPRESSIONS];
            break;
        case 'rule-item':
            options = [...RULE_ITEM_FIELDS];
            break;
        default:
            return null;
    }

    // Filter by prefix
    if (prefix) {
        options = options.filter(
            (o) => o.label.startsWith(prefix) || o.label.toLowerCase().startsWith(prefix.toLowerCase()),
        );
    }

    if (options.length === 0) return null;

    const from = wordMatch ? pos - prefix.length : pos;

    return {
        from,
        options,
        validFor: /^[\w$]*$/,
    };
}

export { prismCompletion };
