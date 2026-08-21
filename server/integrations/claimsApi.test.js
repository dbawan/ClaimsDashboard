import test from "node:test";
import assert from "node:assert/strict";
import { readCategorizedClaim } from "./claimsApi.js";

const settings = Object.freeze({
  configured: true,
  baseUrl: "https://claims.example.test/api/v1",
  apiKey: "server-secret",
  workflow: "presubmission",
  timeoutMs: 1_000,
});

test("categorized claim lookup uses the exact claim endpoint and server API key", async () => {
  let request;
  const result = await readCategorizedClaim("CLAIM/123", {
    settings,
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return new Response(JSON.stringify({
        claim: {
          claim_id: "CLAIM/123",
          rcm_case_id: "CASE-9",
          category: { label: "timely_filing", display: "Timely Filing" },
          normalized_reason: "filing_deadline_exceeded",
          reason_display: "Filing Deadline Exceeded",
          confidence: 0.94,
          requires_human_review: false,
          carc_codes: ["29", "29"],
          rarc_codes: ["N211"],
          total_charge_amount: "1200.00",
          line_items: [{ line_item_id: "LINE-1", cpt_code: "99214", owed_amount: "850" }],
          notes: [{ source_id: "NOTE-1", follow_up_action: "Submit appeal" }],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  assert.equal(request.url, "https://claims.example.test/api/v1/claims/CLAIM%2F123?workflow=presubmission");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.headers["X-API-Key"], "server-secret");
  assert.equal(result.integration.status, "ready");
  assert.equal(result.claim.category.display, "Timely Filing");
  assert.equal(result.claim.confidence, 0.94);
  assert.deepEqual(result.claim.carcCodes, ["29"]);
  assert.equal(result.claim.lineItems[0].owedAmount, 850);
  assert.equal(result.claim.notes[0].followUpAction, "Submit appeal");
});

test("missing Claims API credentials do not make a network request", async () => {
  let called = false;
  const result = await readCategorizedClaim("123", {
    settings: { ...settings, configured: false, apiKey: "" },
    fetchImpl: async () => {
      called = true;
      throw new Error("should not run");
    },
  });

  assert.equal(called, false);
  assert.equal(result.integration.status, "not_configured");
  assert.equal(result.claim, null);
});

test("Claims API errors remain isolated from the primary claim lifecycle", async () => {
  const unauthorized = await readCategorizedClaim("123", {
    settings,
    fetchImpl: async () => new Response('{"error":"unauthorized"}', { status: 401 }),
  });
  const missing = await readCategorizedClaim("123", {
    settings,
    fetchImpl: async () => new Response('{"error":"claim_not_found"}', { status: 404 }),
  });

  assert.equal(unauthorized.integration.status, "misconfigured");
  assert.equal(missing.integration.status, "not_found");
  assert.equal(unauthorized.claim, null);
  assert.equal(missing.claim, null);
});
