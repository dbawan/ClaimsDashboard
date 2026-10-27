import test from "node:test";
import assert from "node:assert/strict";
import {
  assertValidPatientId,
  assertValidPatientClaimOffset,
  assertValidPatientNameSearch,
  assertValidPatientProcedureQuery,
  assertValidServiceDateRange,
  buildPatientClaimsResponse,
  findPatientsByName,
  getClaimsForPatient,
} from "./patientSearchService.js";

test("patient name and patient ID validation reject broad or unselected searches", () => {
  assert.equal(assertValidPatientNameSearch("  Jane   Doe  "), "Jane Doe");
  assert.equal(assertValidPatientNameSearch("O’Connor, Sé"), "O’Connor, Sé");
  assert.throws(() => assertValidPatientNameSearch("J"), /at least two letters/i);
  assert.throws(() => assertValidPatientNameSearch("Jane%"), /valid patient name/i);
  assert.equal(assertValidPatientId("31631"), "31631");
  assert.throws(() => assertValidPatientId("31631 OR 1=1"), /recommendation list/i);
});

test("patient claim date ranges accept real inclusive dates and reject invalid ranges", () => {
  assert.deepEqual(
    assertValidServiceDateRange({ startDate: "2026-01-01", endDate: "2026-03-31" }),
    { startDate: "2026-01-01", endDate: "2026-03-31" },
  );
  assert.deepEqual(assertValidServiceDateRange(), { startDate: null, endDate: null });
  assert.throws(
    () => assertValidServiceDateRange({ startDate: "2026-02-30" }),
    /valid date-of-service boundaries/i,
  );
  assert.throws(
    () => assertValidServiceDateRange({ startDate: "2026-04-01", endDate: "2026-03-31" }),
    /start date must be on or before/i,
  );
});

test("patient claim pagination accepts bounded non-negative offsets", () => {
  assert.equal(assertValidPatientClaimOffset(), 0);
  assert.equal(assertValidPatientClaimOffset("25"), 25);
  assert.throws(() => assertValidPatientClaimOffset("-1"), /valid patient-claim page offset/i);
  assert.throws(() => assertValidPatientClaimOffset("1 OR 1=1"), /valid patient-claim page offset/i);
});

test("patient CPT and HCPCS filtering accepts partial codes and rejects query syntax", () => {
  assert.equal(assertValidPatientProcedureQuery(" a96 "), "A96");
  assert.equal(assertValidPatientProcedureQuery("788"), "788");
  assert.equal(assertValidPatientProcedureQuery(""), null);
  assert.throws(() => assertValidPatientProcedureQuery("A96%"), /letters or numbers/i);
  assert.throws(() => assertValidPatientProcedureQuery("A96 OR 1=1"), /letters or numbers/i);
});

test("patient search wrappers validate before opening a read-only session", async () => {
  let sessions = 0;
  const withReadOnlySession = async (work) => {
    sessions += 1;
    return work({ marker: "read-only" });
  };

  const suggestions = await findPatientsByName("Jane", {
    withReadOnlySession,
    searchPatientsByName: async (session, query) => ({ session, query }),
  });
  assert.deepEqual(suggestions, { session: { marker: "read-only" }, query: "Jane" });

  const claims = await getClaimsForPatient("31631", { includeFinancials: false }, {
    withReadOnlySession,
    readPatientClaimSources: async () => ({
      patient: { patientId: "31631", name: "Jane Doe" },
      total: 0,
      hasMore: false,
      claimRows: [],
      transactions: [],
      claimStatus: [],
      edi835: [],
    }),
  });
  assert.equal(claims.patient.name, "Jane Doe");
  assert.equal(sessions, 2);

  await assert.rejects(
    findPatientsByName("J", { withReadOnlySession }),
    /at least two letters/i,
  );
  assert.equal(sessions, 2);
});

const sources = Object.freeze({
  patient: Object.freeze({
    patientId: "31631",
    name: "Jane Doe",
    dateOfBirth: "1948-02-10",
    chartNumber: "MRN-42",
    inactive: false,
  }),
  total: 1,
  hasMore: false,
  claimRows: Object.freeze([Object.freeze({
    claimId: "80751",
    serviceDate: "2026-01-03",
    lastActivityDate: "2026-01-20",
    status: "Billed",
    payer: "NJMCR",
    provider: "Provider A",
    location: "Princeton",
    procedureCodes: Object.freeze(["78815"]),
  })]),
  transactions: Object.freeze([Object.freeze({
    ENCOUNTERID: "80751",
    CLAIMTRANSACTIONID: "T-1",
    CLAIMTRANSACTIONTYPENAME: "Billed",
    POSTINGDATE: "2026-01-05",
    DATEOFSERVICE: "2026-01-03",
    PROCEDURECODE: "78815",
    Charges: "250.00",
    Balance: "175.00",
    FIRSTNAME: "Jane",
    LASTNAME: "Doe",
    PayerPlan1: "NJMCR",
  })]),
  claimStatus: Object.freeze([Object.freeze({
    ClaimStatusId: "ERA-1",
    PatientControlNumber: "80751A",
    CheckEftDate: "2026-01-20",
    DateOfServiceStart: "2026-01-03",
    AdjudProcedure: "78815",
    ChargeAmount: "250.00",
    Payment: "75.00",
    PayerName: "NJMCR",
  })]),
  edi835: Object.freeze([]),
});

test("patient claim response adds reconciled financial totals only with payment permission", () => {
  const basic = buildPatientClaimsResponse(sources);
  assert.equal(basic.access.paymentsAndEra, false);
  assert.equal("billed" in basic.claims[0], false);
  assert.equal("latestCharge" in basic.claims[0], false);
  assert.equal("daysToPaid" in basic.claims[0], false);
  assert.equal("paid" in basic.claims[0], false);

  const financial = buildPatientClaimsResponse(sources, { includeFinancials: true });
  assert.equal(financial.access.paymentsAndEra, true);
  assert.equal(financial.claims[0].billed, 250);
  assert.equal(financial.claims[0].latestCharge, 250);
  assert.equal(financial.claims[0].paidThresholdPercent, 50);
  assert.equal(financial.claims[0].paidThresholdDate, null);
  assert.equal(financial.claims[0].daysToPaid, null);
  assert.equal(financial.claims[0].paid, 0);
  assert.equal(financial.claims[0].received, 75);
  assert.equal(financial.claims[0].balance, 175);
});
