import test from "node:test";
import assert from "node:assert/strict";
import { enrichClaimWithCategorization } from "./claimCategorizationService.js";

const lifecycle = Object.freeze({
  claim: { claimId: "80751" },
  provenance: { sources: ["FlattenTransctions2"] },
});

test("categorized claim enrichment adds ready data and source provenance", async () => {
  const result = await enrichClaimWithCategorization(lifecycle, {
    readClaim: async (claimId) => ({
      claim: { claimId, category: { display: "Timely Filing" } },
      integration: { status: "ready", source: "RCM Claims API", message: "Loaded" },
    }),
  });

  assert.equal(result.categorization.claimId, "80751");
  assert.equal(result.categorizationIntegration.status, "ready");
  assert.deepEqual(result.provenance.sources, ["FlattenTransctions2", "RCM Claims API"]);
});

test("categorized claim enrichment converts unexpected errors to an isolated status", async () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const result = await enrichClaimWithCategorization(lifecycle, {
      readClaim: async () => { throw new Error("network down"); },
    });
    assert.equal(result.categorization, null);
    assert.equal(result.categorizationIntegration.status, "error");
    assert.deepEqual(result.provenance.sources, ["FlattenTransctions2"]);
  } finally {
    console.error = originalConsoleError;
  }
});
