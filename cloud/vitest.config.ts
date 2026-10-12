import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

// Tests run inside workerd with the bindings from wrangler.jsonc (R2 and
// Durable Objects simulated locally), on test hostnames.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { APEX_ORIGIN: "https://mlch.test", SHARE_ORIGIN: "https://share.mlch.test" } },
    }),
  ],
  resolve: { alias: { "@": path.resolve(__dirname, "../src") } },
  test: { include: ["test/**/*.test.ts"] },
});
