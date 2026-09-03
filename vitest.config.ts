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
    },
  },
});
