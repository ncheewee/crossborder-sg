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
      process.env.NEXT_PUBLIC_API_BASE
        ?? process.env.VITE_API_BASE
        ?? "https://crossborder-sg-api.ncheewee.workers.dev",
    ),
    "process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID": JSON.stringify(
      process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID
        ?? process.env.VITE_GOOGLE_CLIENT_ID
        ?? "309032431650-0lbuaj6igc4s9tc0gddv92ffe6ngkrr4.apps.googleusercontent.com",
    ),
  },
  build: {
    outDir: resolve(__dirname, "docs"),
    emptyOutDir: true,
  },
});
