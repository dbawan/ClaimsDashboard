import test from "node:test";
import assert from "node:assert/strict";
import { claimIdFromLocation, claimWorkspaceUrl } from "./claimNavigation.js";

test("claim workspace links select the Claims view and preserve the app path", () => {
  assert.equal(
    claimWorkspaceUrl("78820", "https://dashboard.example/app?theme=compact#high-level"),
    "https://dashboard.example/app?theme=compact&claim=78820",
  );
});

test("claim IDs round-trip through an encoded workspace URL", () => {
  const url = claimWorkspaceUrl("ERA 123|A", "http://127.0.0.1:3001/#high-level");
  assert.equal(claimIdFromLocation(url), "ERA 123|A");
});
