// Builds the shared-canvas viewer into cloud/dist/viewer. Run from the repo
// root (`npm run build` in cloud/ does), so the app's components and
// dependencies resolve exactly as they do in the app.
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/postcss";

const root = path.resolve(__dirname, "../..");

export default defineConfig({
  root: __dirname,
  base: "/viewer/",
  plugins: [react()],
  // The app's Tailwind (postcss.config.mjs), named here because Vite looks for it from this folder.
  css: { postcss: { plugins: [tailwind({ base: root })] } },
  resolve: { alias: { "@": path.join(root, "src") } },
  build: { outDir: path.resolve(__dirname, "../dist/viewer"), emptyOutDir: true, chunkSizeWarningLimit: 2000 },
});
