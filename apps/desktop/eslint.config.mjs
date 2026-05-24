import { createRequire } from 'module';
import globals from 'globals';

// 本地 no-unsanitized 规则实现 — 避免外部 eslint-plugin-no-unsanitized
// 在 pnpm 严格模式 CI 中的依赖解析问题
const require = createRequire(import.meta.url);
const noUnsanitized = require('./src/utils/eslint-rules/no-unsanitized.cjs');

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
            'src/tailwind.css',
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
                // Tauri API
                __TAURI__: 'readonly',
                __TAURI_INTERNALS__: 'readonly',
            },
        },
        plugins: {
            'no-unsanitized': noUnsanitized,
        },
        rules: {
            // ═══════════════════════════════════════════════════════════════════════
            //  安全 — XSS 防护 (no-unsanitized 插件)
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

            // ═══════════════════════════════════════════════════════════════════════
            //  安全 — 代码注入防护
            // ═══════════════════════════════════════════════════════════════════════
            'no-eval': 'error',
            'no-implied-eval': 'error',
            'no-new-func': 'error',
            'no-script-url': 'error',

            // ═══════════════════════════════════════════════════════════════════════
            //  正确性 — 防止运行时崩溃、逻辑 bug
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
            //  冗余操作 — 移除无意义运行时开销
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
            //  代码卫生 — 死代码、未使用变量、作用域泄漏
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
    // 测试文件：放宽规则
    {
        files: ['**/*.test.js', '**/*.spec.js'],
        rules: {
            'no-console': 'off',
            'no-unused-vars': 'off',
        },
    },
    // 日志模块：允许 console
    {
        files: ['src/utils/logger.js'],
        rules: {
            'no-console': 'off',
        },
    },
];
