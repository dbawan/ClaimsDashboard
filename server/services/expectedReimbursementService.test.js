import test from "node:test";
import assert from "node:assert/strict";
import {
  buildExpectedReimbursementIndex,
  calculateExpectedReimbursement,
} from "./expectedReimbursementService.js";

function record(overrides = {}) {
  return {
    procedure_code: "99213",
    raw_payer: "Payer A, Inc.",
    canonical_payer_after_consolidation: "Payer Group",
    payer_category_after_consolidation: "Commercial",
    selected_rate_per_unit: "120.00",
    observed_detail_row_count: "10",
    selected_scope_training_row_count: "5",
    ...overrides,
  };
}

test("expected reimbursement totals payer/CPT rates by unit and caps each CPT at its charge", () => {
  const index = buildExpectedReimbursementIndex([
    record(),
    record({ procedure_code: "J1234", selected_rate_per_unit: "2.50" }),
    record({ procedure_code: "77777", selected_rate_per_unit: "" }),
  ]);
  const result = calculateExpectedReimbursement({
    payerNames: ["payer a inc"],
    cptFinancials: [
      { procedure: "99213", units: 2, charged: 200 },
      { procedure: "J1234", units: 3, charged: 20 },
      { procedure: "77777", units: 1, charged: 50 },
    ],
    index,
  });

  assert.equal(result.total, 207.5);
  assert.equal(result.matchedCptCount, 2);
  assert.equal(result.totalCptCount, 3);
  assert.equal(result.complete, false);
  assert.equal(result.payer, "Payer A, Inc.");
  assert.deepEqual(result.breakdown.map(({ procedure, ratePerUnit, expected, matchType }) => ({
    procedure,
    ratePerUnit,
    expected,
    matchType,
  })), [
    { procedure: "99213", ratePerUnit: 120, expected: 200, matchType: "raw_payer" },
    { procedure: "J1234", ratePerUnit: 2.5, expected: 7.5, matchType: "raw_payer" },
    { procedure: "77777", ratePerUnit: null, expected: null, matchType: "raw_payer" },
  ]);
});

test("canonical payer fallback uses the strongest supported rate deterministically", () => {
  const index = buildExpectedReimbursementIndex([
    record({ raw_payer: "Payer A", observed_detail_row_count: "10" }),
    record({ raw_payer: "Payer B", selected_rate_per_unit: "150", observed_detail_row_count: "30" }),
  ]);
  const result = calculateExpectedReimbursement({
    payerNames: ["Payer Group"],
    cptFinancials: [{ procedure: "99213", units: 1, charged: 500 }],
    index,
  });

  assert.equal(result.total, 150);
  assert.equal(result.breakdown[0].payer, "Payer B");
  assert.equal(result.breakdown[0].matchType, "canonical_payer");
  assert.equal(result.complete, true);
});

test("claims without a supported payer/CPT rate remain unavailable", () => {
  const index = buildExpectedReimbursementIndex([record()]);
  const result = calculateExpectedReimbursement({
    payerNames: ["Different Payer"],
    cptFinancials: [{ procedure: "99213", charged: 500 }],
    index,
  });

  assert.equal(result.total, null);
  assert.equal(result.breakdown[0].expected, null);
  assert.equal(result.breakdown[0].units, 1);
  assert.equal(result.matchedCptCount, 0);
});
