import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAgingResponse,
  buildClaimIcuResponse,
  buildHighLevelDashboardResponse,
  buildHighLevelResponse,
  getClaimsWithoutResponse,
  getClaimIcu,
  getHighLevelDashboard,
  getHighLevelClaims,
  getUnsubmittedAppointments,
  highLevelProcedureQuery,
  MYSQL_HIGH_LEVEL_CACHE_TTL_MS,
} from "./highLevelService.js";
import { createTtlCache } from "../lib/ttlCache.js";

test("high-level MySQL results remain cached for six hours", () => {
  assert.equal(MYSQL_HIGH_LEVEL_CACHE_TTL_MS, 6 * 60 * 60 * 1_000);
});

test("high-level CPT searches normalize partial codes and reject unsafe or repeated values", async () => {
  assert.equal(highLevelProcedureQuery(" a96 "), "A96");
  assert.equal(highLevelProcedureQuery("78802"), "78802");
  assert.equal(highLevelProcedureQuery("  "), "");
  assert.equal(highLevelProcedureQuery(), "");
  for (const procedureQuery of ["A96%", "788_", "788 OR 1=1", "A".repeat(21), ["78802", "A9607"], {}]) {
    assert.throws(() => highLevelProcedureQuery(procedureQuery), { statusCode: 400 });
    for (const load of [getHighLevelClaims, getHighLevelDashboard]) {
      await assert.rejects(load({ start: "2026-09-01", end: "2026-09-10", procedureQuery }), { statusCode: 400 });
    }
  }
});

test("dashboard CPT search filters financial lines, denials and date details together with payer selection", () => {
  const result = {
    billedRows: [
      { date: "2026-09-01", claimId: "1000", procedureCode: "A9607", charge: 1000, payer: "Plan A" },
      { date: "2026-09-01", claimId: "1000", procedureCode: "78802", charge: 200, payer: "Plan A" },
      { date: "2026-09-01", claimId: "200", procedureCode: "A9607", charge: 400, payer: "Plan B" },
      { date: "2026-09-01", claimId: "300", procedureCode: "77300", charge: 1000, payer: "Plan A" },
    ],
    claimStatusRows: [
      { reference: "1000A", eventDate: "2026-09-05", procedureCode: "A9607", paid: 500, payer: "Plan A" },
      { reference: "1000A", eventDate: "2026-09-05", procedureCode: "78802", paid: 100, payer: "Plan A" },
      { reference: "1000A", eventDate: "2026-09-06", procedureCode: "A9607", paid: -50, payer: "Plan A" },
      { reference: "1000B", eventDate: "2026-09-07", procedureCode: "A9607", charge: 1000, paid: 0, reason: "CO-45", payer: "Plan A" },
      { reference: "300A", eventDate: "2026-09-07", procedureCode: "77300", charge: 1000, paid: 0, reason: "CO-16", payer: "Plan A" },
      { reference: "200A", eventDate: "2026-09-05", procedureCode: "A9607", paid: 200, payer: "Plan B" },
    ],
    latestDeniedBilledRows: [{ claimId: "1000", procedureCode: "A9607", charge: 950, date: "2026-09-01" }],
  };
  const filters = { start: "2026-09-01", end: "2026-09-10" };
  const response = buildHighLevelDashboardResponse(result, { ...filters, procedureQuery: " a96 ", payers: ["PLAN A"] });
  assert.equal(response.procedureQuery, "A96");
  assert.deepEqual(response.totals, { billed: 1000, paid: 500, posted: 0, recouped: -50, claimsBilled: 1, deniedLines: 1 });
  assert.deepEqual(response.deniedCpts.map(({ procedure, averageBilled }) => [procedure, averageBilled]), [["A9607", 950]]);
  assert.deepEqual(response.denialReasons.map(({ reason }) => reason), ["CO-45"]);
  for (const point of response.daily) {
    assert.ok(point.cpts.every(({ procedure }) => procedure === "A9607"));
    assert.ok([...point.claims, ...point.paidClaims, ...point.recoupedClaims].every(({ procedures }) => procedures.every((code) => code === "A9607")));
  }
  const noMatch = buildHighLevelDashboardResponse(result, { ...filters, procedureQuery: "ZZZZZ" });
  assert.deepEqual(noMatch.totals, { billed: 0, paid: 0, posted: 0, recouped: 0, claimsBilled: 0, deniedLines: 0 });
  assert.deepEqual(noMatch.deniedCpts, []);
  assert.deepEqual(noMatch.denialReasons, []);
  const cleared = buildHighLevelDashboardResponse(result, { ...filters, procedureQuery: "" });
  assert.equal(cleared.totals.billed, 2600);
  assert.deepEqual(response.payerOptions, cleared.payerOptions);
});

test("dashboard CPT search preserves latest-submission ranking and works in original mode", () => {
  const result = {
    billedRows: [
      { date: "2026-09-01", claimId: "100", submissionOrder: 0, latestSubmissionOrder: 1, procedureCode: "A9607", charge: 100 },
      { date: "2026-09-02", claimId: "100", submissionOrder: 1, latestSubmissionOrder: 1, procedureCode: "78802", charge: 200 },
    ],
    originalRows: [{ date: "2026-09-01", claimId: "100", procedureCode: "A9607", charge: 80 }],
    ediRows: [{ reference: "999A", eventDate: "20260902", procedureCode: "A9607", paid: 25 }],
  };
  const filters = { start: "2026-09-01", end: "2026-09-10", procedureQuery: "A96" };
  assert.equal(buildHighLevelDashboardResponse(result, { ...filters, billingMode: "all" }).totals.billed, 100);
  assert.equal(buildHighLevelDashboardResponse(result, { ...filters, billingMode: "latest" }).totals.billed, 0);
  const original = buildHighLevelDashboardResponse(result, { ...filters, billingMode: "original" });
  assert.equal(original.totals.billed, 80);
  assert.equal(original.totals.paid, 25);
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
  }, { start: "2026-08-01", end: "2026-08-31", limit: 1, page: 2, sort: "paid-percent" });

  assert.equal(response.claims[0].currentStatus, "pending");
  assert.equal(response.claims[1].currentStatus, "paid");
  assert.equal(response.limit, 1);
  assert.equal(response.page, 2);
  assert.equal(response.offset, 1);
  assert.equal(response.totalPages, 2);
  assert.equal(response.sort, "paid-percent");
});

test("high-level posting timing excludes ERA receipts", () => {
  const response = buildHighLevelResponse({
    total: 2,
    claims: [
      { claimId: "100", serviceDate: "2026-09-01", latestChargeAmount: 1_000 },
      { claimId: "101", serviceDate: "2026-09-01", latestChargeAmount: 1_000 },
    ],
    events: [],
    lifecycleEvents: [
      { claimId: "100", date: "2026-09-01", status: "created", label: "Created", source: "billing" },
      { claimId: "100", date: "2026-09-05", status: "paid", label: "Paid", amount: 500, procedure: "A", source: "payer" },
      { claimId: "101", date: "2026-09-01", status: "created", label: "Created", source: "billing" },
      { claimId: "101", date: "2026-09-04", status: "paid", label: "Paid", amount: 250, procedure: "A", source: "payer" },
      { claimId: "101", date: "2026-09-10", status: "paid", label: "Paid", amount: 250, procedure: "A", source: "payer" },
      { claimId: "101", date: "2026-09-10", status: "paid", label: "Payment posted", amount: 500, procedure: "A", source: "billing" },
    ],
  }, {
    start: "2026-09-03",
    end: "2026-09-30",
    limit: 25,
    paidThresholdPercent: 50,
  });

  assert.equal(response.paidThresholdPercent, 50);
  assert.deepEqual(
    response.claims.map((claim) => [claim.paidThresholdDate, claim.daysToPaid]),
    [[null, null], ["2026-09-10", 9]],
  );
  assert.ok(response.claims.every((claim) => claim.events.every((event) => event.date >= "2026-09-03")));
});

test("expanded CPT payments use latest charges and full-history net postings, separate from receipts", () => {
  const response = buildHighLevelResponse({
    total: 1,
    claims: [{ claimId: "100", latestChargeAmount: 750, latestChargeByCpt: [
      { procedure: "78802", latestCharge: 500 }, { procedure: "A9607", latestCharge: 250 },
    ] }],
    lifecycleEvents: [
      { claimId: "100", date: "2026-07-01", status: "submitted", source: "billing", label: "Billed", procedure: "78802", charge: 9999 },
      { claimId: "100", date: "2026-07-05", status: "paid", source: "billing", label: "Posted payment", procedure: "78802", amount: 400 },
      { claimId: "100", date: "2026-09-05", status: "reversed", source: "billing", label: "Reversed", procedure: "78802", amount: -100 },
      { claimId: "100", date: "2026-09-06", status: "received", source: "payer", label: "Received", procedure: "78802", amount: 450 },
      { claimId: "100", date: "2026-09-07", status: "paid", source: "billing", label: "Posted payment", procedure: "99213", amount: 10 },
      { claimId: "100", date: "2026-09-08", status: "received", source: "payer", label: "Claim-only ERA", amount: 20 },
    ],
  }, { start: "2026-09-01", end: "2026-09-30", limit: 25 });
  assert.deepEqual(response.claims[0].cptPayments, [
    { procedure: "78802", latestCharge: 500, posted: 300, received: 450 },
    { procedure: "A9607", latestCharge: 250, posted: 0, received: 0 },
    { procedure: "99213", latestCharge: null, posted: 10, received: 0 },
    { procedure: "UNCODED", latestCharge: null, posted: 0, received: 20 },
  ]);
  assert.equal(response.claims[0].cptPayments.reduce((sum, row) => sum + row.posted, 0), response.claims[0].paidAmount);
  assert.equal(response.claims[0].cptPayments.reduce((sum, row) => sum + row.received, 0), response.claims[0].receivedAmount);
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

test("Claim ICU derives age, deadline urgency, recovery, and current worklist owner", () => {
  const response = buildClaimIcuResponse({
    total: 1,
    claims: [{
      claimId: "82020",
      patientName: "Jane Doe",
      payer: "Aetna",
      serviceDate: "2026-08-01",
      chargedAmount: 1000,
      paidAmount: 100,
      outstandingArAmount: 600,
      deadlineDate: "2026-09-15",
      cptFinancials: [{
        procedure: "78802",
        charged: 1000,
        units: 1,
        postedAmount: 100,
        outstandingArAmount: 600,
      }],
    }],
  }, {
    today: "2026-09-11",
    limit: 25,
    page: 1,
    owners: [{ claimId: "82020", ownerId: "user-1", ownerName: "Alex Morgan", worklistType: "Appeal" }],
    procedureQuery: "78802",
    calculateExpected: () => ({
      total: 550,
      complete: true,
      breakdown: [{ expected: 550, ratePerUnit: 550 }],
    }),
  });

  assert.equal(response.claims[0].ageDays, 41);
  assert.equal(response.claims[0].daysToDeadline, 4);
  assert.equal(response.claims[0].recoveryAmount, 450);
  assert.equal(response.procedureQuery, "78802");
  assert.deepEqual(response.claims[0].cptDetails[0], {
    procedure: "78802",
    units: 1,
    chargedAmount: 1000,
    postedAmount: 100,
    outstandingArAmount: 600,
    expectedReimbursement: 550,
    ratePerUnit: 550,
    recoveryAmount: 450,
  });
  assert.equal(response.claims[0].owner.name, "Alex Morgan");
  assert.equal(response.claims[0].owner.worklistType, "Appeal");
  assert.equal(response.claims[0].owner.worklistCount, 1);
});

test("Claim ICU summarizes multiple Problem List assignments on one claim", () => {
  const response = buildClaimIcuResponse({
    total: 1,
    claims: [{
      claimId: "82020",
      payer: "Plan A",
      serviceDate: "2026-08-01",
      deadlineDate: "2026-10-30",
      paidAmount: 0,
      outstandingArAmount: 100,
      cptFinancials: [],
    }],
  }, {
    today: "2026-09-11",
    owners: [
      { claimId: "82020", ownerId: "user-1", ownerName: "Alex Morgan", worklistType: "Appeal" },
      { claimId: "82020", ownerId: "user-2", ownerName: "Jamie Rivera", worklistType: "Coding review" },
    ],
    calculateExpected: () => ({ total: null, complete: false, breakdown: [] }),
  });

  assert.equal(response.claims[0].owner.name, "Multiple owners");
  assert.equal(response.claims[0].owner.worklistCount, 2);
  assert.equal(response.claims[0].owner.worklistType, "Appeal, Coding review");
});

test("Claim ICU caches MySQL rows while refreshing worklist owners on every request", async () => {
  let databaseLoads = 0;
  let ownerLoads = 0;
  const reads = [];
  const options = {
    cache: createTtlCache({ ttlMs: 60_000 }),
    withReadOnlySession: async (work) => work({ readOnly: true }),
    readClaimIcu: async (_session, filters) => {
      databaseLoads += 1;
      reads.push(filters);
      return { total: 1, claims: [{ claimId: "82020", cptFinancials: [] }] };
    },
    listClaimWorklistOwners: async () => {
      ownerLoads += 1;
      return [{ claimId: "82020", ownerName: `Owner ${ownerLoads}` }];
    },
    calculateExpected: () => ({ total: null, complete: false }),
    today: () => "2026-09-11",
  };

  const first = await getClaimIcu({ limit: "25" }, options);
  const second = await getClaimIcu({ limit: "25" }, options);
  const filtered = await getClaimIcu({ limit: "25", procedureQuery: "a9596" }, options);
  assert.equal(databaseLoads, 2);
  assert.equal(ownerLoads, 3);
  assert.equal(first.claims[0].owner.name, "Owner 1");
  assert.equal(second.claims[0].owner.name, "Owner 2");
  assert.equal(filtered.claims[0].owner.name, "Owner 3");
  assert.equal(reads[1].procedureQuery, "A9596");
});

test("invalid high-level filters fail before database access", async () => {
  await assert.rejects(getClaimIcu({ sort: "oldest" }), /valid Claim ICU priority/);
  await assert.rejects(getClaimIcu({ includePastDeadline: "sometimes" }), /include past filing limits/);
  await assert.rejects(
    getHighLevelClaims({ start: "2026-09-01", end: "2026-08-01", limit: "25" }),
    /Start date must be on or before end date/,
  );
  await assert.rejects(
    getHighLevelClaims({ start: "2026-08-01", end: "2026-08-31", limit: "500" }),
    /Rows must be 10, 25, 50, or 100/,
  );
  await assert.rejects(
    getHighLevelClaims({ start: "2026-08-01", end: "2026-08-31", limit: "25", page: "1.5" }),
    /Page must be a whole number/,
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
