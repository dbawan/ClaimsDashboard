import test from "node:test";
import assert from "node:assert/strict";
import { buildClaimVitals } from "./claimVitalsService.js";

test("claim vitals calculate aging, financial estimates, and operational deadlines", () => {
  const result = buildClaimVitals({
    claim: { serviceDate: "2026-08-01" },
    claimVitalSources: {
      lastTransactionDate: "2026-08-20",
      originalCharge: 1_000,
      attempts: 3,
      payerNames: ["Aetna"],
    },
    cptFinancials: [{ procedure: "36000", units: 1, charged: 1_000 }],
    summary: { charges: 1_000, totalPaid: 200, adjustments: 150 },
    categorization: { totalInsuranceOwed: 850 },
    comments: [
      {
        category: "appeal_follow_up_or_status",
        createdAt: "2026-07-15T14:30:00Z",
      },
      {
        category: "general_claim_note",
        createdAt: "2026-08-27T14:30:00Z",
      },
    ],
  }, { referenceDate: "2026-08-28" });

  assert.deepEqual(result, {
    asOfDate: "2026-08-28",
    claimAgeDays: 27,
    daysSinceTouch: 1,
    lastTouchDate: "2026-08-27",
    outstandingArAmount: 650,
    originalCharge: 1_000,
    expectedReimbursement: 32.62,
    expectedReimbursementBreakdown: [{
      procedure: "36000",
      units: 1,
      charged: 1_000,
      ratePerUnit: 32.62,
      expected: 32.62,
      payer: "Aetna",
      canonicalPayer: "Aetna",
      matchType: "raw_payer",
    }],
    expectedReimbursementMatchedCptCount: 1,
    expectedReimbursementTotalCptCount: 1,
    expectedReimbursementComplete: true,
    expectedReimbursementPayer: "Aetna",
    paid: 200,
    attempts: 3,
    filingStartDate: "2026-08-01",
    filingStartReason: "service_date",
    filingLimitDate: "2026-10-30",
    filingLimitDaysLeft: 63,
    appealResponseDate: "2026-07-15",
    appealDeadline: "2026-10-30",
    appealDaysLeft: 63,
  });
});

test("the latest Salesforce comment resets days since touch", () => {
  const commentTouched = buildClaimVitals({
    claimVitalSources: { lastTransactionDate: "2026-08-20" },
    comments: [
      { category: "general_claim_note", createdAt: "2026-08-25T17:30:00Z" },
      { category: "general_claim_note", createdAt: "not-a-date" },
    ],
  }, { referenceDate: "2026-08-28" });
  assert.equal(commentTouched.lastTouchDate, "2026-08-25");
  assert.equal(commentTouched.daysSinceTouch, 3);

  const transactionTouched = buildClaimVitals({
    claimVitalSources: { lastTransactionDate: "2026-08-27" },
    comments: [{ category: "general_claim_note", date: "2026-08-25" }],
  }, { referenceDate: "2026-08-28" });
  assert.equal(transactionTouched.lastTouchDate, "2026-08-27");
  assert.equal(transactionTouched.daysSinceTouch, 1);
});

test("claim vitals leave unavailable source values null and show overdue deadlines", () => {
  const result = buildClaimVitals({
    claim: { serviceDate: "2026-01-01" },
    claimVitalSources: {
      lastTransactionDate: null,
      originalCharge: null,
      attempts: 0,
    },
    summary: { totalPaid: 0 },
    categorization: null,
    comments: [],
  }, { referenceDate: "2026-08-28" });

  assert.equal(result.claimAgeDays, 239);
  assert.equal(result.daysSinceTouch, null);
  assert.equal(result.outstandingArAmount, null);
  assert.equal(result.originalCharge, null);
  assert.equal(result.expectedReimbursement, null);
  assert.equal(result.paid, 0);
  assert.equal(result.attempts, 0);
  assert.equal(result.filingLimitDate, "2026-04-01");
  assert.equal(result.filingLimitDaysLeft, -149);
  assert.equal(result.appealDeadline, "2026-04-01");
  assert.equal(result.appealDaysLeft, -149);
});

test("filing clock resets from the latest recorded appeal or rebill across sources", () => {
  const lifecycle = {
    claim: { serviceDate: "2026-01-01" },
    claimVitalSources: { latestAppealRebillDate: "2026-08-01" },
    comments: [
      { category: "appeal_submitted", createdAt: "2026-07-15T14:30:00Z" },
      { category: "corrected_claim_or_rebill", createdAt: "2026-08-20T14:30:00Z" },
      { category: "appeal_submitted", createdAt: "2026-08-10T14:30:00Z" },
      { category: "appeal_planned_or_prepared", createdAt: "2026-08-25T14:30:00Z" },
      { category: "appeal_follow_up_or_status", createdAt: "2026-08-27T14:30:00Z" },
      { category: "appeal_submitted", date: null },
    ],
    timeline: [{ title: "Submission/correction/rebill observed", date: "2026-08-28" }],
  };
  const result = buildClaimVitals(lifecycle, { referenceDate: "2026-08-28" });
  assert.equal(result.filingStartDate, "2026-08-20");
  assert.equal(result.filingStartReason, "appeal_or_rebill");
  assert.equal(result.filingLimitDate, "2026-11-18");
  assert.equal(result.filingLimitDaysLeft, 82);
  assert.equal(result.claimAgeDays, 239);
  assert.equal(result.appealResponseDate, "2026-08-27");
  assert.equal(result.appealDeadline, result.filingLimitDate);
  assert.equal(result.appealDaysLeft, result.filingLimitDaysLeft);

  const laterTransaction = buildClaimVitals({
    ...lifecycle,
    claimVitalSources: { latestAppealRebillDate: "2026-08-25" },
  }, { referenceDate: "2026-08-28" });
  assert.equal(laterTransaction.filingStartDate, "2026-08-25");
  assert.equal(laterTransaction.filingLimitDate, "2026-11-23");
  assert.equal(laterTransaction.appealDeadline, "2026-11-23");
});

test("a submitted appeal resets an expired filing clock for exactly 90 calendar days", () => {
  const lifecycle = {
    claim: { serviceDate: "2026-01-01" },
    comments: [{ category: "appeal_submitted", date: "2026-09-01" }],
  };
  const reset = buildClaimVitals(lifecycle, { referenceDate: "2026-09-01" });
  assert.equal(reset.filingLimitDaysLeft, 90);
  assert.equal(reset.filingLimitDate, "2026-11-30");
  assert.equal(reset.appealDeadline, "2026-11-30");
  assert.equal(buildClaimVitals(lifecycle, { referenceDate: "2026-11-30" }).filingLimitDaysLeft, 0);
  assert.equal(buildClaimVitals(lifecycle, { referenceDate: "2026-12-01" }).filingLimitDaysLeft, -1);
});

test("filing date uses DOS when reset evidence is missing or older, and handles missing DOS", () => {
  const older = buildClaimVitals({
    claim: { serviceDate: "2026-09-01" },
    claimVitalSources: { latestAppealRebillDate: "2026-08-01" },
    comments: [{ category: "appeal_submitted", date: "2026-08-20" }],
  }, { referenceDate: "2026-09-03" });
  assert.equal(older.filingStartDate, "2026-09-01");
  assert.equal(older.filingStartReason, "service_date");
  assert.equal(older.filingLimitDaysLeft, 88);

  const missingDos = buildClaimVitals({
    comments: [{ category: "corrected_claim_or_rebill", date: "2026-09-01" }],
  }, { referenceDate: "2026-09-03" });
  assert.equal(missingDos.filingStartDate, "2026-09-01");
  assert.equal(missingDos.filingStartReason, "appeal_or_rebill");
  assert.equal(missingDos.filingLimitDaysLeft, 88);

  const unavailable = buildClaimVitals({}, { referenceDate: "2026-09-03" });
  assert.equal(unavailable.filingStartDate, null);
  assert.equal(unavailable.filingStartReason, null);
  assert.equal(unavailable.filingLimitDate, null);
  assert.equal(unavailable.filingLimitDaysLeft, null);
});

test("outstanding AR subtracts net paid and booked write-offs in cents, preserving credits and reversals", () => {
  for (const [summary, expected] of [
    [{ charges: 1_000, totalPaid: 200, adjustments: 150 }, 650],
    [{ charges: 0.3, totalPaid: 0.1, adjustments: 0.1 }, 0.1],
    [{ charges: 1_000, totalPaid: 800, adjustments: 250 }, -50],
    [{ charges: 1_000, totalPaid: -50, adjustments: -25 }, 1_075],
    [{ charges: 0, totalPaid: 0, adjustments: 0 }, 0],
    [{ charges: null, totalPaid: 0, adjustments: 0 }, null],
    [{ charges: 1_000, totalPaid: null, adjustments: 0 }, null],
    [{ charges: 1_000, totalPaid: 0 }, null],
    [{ charges: "invalid", totalPaid: 0, adjustments: 0 }, null],
  ]) {
    const result = buildClaimVitals({
      summary,
      categorization: { totalInsuranceOwed: 999 },
      comments: [{ category: "write_off_or_adjustment", text: "Write off $500" }],
    }, { referenceDate: "2026-09-03" });
    assert.equal(result.outstandingArAmount, expected, JSON.stringify(summary));
  }
});
