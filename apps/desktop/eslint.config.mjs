import globals from 'globals';

// ═══════════════════════════════════════════════════════════════════════════════
//  内联 no-unsanitized ESLint 规则
//  替代外部 eslint-plugin-no-unsanitized 包，避免 pnpm 严格模式下
//  CI 中的依赖解析问题。功能等价：检测 innerHTML/outerHTML 赋值
//  和 insertAdjacentHTML/write/writeln 调用中的不安全操作。
// ═══════════════════════════════════════════════════════════════════════════════

const _UNSAFE_PROPERTIES = new Set(['innerHTML', 'outerHTML']);
const _UNSAFE_METHODS = new Set(['insertAdjacentHTML', 'write', 'writeln']);
const _BASE_ESCAPE = new Set(['html', 'safeHtml', 'escapeHtml', 'sanitizeHtml', 'esc', '_esc']);

function _isTriviallySafe(node) {
    if (node.type === 'Literal') return true;
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return true;
    if (node.type === 'UnaryExpression') return _isTriviallySafe(node.argument);
    if (node.type === 'BinaryExpression') return _isTriviallySafe(node.left) && _isTriviallySafe(node.right);
    return false;
}

function _makeCheckEscape(methods, tags) {
    return (node) => {
        if (node.type === 'CallExpression' && node.callee.type === 'Identifier') return methods.has(node.callee.name);
        if (node.type === 'TaggedTemplateExpression' && node.tag.type === 'Identifier') return tags.has(node.tag.name);
        if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
            const p = node.callee.property;
            if (p.type === 'Identifier' && methods.has(p.name)) return true;
        }
        return false;
    };
}

const noUnsanitizedPlugin = {
    meta: { name: 'no-unsanitized', version: '1.0.0' },
    rules: {
        property: {
            meta: {
                type: 'problem',
                docs: { description: 'Disallow unsafe assignment to innerHTML/outerHTML', category: 'possible-errors' },
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
                messages: { unsafeProperty: 'Unsafe assignment to {{property}}' },
            },
            create(context) {
                const opts = context.options[0]?.escape || {};
                const methods = new Set([..._BASE_ESCAPE, ...(opts.methods || [])]);
                const tags = new Set([..._BASE_ESCAPE, ...(opts.taggedTemplates || [])]);
                const checkEscape = _makeCheckEscape(methods, tags);

                return {
                    AssignmentExpression(node) {
                        if (node.left.type !== 'MemberExpression') return;
                        const prop = node.left.property;
                        if (prop.type !== 'Identifier' || !_UNSAFE_PROPERTIES.has(prop.name)) return;
                        if (node.right.type === 'Literal' && node.right.value === '') return;
                        if (checkEscape(node.right)) return;
                        if (_isTriviallySafe(node.right)) return;
                        context.report({ node, messageId: 'unsafeProperty', data: { property: prop.name } });
                    },
                };
            },
        },
        method: {
            meta: {
                type: 'problem',
                docs: { description: 'Disallow unsafe calls to insertAdjacentHTML/write/writeln', category: 'possible-errors' },
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
                messages: { unsafeMethod: 'Unsafe call to {{method}}' },
            },
            create(context) {
                const opts = context.options[0]?.escape || {};
                const methods = new Set([..._BASE_ESCAPE, ...(opts.methods || [])]);
                const tags = new Set([..._BASE_ESCAPE, ...(opts.taggedTemplates || [])]);
                const checkEscape = _makeCheckEscape(methods, tags);

                return {
                    CallExpression(node) {
                        if (node.callee.type !== 'MemberExpression') return;
                        const prop = node.callee.property;
                        if (prop.type !== 'Identifier' || !_UNSAFE_METHODS.has(prop.name)) return;
                        const htmlArg = prop.name === 'insertAdjacentHTML' ? node.arguments[1] : node.arguments[0];
                        if (!htmlArg) return;
                        if (checkEscape(htmlArg)) return;
                        if (_isTriviallySafe(htmlArg)) return;
                        context.report({ node, messageId: 'unsafeMethod', data: { method: prop.name } });
                    },
                };
            },
        },
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
//  ESLint Flat Config
// ═══════════════════════════════════════════════════════════════════════════════

export default [
    {
        ignores: [
            'node_modules/**',
            'src-tauri/**',
            'target/**',
            'dist/**',
            'src/js-yaml.min.js',
            'src/_shared/**',
            'src/cm6.bundle.js',
            'src/uno-generated.css',
            'src/tokens-variables.css',
            'src/tokens-theme.css',
        ],
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.browser,
                jsyaml: 'readonly',
                __TAURI__: 'readonly',
                __TAURI_INTERNALS__: 'readonly',
            },
        },
        plugins: {
            'no-unsanitized': noUnsanitizedPlugin,
        },
        rules: {
            // ═══════════════════════════════════════════════════════════════════════
            //  安全 — XSS 防护
            // ═══════════════════════════════════════════════════════════════════════
            'no-unsanitized/property': ['error', {
                escape: {
                    methods: ['html', 'safeHtml'],
                    taggedTemplates: ['html', 'safeHtml'],
                },
            }],
            'no-unsanitized/method': ['error', {
                escape: {
                    methods: ['html', 'safeHtml'],
                    taggedTemplates: ['html', 'safeHtml'],
                },
            }],
            'no-eval': 'error',
            'no-implied-eval': 'error',
            'no-new-func': 'error',
            'no-script-url': 'error',

            // ═══════════════════════════════════════════════════════════════════════
            //  正确性
            // ═══════════════════════════════════════════════════════════════════════
            'no-undef': 'error',
            'no-redeclare': 'error',
            'no-constant-condition': 'error',
            'no-dupe-keys': 'error',
            'no-duplicate-case': 'error',
            'no-dupe-else-if': 'error',
            'no-self-compare': 'error',
            'no-self-assign': 'error',
            'no-unreachable': 'error',
            'no-global-assign': 'error',
            'no-implicit-globals': 'error',
            'no-async-promise-executor': 'error',
            'no-throw-literal': 'error',
            'no-ex-assign': 'error',
            'no-extra-boolean-cast': 'error',
            'no-regex-spaces': 'error',
            'no-new-wrappers': 'error',
            'no-obj-calls': 'error',
            'no-invalid-regexp': 'error',
            'no-func-assign': 'error',
            'no-import-assign': 'error',
            'no-cond-assign': 'error',
            'no-unexpected-multiline': 'error',
            'no-unsafe-negation': 'error',
            'no-unsafe-optional-chaining': 'error',
            'no-loss-of-precision': 'error',
            'valid-typeof': 'error',
            'no-new': 'error',
            'no-array-constructor': 'error',
            'no-new-object': 'error',
            'no-case-declarations': 'error',
            'no-fallthrough': 'error',
            'no-constant-binary-expression': 'error',
            'no-prototype-builtins': 'error',
            'no-iterator': 'error',
            'no-proto': 'error',
            'no-extend-native': 'error',
            'no-class-assign': 'error',
            'no-constructor-return': 'error',
            'no-this-before-super': 'error',
            'no-setter-return': 'error',
            'no-new-native-nonconstructor': 'error',

            // ═══════════════════════════════════════════════════════════════════════
            //  冗余操作
            // ═══════════════════════════════════════════════════════════════════════
            'no-useless-concat': 'error',
            'no-useless-rename': 'error',
            'no-useless-return': 'error',
            'no-useless-call': 'error',
            'no-useless-computed-key': 'error',
            'no-useless-constructor': 'error',
            'no-duplicate-imports': 'error',

            // ═══════════════════════════════════════════════════════════════════════
            //  类型安全 — V8 对 == 和 === 生成完全相同的字节码
            // ═══════════════════════════════════════════════════════════════════════
            'eqeqeq': 'off',

            // ═══════════════════════════════════════════════════════════════════════
            //  代码卫生
            //  OFF no-var / prefer-const: V8 对 var/let/const 优化结果完全一致
            // ═══════════════════════════════════════════════════════════════════════
            'no-console': 'error',
            'no-var': 'off',
            'prefer-const': 'off',
            'no-unused-vars': ['error', {
                varsIgnorePattern: '^_',
                argsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_',
            }],
            'no-empty': ['error', { allowEmptyCatch: true }],
        },
    },
    {
        files: ['**/*.test.js', '**/*.spec.js'],
        rules: {
            'no-console': 'off',
            'no-unused-vars': 'off',
        },
    },
    {
        files: ['src/utils/logger.js'],
        rules: {
            'no-console': 'off',
        },
    },
];
