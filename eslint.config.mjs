import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  ...nextVitals,
  ...nextTs,
  { ignores: [".next/**", ".next-electron/**", "out/**", "node_modules/**", "coverage/**", "next-env.d.ts"] },
  {
    // CommonJS by design (Electron shell, server.js).
    files: ["**/*.cjs", "**/*.js"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    files: ["**/__tests__/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    rules: { "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }] },
  },
];

export default config;
