import test from "node:test";
import assert from "node:assert/strict";
import { fetchHighLevelClaimIcu, fetchHighLevelClaims, fetchHighLevelDashboard } from "./api.js";

test("High Level requests preserve CPT filters with pagination, billing mode and payer filters", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (path) => {
    requests.push(new URL(path, "http://localhost"));
    return { ok: true, status: 200, json: async () => ({ claims: [] }) };
  });
  const range = { start: "2026-09-01", end: "2026-09-10" };
  await fetchHighLevelClaims({ ...range, limit: 25, page: 2, sort: "billed", procedureQuery: "A96" });
  await fetchHighLevelDashboard({ ...range, billingMode: "latest", payers: ["PLAN A"], procedureQuery: "78802" });
  await fetchHighLevelClaims({ ...range, limit: 25, sort: "youngest", procedureQuery: "" });
  await fetchHighLevelDashboard(range);

  assert.equal(requests[0].pathname, "/api/high-level/claims");
  assert.equal(requests[0].searchParams.get("page"), "2");
  assert.equal(requests[0].searchParams.get("procedureQuery"), "A96");
  assert.equal(requests[1].pathname, "/api/high-level/dashboard");
  assert.equal(requests[1].searchParams.get("procedureQuery"), "78802");
  assert.equal(requests[1].searchParams.get("billingMode"), "latest");
  assert.deepEqual(requests[1].searchParams.getAll("payer"), ["PLAN A"]);
  assert.equal(requests[2].searchParams.get("page"), "1");
  assert.equal(requests[2].searchParams.has("procedureQuery"), false);
  assert.equal(requests[3].searchParams.has("procedureQuery"), false);
});

test("Claim ICU requests preserve priority, paging, and expired-deadline inclusion", async (t) => {
  let request;
  t.mock.method(globalThis, "fetch", async (path) => {
    request = new URL(path, "http://localhost");
    return { ok: true, status: 200, json: async () => ({ claims: [] }) };
  });

  await fetchHighLevelClaimIcu({
    limit: 50,
    page: 3,
    sort: "cpt-charged",
    includePastDeadline: true,
    procedureQuery: "A9596",
  });

  assert.equal(request.pathname, "/api/high-level/claim-icu");
  assert.equal(request.searchParams.get("limit"), "50");
  assert.equal(request.searchParams.get("page"), "3");
  assert.equal(request.searchParams.get("sort"), "cpt-charged");
  assert.equal(request.searchParams.get("includePastDeadline"), "true");
  assert.equal(request.searchParams.get("procedureQuery"), "A9596");
});
