import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAgingResponse,
  buildHighLevelDashboardResponse,
  buildHighLevelResponse,
  getClaimsWithoutResponse,
  getHighLevelDashboard,
  getHighLevelClaims,
  getUnsubmittedAppointments,
  MYSQL_HIGH_LEVEL_CACHE_TTL_MS,
} from "./highLevelService.js";

test("high-level MySQL results remain cached for 24 hours", () => {
  assert.equal(MYSQL_HIGH_LEVEL_CACHE_TTL_MS, 24 * 60 * 60 * 1_000);
});

test("dashboard aggregates daily billed and deduplicated authoritative payments", () => {
  const response = buildHighLevelDashboardResponse({
    billedRows: [
      { date: "2026-07-01", claimId: "100", procedureCode: "78802", charge: 300, patientName: "Patient A", payer: "Plan" },
      { date: "2026-07-01", claimId: "101", procedureCode: "77300", charge: 200, patientName: "Patient B", payer: "Plan" },
      { date: "2026-07-03", claimId: "102", procedureCode: "78802", charge: 100, patientName: "Patient C", payer: "Other" },
    ],
    claimStatusRows: [
      { reference: "100A", eventDate: "2026-07-02", serviceDate: "2026-07-01", procedureCode: "78802", charge: 500, paid: 100, payer: "Plan", traceNumber: "TRACE-1" },
      { reference: "1001A", eventDate: "2026-07-03", serviceDate: "2026-07-01", procedureCode: "77300", charge: 300, paid: 0, reason: "CO45", payer: "Plan", traceNumber: "TRACE-2" },
      { reference: "103A", eventDate: "2026-07-03", serviceDate: "2026-07-01", procedureCode: "78802", charge: 100, paid: -20, payer: "Plan", traceNumber: "TRACE-4" },
    ],
    ediRows: [
      { reference: "100A", eventDate: "20260702", serviceDate: "20260701", procedureCode: "78802", charge: 500, paid: 100, payer: "Plan", traceNumber: "TRACE-1" },
      { reference: "1001A", eventDate: "20260703", serviceDate: "20260701", procedureCode: "77300", charge: 300, paid: 0, reason: '[{"group":"CO","reason":"45"}]', payer: "Plan", traceNumber: "TRACE-2" },
      { reference: "102A", eventDate: "20260703", serviceDate: "20260701", procedureCode: "78802", charge: 100, paid: 25, payer: "Other", traceNumber: "TRACE-3" },
    ],
    latestDeniedBilledRows: [
      { claimId: "1001", procedureCode: "77300", date: "2026-07-04", charge: 275 },
    ],
  }, { start: "2026-07-01", end: "2026-07-03" });

  assert.equal(response.totals.billed, 600);
  assert.equal(response.totals.paid, 125);
  assert.equal(response.totals.recouped, -20);
  assert.equal(response.totals.deniedLines, 1);
  assert.deepEqual(response.payerOptions, [
    { key: "PLAN", label: "Plan", claimCount: 4 },
    { key: "OTHER", label: "Other", claimCount: 1 },
  ]);
  assert.deepEqual(response.deniedCpts, [{
    procedure: "77300",
    count: 1,
    averageBilled: 275,
    claims: [{ claimId: "1001A", billed: 275, latestBillingDate: "2026-07-04" }],
  }]);
  assert.deepEqual(response.denialReasons, [{
    reason: "CO-45",
    count: 1,
    cpts: [{ procedure: "77300", count: 1 }],
  }]);
  assert.deepEqual(response.daily.map((point) => [point.date, point.billed, point.paid, point.recouped]), [
    ["2026-07-01", 500, 0, 0],
    ["2026-07-02", 0, 100, 0],
    ["2026-07-03", 100, 25, -20],
  ]);
  assert.deepEqual(response.daily[0].cpts, [
    { procedure: "78802", count: 1, billed: 300 },
    { procedure: "77300", count: 1, billed: 200 },
  ]);
  assert.deepEqual(response.daily[0].claims.map((claim) => [claim.claimId, claim.billed, claim.procedures]), [
    ["100", 300, ["78802"]],
    ["101", 200, ["77300"]],
  ]);
  assert.equal(response.daily[2].paymentLineCount, 3);
  assert.equal(response.daily[2].deniedLineCount, 1);
  assert.deepEqual(response.daily[1].paidClaims, [{
    claimId: "100A",
    payer: "PLAN",
    serviceDate: "2026-07-01",
    paid: 100,
    procedures: ["78802"],
  }]);
  assert.deepEqual(response.daily[2].paidClaims.map((claim) => [claim.claimId, claim.paid]), [["102A", 25]]);
  assert.deepEqual(response.daily[2].recoupedClaims, [{
    claimId: "103A",
    payer: "PLAN",
    serviceDate: "2026-07-01",
    recouped: -20,
    procedures: ["78802"],
  }]);

  const otherPayer = buildHighLevelDashboardResponse({
    billedRows: [
      { date: "2026-07-01", claimId: "100", procedureCode: "78802", charge: 300, payer: "Plan" },
      { date: "2026-07-03", claimId: "102", procedureCode: "78802", charge: 100, payer: "Other" },
    ],
    claimStatusRows: [
      { reference: "100A", eventDate: "2026-07-02", procedureCode: "78802", charge: 500, paid: 100, payer: "Plan", traceNumber: "TRACE-1" },
    ],
    ediRows: [
      { reference: "102A", eventDate: "20260703", procedureCode: "78802", charge: 100, paid: 25, payer: "Other", traceNumber: "TRACE-3" },
    ],
  }, {
    start: "2026-07-01",
    end: "2026-07-03",
    payers: ["OTHER"],
  });

  assert.deepEqual(otherPayer.selectedPayers, ["OTHER"]);
  assert.equal(otherPayer.totals.billed, 100);
  assert.equal(otherPayer.totals.paid, 25);
  assert.deepEqual(otherPayer.daily.map((point) => [point.billed, point.paid]), [
    [0, 0],
    [0, 0],
    [100, 25],
  ]);
  assert.deepEqual(otherPayer.payerOptions.map((payer) => payer.key), ["OTHER", "PLAN"]);
});

test("dashboard nets a same-day replacement payment against its related recoupment", () => {
  const response = buildHighLevelDashboardResponse({
    billedRows: [],
    claimStatusRows: [
      {
        reference: "77940A",
        eventDate: "2026-08-04",
        serviceDate: "2025-12-30",
        procedureCode: "78835",
        paid: -60204.26,
        payer: "Novitas Solutions, Inc.",
        traceNumber: "888713464",
      },
      {
        reference: "77940A",
        eventDate: "2026-08-04",
        serviceDate: "2025-12-30",
        procedureCode: "78835",
        paid: 48216.39,
        payer: "Novitas Solutions, Inc.",
        traceNumber: "888713464",
      },
      {
        reference: "OTHER1A",
        eventDate: "2026-08-04",
        serviceDate: "2026-07-01",
        procedureCode: "77300",
        paid: 250,
        payer: "Another payer",
        traceNumber: "OTHER-TRACE",
      },
    ],
    ediRows: [],
  }, { start: "2026-08-04", end: "2026-08-04" });

  assert.equal(response.totals.paid, 250);
  assert.equal(response.totals.recouped, -11987.87);
  assert.equal(response.daily[0].paid, 250);
  assert.equal(response.daily[0].recouped, -11987.87);
  assert.deepEqual(response.daily[0].paidClaims.map((claim) => [claim.claimId, claim.paid]), [
    ["OTHER1A", 250],
  ]);
  assert.deepEqual(response.daily[0].recoupedClaims.map((claim) => [claim.claimId, claim.recouped]), [
    ["77940A", -11987.87],
  ]);
});

test("dashboard latest and original billing modes select the correct claim-family member", () => {
  const result = {
    billedRows: [
      { date: "2026-07-01", claimId: "123", submissionOrder: 0, latestSubmissionOrder: 2, procedureCode: "A", charge: 100 },
      { date: "2026-07-02", claimId: "123", submissionOrder: 1, latestSubmissionOrder: 2, procedureCode: "A", charge: 150 },
      { date: "2026-07-03", claimId: "123", submissionOrder: 2, latestSubmissionOrder: 2, procedureCode: "A", charge: 200 },
      { date: "2026-07-03", claimId: "123", submissionOrder: 2, latestSubmissionOrder: 2, procedureCode: "B", charge: 50 },
      { date: "2026-07-01", claimId: "999", submissionOrder: 0, latestSubmissionOrder: 0, procedureCode: "C", charge: 75 },
    ],
    originalRows: [
      { date: "2026-07-01", claimId: "123", procedureCode: "A", charge: 90 },
      { date: "2026-07-02", claimId: "999", procedureCode: "C", charge: 70 },
    ],
    claimStatusRows: [],
    ediRows: [],
  };

  const all = buildHighLevelDashboardResponse(result, {
    start: "2026-07-01",
    end: "2026-07-03",
    billingMode: "all",
  });
  const latest = buildHighLevelDashboardResponse(result, {
    start: "2026-07-01",
    end: "2026-07-03",
    billingMode: "latest",
  });
  const original = buildHighLevelDashboardResponse(result, {
    start: "2026-07-01",
    end: "2026-07-03",
    billingMode: "original",
  });

  assert.equal(all.totals.billed, 575);
  assert.deepEqual(all.daily.flatMap((point) => point.claims.map((claim) => claim.claimId)), ["123", "999", "123A", "123B"]);
  assert.equal(latest.billingMode, "latest");
  assert.equal(latest.totals.billed, 325);
  assert.deepEqual(latest.daily.map((point) => point.billed), [75, 0, 250]);
  assert.deepEqual(latest.daily.flatMap((point) => point.claims.map((claim) => claim.claimId)), ["999", "123B"]);
  assert.equal(original.billingMode, "original");
  assert.equal(original.totals.billed, 160);
  assert.deepEqual(original.daily.map((point) => point.billed), [90, 70, 0]);
  assert.deepEqual(original.daily.flatMap((point) => point.claims.map((claim) => claim.claimId)), ["123", "999"]);
});

test("high-level response derives pending and paid current states", () => {
  const response = buildHighLevelResponse({
    total: 2,
    claims: [
      { claimId: "100", serviceDate: "2026-08-01" },
      { claimId: "101", serviceDate: "2026-08-01" },
    ],
    events: [
      { claimId: "100", date: "2026-08-02", status: "submitted", label: "Submitted" },
      { claimId: "101", date: "2026-08-02", status: "submitted", label: "Submitted" },
      { claimId: "101", date: "2026-08-10", status: "paid", label: "Paid" },
    ],
  }, { start: "2026-08-01", end: "2026-08-31", limit: 25, sort: "paid-percent" });

  assert.equal(response.claims[0].currentStatus, "pending");
  assert.equal(response.claims[1].currentStatus, "paid");
  assert.equal(response.limit, 25);
  assert.equal(response.sort, "paid-percent");
});

test("high-level action claims expose their specific current issue", () => {
  const response = buildHighLevelResponse({
    total: 1,
    claims: [{ claimId: "102", serviceDate: "2026-08-01" }],
    events: [
      { claimId: "102", date: "2026-08-02", status: "submitted", label: "Submitted" },
      { claimId: "102", date: "2026-08-04", status: "action", label: "Denied: CO-45" },
    ],
  }, { start: "2026-08-01", end: "2026-08-31", limit: 25 });

  assert.equal(response.claims[0].currentStatus, "action");
  assert.equal(response.claims[0].issueLabel, "Denied: CO-45");
});

test("aging response uses service date for unsubmitted and submission date for no response", () => {
  const unsubmitted = buildAgingResponse({
    truncated: false,
    items: [{ claimId: "1", serviceDate: "2026-08-01" }],
  }, "unsubmitted", "2026-08-18");
  const noResponse = buildAgingResponse({
    truncated: false,
    items: [{ claimId: "2", submittedDate: "2026-08-08" }],
  }, "no-response", "2026-08-18");

  assert.equal(unsubmitted.items[0].elapsedDays, 17);
  assert.equal(noResponse.items[0].elapsedDays, 10);

  const youngestFirst = buildAgingResponse({
    truncated: false,
    items: [
      { claimId: "1", serviceDate: "2026-08-01" },
      { claimId: "2", serviceDate: "2026-08-15" },
    ],
  }, "unsubmitted", "2026-08-18", { order: "youngest", scope: "recent" });
  assert.deepEqual(youngestFirst.items.map((item) => item.claimId), ["2", "1"]);
  assert.equal(youngestFirst.scope, "recent");
});

test("invalid high-level filters fail before database access", async () => {
  await assert.rejects(
    getHighLevelClaims({ start: "2026-09-01", end: "2026-08-01", limit: "25" }),
    /Start date must be on or before end date/,
  );
  await assert.rejects(
    getHighLevelClaims({ start: "2026-08-01", end: "2026-08-31", limit: "500" }),
    /Rows must be 10, 25, 50, or 100/,
  );
  await assert.rejects(
    getHighLevelClaims({ start: "2026-08-01", end: "2026-08-31", limit: "25", sort: "unknown" }),
    /valid claim sort/,
  );
  await assert.rejects(getUnsubmittedAppointments({ order: "sideways" }), /valid queue order/);
  await assert.rejects(getClaimsWithoutResponse({ scope: "recent" }), /valid queue age filter/);
  await assert.rejects(
    getUnsubmittedAppointments({ start: "2026-09-01", end: "2026-08-01" }),
    /Start date must be on or before end date/,
  );
  await assert.rejects(
    getClaimsWithoutResponse({ start: "2026-08-01", end: "2036-08-01" }),
    /Queue ranges cannot exceed 3,650 days/,
  );
  await assert.rejects(
    getHighLevelDashboard({ start: "2010-01-01", end: "2026-08-31" }),
    /cannot exceed 3,650 days/,
  );
  await assert.rejects(
    getHighLevelDashboard({ start: "2026-08-01", end: "2026-08-31", billingMode: "earliest" }),
    /valid dashboard billing mode/,
  );
});
