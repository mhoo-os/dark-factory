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
      // Lane coverage runs in the Node/SQLite behavioral suite before this Workerd coverage pass.
      include: ["src/index.ts"],
      // The Worker is intentionally small but its external-provider paths are
      // isolated in local tests. These floors prevent coverage from silently
      // dropping while allowing each provider boundary to remain mocked.
      // Keep the authority-heavy Worker paths above the prior smoke-test floor.
      // The D1 suite exercises migrations, contention, fencing, renewal, and
      // exact release rather than counting lease-key strings.
      // Authority-bearing behavior is covered through real D1, signed ingress,
      // workflow cleanup, reconciliation, and protected publication paths.
      // These broad floors apply to the complete Worker, rather than making a
      // low bar that only the new test file can satisfy.
      thresholds: { statements: 48, branches: 46, functions: 72, lines: 56 },
    },
  },
});
