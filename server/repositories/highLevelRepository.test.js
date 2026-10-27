import test from "node:test";
import assert from "node:assert/strict";
import { assertSelectOnly } from "../db/readOnlyPool.js";
import {
  readClaimIcu,
  readClaimsWithoutResponse,
  readHighLevelDashboard,
  readHighLevelClaims,
  readUnsubmittedAppointments,
} from "./highLevelRepository.js";

function fakeSession(handler) {
  return {
    queries: [],
    async select(sql, parameters, options) {
      assertSelectOnly(sql);
      this.queries.push({ sql, parameters, options });
      return handler(sql, parameters, options);
    },
  };
}

test("Claim ICU prioritizes live AR by deadline and keeps CPT reimbursement inputs", async () => {
  const session = fakeSession((_sql, _parameters, { label }) => {
    if (label === "high-level.claim-icu.claims") return [{
      total: 31,
      claimId: "82020",
      serviceDate: "2026-08-01",
      patientName: "Jane Doe",
      payer: "Aetna",
      primaryDiagnosis: "C7A.8",
      chargedAmount: 76424.99,
      paidAmount: 59095.26,
      outstandingArAmount: 15652.82,
      latestResetDate: "2026-09-01",
      deadlineDate: "2026-11-30",
    }];
    if (label === "high-level.claim-icu.cpt-lines") return [
      { claimId: "82020", procedureCode: "78802", charged: 1000, units: 1, outstandingArAmount: 450 },
      { claimId: "82020", procedureCode: "A9607", charged: 75000, units: 2, outstandingArAmount: 15202.82 },
    ];
    if (label === "payments.posted-transactions") return [
      { reference: "82020", procedureCode: "A9607", paid: 50000 },
      { reference: "82020", procedureCode: "A9607", paid: 9095.26 },
    ];
    return [];
  });

  const result = await readClaimIcu(session, {
    limit: 25,
    offset: 25,
    sort: "deadline",
    includePastDeadline: false,
  });

  assert.equal(result.total, 31);
  assert.equal(result.claims[0].primaryDiagnosis, "C7A.8");
  assert.deepEqual(result.claims[0].cptFinancials, [
    { procedure: "78802", charged: 1000, units: 1, outstandingArAmount: 450, postedAmount: 0 },
    { procedure: "A9607", charged: 75000, units: 2, outstandingArAmount: 15202.82, postedAmount: 59095.26 },
  ]);
  assert.equal(result.claims[0].paidAmount, 59095.26);
  const claims = session.queries.find(({ options }) => options.label === "high-level.claim-icu.claims");
  assert.match(claims.sql, /COUNT\(\*\) OVER\(\) AS total/);
  assert.match(claims.sql, /claim_icu\.deadlineDate >= CURRENT_DATE/);
  assert.match(claims.sql, /ORDER BY deadlineDate ASC, prioritizedCptChargedAmount DESC, claimId ASC/);
  assert.match(claims.sql, /LIMIT 25\s+OFFSET 25/);
  assert.match(claims.sql, /DiagnosisCodes/);
  assert.match(claims.sql, /'APPEALSUBMITTED'/);
  assert.match(claims.sql, /recent_activity\.POSTINGDATE >= DATE_SUB\(CURRENT_DATE, INTERVAL 90 DAY\)/);
  assert.doesNotMatch(claims.sql, /ROW_NUMBER\(\) OVER/);
  assert.ok(session.queries.every(({ sql }) => /^SELECT\b/.test(sql.trim())));
});

test("Claim ICU filters by exact CPT before pagination and sorts by that CPT billed amount", async () => {
  const session = fakeSession(() => []);
  await readClaimIcu(session, {
    limit: 25,
    offset: 50,
    sort: "cpt-charged",
    procedureQuery: "A9596",
  });
  const query = session.queries.find(({ options }) => options.label === "high-level.claim-icu.claims");
  assert.deepEqual(query.parameters, ["A9596"]);
  assert.match(query.sql, /CASE WHEN service_lines\.procedureCode = \? THEN service_lines\.charge END/);
  assert.match(query.sql, /claim_icu\.prioritizedCptChargedAmount IS NOT NULL/);
  assert.match(query.sql, /ORDER BY prioritizedCptChargedAmount DESC, deadlineDate ASC, claimId ASC/);
  assert.match(query.sql, /LIMIT 25\s+OFFSET 50/);
  assert.doesNotMatch(query.sql, /A9596/);
});

test("Claim ICU can include expired deadlines and order by highest charge", async () => {
  const session = fakeSession(() => []);
  await readClaimIcu(session, {
    limit: 10,
    sort: "charged",
    includePastDeadline: true,
  });
  const queries = session.queries.filter(({ options }) => options.label === "high-level.claim-icu.claims");
  assert.ok(queries.every(({ sql }) => !/claim_icu\.deadlineDate >= CURRENT_DATE/.test(sql)));
  assert.ok(queries.every(({ sql }) => !/recent_activity/.test(sql)));
  assert.match(queries.find(({ options }) => options.label === "high-level.claim-icu.claims").sql, /ORDER BY chargedAmount DESC, deadlineDate ASC, claimId ASC/);
});

test("CPT claim search filters both count and page before LIMIT while preserving whole-claim detail", async () => {
  const session = fakeSession((_sql, _parameters, { label }) => {
    if (label === "high-level.claims.count") return [{ total: 51 }];
    if (label === "high-level.claims.summary") return [{ claimId: "100", procedureCodes: "A9607,78802", billedAmount: 1200, serviceDate: "2026-09-01" }];
    if (label === "high-level.claims.transaction-events") return [
      { claimId: "100", eventDate: "2026-09-01", eventType: "Claim created", procedureCode: "A9607", charge: 1000 },
      { claimId: "100", eventDate: "2026-09-01", eventType: "Claim created", procedureCode: "78802", charge: 200 },
    ];
    if (label === "high-level.claims.latest-charges") return [
      { claimId: "100", chargeDate: "2026-09-01", procedureCode: "A9607", charge: 1000 },
      { claimId: "100", chargeDate: "2026-09-01", procedureCode: "78802", charge: 200 },
    ];
    return [];
  });
  const result = await readHighLevelClaims(session, {
    start: "2026-09-01", end: "2026-09-10", limit: 25, offset: 25, procedureQuery: "A96",
  });
  for (const label of ["high-level.claims.count", "high-level.claims.summary"]) {
    const query = session.queries.find(({ options }) => options.label === label);
    assert.match(query.sql, /EXISTS \(/);
    assert.match(query.sql, /procedure_matches.ENCOUNTERID = claim_activity.ENCOUNTERID/);
    assert.match(query.sql, /UPPER\(TRIM\(procedure_matches.PROCEDURECODE\)\) LIKE \?/);
    assert.deepEqual(query.parameters, ["2026-09-01", "2026-09-10", "2026-09-01", "2026-09-10", "%A96%"]);
    assert.doesNotMatch(query.sql, /A96/);
  }
  const summary = session.queries.find(({ options }) => options.label === "high-level.claims.summary");
  assert.match(summary.sql, /LIMIT 25\s+OFFSET 25/);
  assert.ok(summary.sql.indexOf("EXISTS") < summary.sql.indexOf("LIMIT"));
  assert.equal(result.total, 51);
  assert.equal(result.claims[0].billedAmount, 1200);
  assert.equal(result.claims[0].latestChargeAmount, 1200);
  assert.deepEqual(result.events.map(({ procedure }) => procedure), ["A9607", "78802"]);
  for (const { options, parameters } of session.queries.filter(({ options }) => ["high-level.claims.transaction-events", "high-level.claims.latest-charges"].includes(options.label))) {
    assert.deepEqual(parameters, ["100"], options.label);
  }
});

test("high-level claims combine transaction and ERA milestones without duplicate payer rows", async () => {
  const session = fakeSession((sql, _parameters, options) => {
    if (/COUNT\(DISTINCT/.test(sql)) return [{ total: 2 }];
    if (options?.label === "high-level.claims.patient-invoice-exact-counts") {
      return [{ claimId: "100", invoiceRowCount: 3 }];
    }
    if (options?.label === "high-level.claims.latest-charges") return [
      { claimId: "100", chargeDate: "2026-08-01", procedureCode: "78802", charge: 500 },
      { claimId: "100", chargeDate: "2026-08-01", procedureCode: "A9607", charge: 250 },
      { claimId: "100", chargeDate: "2026-07-01", procedureCode: "78802", charge: 400 },
      { claimId: "101", chargeDate: "2026-08-03", procedureCode: "78832", charge: 300 },
    ];
    if (/GROUP BY ENCOUNTERID, eventDate/.test(sql)) return [
      { claimId: "100", eventDate: "2026-08-01", eventType: "Billed", amount: 0 },
      { claimId: "101", eventDate: "2026-08-03", eventType: "Claim created", amount: 0 },
    ];
    if (/PatientControlNumber AS reference/.test(sql)) return [
      { reference: "100A", eventDate: "2026-08-10", amount: 125, traceNumber: "CHECK-1" },
    ];
    if (/patient_control_number AS reference/.test(sql)) return [
      { reference: "100A", eventDate: "2026-08-10", amount: 125, traceNumber: "CHECK-1" },
      { reference: "1010", eventDate: "2026-08-11", amount: 999 },
    ];
    if (/GROUP BY ENCOUNTERID/.test(sql)) return [
      { claimId: "100", serviceDate: "2026-08-01", firstActivity: "2026-08-01", lastActivity: "2026-08-10", patientName: "Jane Doe", patientFirstName: "Jane", patientLastName: "Doe", procedureCodes: "78802", payer: "Plan A" },
      { claimId: "101", serviceDate: "2026-08-03", firstActivity: "2026-08-03", lastActivity: "2026-08-03", patientName: "John Doe", patientFirstName: "John", patientLastName: "Doe", procedureCodes: "78832", payer: "Plan B" },
    ];
    return [];
  });

  const result = await readHighLevelClaims(session, {
    start: "2026-08-01",
    end: "2026-08-31",
    limit: 25,
    sort: "billed",
  });

  assert.equal(result.total, 2);
  assert.equal(result.claims.length, 2);
  assert.deepEqual(result.claims.map((claim) => claim.latestChargeAmount), [750, 300]);
  assert.equal(result.claims[0].latestChargeDate, "2026-08-01");
  assert.deepEqual(result.claims[0].latestChargeByCpt, [
    { procedure: "78802", latestCharge: 500 },
    { procedure: "A9607", latestCharge: 250 },
  ]);
  assert.deepEqual(result.claims.map((claim) => claim.invoiceRowCount), [3, 0]);
  assert.deepEqual(result.events.map((event) => [event.claimId, event.status]), [
    ["100", "submitted"],
    ["101", "created"],
    ["100", "received"],
  ]);
  assert.ok(session.queries.every(({ sql }) => /^SELECT\b/.test(sql.trim())));
  assert.ok(session.queries.some(({ sql }) => /PROCEDURECODE AS procedureCode/.test(sql)));
  assert.ok(session.queries.some(({ sql }) => /AdjudProcedure AS procedureCode/.test(sql)));
  assert.ok(session.queries.some(({ sql }) => /service_code AS procedureCode/.test(sql)));
  assert.ok(session.queries.some(({ sql }) => /ORDER BY billedAmount DESC/.test(sql)));
  assert.ok(session.queries.some(({ sql }) => /LIMIT 25\s+OFFSET 0/.test(sql)));
  const transactionEventQuery = session.queries.find(({ options }) => options?.label === "high-level.claims.transaction-events");
  assert.deepEqual(transactionEventQuery.parameters, ["100", "101"]);
  assert.doesNotMatch(transactionEventQuery.sql, /POSTINGDATE BETWEEN/);
  assert.ok(session.queries.some(({ options }) => options?.label === "high-level.claims.patient-invoice-exact-counts"));
});

test("high-level claims count complete invoice rows through the mapped CPT fallback", async () => {
  const session = fakeSession((sql, parameters, options) => {
    if (/COUNT\(DISTINCT/.test(sql)) return [{ total: 1 }];
    if (options?.label === "high-level.claims.patient-invoice-exact-counts") return [];
    if (options?.label === "high-level.claims.patient-invoice-cpt-candidates") {
      assert.deepEqual(parameters, ["200", "2026-08-05", "A9607", "Pluvicto", "%PLUVICTO%"]);
      return [{
        claimId: "200",
        cpt: "A9607",
        product: "Pluvicto",
        id: 41,
        InvoiceNumber: "INV-200",
        DateOfService: "2026-08-05",
        ProductName: "Pluvicto",
        Description: "Therapy dose",
        ProcedureName: "Radiopharmaceutical",
      }];
    }
    if (options?.label === "high-level.claims.patient-invoice-cpt-line-counts") {
      assert.deepEqual(parameters, ["200", "2026-08-05", "INV-200"]);
      return [{ claimId: "200", invoiceRowCount: 4 }];
    }
    if (/GROUP BY ENCOUNTERID, eventDate/.test(sql)) return [
      { claimId: "200", eventDate: "2026-08-05", eventType: "Claim created", procedureCode: "A9607", amount: 0 },
    ];
    if (/GROUP BY ENCOUNTERID/.test(sql)) return [{
      claimId: "200",
      serviceDate: "2026-08-05",
      firstActivity: "2026-08-05",
      lastActivity: "2026-08-05",
      patientName: "Fallback Patient",
      patientFirstName: "Fallback",
      patientLastName: "Patient",
      procedureCodes: "A9607",
      payer: "Plan A",
    }];
    return [];
  });

  const result = await readHighLevelClaims(session, {
    start: "2026-08-01",
    end: "2026-08-31",
    limit: 25,
    sort: "youngest",
  });

  assert.equal(result.claims[0].invoiceRowCount, 4);
  assert.ok(session.queries.every(({ sql }) => /^SELECT\b/.test(sql.trim())));
  assert.deepEqual(
    session.queries
      .filter(({ options }) => options?.label?.includes("patient-invoice"))
      .map(({ options }) => options.label),
    [
      "high-level.claims.patient-invoice-exact-counts",
      "high-level.claims.patient-invoice-cpt-candidates",
      "high-level.claims.patient-invoice-cpt-line-counts",
    ],
  );
});

test("high-level date-only invoice fallback flags claims sharing the service date", async () => {
  const session = fakeSession((sql, _parameters, options) => {
    if (/COUNT\(DISTINCT/.test(sql)) return [{ total: 1 }];
    if (options?.label === "high-level.claims.patient-invoice-exact-counts") return [];
    if (options?.label === "high-level.claims.patient-invoice-date-only-counts") {
      return [{ claimId: "300", serviceDate: "2026-08-07", invoiceRowCount: 2 }];
    }
    if (options?.label === "high-level.claims.patient-invoice-date-only-claim-candidates") {
      return [
        { serviceDate: "2026-08-07", claimId: "300" },
        { serviceDate: "2026-08-07", claimId: "301" },
      ];
    }
    if (/GROUP BY ENCOUNTERID, eventDate/.test(sql)) return [
      { claimId: "300", eventDate: "2026-08-07", eventType: "Claim created", amount: 0 },
    ];
    if (/GROUP BY ENCOUNTERID/.test(sql)) return [{
      claimId: "300",
      serviceDate: "2026-08-07",
      firstActivity: "2026-08-07",
      lastActivity: "2026-08-07",
      patientName: null,
      patientFirstName: null,
      patientLastName: null,
      procedureCodes: "78832",
      payer: "Plan A",
    }];
    return [];
  });

  const result = await readHighLevelClaims(session, {
    start: "2026-08-01",
    end: "2026-08-31",
    limit: 25,
    sort: "youngest",
  });

  assert.equal(result.claims[0].invoiceRowCount, 2);
  assert.equal(result.claims[0].invoiceMatchMethod, "service_date_only");
  assert.equal(result.claims[0].invoiceMatchAmbiguous, true);
  assert.deepEqual(result.claims[0].invoiceCandidateClaimIds, ["300", "301"]);
  assert.ok(session.queries.every(({ sql }) => /^SELECT\b/.test(sql.trim())));
});

test("dashboard reads billed, ClaimStatus, and EDI aggregates with SELECT-only queries", async () => {
  const session = fakeSession((sql, parameters, options) => {
    if (options.label === "high-level.dashboard.billed") {
      assert.match(sql, /POSTINGDATE >= \?/);
      assert.match(sql, /POSTINGDATE < DATE_ADD\(\?, INTERVAL 1 DAY\)/);
      assert.match(sql, /CLAIMTRANSACTIONTYPENAME IN \('Billed', 'Re-billed claim', 'Re-billed'\)/);
      assert.doesNotMatch(sql, /REGEXP/);
      assert.match(sql, /DENSE_RANK\(\) OVER \(PARTITION BY billed_lines\.claimId ORDER BY billed_lines\.date ASC\) - 1/);
      assert.match(sql, /MAX\(ranked_lines\.submissionOrder\) OVER/);
      assert.match(sql, /GROUP BY transactions\.ENCOUNTERID/);
      assert.match(sql, /PROCEDURECODE.*procedureCode/);
      assert.match(sql, /COALESCE\(NULLIF\(transactions\.CompanyName1, ''\), NULLIF\(transactions\.PayerPlan1, ''\)\)\) AS payer/);
      assert.deepEqual(parameters, ["2026-07-01", "2026-07-31", "2026-07-01", "2026-07-31"]);
      return [{ date: "2026-07-01", claimId: "100", submissionOrder: 1, latestSubmissionOrder: 1, procedureCode: "78802", charge: 500 }];
    }
    if (options.label === "high-level.dashboard.original") {
      assert.match(sql, /CLAIMTRANSACTIONTYPENAME = 'Claim created'/);
      assert.match(sql, /DATE\(transactions\.POSTINGDATE\) AS date/);
      assert.match(sql, /SUM\(COALESCE\(transactions\.Charges, 0\)\) AS charge/);
      assert.match(sql, /COALESCE\(NULLIF\(transactions\.CompanyName1, ''\), NULLIF\(transactions\.PayerPlan1, ''\)\)\) AS payer/);
      assert.deepEqual(parameters, ["2026-07-01", "2026-07-31"]);
      return [{ date: "2026-07-02", claimId: "100", procedureCode: "78802", charge: 450 }];
    }
    if (options.label === "high-level.dashboard.claim-status") {
      assert.match(sql, /AdjustmentCodes/);
      return [{ reference: "1000A", eventDate: "2026-07-10", paid: 0, reason: "CO-45" }];
    }
    if (options.label === "high-level.dashboard.edi-835") {
      assert.match(sql, /service_adjustments AS reason/);
      assert.equal(parameters.length, 12);
      return [{ reference: "101A", eventDate: "20260711", paid: 25 }];
    }
    if (["era.advancedmd.received-payments", "payments.posted-transactions"].includes(options.label)) return [];
    assert.equal(options.label, "high-level.dashboard.latest-denied-billed");
    assert.match(sql, /DENSE_RANK\(\) OVER \(PARTITION BY billed_lines\.claimId ORDER BY billed_lines\.date DESC\)/);
    assert.match(sql, /latest_lines\.recency = 1/);
    assert.match(sql, /CLAIMTRANSACTIONTYPENAME IN \('Billed', 'Re-billed claim', 'Re-billed'\)/);
    assert.deepEqual(parameters, ["1000", "1000A"]);
    return [{ claimId: "1000", procedureCode: "78802", date: "2026-07-09", charge: 550 }];
  });

  const result = await readHighLevelDashboard(session, {
    start: "2026-07-01",
    end: "2026-07-31",
  });

  assert.equal(result.billedRows.length, 1);
  assert.equal(result.originalRows.length, 1);
  assert.equal(result.claimStatusRows.length, 1);
  assert.equal(result.ediRows.length, 1);
  assert.equal(result.latestDeniedBilledRows.length, 1);
  assert.equal(session.queries.length, 7);
  assert.ok(session.queries.every(({ sql }) => /^SELECT\b/.test(sql.trim())));
});

test("unsubmitted appointments use the selected service-date range", async () => {
  const session = fakeSession((sql, parameters) => {
    assert.match(sql, /DATEOFSERVICE <= CURRENT_DATE/);
    assert.match(sql, /DATE_SUB\(CURRENT_DATE, INTERVAL 30 DAY\)/);
    assert.doesNotMatch(sql, /DATE\(DATEOFSERVICE\) <= CURRENT_DATE/);
    assert.match(sql, /HAVING SUM/);
    assert.match(sql, /serviceDate >= \?/);
    assert.match(sql, /serviceDate <= \?/);
    assert.match(sql, /ORDER BY serviceDate DESC/);
    assert.deepEqual(parameters, ["2026-08-01", "2026-08-18"]);
    return [{
      claimId: "200",
      serviceDate: "2026-08-01",
      lastActivity: "2026-08-01",
      patientName: "Patient One",
      payer: "Plan",
      provider: "Doctor One",
      location: "Princeton",
      mrn: "42",
      dateOfBirth: "1980-01-02",
      procedures: "77300,78802",
    }];
  });

  const result = await readUnsubmittedAppointments(session, {
    start: "2026-08-01",
    end: "2026-08-18",
    order: "youngest",
    scope: "recent",
  });
  assert.equal(result.items[0].claimId, "200");
  assert.deepEqual(result.items[0].procedures, ["77300", "78802"]);
  assert.equal(result.items[0].provider, "Doctor One");
  assert.equal(result.truncated, false);
});

test("no-response queue includes AdvancedMD responses and rejects conflicting visit IDs", async () => {
  const session = fakeSession((sql, parameters) => {
    if (/HAVING submittedDate IS NOT NULL/.test(sql)) {
      assert.doesNotMatch(sql, /NOT EXISTS/);
      assert.match(sql, /submittedDate <= DATE_SUB\(CURRENT_DATE, INTERVAL 30 DAY\)/);
      assert.match(sql, /submittedDate >= \?/);
      assert.match(sql, /submittedDate <= \?/);
      assert.match(sql, /ORDER BY submittedDate DESC/);
      assert.match(sql, /CHAR_LENGTH\(TRIM\(CAST\(ENCOUNTERID AS CHAR\)\)\) >= 4/);
      assert.match(sql, /LIMIT 1501/);
      assert.deepEqual(parameters, ["2026-07-01", "2026-07-31"]);
      return [
        { claimId: "300", submittedDate: "2026-07-03", serviceDate: "2026-06-20", patientName: "A", payer: "Plan", procedures: "77300" },
        { claimId: "301", submittedDate: "2026-07-02", serviceDate: "2026-06-21", patientName: "B", payer: "Plan", procedures: "A9513" },
        { claimId: "302", submittedDate: "2026-07-02", serviceDate: "2026-06-21", patientName: "C", payer: "Plan", procedures: "A9513" },
      ];
    }

    if (/vw_ODBC_edi_Era_ReportClaim/.test(sql)) {
      assert.deepEqual(parameters.slice(1), ["300", "301", "302"]);
      return [{ reference: "302A", visitId: "302" }, { reference: "301A", visitId: "999" }];
    }
    assert.match(sql, /SELECT DISTINCT (?:PatientControlNumber|patient_control_number) AS reference/);
    assert.match(sql, /CAST\((?:PatientControlNumber|patient_control_number) AS UNSIGNED\) IN \(\?, \?, \?\)/);
    assert.doesNotMatch(sql, /REGEXP_LIKE|UNION ALL|COLLATE|CONCAT/);
    assert.deepEqual(parameters, ["300", "301", "302"]);
    return /FROM `uniCoin`\.`ClaimStatus`/.test(sql)
      ? [{ reference: "300A" }]
      : [{ reference: "3010" }];
  });

  const diagnostics = [];
  const result = await readClaimsWithoutResponse(
    session,
    { start: "2026-07-01", end: "2026-07-31", order: "youngest", scope: "overdue" },
    (stage, details) => diagnostics.push({ stage, details }),
  );
  assert.deepEqual(result.items.map((item) => item.claimId), ["301"]);
  assert.deepEqual(result.items[0].procedures, ["A9513"]);
  assert.equal(result.scanned, 3);
  assert.equal(session.queries.length, 4);
  assert.deepEqual(session.queries.slice(1).map(({ options }) => options.label), [
    "high-level.no-response.claim-status",
    "high-level.no-response.edi-835",
    "high-level.no-response.advancedmd",
  ]);
  assert.deepEqual(diagnostics.map(({ stage }) => stage), [
    "candidates:start",
    "candidates:complete",
    "responses:start",
    "responses:source",
    "responses:source",
    "responses:complete",
    "results:complete",
  ]);
  assert.ok(diagnostics.every(({ details }) => !("claimId" in details) && !("patientName" in details)));
});
