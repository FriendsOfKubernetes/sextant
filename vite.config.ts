import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/** `locale-de` for a translation file of `src/locales/de/`; English stays in the main bundle (`null`). */
function localeChunk(id: string): string | null {
  const lang = /\/src\/locales\/([^/]+)\/[^/]+\.json$/.exec(id)?.[1];
  return lang && lang !== "en" ? `locale-${lang}` : null;
}

// Tauri expects a fixed dev port and serves the built files from `dist/`.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/target/**", "**/crates/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: ["es2022", "chrome110", "safari15"],
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
    rolldownOptions: {
      output: {
        codeSplitting: {
          // One chunk per UI language (src/i18n/index.ts loads it when chosen); English stays in the main bundle.
          groups: [{ name: (id: string) => localeChunk(id) }],
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
    restoreMocks: true,
  },
});
