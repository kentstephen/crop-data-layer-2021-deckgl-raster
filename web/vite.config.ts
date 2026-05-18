import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  server: { port: 5454, strictPort: true },
  // @developmentseed/geotiff worker pool uses top-level await.
  build: { target: "esnext" },
  optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
