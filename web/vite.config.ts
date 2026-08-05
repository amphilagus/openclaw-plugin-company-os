import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  base: "/plugins/company-os-ui/",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/plugins/company-os/api": "http://127.0.0.1:18789",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
