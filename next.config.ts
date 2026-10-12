import type { NextConfig } from "next";
import sharedConfig from "./next.config.shared.cjs";

const nextConfig: NextConfig = {
  ...sharedConfig,
  // Keep the Electron dev server independent of a plain browser dev server.
  distDir: process.env.MLCH_ELECTRON === "1" && process.env.NODE_ENV === "development" ? ".next-electron" : ".next",
  turbopack: { root: __dirname },
  // The packaged app (scripts/package-app.mjs) ships only the server files Next traces.
  ...(process.env.MLCH_STANDALONE === "1"
    ? {
        output: "standalone" as const,
        // Paths built from process.cwd() make the tracer take whole folders; none of these run in the app.
        outputFileTracingExcludes: {
          "*": ["dist/**", "cloud/**", "native/**", "docs/**", "design/**", "src/**", ".claude/**", "build/**", "*.md", "node_modules/@openai/codex-darwin-*/**", "node_modules/@openai/codex-linux-*/**", "node_modules/@openai/codex-win32-*/**", "node_modules/@anthropic-ai/claude-agent-sdk-darwin-*/**", "node_modules/@anthropic-ai/claude-agent-sdk-linux-*/**", "node_modules/@anthropic-ai/claude-agent-sdk-win32-*/**", "node_modules/onnxruntime-node/**", "node_modules/@img/sharp-wasm32/**"],
        },
      }
    : {}),
  typescript: { tsconfigPath: "tsconfig.build.json" },
};

export default nextConfig;
