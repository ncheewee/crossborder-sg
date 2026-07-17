import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname, "static-entry"),
  base: "/crossborder-sg/",
  publicDir: resolve(__dirname, "public"),
  plugins: [react()],
  define: {
    "process.env.NEXT_PUBLIC_API_BASE": JSON.stringify(
      process.env.NEXT_PUBLIC_API_BASE ?? process.env.VITE_API_BASE ?? "",
    ),
  },
  build: {
    outDir: resolve(__dirname, "docs"),
    emptyOutDir: true,
  },
});
