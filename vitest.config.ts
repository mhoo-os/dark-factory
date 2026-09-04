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
      // Keep the authority-heavy Worker paths above the prior smoke-test floor.
      // The D1 suite exercises migrations, contention, fencing, renewal, and
      // exact release rather than counting lease-key strings.
      // The behavioral scheduler/receipt/lease suite now exercises the
      // authority-bearing paths enough to make a substantially stronger floor
      // practical. Keep each dimension below the measured local result while
      // requiring future changes to retain that coverage.
      thresholds: { statements: 26, branches: 24, functions: 45, lines: 29 },
    },
  },
});
