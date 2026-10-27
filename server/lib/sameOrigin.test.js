import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";
import { requireSameOrigin, SameOriginRequiredError } from "./sameOrigin.js";

function requestWithOrigin(origin) {
  return { get: (name) => name === "origin" ? origin : undefined };
}

test("same-origin middleware accepts only the configured application origin", () => {
  let allowed = false;
  requireSameOrigin(requestWithOrigin(config.appOrigin), {}, (error) => { allowed = !error; });
  assert.equal(allowed, true);

  let denied;
  requireSameOrigin(requestWithOrigin("https://attacker.example"), {}, (error) => { denied = error; });
  assert.ok(denied instanceof SameOriginRequiredError);
  assert.equal(denied.statusCode, 403);
});
