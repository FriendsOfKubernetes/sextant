import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Runs this extension's tests from its own folder (`npx vitest run`); `npm run sdk:check` runs them through
// sdk/vitest.config.ts. The SDK is in sdk/ of the repository, and the tests read Sextant's own evaluator of extension
// conditions (src/extensions/problemRules.ts).
const sdk = (path: string) => fileURLToPath(new URL(`../../sdk/src/${path}`, import.meta.url));

export default defineConfig({
  server: { fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] } },
  resolve: {
    alias: [
      { find: /^@sextant\/extension-sdk$/, replacement: sdk("index.ts") },
      { find: /^@sextant\/extension-sdk\/testing$/, replacement: sdk("testing.ts") },
    ],
  },
  test: { environment: "jsdom", include: ["src/**/*.test.ts"] },
});
