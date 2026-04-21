import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@cblite": path.resolve(__dirname, "../packages/cblite-adapter/src/web.ts"),
    },
  },
  optimizeDeps: {
    // @couchbase/lite-js may ship WASM; allow Vite to pre-bundle it
    include: ["@couchbase/lite-js"],
  },
});
