import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The shared contract lives outside this package root (packages/shared) and is
// imported by relative path with an explicit .ts extension, so dev-server file
// access has to reach one level up.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: [".."] },
  },
  preview: { port: 5173, strictPort: true },
  build: { target: "es2022", sourcemap: true },
});
