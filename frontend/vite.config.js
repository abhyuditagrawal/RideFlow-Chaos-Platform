import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` talks to a local docker compose stack the same way the
// dashboard container's nginx does in production (see nginx.conf).
const strip = (prefix) => (path) => path.replace(prefix, "");

export default defineConfig({
  plugins: [
    react(),
    {
      name: "rideflow-dev-config",
      configureServer(server) {
        server.middlewares.use("/api/config", (req, res) => {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ mode: "direct" }));
        });
      },
    },
  ],
  server: {
    port: 5174,
    proxy: {
      "/api/chaos": { target: "http://localhost:9000", rewrite: strip(/^\/api\/chaos/) },
      "/api/security": { target: "http://localhost:9001", rewrite: strip(/^\/api\/security/) },
      "/api/app": { target: "http://localhost:8080", rewrite: strip(/^\/api\/app/) },
    },
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 1200,
  },
});
