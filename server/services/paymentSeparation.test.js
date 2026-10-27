import test from "node:test";
import assert from "node:assert/strict";
import { buildClaimLifecycle } from "./claimLifecycleService.js";
import { buildHighLevelDashboardResponse } from "./highLevelService.js";
import { advancedMdEraRows } from "../lib/eraReconciliation.js";
import { filterClaimLifecycleByPermissions } from "../permissions/claimAccess.js";
import { readAdvancedMdEra } from "../repositories/advancedMdEraRepository.js";
import { readPostedPayments } from "../repositories/postedPaymentRepository.js";
import { assertSelectOnly } from "../db/readOnlyPool.js";
import { paymentViewData, buildPaymentChartModel, buildCptPaymentModels } from "../../src/features/claims/paymentChartModel.js";
import { buildClaimStory } from "../../src/features/claims/claimStoryModel.js";

const tx = (overrides = {}) => ({
  EHR: "AMD", ENCOUNTERID: "80751", CLAIMID: 40500, PAYMENTCLAIMID: 500,
  CLAIMTRANSACTIONID: 1, CLAIMTRANSACTIONTYPENAME: "Claim created",
  POSTINGDATE: "2026-09-01", DATEOFSERVICE: "2026-09-01",
  PROCEDURECODE: "99213", Charges: 200, Amount: 0, ...overrides,
});
const era = (overrides = {}) => ({
  licenseKey: 161549, eraClaimId: 20, reportId: 10, visitId: "80751",
  reference: "80751A", payerClaimControl: "PAYER-CLAIM-1", payer: "Plan",
  traceNumber: "CHECK-1", eventDate: "2026-09-02", receivedAt: "2026-09-03",
  claimPaid: 100, detailId: 30, chargeId: "500", procedureCode: "99213",
  serviceDate: "2026-09-01", paid: 100, charge: 200, allowed: 120,
  patientResponsibility: 20, adjusted: 80, reason: "CO-45", ...overrides,
});
const sources = (overrides = {}) => ({
  claimId: "80751", transactions: [tx()], claimStatus: [], edi835: [],
  advancedMdEra: [era()], ...overrides,
});

test("an ERA receipt never creates a posted total, posting stage, or posted CPT amount", () => {
  const claim = buildClaimLifecycle(sources());
  assert.equal(claim.summary.receivedPaid, 100);
  assert.equal(claim.summary.totalPaid, 0);
  assert.equal(claim.summary.daysToPaid, null);
  assert.equal(claim.progress.find((step) => step.key === "payment-received").achieved, true);
  assert.equal(claim.progress.find((step) => step.key === "payment-posting").achieved, false);
  for (const [view, amount] of [["posted", 0], ["received", 100]]) {
    const data = paymentViewData(claim, view);
    const model = buildPaymentChartModel(data);
    const cpts = buildCptPaymentModels(data, model.eventGroups);
    assert.equal(cpts.find((cpt) => cpt.procedure === "99213").totalPaid, amount);
  }
});

test("later postings and their reversals use ledger dates without adding the ERA again", () => {
  const claim = buildClaimLifecycle(sources({ transactions: [tx(),
    tx({ CLAIMTRANSACTIONID: 2, CLAIMTRANSACTIONTYPENAME: "Applied payment", POSTINGDATE: "2026-09-05", Amount: 100 }),
    tx({ CLAIMTRANSACTIONID: 3, CLAIMTRANSACTIONTYPENAME: "Payment reversal", POSTINGDATE: "2026-09-06", Amount: -25 }),
  ] }));
  assert.equal(claim.summary.receivedPaid, 100);
  assert.equal(claim.summary.postedPaid, 75);
  assert.equal(claim.summary.totalPaid, 75);
  assert.equal(claim.summary.paidThresholdDate, "2026-09-05");
  assert.equal(claim.progress.find((step) => step.key === "payment-posting").detail, "2026-09-05");
  assert.equal(claim.timeline.reduce((sum, event) => sum + event.countedPayment, 0), 75);
  assert.equal(claim.timeline.reduce((sum, event) => sum + event.receivedPayment, 0), 100);
});

test("same-day receipt and posting stay separate in the story", () => {
  const claim = buildClaimLifecycle(sources({ transactions: [tx(),
    tx({ CLAIMTRANSACTIONID: 2, CLAIMTRANSACTIONTYPENAME: "Applied payment", POSTINGDATE: "2026-09-02", Amount: 100 }),
  ] }));
  const story = buildClaimStory(claim);
  assert.equal(story.find((step) => step.title === "Posted payment").amount, 100);
  assert.equal(story.find((step) => step.title === "Payment received").amount, 100);
});

test("AMD native charge IDs retain the 40000 offset and duplicate ERA sources count once", () => {
  const amd = [era({ detailId: 30, paid: 50 }), era({ detailId: 31, chargeId: "501", paid: 50 })];
  const legacy = {
    PatientControlNumber: "80751A", ClaimNumber: "PAYER-CLAIM-1",
    CheckEftTraceNumber: "CHECK-1", CheckEftDate: "2026-09-02",
    DateOfServiceStart: "2026-09-01", AdjudProcedure: "99213", Payment: 100,
  };
  const claim = buildClaimLifecycle(sources({ advancedMdEra: amd, claimStatus: [legacy], edi835: [{
    patient_control_number: "80751A", payer_claim_control: "PAYER-CLAIM-1",
    trace_number: "CHECK-1", payment_date: "20260902", service_date: "20260901",
    service_code: "99213", paid_amount: 100,
  }] }));
  assert.equal(claim.summary.receivedPaid, 100);
  assert.equal(claim.eras.length, 1);
  assert.equal(claim.eras[0].lineCount, 2);
  assert.deepEqual(claim.eras[0].observedSources, ["AdvancedMD ERA", "ClaimStatus ERA", "EDI 835 ERA"]);
  assert.deepEqual(advancedMdEraRows(amd).map((row) => row.flattenedClaimId), ["40500", "40501"]);
  assert.equal(claim.claim.encounterId, "80751");
});

test("claim-only ERAs and header differences are received once as unallocated amounts", () => {
  for (const [row, expected] of [
    [era({ detailId: null, paid: null, claimPaid: 125 }), 125],
    [era({ paid: 100, claimPaid: 125 }), 125],
    [era({ paid: -100, claimPaid: -125 }), -125],
  ]) {
    const claim = buildClaimLifecycle(sources({ advancedMdEra: [row] }));
    assert.equal(claim.summary.receivedPaid, expected);
    assert.equal(claim.summary.totalPaid, 0);
    assert.ok(claim.eras[0].serviceLines.some((line) => line.claimLevelOnly));
    assert.equal(claim.timeline.flatMap((event) => event.cptReceived).reduce((sum, line) => sum + line.paid, 0), expected);
  }
});

test("reused transaction IDs across source types do not suppress distinct ledger actions", () => {
  const paid = tx({ CLAIMTRANSACTIONID: 1, CLAIMTRANSACTIONTYPENAME: "Applied payment", Amount: 100 });
  const claim = buildClaimLifecycle(sources({ transactions: [tx(), paid, paid,
    tx({ CLAIMTRANSACTIONID: 1, CLAIMTRANSACTIONTYPENAME: "Payment reversal", Amount: -25 }),
  ] }));
  assert.equal(claim.summary.totalPaid, 75);
});

test("dashboard receipt and posting lines use separate dates and keep shared checks in separate claims", () => {
  const dashboard = buildHighLevelDashboardResponse({
    advancedMdEra: [era(), era({ eraClaimId: 21, reference: "80752A", visitId: "80752", paid: 100 })],
    postedRows: [{ reference: "80751", eventDate: "2026-09-05", procedureCode: "99213", paid: 100, payer: "Plan" }],
    ediRows: [{ reference: "80751A", eventDate: "2026-09-02", serviceDate: "2026-09-01", procedureCode: "99213", traceNumber: "CHECK-1", paid: 100, payer: "Plan" }],
  }, { start: "2026-09-01", end: "2026-09-06" });
  assert.equal(dashboard.totals.paid, 200);
  assert.equal(dashboard.totals.posted, 100);
  assert.equal(dashboard.daily.find((day) => day.date === "2026-09-02").posted, 0);
  assert.equal(dashboard.daily.find((day) => day.date === "2026-09-05").paid, 0);
  assert.equal(dashboard.daily.find((day) => day.date === "2026-09-02").paidClaims.length, 2);
});

test("receipt amounts and the new stage respect existing financial permissions", () => {
  const filtered = filterClaimLifecycleByPermissions(buildClaimLifecycle(sources()), { claimOverview: true });
  assert.equal(filtered.summary.receivedPaid, undefined);
  assert.equal(filtered.eras, undefined);
  assert.ok(filtered.progress.every((step) => !["payment-received", "payment-posting"].includes(step.key)));
  assert.ok(!filtered.provenance.sources.includes("AdvancedMD ERA"));
  assert.equal(filtered.provenance.advancedMdEraRows, 0);
});

test("new repositories use guarded SELECT queries and reject numeric lookalike claim references", async () => {
  const queries = [];
  const session = { async select(sql, parameters) {
    assertSelectOnly(sql);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b/i);
    queries.push({ sql, parameters });
    return /ReportClaim/.test(sql) ? [era(), era({ reference: "807510" }), era({ visitId: "99999" })] : [];
  } };
  assert.equal((await readAdvancedMdEra(session, { claimIds: ["80751"] })).length, 1);
  assert.match(queries[0].sql, /LEFT JOIN.*ReportDetail/);
  assert.doesNotMatch(queries[0].sql, /Display\s*=|Posted\s*=/);
  await readPostedPayments(session, { start: "2026-09-01", end: "2026-09-06" });
  assert.match(queries[1].sql, /Amount AS paid/);
  assert.match(queries[1].sql, /POSTINGDATE >= \?/);
  assert.equal(queries.length, 2);
});
