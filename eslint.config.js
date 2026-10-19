// @ts-check
import js from "@eslint/js";
import i18next from "eslint-plugin-i18next";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      // Built extensions (`sdk/scripts/build.mjs`): bundled output, not source.
      "sdk/**/dist/**",
      "target/**",
      "src-tauri/**",
      "crates/**",
      "src/api/generated/**",
      "node_modules/**",
      ".autopilot/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { i18next },
    rules: {
      // Every user-visible string comes from src/locales/<lang>/<namespace>.json.
      "i18next/no-literal-string": [
        "error",
        {
          mode: "jsx-only",
          "jsx-attributes": {
            // Technical attributes; anything a user reads (aria-label, title, alt, placeholder) must be translated.
            exclude: [
              "className",
              // Class names passed down to an element (`wrapperClassName`, `slotClassName`…).
              "[a-z]+ClassName",
              "styleName",
              "style",
              "type",
              "key",
              "id",
              // Where a table's column widths are saved (src/components/Table/ResizableTable.tsx).
              "tableId",
              "width",
              "height",
              "role",
              "orientation",
              "direction",
              "tone",
              // `Button` props that pick a look or an icon of the set (src/components/Button.tsx), and callbacks.
              "variant",
              "size",
              "icon",
              "on[A-Z].*",
              "src",
              "href",
              "rel",
              "target",
              "name",
              "htmlFor",
              "dateTime",
              "data-.*",
              "aria-(orientation|current|modal|live|haspopup|controls|labelledby|describedby)",
            ],
          },
          words: {
            // Strings without any letter (symbols like "×", "▾", numbers, punctuation) are not translatable text.
            exclude: ["[0-9!-/:-@[-`{-~]+", "[A-Z_-]+", /^[^\p{L}]*$/u],
          },
        },
      ],
      // The backend is reached only through src/api.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@tauri-apps/*"], message: "Call the backend through src/api (api.*, hooks, events)." },
          ],
        },
      ],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["src/api/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    files: ["src/**/*.test.{ts,tsx}", "src/test/**/*.{ts,tsx}"],
    rules: { "i18next/no-literal-string": "off" },
  },
  {
    files: ["scripts/**/*.mjs", "*.config.{js,ts}"],
    languageOptions: { globals: globals.node },
  },
);
