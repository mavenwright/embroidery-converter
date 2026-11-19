import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: "app",
  publicDir: fileURLToPath(new URL("./public", import.meta.url)),
  build: { outDir: "../dist", emptyOutDir: true, target: "es2022" },
});
