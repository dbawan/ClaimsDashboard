import test from "node:test";
import assert from "node:assert/strict";
import { filterClaimLifecycleByPermissions } from "./claimAccess.js";

function lifecycleFixture() {
  return {
    claim: {
      claimId: "78820",
      encounterId: "78820",
      status: "Paid",
      patientName: "Jane Doe",
      payer: "Example Health",
      submissionReferences: ["78820A"],
      salesforceStatus: "In Process",
    },
    summary: { charges: 100, totalPaid: 80, balance: 20, commentCount: 1 },
    timeline: [
      { id: "overview", eventType: "billed", paymentAuthority: "informational", amount: null, countedPayment: 0 },
      { id: "payment", eventType: "era", paymentAuthority: "era", amount: 80, countedPayment: 80 },
      { id: "comment", eventType: "salesforce-comment", paymentAuthority: "informational", amount: null, countedPayment: 0 },
    ],
    progress: [
      { key: "visit-scheduled", state: "complete" },
      { key: "prior-auth", state: "complete" },
      { key: "adjudicated", state: "complete" },
      { key: "payment-posting", state: "current" },
    ],
    warnings: ["warning"],
    eras: [{ id: "era-1" }],
    cptFinancials: [{ procedure: "A9607" }],
    priorAuthorizations: [{ id: "auth-1" }],
    patientInvoices: [{ id: "invoice-1" }],
    invoiceIntegration: { status: "ready" },
    comments: [{ id: "comment-1" }],
    commentIntegration: { status: "ready" },
    categorization: { category: { display: "Denial" } },
    categorizationIntegration: { status: "ready" },
    claimVitals: {
      asOfDate: "2026-08-28",
      claimAgeDays: 27,
      daysSinceTouch: 8,
      lastTouchDate: "2026-08-20",
      outstandingArAmount: 850,
      originalCharge: 1_000,
      expectedReimbursement: 800,
      expectedReimbursementBreakdown: [{
        procedure: "A9607",
        units: 1,
        charged: 1_000,
        ratePerUnit: 800,
        expected: 800,
        payer: "Example Health",
        canonicalPayer: "Example Health Group",
        matchType: "raw_payer",
      }],
      expectedReimbursementMatchedCptCount: 1,
      expectedReimbursementTotalCptCount: 1,
      expectedReimbursementComplete: true,
      expectedReimbursementPayer: "Example Health",
      paid: 80,
      attempts: 2,
      filingStartDate: "2026-08-20",
      filingStartReason: "appeal_or_rebill",
      filingLimitDate: "2026-11-18",
      filingLimitDaysLeft: 82,
      appealResponseDate: "2026-07-15",
      appealDeadline: "2026-11-18",
      appealDaysLeft: 82,
    },
    provenance: {
      sources: ["Transactions", "ClaimStatus ERA", "Salesforce comments"],
      transactionRows: 2,
      claimStatusRows: 1,
      edi835Rows: 1,
      priorAuthorizationRows: 1,
      patientInvoiceRows: 1,
      salesforceCases: 1,
      salesforceComments: 1,
      categorizedComments: 1,
      duplicatesRemoved: 1,
      eraMatchedPostings: 1,
      paymentRule: "ERA is authoritative",
      matchRule: "Exact claim family",
    },
  };
}

test("claim overview excludes financial and supporting-record payloads", () => {
  const result = filterClaimLifecycleByPermissions(lifecycleFixture(), {
    claimOverview: true,
    paymentsAndEra: false,
    supportingRecords: false,
    worklistAccess: false,
    worklistManagement: true,
  });

  assert.equal(result.claim.patientName, "Jane Doe");
  assert.equal("salesforceStatus" in result.claim, false);
  assert.deepEqual(result.timeline.map(({ id }) => id), ["overview"]);
  assert.deepEqual(result.progress.map(({ key }) => key), ["visit-scheduled", "adjudicated"]);
  assert.equal(result.progress.at(-1).state, "current");
  assert.equal("eras" in result, false);
  assert.equal("comments" in result, false);
  assert.equal("priorAuthorizations" in result, false);
  assert.equal("totalPaid" in result.summary, false);
  assert.equal(result.claimVitals.claimAgeDays, 27);
  assert.equal(result.claimVitals.paid, null);
  assert.equal(result.claimVitals.outstandingArAmount, null);
  assert.equal(result.claimVitals.filingStartDate, "2026-08-20");
  assert.equal(result.claimVitals.filingStartReason, "appeal_or_rebill");
  assert.equal(result.claimVitals.appealDeadline, "2026-11-18");
  assert.equal(result.access.worklistAccess, true);
  assert.equal(result.access.worklistManagement, true);
});

test("worklist access exposes checklist use without management controls", () => {
  const result = filterClaimLifecycleByPermissions(lifecycleFixture(), {
    claimOverview: true,
    paymentsAndEra: false,
    supportingRecords: false,
    worklistAccess: true,
    worklistManagement: false,
  });

  assert.equal(result.access.worklistAccess, true);
  assert.equal(result.access.worklistManagement, false);
});

test("payments and ERA exposes only financial claim data", () => {
  const result = filterClaimLifecycleByPermissions(lifecycleFixture(), {
    claimOverview: false,
    paymentsAndEra: true,
    supportingRecords: false,
  });

  assert.equal("patientName" in result.claim, false);
  assert.equal("salesforceStatus" in result.claim, false);
  assert.equal(result.summary.totalPaid, 80);
  assert.deepEqual(result.timeline.map(({ id }) => id), ["payment"]);
  assert.deepEqual(result.eras, [{ id: "era-1" }]);
  assert.deepEqual(result.cptFinancials, [{ procedure: "A9607" }]);
  assert.equal("comments" in result, false);
  assert.deepEqual(result.progress, []);
  assert.equal(result.claimVitals.paid, 80);
  assert.equal(result.claimVitals.originalCharge, 1_000);
  assert.equal(result.claimVitals.expectedReimbursement, 800);
  assert.equal(result.claimVitals.expectedReimbursementPayer, null);
  assert.equal(result.claimVitals.expectedReimbursementBreakdown[0].payer, null);
  assert.equal(result.claimVitals.expectedReimbursementBreakdown[0].canonicalPayer, null);
  assert.equal(result.claimVitals.expectedReimbursementMatchedCptCount, 1);
  assert.equal(result.claimVitals.expectedReimbursementComplete, true);
  assert.equal(result.claimVitals.outstandingArAmount, 850);
  assert.equal(result.claimVitals.claimAgeDays, null);
  assert.equal(result.claimVitals.filingStartDate, null);
  assert.equal(result.claimVitals.filingStartReason, null);
});

test("supporting records exposes notes and linked records without financial data", () => {
  const result = filterClaimLifecycleByPermissions(lifecycleFixture(), {
    claimOverview: false,
    paymentsAndEra: false,
    supportingRecords: true,
  });

  assert.equal("patientName" in result.claim, false);
  assert.equal(result.claim.salesforceStatus, "In Process");
  assert.equal(result.claim.status, "Claim located");
  assert.deepEqual(result.timeline.map(({ id }) => id), ["comment"]);
  assert.deepEqual(result.comments, [{ id: "comment-1" }]);
  assert.deepEqual(result.priorAuthorizations, [{ id: "auth-1" }]);
  assert.deepEqual(result.patientInvoices, [{ id: "invoice-1" }]);
  assert.equal("eras" in result, false);
  assert.equal("totalPaid" in result.summary, false);
  assert.equal(result.claimVitals.outstandingArAmount, null);
  assert.equal(result.claimVitals.appealDeadline, "2026-11-18");
  assert.equal(result.claimVitals.paid, null);
});
