// Builds the shared-canvas viewer into cloud/dist/viewer. Run from the repo
// root (`npm run build` in cloud/ does), so the app's components and
// dependencies resolve exactly as they do in the app.
import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/postcss";

const root = path.resolve(__dirname, "../..");
const version = (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }).version;

export default defineConfig({
  root: __dirname,
  base: "/viewer/",
  plugins: [react()],
  // The app's Tailwind (postcss.config.mjs), named here because Vite looks for it from this folder.
  css: { postcss: { plugins: [tailwind({ base: root })] } },
  resolve: { alias: { "@": path.join(root, "src") } },
  // The landing page shows the current release.
  define: {
    "import.meta.env.VITE_MLCH_VERSION": JSON.stringify(version),
    // Where the source lives (a fork sets its own with MLCH_SOURCE_URL).
    "import.meta.env.VITE_MLCH_SOURCE_URL": JSON.stringify(process.env.MLCH_SOURCE_URL ?? "https://github.com/move38studios/mlch"),
  },
  build: {
    outDir: path.resolve(__dirname, "../dist/viewer"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    // The shared-canvas viewer, and the landing page (the same canvas, with nothing behind it).
    rollupOptions: { input: { viewer: path.join(__dirname, "index.html"), landing: path.join(__dirname, "landing.html") } },
  },
});
