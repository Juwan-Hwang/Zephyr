import globals from "globals";

export default [
  {
    ignores: ["node_modules/**", "src-tauri/**", "dist/**", "src/js-yaml.min.js", "src/_shared/**", "src/cm6.bundle.js"]
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        jsyaml: "readonly",
      }
    },
    rules: {
      // ═══════════════════════════════════════════════════════════════════════
      //  正确性 — 防止运行时崩溃、逻辑 bug
      // ═══════════════════════════════════════════════════════════════════════
      "no-undef": "error",
      "no-redeclare": "error",
      "no-constant-condition": "error",
      "no-dupe-keys": "error",
      "no-duplicate-case": "error",
      "no-dupe-else-if": "error",
      "no-self-compare": "error",
      "no-self-assign": "error",
      "no-unreachable": "error",
      "no-global-assign": "error",
      "no-implicit-globals": "error",
      "no-async-promise-executor": "error",
      "no-throw-literal": "error",
      "no-ex-assign": "error",
      "no-extra-boolean-cast": "error",
      "no-regex-spaces": "error",
      "no-new-wrappers": "error",
      "no-obj-calls": "error",
      "no-invalid-regexp": "error",
      "no-func-assign": "error",
      "no-import-assign": "error",
      "no-cond-assign": "error",
      "no-unexpected-multiline": "error",
      "no-unsafe-negation": "error",
      "no-unsafe-optional-chaining": "error",
      "no-loss-of-precision": "error",
      "valid-typeof": "error",
      "no-new": "error",
      "no-array-constructor": "error",
      "no-new-object": "error",
      "no-case-declarations": "error",
      "no-fallthrough": "error",
      "no-constant-binary-expression": "error",
      "no-prototype-builtins": "error",
      "no-iterator": "error",
      "no-proto": "error",
      "no-extend-native": "error",
      "no-class-assign": "error",
      "no-constructor-return": "error",
      "no-this-before-super": "error",
      "no-setter-return": "error",
      "no-new-native-nonconstructor": "error",

      // ═══════════════════════════════════════════════════════════════════════
      //  安全 — 防止代码注入
      // ═══════════════════════════════════════════════════════════════════════
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-script-url": "error",

      // ═══════════════════════════════════════════════════════════════════════
      //  冗余操作 — 移除无意义运行时开销
      // ═══════════════════════════════════════════════════════════════════════
      "no-useless-concat": "error",
      "no-useless-rename": "error",
      "no-useless-return": "error",
      "no-useless-call": "error",
      "no-useless-computed-key": "error",
      "no-useless-constructor": "error",
      "no-duplicate-imports": "error",

      // ═══════════════════════════════════════════════════════════════════════
      //  类型安全 — 防止隐式类型转换 bug
      //  OFF: V8 对 == 和 === 生成完全相同的字节码，桌面应用无浏览器隐式转换坑
      // ═══════════════════════════════════════════════════════════════════════
      "eqeqeq": "off",

      // ═══════════════════════════════════════════════════════════════════════
      //  代码卫生 — 死代码、未使用变量、作用域泄漏
      //  OFF no-var / prefer-const: V8 对 var/let/const 优化结果完全一致
      // ═══════════════════════════════════════════════════════════════════════
      "no-console": "error",
      "no-var": "off",
      "prefer-const": "off",
      "no-unused-vars": ["error", {
        "varsIgnorePattern": "^_",
        "argsIgnorePattern": "^_",
        "caughtErrorsIgnorePattern": "^_",
      }],
      "no-empty": ["error", { "allowEmptyCatch": true }],
    }
  },
  // 测试文件：放宽规则
  {
    files: ["**/*.test.js", "**/*.spec.js"],
    rules: {
      "no-console": "off",
      "no-unused-vars": "off",
    }
  },
  // 日志模块：允许 console
  {
    files: ["src/utils/logger.js"],
    rules: {
      "no-console": "off",
    }
  }
];
