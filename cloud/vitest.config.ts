import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

// Tests run inside workerd with the bindings from wrangler.jsonc (R2 and
// Durable Objects simulated locally), on test hostnames.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.mlch.jsonc" },
      miniflare: { bindings: { APEX_ORIGIN: "https://mlch.test", SHARE_ORIGIN: "https://share.mlch.test", ACCOUNTS: "", GOOGLE_CLIENT_ID: "test-client" } },
    }),
  ],
  resolve: { alias: { "@": path.resolve(__dirname, "../src") } },
  test: { include: ["test/**/*.test.ts"] },
});
