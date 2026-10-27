import test from "node:test";
import assert from "node:assert/strict";
import { pathWithinApp } from "./appPath.js";

test("application paths stay under the configured deployment base path", () => {
  assert.equal(pathWithinApp("/", "/dashboardapp/"), "/dashboardapp/");
  assert.equal(pathWithinApp("/api/health", "/dashboardapp/"), "/dashboardapp/api/health");
  assert.equal(pathWithinApp("auth/login", "/dashboardapp"), "/dashboardapp/auth/login");
});

test("application paths continue to work for root deployments", () => {
  assert.equal(pathWithinApp("/"), "/");
  assert.equal(pathWithinApp("/api/health"), "/api/health");
});
