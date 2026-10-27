import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequestLogger } from "./requestLogger.js";
import { config } from "../config.js";

function runRequest({ url = config.appPath("/api/health"), statusCode = 200, event = "finish" } = {}) {
  const calls = [];
  const logger = {
    info: (...arguments_) => calls.push(["info", ...arguments_]),
    warn: (...arguments_) => calls.push(["warn", ...arguments_]),
    error: (...arguments_) => calls.push(["error", ...arguments_]),
  };
  const times = [1_000_000_000n, 1_012_300_000n];
  const middleware = createRequestLogger({ logger, now: () => times.shift() });
  const request = { method: "GET", originalUrl: url };
  const response = Object.assign(new EventEmitter(), {
    statusCode,
    writableFinished: event === "finish",
  });
  let nextCalled = false;

  middleware(request, response, () => {
    nextCalled = true;
  });
  response.emit(event);

  return { calls, nextCalled, response };
}

test("request logger writes completed backend requests to the console logger", () => {
  const { calls, nextCalled } = runRequest();

  assert.equal(nextCalled, true);
  assert.deepEqual(calls, [["info", "[http] request", {
    method: "GET",
    path: config.appPath("/api/health"),
    statusCode: 200,
    durationMs: 12.3,
    outcome: "complete",
  }]]);
});

test("request logger removes query strings and redacts claim identifiers", () => {
  const { calls } = runRequest({
    url: `${config.appPath("/api/claims/78820")}?authorization=secret`,
    statusCode: 404,
  });

  assert.equal(calls[0][0], "warn");
  assert.equal(calls[0][2].path, config.appPath("/api/claims/:claimId"));
});

test("request logger redacts claim identifiers from nested write routes", () => {
  const { calls } = runRequest({
    url: config.appPath("/api/claims/78820/salesforce-notes"),
    statusCode: 201,
  });
  assert.equal(calls[0][2].path, config.appPath("/api/claims/:claimId/salesforce-notes"));
});

test("request logger preserves the patient search route and redacts selected patient IDs", () => {
  const search = runRequest({
    url: `${config.appPath("/api/claims/patients/search")}?q=Jane`,
  });
  const claims = runRequest({
    url: config.appPath("/api/claims/patients/31631/claims"),
  });

  assert.equal(search.calls[0][2].path, config.appPath("/api/claims/patients/search"));
  assert.equal(claims.calls[0][2].path, config.appPath("/api/claims/patients/:patientId/claims"));
});

test("request logger preserves worklist type routes and redacts claim worklist IDs", () => {
  const types = runRequest({ url: config.appPath("/api/claims/worklist-types") });
  const assignment = runRequest({ url: config.appPath("/api/claims/81047/worklist") });

  assert.equal(types.calls[0][2].path, config.appPath("/api/claims/worklist-types"));
  assert.equal(assignment.calls[0][2].path, config.appPath("/api/claims/:claimId/worklist"));
});

test("request logger redacts claim IDs from live enrichment routes", () => {
  const realtime = runRequest({ url: config.appPath("/api/claims/81047/realtime") });
  assert.equal(
    realtime.calls[0][2].path,
    config.appPath("/api/claims/:claimId/realtime"),
  );
});

test("request logger records aborted requests once", () => {
  const { calls, response } = runRequest({ event: "close", statusCode: 200 });
  response.emit("finish");

  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].outcome, "aborted");
});

test("request logger sends server errors to the error console", () => {
  const { calls } = runRequest({ statusCode: 503 });
  assert.equal(calls[0][0], "error");
});
