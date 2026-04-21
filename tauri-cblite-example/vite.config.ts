import { defineConfig } from "vite";
import path from "path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  clearScreen: false,
  resolve: {
    dedupe: ["@tauri-apps/api"],
    alias: {
      "@cblite": path.resolve(__dirname, "node_modules/tauri-plugin-cblite/index.js"),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    fs: { allow: [".."] },
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
