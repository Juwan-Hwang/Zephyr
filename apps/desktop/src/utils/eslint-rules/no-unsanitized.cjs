/**
 * @file Lightweight replacement for eslint-plugin-no-unsanitized
 *
 * Detects unsafe assignments to innerHTML, outerHTML, and calls to
 * insertAdjacentHTML / write / writeln without requiring the external
 * mozilla eslint-plugin-no-unsanitized package.
 *
 * This avoids pnpm strict-mode dependency resolution issues in CI
 * while still catching new unsafe DOM manipulation at lint time.
 *
 * Escape functions recognized: html, safeHtml, escapeHtml, sanitizeHtml
 */

'use strict';

const UNSAFE_PROPERTIES = new Set(['innerHTML', 'outerHTML']);
const UNSAFE_METHODS = new Set(['insertAdjacentHTML', 'write', 'writeln']);
const ESCAPE_FUNCTIONS = new Set(['html', 'safeHtml', 'escapeHtml', 'sanitizeHtml', 'esc', '_esc']);

/**
 * Check if a node is a known safe escape function call
 * @param {import('estree').Node} node
 * @returns {boolean}
 */
function isEscaped(node) {
    // Direct call: escapeHtml(x)
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
        return ESCAPE_FUNCTIONS.has(node.callee.name);
    }
    // Tagged template: html`...` / safeHtml`...`
    if (node.type === 'TaggedTemplateExpression' && node.tag.type === 'Identifier') {
        return ESCAPE_FUNCTIONS.has(node.tag.name);
    }
    // Member call: DOMPurify.sanitize(x)
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
        const prop = node.callee.property;
        if (prop.type === 'Identifier' && ESCAPE_FUNCTIONS.has(prop.name)) {
            return true;
        }
    }
    return false;
}

/**
 * Check if a value is trivially safe (literal string, empty string, number, etc.)
 * @param {import('estree').Node} node
 * @returns {boolean}
 */
function isTriviallySafe(node) {
    if (node.type === 'Literal') return true;
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return true;
    if (node.type === 'UnaryExpression') return isTriviallySafe(node.argument);
    if (node.type === 'BinaryExpression') {
        return isTriviallySafe(node.left) && isTriviallySafe(node.right);
    }
    return false;
}

/** @type {import('eslint').Rule.RuleModule} */
const propertyRule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Disallow unsafe assignment to innerHTML/outerHTML',
            category: 'possible-errors',
        },
        schema: [{
            type: 'object',
            properties: {
                escape: {
                    type: 'object',
                    properties: {
                        taggedTemplates: { type: 'array', items: [{ type: 'string' }] },
                        methods: { type: 'array', items: [{ type: 'string' }] },
                    },
                },
            },
            additionalProperties: false,
        }],
        messages: {
            unsafeProperty: 'Unsafe assignment to {{property}}',
        },
    },
    create(context) {
        // Merge user-configured escape functions
        const opts = context.options[0]?.escape || {};
        const extraMethods = new Set([...ESCAPE_FUNCTIONS, ...(opts.methods || [])]);
        const extraTags = new Set([...ESCAPE_FUNCTIONS, ...(opts.taggedTemplates || [])]);

        /** @param {import('estree').Node} node */
        function checkEscape(node) {
            if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
                return extraMethods.has(node.callee.name);
            }
            if (node.type === 'TaggedTemplateExpression' && node.tag.type === 'Identifier') {
                return extraTags.has(node.tag.name);
            }
            if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
                const prop = node.callee.property;
                if (prop.type === 'Identifier' && extraMethods.has(prop.name)) return true;
            }
            return false;
        }

        return {
            AssignmentExpression(node) {
                if (node.left.type !== 'MemberExpression') return;
                const prop = node.left.property;
                if (prop.type !== 'Identifier' || !UNSAFE_PROPERTIES.has(prop.name)) return;

                // Allow: el.innerHTML = ''  (clearing)
                if (node.right.type === 'Literal' && node.right.value === '') return;

                // Allow: el.innerHTML = escapeHtml(x)
                if (checkEscape(node.right)) return;

                // Allow: el.innerHTML = `<static content>` (no expressions)
                if (isTriviallySafe(node.right)) return;

                context.report({
                    node,
                    messageId: 'unsafeProperty',
                    data: { property: prop.name },
                });
            },
        };
    },
};

/** @type {import('eslint').Rule.RuleModule} */
const methodRule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Disallow unsafe calls to insertAdjacentHTML/write/writeln',
            category: 'possible-errors',
        },
        schema: [{
            type: 'object',
            properties: {
                escape: {
                    type: 'object',
                    properties: {
                        taggedTemplates: { type: 'array', items: [{ type: 'string' }] },
                        methods: { type: 'array', items: [{ type: 'string' }] },
                    },
                },
            },
            additionalProperties: false,
        }],
        messages: {
            unsafeMethod: 'Unsafe call to {{method}}',
        },
    },
    create(context) {
        const opts = context.options[0]?.escape || {};
        const extraMethods = new Set([...ESCAPE_FUNCTIONS, ...(opts.methods || [])]);
        const extraTags = new Set([...ESCAPE_FUNCTIONS, ...(opts.taggedTemplates || [])]);

        /** @param {import('estree').Node} node */
        function checkEscape(node) {
            if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
                return extraMethods.has(node.callee.name);
            }
            if (node.type === 'TaggedTemplateExpression' && node.tag.type === 'Identifier') {
                return extraTags.has(node.tag.name);
            }
            if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
                const prop = node.callee.property;
                if (prop.type === 'Identifier' && extraMethods.has(prop.name)) return true;
            }
            return false;
        }

        return {
            CallExpression(node) {
                if (node.callee.type !== 'MemberExpression') return;
                const prop = node.callee.property;
                if (prop.type !== 'Identifier' || !UNSAFE_METHODS.has(prop.name)) return;

                // insertAdjacentHTML's second arg is the HTML string
                const htmlArg = prop.name === 'insertAdjacentHTML' ? node.arguments[1] : node.arguments[0];
                if (!htmlArg) return;

                if (checkEscape(htmlArg)) return;
                if (isTriviallySafe(htmlArg)) return;

                context.report({
                    node,
                    messageId: 'unsafeMethod',
                    data: { method: prop.name },
                });
            },
        };
    },
};

module.exports = {
    meta: {
        name: 'no-unsanitized',
        version: '1.0.0',
    },
    rules: {
        property: propertyRule,
        method: methodRule,
    },
};
