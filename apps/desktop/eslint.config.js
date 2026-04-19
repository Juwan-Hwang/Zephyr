import globals from "globals";

export default [
  {
    ignores: ["node_modules/**", "src-tauri/**", "dist/**", "src/js-yaml.min.js", "src/_shared/**"]
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        // Browser globals (covers Event, MutationObserver, window, document, etc.)
        ...globals.browser,
        // App-specific globals
        jsyaml: "readonly",
      }
    },
    rules: {
      "no-unused-vars": "off",
      "no-undef": "error"
    }
  }
];
