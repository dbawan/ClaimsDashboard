import test from "node:test";
import assert from "node:assert/strict";
import { appViewFromLocation } from "./appView.js";

test("the application lands on High Level without arguments and keeps claim deep links", () => {
  assert.equal(appViewFromLocation("https://apps.example/dashboardapp/"), "high-level");
  assert.equal(appViewFromLocation("https://apps.example/dashboardapp/?claim=82020"), "claims");
  assert.equal(appViewFromLocation("https://apps.example/dashboardapp/#claims"), "claims");
  assert.equal(appViewFromLocation("https://apps.example/dashboardapp/?claim=82020#high-level"), "high-level");
});
