import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

// The SDK's own tests, and those of the template and the examples. `test/bridge.test.ts` also loads Sextant's host
// side (`src/extensions/bridge.ts`) to prove that both sides speak the same protocol.
export default defineConfig({
  root,
  resolve: {
    alias: [
      { find: /^@sextant\/extension-sdk$/, replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)) },
      { find: /^@sextant\/extension-sdk\/testing$/, replacement: fileURLToPath(new URL("./src/testing.ts", import.meta.url)) },
      { find: /^@sextant\/extension-sdk\/backend$/, replacement: fileURLToPath(new URL("./src/backend.ts", import.meta.url)) },
    ],
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts", "template/**/*.test.ts", "examples/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    restoreMocks: true,
  },
});
