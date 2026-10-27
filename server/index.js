import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import express from "express";
import { config, projectRoot } from "./config.js";
import { closePool } from "./db/readOnlyPool.js";
import { closePermissionsPool } from "./permissions/userPermissions.js";
import { createApp } from "./app.js";

const app = createApp();

if (config.isProduction) {
  const staticDirectory = path.join(projectRoot, "dist");
  app.use(config.appPath("/"), express.static(staticDirectory, { etag: true, maxAge: "1h" }));
  app.get(config.appPath("/"), (request, response) => {
    response.sendFile(path.join(staticDirectory, "index.html"));
  });
  app.get(`${config.appPath("").replace(/\/$/, "")}/{*path}`, (request, response) => {
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
  console.log(`Claim Lifecycle is available at http://${config.host}:${config.port}${config.appPath("/")}`);
  console.log("Claim-source database access: read-only transactions, SELECT statements only");
  console.log(`SSO permission store: ${config.userPermissions.schema}.${config.userPermissions.table}`);
  console.log(
    `Worklist store: ${config.worklists.schema}.${config.worklists.typesTable} + ${config.worklists.claimsTable}`,
  );
  if (!config.permissionsDb.configured) {
    console.warn("SSO permission database credentials are not configured; set PERMISSIONS_DB_HOST and PERMISSIONS_DB_USER");
  }
});

async function shutdown() {
  server.close(async () => {
    await Promise.all([closePool(), closePermissionsPool()]);
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
