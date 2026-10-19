import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "frontend",
  plugins: [react(), tailwindcss()],
  build: { outDir: "../public", emptyOutDir: true },
  server: { proxy: { "/api": { target: "http://localhost:3000", ws: true }, "/novnc": "http://localhost:3000" } },
});
