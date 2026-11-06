import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `npx vitest run` in this folder: the SDK from `../../sdk` (as `tsconfig.json` maps it), without installing it.
// `npm run sdk:check` runs these tests with the SDK's own config.
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
