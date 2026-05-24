import noUnsanitized from 'eslint-plugin-no-unsanitized';

export default [
    {
        ignores: [
            'dist/',
            'node_modules/',
            'src/cm6.bundle.js',
            'src/tailwind.css',
            'src/_shared/',
        ],
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                // Browser
                window: 'readonly',
                document: 'readonly',
                navigator: 'readonly',
                console: 'readonly',
                setTimeout: 'readonly',
                setInterval: 'readonly',
                clearTimeout: 'readonly',
                clearInterval: 'readonly',
                fetch: 'readonly',
                URL: 'readonly',
                Blob: 'readonly',
                FormData: 'readonly',
                DOMParser: 'readonly',
                Node: 'readonly',
                Element: 'readonly',
                HTMLElement: 'readonly',
                Event: 'readonly',
                FileReader: 'readonly',
                IntersectionObserver: 'readonly',
                ResizeObserver: 'readonly',
                MutationObserver: 'readonly',
                // Tauri API
                __TAURI__: 'readonly',
                __TAURI_INTERNALS__: 'readonly',
            },
        },
        plugins: {
            'no-unsanitized': noUnsanitized,
        },
        rules: {
            // P0: 禁止未转义的 innerHTML 和 insertAdjacentHTML
            // 将 html 和 safeHtml 识别为有效的 sanitizer
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

            // 额外安全规则
            'no-eval': 'error',
            'no-implied-eval': 'error',
            'no-new-func': 'error',
        },
    },
];
