import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// the Ahoy web UI, built into ../server/public and served by the Ahoy server at /
// dev: `bun run dev` serves on :8791 and proxies the API to a running Ahoy server on :8790. xfwd: the proxy says which address
// the page was opened at (X-Forwarded-Host), as a reverse proxy does: the server takes changes from its own page only, and
// over plain http on another machine's address the browser's Origin is all it has to tell that by
export default defineConfig({
  plugins: [react()],
  build: { outDir: "../server/public", emptyOutDir: true },
  server: { port: 8791, proxy: { "/api": { target: process.env.AHOY_URL || "http://localhost:8790", changeOrigin: true, xfwd: true } } },
});
