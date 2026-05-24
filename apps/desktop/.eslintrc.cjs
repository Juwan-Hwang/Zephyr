module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  extends: [
    'eslint:recommended',
  ],
  plugins: [
    'no-unsanitized',
  ],
  rules: {
    // P0: 禁止未转义的 innerHTML 和 insertAdjacentHTML
    // 将 html 和 safeHtml 识别为有效的 sanitizer
    'no-unsanitized/property': ['error', { escape: { methods: ['html', 'safeHtml'] } }],
    'no-unsanitized/method': ['error', { escape: { methods: ['html', 'safeHtml'] } }],

    // 额外安全规则
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error',
  },
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  globals: {
    // Tauri API
    __TAURI__: 'readonly',
    __TAURI_INTERNALS__: 'readonly',
  },
  // 忽略文件
  ignorePatterns: [
    'dist/',
    'node_modules/',
    'src/cm6.bundle.js',
    'src/tailwind.css',
    'src/_shared/',
  ],
};
