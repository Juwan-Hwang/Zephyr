export default [
  {
    ignores: ["node_modules/**", "src-tauri/**", "dist/**", "src/js-yaml.min.js"]
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        window: "readonly",
        document: "readonly",
        console: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        localStorage: "readonly",
        WebSocket: "readonly",
        URL: "readonly",
        Blob: "readonly",
        btoa: "readonly",
        atob: "readonly",
        jsyaml: "readonly",
        AbortController: "readonly",
        TextDecoder: "readonly",
        navigator: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        NodeList: "readonly",
        HTMLElement: "readonly",
        Element: "readonly",
        ResizeObserver: "readonly",
        IntersectionObserver: "readonly",
        CSS: "readonly"
      }
    },
    rules: {
      "no-unused-vars": "off",
      "no-undef": "error"
    }
  }
];