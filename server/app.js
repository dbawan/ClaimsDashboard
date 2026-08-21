import express from "express";
import { requireSso } from "./auth/cognito.js";
import { authRouter, callbackHandler, sessionHandler } from "./routes/auth.js";
import { claimsRouter } from "./routes/claims.js";
import { highLevelRouter } from "./routes/highLevel.js";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use((request, response, next) => {
    response.set({
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    next();
  });

  app.use("/auth", authRouter);
  app.get("/callback", callbackHandler);

  app.get("/api/health", (request, response) => {
    response.json({ status: "ok", mode: "read-only" });
  });
  app.get("/api/auth/session", sessionHandler);
  app.use("/api", requireSso);
  app.use("/api/high-level", highLevelRouter);
  app.use("/api/claims", claimsRouter);

  app.all("/api/{*path}", (request, response) => {
    if (request.method !== "GET") {
      response.status(405).json({
        code: "READ_ONLY_API",
        message: "This application exposes read-only GET endpoints only.",
      });
      return;
    }
    response.status(404).json({ code: "NOT_FOUND", message: "API route not found." });
  });

  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    const status = Number(error.statusCode) || 500;
    const timeout = error.code === "DB_QUERY_TIMEOUT";
    const body = {
      code: error.code || (status >= 500 ? "CLAIM_SEARCH_FAILED" : "INVALID_REQUEST"),
      message:
        error.expose
          ? error.message
          : timeout
          ? "The claim data took too long to load. Please retry."
          : status >= 500
          ? "The claim data could not be loaded. Please try again."
          : error.message,
    };
    if (error.claimIds) body.claimIds = error.claimIds;
    if (status >= 500) console.error("Claim search failed:", error.message);
    response.status(status).json(body);
  });

  return app;
}
