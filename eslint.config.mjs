import globals from "globals";
import nounsanitized from "eslint-plugin-no-unsanitized";

// Lean, high-signal lint setup for the no-build frontend. Correctness rules that
// catch real bugs are errors (CI-blocking). The escaping rule is a tracked
// warning: every existing `innerHTML = `...${escapeHtml(x)}...`` sink trips it,
// so flipping it to an error first needs the ~60 sinks migrated to the
// auto-escaping `html` tagged template (see client/utils.js). Until then it
// surfaces new/unsafe sinks in review without blocking the build.
const correctnessRules = {
  "no-dupe-args": "error",
  "no-dupe-keys": "error",
  "no-dupe-else-if": "error",
  "no-dupe-class-members": "error",
  "no-unreachable": "error",
  "no-const-assign": "error",
  "no-func-assign": "error",
  "no-import-assign": "error",
  "no-class-assign": "error",
  "no-setter-return": "error",
  "getter-return": "error",
  "no-self-assign": "error",
  "no-self-compare": "error",
  "no-unsafe-negation": "error",
  "no-unsafe-finally": "error",
  "no-cond-assign": ["error", "except-parens"],
  "no-compare-neg-zero": "error",
  "no-fallthrough": "error",
  "no-obj-calls": "error",
  "no-sparse-arrays": "error",
  "no-async-promise-executor": "error",
  "use-isnan": "error",
  "valid-typeof": "error",
  "no-undef": "error",
};

const escapingRules = {
  "no-unsanitized/property": [
    "warn",
    { escape: { methods: ["escapeHtml"], taggedTemplates: ["html"] } },
  ],
  "no-unsanitized/method": [
    "warn",
    { escape: { methods: ["escapeHtml"], taggedTemplates: ["html"] } },
  ],
};

export default [
  {
    ignores: ["node_modules/**", "site/**", "dist/**", "data/**", ".venv/**"],
  },
  {
    // Live-site frontend (runs in the browser as ES modules).
    files: ["app.js", "client/**/*.js"],
    plugins: { "no-unsanitized": nounsanitized },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.browser },
    },
    rules: { ...correctnessRules, ...escapingRules },
  },
  {
    // Tampermonkey collector: runs as a userscript with GM_* + page globals.
    files: ["akatsuki-steamgifts-sync.user.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "script",
      globals: {
        ...globals.browser,
        GM_info: "readonly",
        GM_getValue: "readonly",
        GM_setValue: "readonly",
        GM_deleteValue: "readonly",
        GM_registerMenuCommand: "readonly",
        GM_addStyle: "readonly",
        GM: "readonly",
        unsafeWindow: "readonly",
      },
    },
    rules: { ...correctnessRules },
  },
];
