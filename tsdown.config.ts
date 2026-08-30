// Build config for agy-proxy (tsdown / rolldown).
// Single Node service bundle; the WebUI lives in web/ and builds separately
// via vite (npm run web:build), its dist/ is served as static files.
import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    outDir: "dist",
    format: ["esm"],
    platform: "node",
    target: "es2024",
    dts: true,
    clean: true,
    fixedExtension: false,
  },
]);
