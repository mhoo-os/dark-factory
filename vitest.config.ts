import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.test.jsonc" } })],
  test: {
    include: ["tests/**/*.worker.test.ts"],
    coverage: {
      // Workers' local runtime does not expose the V8 inspector coverage API;
      // Istanbul instruments the bundle and works in Miniflare/workerd.
      provider: "istanbul",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      // The Worker is intentionally small but its external-provider paths are
      // isolated in local tests. These floors prevent coverage from silently
      // dropping while allowing each provider boundary to remain mocked.
      thresholds: { statements: 20, branches: 18, functions: 35, lines: 23 },
    },
  },
});
