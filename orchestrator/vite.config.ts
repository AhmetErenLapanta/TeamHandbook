import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  // npm run dev starts the server on ORCHESTRATOR_PORT, so /api goes where it listens.
  server: { proxy: { "/api": `http://127.0.0.1:${process.env.ORCHESTRATOR_PORT || "8080"}` } },
});
