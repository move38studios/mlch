import type { NextConfig } from "next";
import sharedConfig from "./next.config.shared.cjs";

const nextConfig: NextConfig = {
  ...sharedConfig,
  // Keep the Electron dev server independent of a plain browser dev server.
  distDir: process.env.MULCH_ELECTRON === "1" && process.env.NODE_ENV === "development" ? ".next-electron" : ".next",
  turbopack: { root: __dirname },
  typescript: { tsconfigPath: "tsconfig.build.json" },
};

export default nextConfig;
