import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolveApplicationProfile } from "./appEnvironment.js";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");
  const profile = resolveApplicationProfile(environment);
  const basePath = profile.appBasePath.replace(/\/$/, "");
  return {
    base: basePath ? `${basePath}/` : "/",
    plugins: [react()],
    server: {
      host: profile.host,
      port: profile.port,
      strictPort: true,
    },
    preview: {
      host: profile.host,
      port: profile.port,
      strictPort: true,
    },
    build: {
      outDir: "dist",
      sourcemap: true,
    },
  };
});
