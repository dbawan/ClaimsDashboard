import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import express from "express";
import { config, projectRoot } from "./config.js";
import { closePool } from "./db/readOnlyPool.js";
import { createApp } from "./app.js";

const app = createApp();

if (config.isProduction) {
  const staticDirectory = path.join(projectRoot, "dist");
  app.use(express.static(staticDirectory, { etag: true, maxAge: "1h" }));
  app.get("/{*path}", (request, response) => {
    response.sendFile(path.join(staticDirectory, "index.html"));
  });
} else {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    root: projectRoot,
    server: { middlewareMode: true, hmr: false },
    appType: "spa",
  });
  app.use(vite.middlewares);
}

const server = createServer(app);
server.listen(config.port, config.host, () => {
  console.log(`Claim Lifecycle is available at http://${config.host}:${config.port}`);
  console.log("Database access mode: read-only transaction, SELECT statements only");
});

async function shutdown() {
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
